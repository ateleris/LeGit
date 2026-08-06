// Merge panel — the dedicated conflict-resolution surface (GitKraken-style,
// result pane in the middle): Current | (Base) | Result | Incoming. Summoned
// for Conflicted files (sharing the Diff panel's dock slot via swapSummon);
// the Diff panel itself no longer knows about conflicts.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRepoStore } from "../../store/repos";
import { useSettingsStore } from "../../store/settings";
import { useSummonTarget } from "../../store/summon";
import {
  repoBranches,
  repoConflictFileSides,
  repoReadWorktreeFile,
  repoResolveTakeSide,
  repoStage,
  repoWriteWorktreeFile,
} from "../../lib/commands";
import type { Branch, ConflictFileSides, ConflictSide } from "../../lib/types";
import { useOpState } from "../../lib/useOpState";
import { formatAppError } from "../../lib/types";
import { invalidateRepoDomains } from "../../lib/repoInvalidation";
import { notifyResolutionInvisible } from "../../lib/mergeFeedback";
import { notify } from "../../store/notifications";
import { segStyle } from "../shared/segmented";
import { PanelLoadingBar } from "../shared/PanelLoadingBar";
import { ToolbarButton } from "../shared/ToolbarButton";
import { LineEndingBadge } from "../shared/LineEndingBadge";
import { applyEol } from "../Diff/editModel";
import {
  conflictSideNames,
  externalChangePending,
  parseConflicts,
  sideLabel,
  type LineSelection,
  type ParsedConflicts,
} from "../Diff/conflictModel";
import { MergeView, type MergeViewHandle } from "./MergeView";

/** Payload for summoning the Merge panel. */
export interface MergeRequest {
  repoId: string;
  path: string;
}

/** Fresh all-unselected per-line flags for a parse. */
function emptySelections(parsed: ParsedConflicts | null): LineSelection[] {
  if (!parsed) return [];
  return parsed.sections
    .filter((s) => s.kind === "conflict")
    .map((s) => ({
      ours: (s as { ours: string[] }).ours.map(() => false),
      theirs: (s as { theirs: string[] }).theirs.map(() => false),
    }));
}

