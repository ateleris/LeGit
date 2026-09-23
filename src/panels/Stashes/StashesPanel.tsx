import { useCallback, useMemo, useState } from "react";
import {
  applyStash,
  createStash,
  dropStash,
  popStash,
  renameStash,
  stashBranch,
  type RefActionContext,
} from "../../lib/refActions";
import { confirmDestructiveAction } from "../../store/confirm";
import { useQueryClient } from "@tanstack/react-query";
import { useActiveRepo } from "../../store/repos";
import { usePanelFocusEffect } from "../PanelApiContext";
import { notify } from "../../store/notifications";
import { useSummonStore } from "../../store/summon";
import type { StashEntry } from "../../lib/types";
import { formatAppError } from "../../lib/errors";
import { formatRelative } from "../../lib/time";
import { StashIcon } from "../../icons";
import { PanelLoadingBar } from "../shared/PanelLoadingBar";
import { usePanelRunner } from "../shared/usePanelRunner";
import { InlineEditor } from "../shared/InlineEditor";
import { ShrinkingPathText } from "../shared/ShrinkingPathText";
import { splitStashMessage } from "../shared/pathSplit";
import { RefFilterRow } from "../shared/RefFilterRow";
import { matchesRefFilter } from "../../lib/refFilter";
import { Button } from "../shared/buttons";
import { ToolbarButton } from "../shared/ToolbarButton";
import { isRowBackgroundClick, jumpPanelsToCommit } from "../shared/jumpToCommit";
import { useStashes } from "../../lib/queries/useRepoQueries";

const monoInput: React.CSSProperties = {
  fontSize: "var(--fz-md)",
  fontFamily: "monospace",
};

/**
 * Open a stash's contents in the read-only diff path. A stash's commit SHA is a
 * real git object whose first parent is its base, so this reuses the exact
 * commit-click flow (commit-details + Changed Files) — no special diff backend.
 */
export function openStashDiff(stashSha: string) {
  const summon = useSummonStore.getState();
  summon.summon("commit-details", stashSha);
  summon.swapSummon("changed-files", "working-changes", stashSha);
}

/**
 * Stashes section — stash list with apply / pop / rename / drop and a
 * create-stash form. Rendered as a pane inside the combined Refs panel
 * (see `Refs/RefsPanel`), which supplies the header — body-only.
 */
