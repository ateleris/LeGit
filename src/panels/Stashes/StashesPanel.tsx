import { useCallback, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useActiveRepo } from "../../store/repos";
import { usePanelFocusEffect } from "../PanelApiContext";
import { invalidateRepoDomains } from "../../lib/repoInvalidation";
import {
  repoStashes,
  repoCreateStash,
  repoApplyStash,
  repoPopStash,
  repoDropStash,
  repoRenameStash,
  repoStashBranch,
} from "../../lib/commands";
import { formatSwitchError } from "../../lib/switchFeedback";
import { notify } from "../../store/notifications";
import { useSummonStore } from "../../store/summon";
import { useConfirmDestructive } from "../../store/settings";
import type { StashEntry } from "../../lib/types";
import { formatAppError } from "../../lib/types";
import { formatRelative } from "../../lib/time";
import { StashIcon } from "../../icons";
import { PanelLoadingBar } from "../shared/PanelLoadingBar";
import { InlineEditor } from "../shared/InlineEditor";
import { Button } from "../shared/buttons";

// A stash mutation touches the working tree, the stash list, and the graph.
const AFFECTED_DOMAINS = ["stashes", "log", "status"];
// Branch-from-stash additionally creates and checks out a branch.
const BRANCH_DOMAINS = ["stashes", "log", "status", "branches", "tracking"];

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

  const { data: stashes = [], isFetching, refetch } = useQuery<StashEntry[]>({
    queryKey: [repo?.id, "stashes"],
    queryFn: () => repoStashes(repo!.id),
    enabled: !!repo,
    staleTime: 5_000,
  });

  const reload = useCallback(() => { refetch(); }, [refetch]);
  usePanelFocusEffect(reload);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createMsg, setCreateMsg] = useState("");
  // Default on: a stash should capture the full working state, untracked files
  // included. Users can still opt out per-stash.
  const [includeUntracked, setIncludeUntracked] = useState(true);
  const [keepIndex, setKeepIndex] = useState(false);
  const confirmDestructive = useConfirmDestructive();
  const [confirmDrop, setConfirmDrop] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draftMsg, setDraftMsg] = useState("");
  const [branching, setBranching] = useState<string | null>(null);
  const [draftBranch, setDraftBranch] = useState("");

  const invalidate = useCallback(() => {
    if (!repo) return;
    invalidateRepoDomains(queryClient, repo.id, AFFECTED_DOMAINS);
  }, [queryClient, repo]);

  const openRename = (s: StashEntry) => {
    setError(null);
    setConfirmDrop(null);
    setBranching(null);
    setDraftMsg(s.message);
    setRenaming(s.stash_sha);
  };

  const openBranch = (s: StashEntry) => {
    setError(null);
    setConfirmDrop(null);
    setRenaming(null);
    setDraftBranch("");
    setBranching(s.stash_sha);
  };

  // `git stash branch`: new branch at the stash's base, stash applied and
  // dropped on success — the escape hatch when a plain apply would conflict.
  const doBranch = async (sha: string) => {
    if (!repo) return;
    const name = draftBranch.trim();
    if (!name) return;
    setBusy(true);
    setError(null);
    try {
      await repoStashBranch(repo.id, sha, name);
      invalidateRepoDomains(queryClient, repo.id, BRANCH_DOMAINS);
      setBranching(null);
      notify.info(`Created branch '${name}' from the stash and checked it out.`);
    } catch (e) {
      setError(formatSwitchError(e));
    } finally {
      setBusy(false);
    }
  };

  // Rename via drop + re-store (see the backend): the stash keeps its content
  // but moves to stash@{0}. The list refetch reflects the new order.
  const doRename = async (sha: string) => {
    if (!repo) return;
    const next = draftMsg.trim();
    if (!next) return;
    setBusy(true);
    setError(null);
    try {
      await repoRenameStash(repo.id, sha, next);
      invalidate();
      setRenaming(null);
    } catch (e) {
      setError(formatAppError(e));
    } finally {
      setBusy(false);
    }
  };

  const doCreate = async () => {
    if (!repo) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await repoCreateStash(
        repo.id,
        createMsg.trim() || undefined,
        includeUntracked,
        keepIndex,
      );
      invalidate();
      if (outcome.kind === "nothing_to_stash") {
        notify.info("Nothing to stash — the working tree is clean.");
      } else {
        setCreateMsg("");
        setIncludeUntracked(false);
        setKeepIndex(false);
      }
    } catch (e) {
      setError(formatAppError(e));
    } finally {
      setBusy(false);
    }
  };

  // Apply or pop, surfacing a merge conflict as an info toast (the op partially
  // succeeded; on a pop, git keeps the stash so it reappears after refetch).
  // Actions address the stash by SHA; the selector is only for the toast text.
  const doApplyOrPop = async (
    sha: string,
    selector: string,
    fn: (repoId: string, sha: string) => Promise<{ kind: string; message?: string }>,
    verb: string,
  ) => {
    if (!repo) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await fn(repo.id, sha);
      invalidate();
      if (outcome.kind === "conflicts") {
        notify.info(
          `${verb} ${selector} produced conflicts — resolve them in your working tree.`,
        );
      }
    } catch (e) {
      setError(formatAppError(e));
    } finally {
      setBusy(false);
    }
  };

  const doDrop = async (sha: string) => {
    if (!repo) return;
    setBusy(true);
    setError(null);
    try {
      await repoDropStash(repo.id, sha);
      invalidate();
      setConfirmDrop(null);
    } catch (e) {
      setError(formatAppError(e));
    } finally {
      setBusy(false);
    }
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
        style={{ display: "flex", flexDirection: "column", gap: 10 }}
      >
        {error && (
          <pre className="legit-error" style={{ margin: 0, fontSize: "var(--fz-md)" }}>
            {error}
          </pre>
        )}

        {stashes.length === 0 ? (
          <span className="legit-subtle" style={{ fontSize: "var(--fz-md)" }}>
            No stashes.
          </span>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {stashes.map((s) => (
              // Rows (and the per-row edit/confirm state) are keyed by the
              // stash SHA — stable across the reordering a rename/drop causes,
              // where positional selectors would attach state to the wrong row.
              <StashRow
                key={s.stash_sha}
                stash={s}
                busy={busy}
                confirmingDrop={confirmDrop === s.stash_sha}
                editing={renaming === s.stash_sha}
                draftMsg={draftMsg}
                onDraftChange={setDraftMsg}
                branching={branching === s.stash_sha}
                draftBranch={draftBranch}
                onDraftBranchChange={setDraftBranch}
                onOpenBranch={() => openBranch(s)}
                onSaveBranch={() => doBranch(s.stash_sha)}
                onCancelBranch={() => setBranching(null)}
                onApply={() => doApplyOrPop(s.stash_sha, s.selector, repoApplyStash, "Applying")}
                onPop={() => doApplyOrPop(s.stash_sha, s.selector, repoPopStash, "Popping")}
                onViewDiff={() => openStashDiff(s.stash_sha)}
                onOpenRename={() => openRename(s)}
                onSaveRename={() => doRename(s.stash_sha)}
                onCancelEdit={() => setRenaming(null)}
                onOpenDrop={() => {
                  setError(null);
                  // Global destructive-confirmation setting: when off, drop runs immediately.
                  if (confirmDestructive) setConfirmDrop(s.stash_sha);
                  else void doDrop(s.stash_sha);
                }}
                onConfirmDrop={() => doDrop(s.stash_sha)}
                onCancelDrop={() => setConfirmDrop(null)}
              />
            ))}
          </div>
        )}

        <div
          style={{
            borderTop: "1px solid var(--panel-border)",
            paddingTop: 10,
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}
        >
          <SectionLabel>New stash</SectionLabel>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
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
              gap: 6,
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
              gap: 6,
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
  confirmingDrop,
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
  onConfirmDrop,
  onCancelDrop,
}: {
  stash: StashEntry;
  busy: boolean;
  confirmingDrop: boolean;
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
  onConfirmDrop: () => void;
  onCancelDrop: () => void;
}) {
  return (
    <div
      style={{
        border: "1px solid var(--panel-border)",
        borderRadius: 4,
        padding: "8px 10px",
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ color: "var(--ref-stash-fg)", flexShrink: 0, display: "inline-flex" }}>
          <StashIcon />
        </span>
        <span
          style={{
            fontSize: "var(--fz-md)",
            flex: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={stash.message}
        >
          {stash.message}
        </span>
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
      ) : confirmingDrop ? (
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <span style={{ fontSize: "var(--fz-md)", flex: 1 }}>
            Drop this stash?
          </span>
          <Button variant="danger" disabled={busy} onClick={onConfirmDrop}>
            Drop
          </Button>
          <button disabled={busy} onClick={onCancelDrop}>
            Cancel
          </button>
        </div>
      ) : (
        <div style={{ display: "flex", gap: 6, justifyContent: "flex-end", flexWrap: "wrap" }}>
          <button disabled={busy} onClick={onViewDiff}>View diff</button>
          <button disabled={busy} onClick={onApply}>Apply</button>
          <button disabled={busy} onClick={onPop}>Pop</button>
          <button disabled={busy} onClick={onOpenBranch}>Branch</button>
          <button disabled={busy} onClick={onOpenRename}>Rename</button>
          <button disabled={busy} onClick={onOpenDrop}>Drop</button>
        </div>
      )}
    </div>
  );
}
