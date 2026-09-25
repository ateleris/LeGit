import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PanelError } from "../shared/PanelError";
import { segStyle } from "../shared/segmented";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSettingsStore } from "../../store/settings";
import { useGuardedEditorRequest } from "../shared/useGuardedEditorRequest";
import { api } from "../../lib/commands";
import type { DiffEntry, DiffRequest ,
  TextDiff,
} from "../../lib/types";
import { diffSides } from "../../lib/diffSides";
import { LineEndingBadge, RevertableLineEndingBadge } from "../shared/LineEndingBadge";
import { formatAppError } from "../../lib/errors";
import { invalidateRepoDomains } from "../../lib/repoInvalidation";
import { notify } from "../../store/notifications";
import { PanelLoadingBar } from "../shared/PanelLoadingBar";
import { ToolbarButton } from "../shared/ToolbarButton";
import {
  PanelContextMenuProvider,
  type BaselineEntry,
} from "../shared/menu/PanelContextMenu";
import {
  type DiffEditorHandle,
  type DiffViewMode,
  type HunkAction,
  type LineActionOp,
} from "./DiffEditor";
import { spliceEdits, splitLines } from "./editModel";
import { expandDiff, type HunkExpansion } from "./expandModel";
import { EXPAND_STEP } from "../codemirror/hunkExpanders";
import { STALE } from "../../lib/queryTiming";
import { DiffBody } from "./DiffBody";
import {
  CHUNKED_CONTEXT,
  CONTEXT_KEY,
  FULL_FILE_CONTEXT,
  MODE_KEY,
  loadPref,
  type ContextMode,
} from "./viewPrefs";

/** Per-hunk actions offered for a given diff source. Commit diffs are read-only. */
function actionsForSource(req: DiffRequest | null): HunkAction[] {
  if (!req) return [];
  switch (req.source.kind) {
    case "working_unstaged":
      return ["stage", "discard"];
    case "working_staged":
      return ["unstage"];
    default:
      return [];
  }
}

/** Same file/source identity (a refetch of it must not count as a switch). */
function sameTarget(a: DiffRequest | null, b: DiffRequest | null): boolean {
  return !!a && !!b && a.repoId === b.repoId && a.path === b.path && a.source.kind === b.source.kind;
}

/**
 * Diff panel — renders the diff for a single file received via the summon
 * mechanism (from Working Changes or Changed Files). Working-tree diffs expose
 * per-hunk stage/unstage/discard; the unstaged diff is additionally editable
 * on its new side (explicit save writes back to the file); commit diffs are
 * read-only.
 */