export function StashesSection() {
  const repo = useActiveRepo();
  const queryClient = useQueryClient();

  const { data: stashes = [], isFetching, refetch } = useStashes(repo?.id);

  const [filterQuery, setFilterQuery] = useState("");
  const filteredStashes = useMemo(
    () => stashes.filter((s) => matchesRefFilter(s.message, filterQuery)),
    [stashes, filterQuery],
  );

  const reload = useCallback(() => { refetch(); }, [refetch]);
  usePanelFocusEffect(reload);

  // The shared actions report their own errors and refresh their domains;
  // the runner adds the re-entry guard and delayed busy state.
  const { busy, run } = usePanelRunner({
    enabled: !!repo,
    onError: (e) => notify.error(formatAppError(e)),
  });
  const guarded = async (action: (c: RefActionContext) => Promise<boolean>) => {
    if (!repo) return false;
    let ok = false;
    await run(async () => {
      ok = await action({ queryClient, repo });
    });
    return ok;
  };
  const [createMsg, setCreateMsg] = useState("");
  // Default on: a stash should capture the full working state, untracked files
  // included. Users can still opt out per-stash.
  const [includeUntracked, setIncludeUntracked] = useState(true);
  const [keepIndex, setKeepIndex] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draftMsg, setDraftMsg] = useState("");
  const [branching, setBranching] = useState<string | null>(null);
  const [draftBranch, setDraftBranch] = useState("");

  const openRename = (s: StashEntry) => {
    setBranching(null);
    setDraftMsg(s.message);
    setRenaming(s.stash_sha);
  };

  const openBranch = (s: StashEntry) => {
    setRenaming(null);
    setDraftBranch("");
    setBranching(s.stash_sha);
  };

  const doBranch = async (sha: string) => {
    const name = draftBranch.trim();
    if (!name) return;
    if (await guarded((c) => stashBranch(c, sha, name))) setBranching(null);
  };

  const doRename = async (sha: string) => {
    const next = draftMsg.trim();
    if (!next) return;
    if (await guarded((c) => renameStash(c, sha, next))) setRenaming(null);
  };

  const doCreate = async () => {
    if (!repo) return;
    let result: Awaited<ReturnType<typeof createStash>> = null;
    await run(async () => {
      result = await createStash(
        { queryClient, repo },
        { message: createMsg.trim() || undefined, includeUntracked, keepIndex },
      );
    });
    if (result === "created") {
      setCreateMsg("");
      setIncludeUntracked(false);
      setKeepIndex(false);
    }
  };

  const requestDrop = async (s: StashEntry) => {
    const ok = await confirmDestructiveAction({
      title: "Drop stash",
      message: "Deletes the stash entry; its changes are not applied anywhere.",
      detail: s.message,
      confirmLabel: "Drop stash",
    });
    if (ok) void guarded((c) => dropStash(c, s.stash_sha));
  };

  if (!repo) {
    return (
      <div className="legit-panel">
        <div className="legit-panel__body">
          <span className="legit-subtle">No repository open.</span>
        </div>
      </div>
    );
  }

  return (
    <div className="legit-panel" style={{ display: "flex", flexDirection: "column" }}>
      <PanelLoadingBar active={isFetching} />
      <div
        className="legit-panel__body"
        style={{ display: "flex", flexDirection: "column", gap: "0.833em" }}
      >
        {stashes.length > 0 && (
          <RefFilterRow query={filterQuery} onQueryChange={setFilterQuery} label="stashes" />
        )}
        {stashes.length === 0 ? (
          <span className="legit-subtle" style={{ fontSize: "var(--fz-md)" }}>
            No stashes.
          </span>
        ) : filteredStashes.length === 0 ? (
          <span className="legit-subtle" style={{ fontSize: "var(--fz-md)" }}>
            No matches.
          </span>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.5em" }}>
            {filteredStashes.map((s) => (
              // Rows (and the per-row edit/confirm state) are keyed by the
              // stash SHA — stable across the reordering a rename/drop causes,
              // where positional selectors would attach state to the wrong row.
              <StashRow
                key={s.stash_sha}
                stash={s}
                busy={busy}
                editing={renaming === s.stash_sha}
                draftMsg={draftMsg}
                onDraftChange={setDraftMsg}
                branching={branching === s.stash_sha}
                draftBranch={draftBranch}
                onDraftBranchChange={setDraftBranch}
                onOpenBranch={() => openBranch(s)}
                onSaveBranch={() => doBranch(s.stash_sha)}
                onCancelBranch={() => setBranching(null)}
                onApply={() => guarded((c) => applyStash(c, s.stash_sha, s.selector))}
                onPop={() => guarded((c) => popStash(c, s.stash_sha, s.selector))}
                onViewDiff={() => openStashDiff(s.stash_sha)}
                onOpenRename={() => openRename(s)}
                onSaveRename={() => doRename(s.stash_sha)}
                onCancelEdit={() => setRenaming(null)}
                onOpenDrop={() => void requestDrop(s)}
              />
            ))}
          </div>
        )}

        <div
          style={{
            borderTop: "1px solid var(--panel-border)",
            paddingTop: "0.833em",
            display: "flex",
            flexDirection: "column",
            gap: "0.5em",
          }}
        >
          <SectionLabel>New stash</SectionLabel>
          <div style={{ display: "flex", gap: "0.5em", flexWrap: "wrap" }}>
            <input
              value={createMsg}
              onChange={(e) => setCreateMsg(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && doCreate()}
              placeholder="message (optional)"
              style={{ ...monoInput, flex: 1, minWidth: 0 }}
            />
            <Button variant="primary" disabled={busy} onClick={doCreate}>
              Stash
            </Button>
          </div>
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.5em",
              fontSize: "var(--fz-sm)",
              color: "var(--subtle-fg)",
            }}
          >
            <input
              type="checkbox"
              checked={includeUntracked}
              onChange={(e) => setIncludeUntracked(e.target.checked)}
            />
            Include untracked files
          </label>
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.5em",
              fontSize: "var(--fz-sm)",
              color: "var(--subtle-fg)",
            }}
            title="The stash still records everything, but staged changes stay staged in the working tree (--keep-index)."
          >
            <input
              type="checkbox"
              checked={keepIndex}
              onChange={(e) => setKeepIndex(e.target.checked)}
            />
            Keep staged changes
          </label>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Subcomponents