export function MergePanel() {
  const queryClient = useQueryClient();
  const [request, setRequest] = useState<MergeRequest | null>(null);
  const [dirty, setDirty] = useState(false);
  // Conflicts view folds the common stretches; Full file shows everything.
  const [viewMode, setViewMode] = useState<"conflicts" | "full">(
    () => (localStorage.getItem("legit.merge.viewMode") === "full" ? "full" : "conflicts"),
  );
  const chooseViewMode = (next: "conflicts" | "full") => {
    setViewMode(next);
    localStorage.setItem("legit.merge.viewMode", next);
  };
  const [rebuildKey, setRebuildKey] = useState(0);
  const [pending, setPending] = useState<MergeRequest | null>(null);
  // Mark-resolved guard: blocks remaining in the result at click time.
  const [confirmUnresolved, setConfirmUnresolved] = useState<number | null>(null);
  // True after THIS panel staged the file - corrects the "use Mark resolved"
  // guidance once the resolution is already staged.
  const [stagedNotice, setStagedNotice] = useState(false);
  const [navIndex, setNavIndex] = useState(0);
  const viewRef = useRef<MergeViewHandle | null>(null);
  const savingRef = useRef(false);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const requestRef = useRef(request);
  requestRef.current = request;

  const onReceive = useCallback((payload: MergeRequest | null) => {
    if (
      dirtyRef.current &&
      payload &&
      requestRef.current &&
      (payload.path !== requestRef.current.path || payload.repoId !== requestRef.current.repoId)
    ) {
      setPending(payload);
      return;
    }
    setRequest(payload);
  }, []);
  useSummonTarget<MergeRequest | null>("merge", onReceive);

  // Drop state that belongs to a repo the user switched away from.
  const activeRepoId = useRepoStore((s) => s.activeRepoId);
  useEffect(() => {
    setRequest((req) => {
      if (req && req.repoId !== activeRepoId) {
        setDirty(false);
        setPending(null);
        return null;
      }
      return req;
    });
  }, [activeRepoId]);

  const {
    data: diskContent,
    isError: isReadError,
    isFetching,
  } = useQuery<string>({
    // Under the "diff" domain so existing invalidations refresh it; stays
    // enabled while dirty so external edits are still NOTICED (the view's
    // baseline below is what protects the in-progress result).
    queryKey: [request?.repoId, "diff", "merge-content", request?.path],
    queryFn: () => repoReadWorktreeFile(request!.repoId, request!.path),
    enabled: !!request && request.repoId === activeRepoId,
    staleTime: 5_000,
  });
  // The baseline the view is built from: follows the disk while the result
  // is pristine (external edits reload the conflict), frozen while dirty so
  // a background refetch never clobbers an in-progress resolution - the
  // externalChangePending banner asks the user instead.
  const [content, setContent] = useState<string | null>(null);
  // Disk text the user chose to keep editing over (banner dismissed).
  const [dismissedDisk, setDismissedDisk] = useState<string | null>(null);
  useEffect(() => {
    setContent(null);
    setDismissedDisk(null);
  }, [request?.repoId, request?.path]);
  useEffect(() => {
    if (!dirty && diskContent != null) setContent(diskContent);
  }, [dirty, diskContent]);
  const externalChange = externalChangePending(content, diskContent, dirty, dismissedDisk);
  const parsed = useMemo(() => (content != null ? parseConflicts(content) : null), [content]);
  const parsedRef = useRef(parsed);
  parsedRef.current = parsed;

  const { data: sides } = useQuery<ConflictFileSides>({
    queryKey: [request?.repoId, "diff", "sides", request?.path],
    queryFn: () => repoConflictFileSides(request!.repoId, request!.path),
    enabled: !!request && request.repoId === activeRepoId && !dirty && !isReadError,
    staleTime: 5_000,
  });

  const { data: branches = [] } = useQuery<Branch[]>({
    queryKey: [request?.repoId, "branches"],
    queryFn: () => repoBranches(request!.repoId),
    enabled: !!request && request.repoId === activeRepoId,
    staleTime: 5_000,
  });
  const currentBranchName = useMemo(
    () => branches.find((b) => b.is_current)?.name ?? null,
    [branches],
  );

  // Names the incoming side when the markers cannot (a reopened conflict's
  // labels are the literal "ours"/"theirs"): the merge source branch, the
  // branch being rebased, or the picked/reverted commit.
  const opState = useOpState(request?.repoId);
  const incomingName = useMemo(() => {
    switch (opState?.kind) {
      case "merge":
        return opState.branch;
      case "rebase":
        return opState.head_name;
      case "cherry_pick":
      case "revert":
        return opState.sha;
      default:
        return null;
    }
  }, [opState]);

  const sideNames = useMemo(
    () => (parsed ? conflictSideNames(parsed, currentBranchName, incomingName) : null),
    [parsed, currentBranchName, incomingName],
  );

  // Per-line selections; live in a ref for the mounted view, in state for
  // the toolbar (resolved counter). Reset whenever the baseline changes.
  const [selections, setSelections] = useState<LineSelection[]>([]);
  const selectionsRef = useRef<LineSelection[]>([]);
  useEffect(() => {
    const fresh = emptySelections(parsed);
    selectionsRef.current = fresh;
    setSelections(fresh);
    setNavIndex(0);
  }, [parsed]);

  const applySelection = useCallback((next: LineSelection[], block: number) => {
    selectionsRef.current = next;
    setSelections(next);
    viewRef.current?.applyBlock(block);
  }, []);

  const onToggleLine = useCallback(
    (block: number, side: "ours" | "theirs", line: number) => {
      const cur = selectionsRef.current;
      const next = cur.map((s, i) =>
        i === block ? { ...s, [side]: s[side].map((v, l) => (l === line ? !v : v)) } : s,
      );
      applySelection(next, block);
    },
    [applySelection],
  );
  const onToggleBlock = useCallback(
    (block: number, side: "ours" | "theirs") => {
      const cur = selectionsRef.current;
      const all = cur[block]?.[side].every(Boolean) ?? false;
      const next = cur.map((s, i) =>
        i === block ? { ...s, [side]: s[side].map(() => !all) } : s,
      );
      applySelection(next, block);
    },
    [applySelection],
  );

  const onDirty = useCallback(() => {
    setDirty(true);
    // Editing invalidates a pending "stage anyway?" count and the
    // "already staged" guidance.
    setConfirmUnresolved(null);
    setStagedNotice(false);
  }, []);

  // Header checkbox: select/clear one side across ALL blocks (per-line and
  // per-block toggles still refine afterwards; both sides may be selected).
  const onToggleSideAll = useCallback((side: "ours" | "theirs") => {
    const cur = selectionsRef.current;
    const flags = cur.flatMap((s) => s[side]);
    const all = flags.length > 0 && flags.every(Boolean);
    const next = cur.map((s) => ({ ...s, [side]: s[side].map(() => !all) }));
    selectionsRef.current = next;
    setSelections(next);
    for (let i = 0; i < next.length; i++) viewRef.current?.applyBlock(i);
  }, []);

  const onTakeSide = useCallback(
    async (side: ConflictSide) => {
      const req = requestRef.current;
      if (!req) return;
      try {
        await repoResolveTakeSide(req.repoId, req.path, side);
        // The whole-file choice supersedes any in-editor result.
        setDirty(false);
        setStagedNotice(true);
        setRebuildKey((k) => k + 1);
        invalidateRepoDomains(queryClient, req.repoId, ["status", "log", "diff", "op_state"]);
        await notifyResolutionInvisible(req.repoId, req.path);
      } catch (e) {
        notify.error(formatAppError(e));
      }
    },
    [queryClient],
  );

  // The single confirming action: write the result document to the file and
  // stage it as resolved. There is no intermediate Save - the result lives
  // in the editor until the merge for this file is confirmed here.
  const doMarkResolved = useCallback(async () => {
    if (savingRef.current) return;
    const req = requestRef.current;
    if (!req) return;
    savingRef.current = true;
    try {
      const parsedNow = parsedRef.current;
      let text = viewRef.current?.getText();
      if (text != null && parsedNow) {
        // The view guarantees a trailing newline; restore the file's own
        // convention and EOL before writing.
        if (!parsedNow.trailingNewline && text.endsWith("\n")) text = text.slice(0, -1);
        await repoWriteWorktreeFile(req.repoId, req.path, applyEol(text, parsedNow.eol));
      }
      await repoStage(req.repoId, [req.path]);
      setDirty(false);
      setStagedNotice(true);
      setRebuildKey((k) => k + 1);
      invalidateRepoDomains(queryClient, req.repoId, ["status", "log", "diff", "op_state"]);
      await notifyResolutionInvisible(req.repoId, req.path);
    } catch (e) {
      notify.error(formatAppError(e));
    } finally {
      savingRef.current = false;
    }
  }, [queryClient]);

  // Guard: staging a result that still parses to conflict blocks is almost
  // always a mistake - inline confirm instead of a hard block (markers can be
  // intentional, and detection is heuristic). Gates on the re-parsed editor
  // text, never the selection counter: resolving a block by deleting both
  // sides is valid but counts as "unaddressed" there.
  const onMarkResolved = useCallback(() => {
    const text = viewRef.current?.getText();
    const remaining = text != null ? parseConflicts(text).conflictCount : 0;
    if (remaining > 0) {
      setConfirmUnresolved(remaining);
      return;
    }
    void doMarkResolved();
  }, [doMarkResolved]);
  // Stale per-file state must not survive a file switch (edits clear these
  // in onDirty).
  useEffect(() => {
    setConfirmUnresolved(null);
    setStagedNotice(false);
  }, [request]);

  // Discard the in-progress result and rebuild from the file on disk.
  const reloadFromDisk = useCallback(() => {
    setDirty(false);
    setConfirmUnresolved(null);
    setDismissedDisk(null);
  }, []);

  const conflictCount = parsed?.conflictCount ?? 0;
  const resolvedCount = selections.filter(
    (s) => s.ours.some(Boolean) || s.theirs.some(Boolean),
  ).length;

  const goToBlock = useCallback(
    (delta: number) => {
      if (conflictCount === 0) return;
      setNavIndex((i) => {
        const next = (i + delta + conflictCount) % conflictCount;
        viewRef.current?.scrollToBlock(next);
        return next;
      });
    },
    [conflictCount],
  );

  const syntaxHighlighting = useSettingsStore(
    (s) => s.settings?.diff_syntax_highlighting ?? false,
  );
  const syntaxPath = syntaxHighlighting && request ? request.path : null;

  if (!request) {
    return (
      <div className="legit-panel">
        <div className="legit-panel__body">
          <span className="legit-subtle">
            Select a conflicted file in Working Changes to resolve it here.
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="legit-panel" style={{ display: "flex", flexDirection: "column" }}>
      <PanelLoadingBar active={isFetching} />
      <div
        className="legit-panel__toolbar"
        style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}
      >
        <div style={{ display: "flex", flexShrink: 0 }}>
          <button
            onClick={() => chooseViewMode("conflicts")}
            aria-pressed={viewMode === "conflicts"}
            title="Fold the unchanged stretches between conflicts"
            style={segStyle(viewMode === "conflicts", "left")}
          >
            Chunks
          </button>
          <button
            onClick={() => chooseViewMode("full")}
            aria-pressed={viewMode === "full"}
            title="Show the whole files"
            style={segStyle(viewMode === "full", "right")}
          >
            Full file
          </button>
        </div>
        <span
          className="legit-subtle"
          style={{
            fontSize: "var(--fz-sm)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            minWidth: 0,
          }}
          title={request.path}
        >
          {request.path}
        </span>
        <LineEndingBadge repoId={request.repoId} path={request.path} rev={null} oldRev={":"} />
        <span className="legit-subtle" style={{ fontSize: "var(--fz-sm)", flexShrink: 0 }}>
          {conflictCount > 0
            ? `${resolvedCount}/${conflictCount} conflict${conflictCount === 1 ? "" : "s"} addressed`
            : "no conflict markers"}
        </span>
        {conflictCount > 1 && (
          <span style={{ display: "flex", gap: 2, flexShrink: 0 }}>
            <ToolbarButton label="↑" title="Previous conflict" onClick={() => goToBlock(-1)} />
            <ToolbarButton label="↓" title="Next conflict" onClick={() => goToBlock(1)} />
          </span>
        )}
        <span style={{ display: "flex", gap: 4, marginLeft: "auto", flexShrink: 0 }}>
          <ToolbarButton
            label="Mark resolved"
            title={
              resolvedCount < conflictCount
                ? "Write the result and stage it (conflict markers may remain!) - Ctrl+S"
                : "Write the result and stage the file as resolved (Ctrl+S)"
            }
            onClick={onMarkResolved}
          />
        </span>
      </div>

      {confirmUnresolved !== null && (
        <div
          className="legit-panel__toolbar"
          style={{ display: "flex", alignItems: "center", gap: 8 }}
        >
          <span className="legit-subtle" style={{ fontSize: "var(--fz-sm)" }}>
            {confirmUnresolved} conflict{confirmUnresolved === 1 ? "" : "s"} still unresolved -
            stage anyway?
          </span>
          <ToolbarButton
            label="Stage anyway"
            onClick={() => {
              setConfirmUnresolved(null);
              void doMarkResolved();
            }}
          />
          <ToolbarButton label="Cancel" onClick={() => setConfirmUnresolved(null)} />
        </div>
      )}

      {pending !== null && (
        <div
          className="legit-panel__toolbar"
          style={{ display: "flex", alignItems: "center", gap: 8 }}
        >
          <span className="legit-subtle" style={{ fontSize: "var(--fz-sm)" }}>
            Unsaved result for {request.path} will be lost.
          </span>
          <ToolbarButton
            label="Switch anyway"
            onClick={() => {
              setDirty(false);
              setRequest(pending);
              setPending(null);
            }}
          />
          <ToolbarButton label="Stay" onClick={() => setPending(null)} />
        </div>
      )}

      {externalChange && (
        <div
          className="legit-panel__toolbar"
          style={{ display: "flex", alignItems: "center", gap: 8 }}
        >
          <span className="legit-subtle" style={{ fontSize: "var(--fz-sm)" }}>
            The file changed on disk - reload it? The current result will be lost.
          </span>
          <ToolbarButton label="Reload" onClick={reloadFromDisk} />
          <ToolbarButton
            label="Keep editing"
            onClick={() => setDismissedDisk(diskContent ?? null)}
          />
        </div>
      )}

      {isReadError ? (
        // Not renderable as text (binary): whole-file take is the only
        // resolution here - the one place the take buttons remain.
        <div
          className="legit-panel__body"
          style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-start" }}
        >
          <span className="legit-subtle">
            This conflicted file cannot be shown as text. Resolve it by taking one side:
          </span>
          <span style={{ display: "flex", gap: 4 }}>
            <ToolbarButton
              label={`Take ${sideLabel("current", sideNames?.ours ?? null)}`}
              title="Resolve the whole file with the current side"
              onClick={() => onTakeSide("ours")}
            />
            <ToolbarButton
              label={`Take ${sideLabel("incoming", sideNames?.theirs ?? null)}`}
              title="Resolve the whole file with the incoming side"
              onClick={() => onTakeSide("theirs")}
            />
          </span>
        </div>
      ) : parsed && conflictCount === 0 ? (
        <div className="legit-panel__body">
          <span className="legit-subtle">
            {stagedNotice
              ? "Resolved and staged. Reopen the conflict from the file's context menu in Working Changes if needed."
              : "No conflict markers left in this file. Use Mark resolved to stage it."}
          </span>
        </div>
      ) : parsed && content != null && sides ? (
        <MergeView
          ref={viewRef}
          ours={sides.ours}
          theirs={sides.theirs}
          sideNames={sideNames}
          content={content}
          parsed={parsed}
          selectionsRef={selectionsRef}
          onToggleLine={onToggleLine}
          onToggleBlock={onToggleBlock}
          onToggleSideAll={onToggleSideAll}
          onDirty={onDirty}
          onSaveRequest={onMarkResolved}
          rebuildKey={rebuildKey}
          foldCommon={viewMode === "conflicts"}
          syntaxPath={syntaxPath}
        />
      ) : null}
    </div>
  );
}