export function DiffPanel() {
  const queryClient = useQueryClient();
  // The shown diff is per-repo view state: it survives a layout apply's dock
  // rebuild and the slot swap with Merge, and each repo keeps its own across
  // tab switches (the query below only ever runs for the active repo's
  // request). While the new side has unsaved edits, a summoned file switch
  // waits for the user.
  const {
    request,
    requestRef,
    dirty,
    dirtyRef,
    setDirty,
    pending,
    acceptPending,
    rejectPending,
    rebuildKey,
    rebuild,
    guardSave,
    activeRepoId,
  } = useGuardedEditorRequest<DiffRequest>({
    panelId: "diff",
    viewStateKey: "diff.request",
    sameTarget,
  });
  const [mode, setMode] = useState<DiffViewMode>(() => loadPref(MODE_KEY, "inline"));
  const [contextMode, setContextMode] = useState<ContextMode>(() =>
    loadPref(CONTEXT_KEY, "chunked")
  );
  const editorRef = useRef<DiffEditorHandle | null>(null);
  const dataRef = useRef<DiffEntry | undefined>(undefined);

  const context = contextMode === "full" ? FULL_FILE_CONTEXT : CHUNKED_CONTEXT;

  const {
    data,
    isFetching,
    isError,
    error,
  } = useQuery<DiffEntry>({
    // `oldPath` lets the backend pair a rename's two sides: a modified rename
    // returns real hunks; a pure rename returns an empty diff (→ rename notice).
    queryKey: [request?.repoId, "diff", request?.source, request?.path, request?.oldPath, context],
    queryFn: () =>
      api.repoDiff(request!.repoId, request!.source, request!.path, request!.oldPath ?? null, context),
    // Only diff the ACTIVE repo: the per-repo request key makes a mismatch
    // impossible after the switch renders, but this guards the render where
    // the store subscriptions have not caught up yet. While dirty,
    // refetches are deferred entirely: a refetch rebuilds the editor and would
    // silently discard the user's unsaved edits (React Query keeps the cached
    // data, and pending invalidations run when re-enabled after save/discard).
    enabled: !!request && request.repoId === activeRepoId && !dirty,
    staleTime: STALE.live,
  });
  // GitHub-style per-hunk context expansion (chunked view only; the full
  // view already shows everything). Keyed by hunk index of the CURRENT
  // data, so it resets whenever the underlying diff changes.
  const [expansions, setExpansions] = useState<Map<number, HunkExpansion>>(new Map());
  useEffect(() => {
    setExpansions(new Map());
  }, [data]);

  // The new side's full text supplies the real context lines. Where it
  // lives depends on the source: worktree, the index (`:0`), or a revision.
  const expandRev = useMemo(() => {
    switch (request?.source.kind) {
      case "working_unstaged":
        return { rev: null as string | null };
      case "working_staged":
        return { rev: ":0" };
      case "commit":
        return { rev: request.source.commit_id };
      case "commit_range":
        return { rev: request.source.to };
      default:
        return null;
    }
  }, [request?.source]);
  const { data: expandSource } = useQuery<string | null>({
    queryKey: [request?.repoId, "diff", "expand-src", request?.path, expandRev?.rev ?? "worktree"],
    queryFn: async () => {
      if (expandRev!.rev === null) return api.repoReadWorktreeFile(request!.repoId, request!.path);
      const f = await api.repoFileAtRevision(request!.repoId, expandRev!.rev, request!.path);
      return "Text" in f ? f.Text : null;
    },
    enabled:
      contextMode === "chunked" &&
      !!request &&
      !!expandRev &&
      !!data &&
      "Text" in data &&
      request.repoId === activeRepoId,
    staleTime: STALE.live,
  });

  // What the editor renders (and the save path splices against): the raw
  // diff, or the expanded one once the source text is available.
  const displayData = useMemo<DiffEntry | undefined>(() => {
    if (!data || !("Text" in data) || expansions.size === 0 || expandSource == null) return data;
    return { ...data, Text: expandDiff(data.Text, splitLines(expandSource), expansions) };
  }, [data, expansions, expandSource]);
  dataRef.current = displayData;

  const trailingExpander = useMemo(() => {
    if (contextMode !== "chunked" || !displayData || !("Text" in displayData)) return false;
    if (expandSource == null) return false;
    const hunks = displayData.Text.hunks;
    if (hunks.length === 0) return false;
    const last = hunks[hunks.length - 1];
    return splitLines(expandSource).length > last.new_start + last.new_lines - 1;
  }, [contextMode, displayData, expandSource]);

  const onExpandHunk = useCallback((hunkIndex: number, dir: "up" | "down") => {
    if (dirtyRef.current) {
      notify.error("Unsaved edits in the diff. Save or discard them first.");
      return;
    }
    setExpansions((prev) => {
      const next = new Map(prev);
      // GitHub semantics: a header's ↓ reveals the top of the gap above it
      // (extends the PREVIOUS hunk downward); ↑ reveals the gap's bottom
      // (extends THIS hunk upward). The first hunk's gap is bounded by the
      // file start (up only); the synthetic tail row (-1) extends the last
      // hunk downward.
      const lastRef = dataRef.current;
      const hunkCount = lastRef && "Text" in lastRef ? lastRef.Text.hunks.length : 0;
      let key: number;
      let effDir: "up" | "down";
      if (hunkIndex === -1) {
        key = hunkCount - 1;
        effDir = "down";
      } else if (dir === "down") {
        key = Math.max(hunkIndex - 1, 0);
        effDir = hunkIndex - 1 < 0 ? "up" : "down";
      } else {
        key = hunkIndex;
        effDir = "up";
      }
      if (key < 0) return prev;
      const cur = next.get(key) ?? { up: 0, down: 0 };
      next.set(key, { ...cur, [effDir]: cur[effDir] + EXPAND_STEP });
      return next;
    });
  }, []);

  // Editable only for the unstaged working diff: its new side IS the file on
  // disk. Staged diffs (new side = index) and commit diffs stay read-only.
  const editable = request?.source.kind === "working_unstaged";

  // Global opt-in for syntax highlighting; the path picks the language.
  const syntaxEnabled = useSettingsStore((s) => s.settings?.diff_syntax_highlighting ?? false);
  const syntaxPath = syntaxEnabled && request ? request.path : null;

  const actions = useMemo(() => actionsForSource(request), [request?.source.kind]);

  // The per-line hover affordance: stage a line in an unstaged diff, unstage one
  // in a staged diff, nothing for read-only commit diffs.
  const lineActionOp: LineActionOp = useMemo(() => {
    switch (request?.source.kind) {
      case "working_unstaged":
        return "stage";
      case "working_staged":
        return "unstage";
      default:
        return null;
    }
  }, [request?.source.kind]);

  // Whole-hunk stage/unstage/discard (header buttons + context menu).
  const onAction = useCallback(
    async (hunkIndex: number, action: HunkAction) => {
      if (!request) return;
      if (dirtyRef.current) {
        notify.error("Unsaved edits in the diff. Save or discard them first.");
        return;
      }
      const { repoId, path } = request;
      try {
        if (action === "stage") await api.repoStageHunk(repoId, path, hunkIndex);
        else if (action === "unstage") await api.repoUnstageHunk(repoId, path, hunkIndex);
        else await api.repoDiscardHunk(repoId, path, hunkIndex);
        // Refresh the working-tree views and this diff so the new state shows.
        invalidateRepoDomains(queryClient, repoId, ["status", "log", "diff"]);
      } catch (e) {
        notify.error(formatAppError(e));
      }
    },
    [request, queryClient]
  );

  // Line-level stage/unstage/discard: a single line from the hover
  // affordance, one or more (a selection) from the context menu. Lines always
  // belong to ONE hunk - `apply_lines` stages a subset of a single hunk.
  const onLineAction = useCallback(
    async (hunkIndex: number, lines: number[], action: HunkAction) => {
      if (!request) return;
      if (dirtyRef.current) {
        notify.error("Unsaved edits in the diff. Save or discard them first.");
        return;
      }
      const { repoId, path } = request;
      try {
        if (action === "stage") await api.repoStageLines(repoId, path, hunkIndex, lines);
        else if (action === "unstage") await api.repoUnstageLines(repoId, path, hunkIndex, lines);
        else await api.repoDiscardLines(repoId, path, hunkIndex, lines);
        invalidateRepoDomains(queryClient, repoId, ["status", "log", "diff"]);
      } catch (e) {
        notify.error(formatAppError(e));
      }
    },
    [request, queryClient]
  );

  // Write the edited document back to the file: read the on-disk baseline
  // and splice each hunk's new-side text into it.
  const onSave = useCallback(
    () =>
      guardSave(async () => {
        const req = requestRef.current;
        const entry = dataRef.current;
        const texts = editorRef.current?.collectHunkTexts();
        if (!req || !entry || !("Text" in entry) || !texts) return;
        try {
          const original = await api.repoReadWorktreeFile(req.repoId, req.path);
          const next = spliceEdits(
            original,
            entry.Text.hunks.map((h) => ({ newStart: h.new_start, newLines: h.new_lines })),
            texts
          );
          await api.repoWriteWorktreeFile(req.repoId, req.path, next);
          setDirty(false);
          rebuild();
          invalidateRepoDomains(queryClient, req.repoId, ["status", "log", "diff"]);
        } catch (e) {
          notify.error(formatAppError(e));
        }
      }),
    [guardSave, requestRef, setDirty, rebuild, queryClient],
  );

  const onDiscardEdits = useCallback(() => {
    setDirty(false);
    // The file on disk never changed, so the refetched diff is identical -
    // the rebuild key is what actually resets the editor's document.
    rebuild();
    const req = requestRef.current;
    // Still invalidate: the query was disabled while dirty and may have
    // missed watcher events.
    if (req) invalidateRepoDomains(queryClient, req.repoId, ["diff"]);
  }, [setDirty, rebuild, requestRef, queryClient]);

  const onDirty = useCallback(() => setDirty(true), [setDirty]);

  const chooseMode = (next: DiffViewMode) => {
    setMode(next);
    localStorage.setItem(MODE_KEY, next);
  };
  const chooseContext = (next: ContextMode) => {
    setContextMode(next);
    localStorage.setItem(CONTEXT_KEY, next);
  };

  if (!request) {
    return (
      <div className="legit-panel">
        <div className="legit-panel__body">
          <span className="legit-subtle">Select a file to see its diff.</span>
        </div>
      </div>
    );
  }

  const baseline: BaselineEntry[] = [
    {
      label: "Refresh",
      onClick: () => invalidateRepoDomains(queryClient, request.repoId, ["status", "log", "diff"]),
    },
  ];

  return (
    <PanelContextMenuProvider baseline={baseline}>
    <div className="legit-panel" style={{ display: "flex", flexDirection: "column" }}>
      <PanelLoadingBar active={isFetching} />
      <div
        className="legit-panel__toolbar"
        style={{ display: "flex", alignItems: "center", gap: "0.667em" }}
      >
        <div style={{ display: "flex" }}>
          <button onClick={() => chooseMode("inline")} aria-pressed={mode === "inline"} style={segStyle(mode === "inline", "left")}>
            Inline
          </button>
          <button onClick={() => chooseMode("split")} aria-pressed={mode === "split"} style={segStyle(mode === "split", "right")}>
            Split
          </button>
        </div>
        <div style={{ display: "flex" }}>
          <button onClick={() => chooseContext("chunked")} aria-pressed={contextMode === "chunked"} style={segStyle(contextMode === "chunked", "left")}>
            Chunks
          </button>
          <button onClick={() => chooseContext("full")} aria-pressed={contextMode === "full"} style={segStyle(contextMode === "full", "right")}>
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
        {(() => {
          const s = diffSides(request.source);
          // Only the unstaged diff offers the revert action — its new side is
          // the working tree, the one side we can rewrite safely.
          return request.source.kind === "working_unstaged" ? (
            <RevertableLineEndingBadge
              repoId={request.repoId}
              path={request.path}
              rev={s.rev}
              oldRev={s.oldRev}
              disabled={dirty}
            />
          ) : (
            <LineEndingBadge repoId={request.repoId} path={request.path} rev={s.rev} oldRev={s.oldRev} />
          );
        })()}
        {dirty && (
          <span style={{ display: "flex", gap: "0.333em", marginLeft: "auto" }}>
            <ToolbarButton
              label="Save"
              title="Write changes to the file (Ctrl+S)"
              onClick={onSave}
            />
            <ToolbarButton
              label="Discard edits"
              title="Reload the file, dropping your edits"
              onClick={onDiscardEdits}
            />
          </span>
        )}
      </div>

      {pending !== null && (
        <div
          className="legit-panel__toolbar"
          style={{ display: "flex", alignItems: "center", gap: "0.667em" }}
        >
          <span className="legit-subtle" style={{ fontSize: "var(--fz-sm)" }}>
            Unsaved edits in {request.path} will be lost.
          </span>
          <ToolbarButton label="Discard edits & switch" onClick={acceptPending} />
          <ToolbarButton label="Keep editing" onClick={rejectPending} />
        </div>
      )}

      {isError && (
        <PanelError error={error} />
      )}

      <div style={{ flex: 1, minHeight: 0 }}>
        <DiffBody
            data={displayData}
            onExpandHunk={contextMode === "chunked" ? onExpandHunk : undefined}
            trailingExpander={trailingExpander}
            mode={mode}
            actions={actions}
            onAction={onAction}
            request={request}
            lineActionOp={lineActionOp}
            onLineAction={onLineAction}
            editable={editable}
            dirty={dirty}
            onDirty={onDirty}
            onSaveRequest={onSave}
            editorRef={editorRef}
            rebuildKey={rebuildKey}
            syntaxPath={syntaxPath}
          />
      </div>
    </div>
    </PanelContextMenuProvider>
  );
}