// ---------------------------------------------------------------------------

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        fontSize: "var(--fz-sm)",
        textTransform: "uppercase",
        letterSpacing: 0.5,
        color: "var(--subtle-fg)",
      }}
    >
      {children}
    </span>
  );
}

function StashRow({
  stash,
  busy,
  editing,
  draftMsg,
  onDraftChange,
  branching,
  draftBranch,
  onDraftBranchChange,
  onOpenBranch,
  onSaveBranch,
  onCancelBranch,
  onApply,
  onPop,
  onViewDiff,
  onOpenRename,
  onSaveRename,
  onCancelEdit,
  onOpenDrop,
}: {
  stash: StashEntry;
  busy: boolean;
  editing: boolean;
  draftMsg: string;
  onDraftChange: (v: string) => void;
  branching: boolean;
  draftBranch: string;
  onDraftBranchChange: (v: string) => void;
  onOpenBranch: () => void;
  onSaveBranch: () => void;
  onCancelBranch: () => void;
  onApply: () => void;
  onPop: () => void;
  onViewDiff: () => void;
  onOpenRename: () => void;
  onSaveRename: () => void;
  onCancelEdit: () => void;
  onOpenDrop: () => void;
}) {
  return (
    <div
      onClick={(e) => {
        // Background click = show the stash's node in the graph (stash nodes
        // are injected into the log by their commit SHA); not while an inline
        // rename/branch/drop flow is open, and never for the row's buttons.
        if (!editing && !branching && isRowBackgroundClick(e.target)) {
          jumpPanelsToCommit(stash.stash_sha);
        }
      }}
      style={{
        border: "1px solid var(--panel-border)",
        borderRadius: 4,
        padding: "0.667em 0.833em",
        display: "flex",
        flexDirection: "column",
        gap: "0.5em",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "0.667em" }}>
        <span style={{ color: "var(--ref-stash-fg)", flexShrink: 0, display: "inline-flex" }}>
          <StashIcon />
        </span>
        <ShrinkingPathText
          {...splitStashMessage(stash.message)}
          style={{ fontSize: "var(--fz-md)", flex: 1 }}
          title={stash.message}
        />
        <span className="legit-subtle" style={{ fontSize: "var(--fz-sm)", flexShrink: 0 }}>
          {formatRelative(stash.timestamp)}
        </span>
      </div>

      {editing ? (
        <InlineEditor
          label="Rename stash"
          disabled={busy}
          onSave={onSaveRename}
          onCancel={onCancelEdit}
        >
          <input
            autoFocus
            value={draftMsg}
            onChange={(e) => onDraftChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onSaveRename();
              if (e.key === "Escape") onCancelEdit();
            }}
            style={{ fontSize: "var(--fz-md)" }}
          />
        </InlineEditor>
      ) : branching ? (
        <InlineEditor
          label="Branch from stash"
          disabled={busy}
          onSave={onSaveBranch}
          onCancel={onCancelBranch}
        >
          <input
            autoFocus
            value={draftBranch}
            onChange={(e) => onDraftBranchChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onSaveBranch();
              if (e.key === "Escape") onCancelBranch();
            }}
            placeholder="new branch name"
            style={{ fontSize: "var(--fz-md)" }}
          />
        </InlineEditor>
      ) : (
        <div style={{ display: "flex", gap: "0.5em", justifyContent: "flex-end", flexWrap: "wrap" }}>
          <ToolbarButton label="View diff" disabled={busy} onClick={onViewDiff} />
          <ToolbarButton label="Apply" disabled={busy} onClick={onApply} />
          <ToolbarButton label="Pop" disabled={busy} onClick={onPop} />
          <ToolbarButton label="Branch" disabled={busy} onClick={onOpenBranch} />
          <ToolbarButton label="Rename" disabled={busy} onClick={onOpenRename} />
          <ToolbarButton label="Drop" disabled={busy} onClick={onOpenDrop} />
        </div>
      )}
    </div>
  );
}
