import { useCallback, useEffect, useRef, useState } from "react";
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
} from "../../lib/commands";
import { notify } from "../../store/notifications";
import { useSummonStore, useSummonTarget } from "../../store/summon";
import type { StashEntry } from "../../lib/types";
import { formatAppError } from "../../lib/types";
import { formatRelative } from "../../lib/time";
import { StashIcon } from "../../icons";
import { PanelLoadingBar } from "../shared/PanelLoadingBar";
import { InlineEditor } from "../shared/InlineEditor";

type SummonPayload = { action: "rename"; selector: string };

// A stash mutation touches the working tree, the stash list, and the graph.
const AFFECTED_DOMAINS = ["stashes", "log", "status"];

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

export function StashesPanel() {
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
  const [confirmDrop, setConfirmDrop] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draftMsg, setDraftMsg] = useState("");
  const [pendingRename, setPendingRename] = useState<string | null>(null);
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  const invalidate = useCallback(() => {
    if (!repo) return;
    invalidateRepoDomains(queryClient, repo.id, AFFECTED_DOMAINS);
  }, [queryClient, repo]);

  const openRename = (s: StashEntry) => {
    setError(null);
    setConfirmDrop(null);
    setDraftMsg(s.message);
    setRenaming(s.selector);
  };

  // Rename via drop + re-store (see the backend): the stash keeps its content
  // but moves to stash@{0}. The list refetch reflects the new order.
  const doRename = async (selector: string) => {
    if (!repo) return;
    const next = draftMsg.trim();
    if (!next) return;
    setBusy(true);
    setError(null);
    try {
      await repoRenameStash(repo.id, selector, next);
      invalidate();
      setRenaming(null);
    } catch (e) {
      setError(formatAppError(e));
    } finally {
      setBusy(false);
    }
  };

  // Context-menu "Rename stash…" summons this panel with the target selector.
  const onSummon = useCallback((payload: SummonPayload) => {
    if (payload.action !== "rename") return;
    const s = stashes.find((x) => x.selector === payload.selector);
    if (s) {
      setError(null);
      setConfirmDrop(null);
      setDraftMsg(s.message);
      setRenaming(s.selector);
      setTimeout(() => rowRefs.current.get(s.selector)?.scrollIntoView({ block: "nearest" }), 0);
    } else {
      setPendingRename(payload.selector);
    }
  }, [stashes]);
  useSummonTarget<SummonPayload>("stashes", onSummon);

  // If the panel was just opened by the summon, the list may not have loaded
  // yet — retry the rename once stashes arrive.
  useEffect(() => {
    if (!pendingRename || stashes.length === 0) return;
    const s = stashes.find((x) => x.selector === pendingRename);
    if (!s) return;
    setPendingRename(null);
    setError(null);
    setDraftMsg(s.message);
    setRenaming(s.selector);
    setTimeout(() => rowRefs.current.get(s.selector)?.scrollIntoView({ block: "nearest" }), 0);
  }, [stashes, pendingRename]);

  const doCreate = async () => {
    if (!repo) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await repoCreateStash(
        repo.id,
        createMsg.trim() || undefined,
        includeUntracked,
      );
      invalidate();
      if (outcome.kind === "nothing_to_stash") {
        notify.info("Nothing to stash — the working tree is clean.");
      } else {
        setCreateMsg("");
        setIncludeUntracked(false);
      }
    } catch (e) {
      setError(formatAppError(e));
    } finally {
      setBusy(false);
    }
  };

  // Apply or pop, surfacing a merge conflict as an info toast (the op partially
  // succeeded; on a pop, git keeps the stash so it reappears after refetch).
  const doApplyOrPop = async (
    selector: string,
    fn: (repoId: string, selector: string) => Promise<{ kind: string; message?: string }>,
    verb: string,
  ) => {
    if (!repo) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await fn(repo.id, selector);
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

  const doDrop = async (selector: string) => {
    if (!repo) return;
    setBusy(true);
    setError(null);
    try {
      await repoDropStash(repo.id, selector);
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
        <div className="legit-panel__toolbar"><strong>Stashes</strong></div>
        <div className="legit-panel__body">
          <span className="legit-subtle">No repository open.</span>
        </div>
      </div>
    );
  }

  return (
    <div className="legit-panel" style={{ display: "flex", flexDirection: "column" }}>
      <PanelLoadingBar active={isFetching} />
      <div className="legit-panel__toolbar">
        <strong>Stashes — {repo.name}</strong>
      </div>
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
              <StashRow
                key={s.selector}
                stash={s}
                busy={busy}
                confirmingDrop={confirmDrop === s.selector}
                editing={renaming === s.selector}
                draftMsg={draftMsg}
                rowRef={(el) => {
                  if (el) rowRefs.current.set(s.selector, el);
                  else rowRefs.current.delete(s.selector);
                }}
                onDraftChange={setDraftMsg}
                onApply={() => doApplyOrPop(s.selector, repoApplyStash, "Applying")}
                onPop={() => doApplyOrPop(s.selector, repoPopStash, "Popping")}
                onViewDiff={() => openStashDiff(s.stash_sha)}
                onOpenRename={() => openRename(s)}
                onSaveRename={() => doRename(s.selector)}
                onCancelEdit={() => setRenaming(null)}
                onOpenDrop={() => { setError(null); setConfirmDrop(s.selector); }}
                onConfirmDrop={() => doDrop(s.selector)}
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
          <div style={{ display: "flex", gap: 6 }}>
            <input
              value={createMsg}
              onChange={(e) => setCreateMsg(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && doCreate()}
              placeholder="message (optional)"
              style={{ ...monoInput, flex: 1 }}
            />
            <button className="primary" disabled={busy} onClick={doCreate}>
              Stash
            </button>
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
  rowRef,
  onDraftChange,
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
  rowRef: (el: HTMLDivElement | null) => void;
  onDraftChange: (v: string) => void;
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
      ref={rowRef}
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
      ) : confirmingDrop ? (
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: "var(--fz-md)", flex: 1 }}>
            Drop this stash?
          </span>
          <button className="danger" disabled={busy} onClick={onConfirmDrop}>
            Drop
          </button>
          <button disabled={busy} onClick={onCancelDrop}>
            Cancel
          </button>
        </div>
      ) : (
        <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
          <button disabled={busy} onClick={onViewDiff}>View diff</button>
          <button disabled={busy} onClick={onApply}>Apply</button>
          <button disabled={busy} onClick={onPop}>Pop</button>
          <button disabled={busy} onClick={onOpenRename}>Rename</button>
          <button disabled={busy} onClick={onOpenDrop}>Drop</button>
        </div>
      )}
    </div>
  );
}
