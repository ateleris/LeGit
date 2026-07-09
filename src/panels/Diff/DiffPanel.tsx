import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRepoStore } from "../../store/repos";
import { useSettingsStore } from "../../store/settings";
import { useSummonTarget } from "../../store/summon";
import {
  repoDiff,
  repoDiscardHunk,
  repoDiscardLines,
  repoReadWorktreeFile,
  repoStage,
  repoStageHunk,
  repoStageLines,
  repoUnstageHunk,
  repoUnstageLines,
  repoWriteWorktreeFile,
} from "../../lib/commands";
import type { DiffEntry, DiffRequest, DiffSource } from "../../lib/types";
import { LineEndingBadge } from "../shared/LineEndingBadge";
import { SubmoduleDiffView, SubmoduleDirtyNotice } from "./SubmoduleDiffView";
import { formatAppError } from "../../lib/types";
import { invalidateRepoDomains } from "../../lib/repoInvalidation";
import { notify } from "../../store/notifications";
import { PanelLoadingBar } from "../shared/PanelLoadingBar";
import { ToolbarButton } from "../shared/ToolbarButton";
import {
  PanelContextMenuProvider,
  usePanelContextMenu,
  type BaselineEntry,
} from "../Commits/menu/PanelContextMenu";
import { MenuItem, Separator } from "../Commits/menu/primitives";
import {
  DiffEditor,
  type DiffEditorHandle,
  type DiffViewMode,
  type HunkAction,
  type LineActionOp,
} from "./DiffEditor";
import { spliceEdits } from "./editModel";

const ACTION_TITLE: Record<HunkAction, string> = {
  stage: "Stage chunk",
  unstage: "Unstage chunk",
  discard: "Discard chunk",
};

const LINE_LABEL: Record<HunkAction, string> = {
  stage: "Stage line",
  unstage: "Unstage line",
  discard: "Discard line",
};

type ContextMode = "chunked" | "full";

// View-mode preferences are remembered client-side across panel re-opens.
const MODE_KEY = "legit.diff.viewMode";
const CONTEXT_KEY = "legit.diff.contextMode";
const FULL_FILE_CONTEXT = 100_000;
const CHUNKED_CONTEXT = 3;

function loadPref<T extends string>(key: string, fallback: T): T {
  const v = typeof localStorage !== "undefined" ? localStorage.getItem(key) : null;
  return (v as T) ?? fallback;
}

/** Per-hunk actions offered for a given diff source. Commit diffs are read-only. */
/**
 * The two sides to check line endings for, per diff source. `rev`: null =
 * working tree, ":" = index, else a rev spec. The badge shows the new side,
 * or "old→new" when they differ.
 */
function lineEndingSides(source: DiffSource): { rev: string | null; oldRev: string | null } {
  switch (source.kind) {
    case "working_unstaged":
      return { rev: null, oldRev: ":" }; // working tree vs index
    case "working_staged":
      return { rev: ":", oldRev: "HEAD" }; // index vs HEAD
    case "commit":
      return { rev: source.commit_id, oldRev: `${source.commit_id}^` }; // commit vs first parent
    case "commit_range":
      return { rev: source.to, oldRev: source.from };
  }
}

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
  const [request, setRequest] = useState<DiffRequest | null>(null);
  const [mode, setMode] = useState<DiffViewMode>(() => loadPref(MODE_KEY, "inline"));
  const [contextMode, setContextMode] = useState<ContextMode>(() =>
    loadPref(CONTEXT_KEY, "chunked")
  );
  const [dirty, setDirty] = useState(false);
  // Forces an editor rebuild after save/discard even when the refetched diff
  // is byte-identical (React Query then keeps the same object, so nothing
  // else in the mount dependencies changes).
  const [rebuildKey, setRebuildKey] = useState(0);
  // A summoned file switch waiting on the user while edits are unsaved; the
  // inner req may itself be null ("clear the panel"), hence the wrapper.
  const [pending, setPending] = useState<{ req: DiffRequest | null } | null>(null);
  const editorRef = useRef<DiffEditorHandle | null>(null);
  const savingRef = useRef(false);
  // Mirrors so save/receive callbacks keep a stable identity (recreating the
  // editor mid-edit would discard the user's unsaved changes).
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const requestRef = useRef(request);
  requestRef.current = request;
  const dataRef = useRef<DiffEntry | undefined>(undefined);

  // A null payload means "no file selected" — reset to the placeholder. While
  // dirty, a switch to a different file must be confirmed, not silent.
  const onReceive = useCallback((payload: DiffRequest | null) => {
    if (dirtyRef.current && !sameTarget(payload, requestRef.current)) {
      setPending({ req: payload });
      return;
    }
    setRequest(payload);
  }, []);
  useSummonTarget<DiffRequest | null>("diff", onReceive);

  // Drop a diff that belongs to a repository the user has switched away from —
  // its content (and any stage/unstage actions) no longer apply. Unsaved edits
  // are dropped too: they belong to the other repo's file, which is untouched
  // on disk.
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
      repoDiff(request!.repoId, request!.source, request!.path, request!.oldPath ?? null, context),
    // Only diff the ACTIVE repo: a request left over from the previous repo must
    // never query (its path doesn't exist in the new repo). The effect above
    // also clears it; this guards the render before that runs. While dirty,
    // refetches are deferred entirely: a refetch rebuilds the editor and would
    // silently discard the user's unsaved edits (React Query keeps the cached
    // data, and pending invalidations run when re-enabled after save/discard).
    enabled: !!request && request.repoId === activeRepoId && !dirty,
    staleTime: 5_000,
  });
  dataRef.current = data;

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
        if (action === "stage") await repoStageHunk(repoId, path, hunkIndex);
        else if (action === "unstage") await repoUnstageHunk(repoId, path, hunkIndex);
        else await repoDiscardHunk(repoId, path, hunkIndex);
        // Refresh the working-tree views and this diff so the new state shows.
        invalidateRepoDomains(queryClient, repoId, ["status", "log", "diff"]);
      } catch (e) {
        notify.error(formatAppError(e));
      }
    },
    [request, queryClient]
  );

  // Per-line stage/unstage/discard (hover affordance + context menu).
  const onLineAction = useCallback(
    async (hunkIndex: number, lineIndex: number, action: HunkAction) => {
      if (!request) return;
      if (dirtyRef.current) {
        notify.error("Unsaved edits in the diff. Save or discard them first.");
        return;
      }
      const { repoId, path } = request;
      const lines = [lineIndex];
      try {
        if (action === "stage") await repoStageLines(repoId, path, hunkIndex, lines);
        else if (action === "unstage") await repoUnstageLines(repoId, path, hunkIndex, lines);
        else await repoDiscardLines(repoId, path, hunkIndex, lines);
        invalidateRepoDomains(queryClient, repoId, ["status", "log", "diff"]);
      } catch (e) {
        notify.error(formatAppError(e));
      }
    },
    [request, queryClient]
  );

  // Write the edited document back to the file: read the on-disk baseline
  // and splice each hunk's new-side text into it.
  const onSave = useCallback(async () => {
    if (savingRef.current) return;
    const req = requestRef.current;
    const entry = dataRef.current;
    const texts = editorRef.current?.collectHunkTexts();
    if (!req || !entry || !("Text" in entry) || !texts) return;
    savingRef.current = true;
    try {
      const original = await repoReadWorktreeFile(req.repoId, req.path);
      const next = spliceEdits(
        original,
        entry.Text.hunks.map((h) => ({ newStart: h.new_start, newLines: h.new_lines })),
        texts
      );
      await repoWriteWorktreeFile(req.repoId, req.path, next);
      setDirty(false);
      setRebuildKey((k) => k + 1);
      invalidateRepoDomains(queryClient, req.repoId, ["status", "log", "diff"]);
    } catch (e) {
      notify.error(formatAppError(e));
    } finally {
      savingRef.current = false;
    }
  }, [queryClient]);

  const onDiscardEdits = useCallback(() => {
    setDirty(false);
    // The file on disk never changed, so the refetched diff is identical —
    // the rebuild key is what actually resets the editor's document.
    setRebuildKey((k) => k + 1);
    const req = requestRef.current;
    // Still invalidate: the query was disabled while dirty and may have
    // missed watcher events.
    if (req) invalidateRepoDomains(queryClient, req.repoId, ["diff"]);
  }, [queryClient]);

  const onDirty = useCallback(() => setDirty(true), []);

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
        style={{ display: "flex", alignItems: "center", gap: 8 }}
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
          const s = lineEndingSides(request.source);
          return <LineEndingBadge repoId={request.repoId} path={request.path} rev={s.rev} oldRev={s.oldRev} />;
        })()}
        {dirty && (
          <span style={{ display: "flex", gap: 4, marginLeft: "auto" }}>
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
          style={{ display: "flex", alignItems: "center", gap: 8 }}
        >
          <span className="legit-subtle" style={{ fontSize: "var(--fz-sm)" }}>
            Unsaved edits in {request.path} will be lost.
          </span>
          <ToolbarButton
            label="Discard edits & switch"
            onClick={() => {
              setDirty(false);
              setRequest(pending.req);
              setPending(null);
            }}
          />
          <ToolbarButton label="Keep editing" onClick={() => setPending(null)} />
        </div>
      )}

      {isError && (
        <pre className="legit-error" style={{ margin: "8px 12px", fontSize: "var(--fz-md)" }}>
          {formatAppError(error)}
        </pre>
      )}

      <div style={{ flex: 1, minHeight: 0 }}>
        <DiffBody
            data={data}
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

function DiffBody({
  data,
  mode,
  actions,
  onAction,
  request,
  lineActionOp,
  onLineAction,
  editable,
  dirty,
  onDirty,
  onSaveRequest,
  editorRef,
  rebuildKey,
  syntaxPath,
}: {
  data: DiffEntry | undefined;
  mode: DiffViewMode;
  actions: HunkAction[];
  onAction: (hunkIndex: number, action: HunkAction) => void;
  request: DiffRequest;
  lineActionOp: LineActionOp;
  onLineAction: (hunkIndex: number, lineIndex: number, action: HunkAction) => void;
  editable: boolean;
  dirty: boolean;
  onDirty: () => void;
  onSaveRequest: () => void;
  editorRef: React.MutableRefObject<DiffEditorHandle | null>;
  rebuildKey: number;
  syntaxPath: string | null;
}) {
  const { openMenu, closeMenu } = usePanelContextMenu();
  const onContextMenu = useCallback(
    (hunkIndex: number, lineIndex: number | null, event: MouseEvent) => {
      const section = (
        <>
          {/* Line actions — only when a changed line was clicked. */}
          {lineIndex != null &&
            actions.map((a) => (
              <MenuItem
                key={`line-${a}`}
                onClick={() => {
                  onLineAction(hunkIndex, lineIndex, a);
                  closeMenu();
                }}
              >
                {LINE_LABEL[a]}
              </MenuItem>
            ))}
          {lineIndex != null && <Separator />}
          {actions.map((a) => (
            <MenuItem
              key={a}
              onClick={() => {
                onAction(hunkIndex, a);
                closeMenu();
              }}
            >
              {ACTION_TITLE[a]}
            </MenuItem>
          ))}
        </>
      );
      openMenu(event as unknown as React.MouseEvent, section);
    },
    [actions, onAction, onLineAction, openMenu, closeMenu]
  );

  // A dirty-inside submodule has no superproject diff (unmoved pointer, and
  // untracked-only dirt yields empty diff output) - render the explanatory
  // notice from the known state instead of whatever the diff text parsed to.
  if (request.change === "SubmoduleDirty") {
    return <SubmoduleDirtyNotice repoId={request.repoId} path={request.path} />;
  }

  if (!data) return null;

  if ("Binary" in data) {
    return (
      <div className="legit-panel__body">
        <span className="legit-subtle">Binary file — no text diff to show.</span>
      </div>
    );
  }
  if ("Submodule" in data) {
    return <SubmoduleDiffView repoId={request.repoId} change={data.Submodule} />;
  }

  const text = data.Text;
  if (text.hunks.length === 0) {
    // A rename/copy with no content change has no hunks — say so explicitly
    // rather than the bare "No changes".
    const isRename = request.change === "Renamed" || request.change === "Copied";
    return (
      <div className="legit-panel__body">
        <span className="legit-subtle">
          {isRename
            ? `Renamed${request.oldPath ? ` from ${request.oldPath}` : ""} → ${request.path} (no content changes)`
            : "No changes."}
        </span>
      </div>
    );
  }

  // Identity of the shown file/source: scroll is preserved across content
  // refetches (e.g. after staging) but reset when this changes.
  const scrollResetKey = `${request.repoId}|${request.path}|${request.source.kind}|${
    request.source.kind === "commit" ? request.source.commit_id : ""
  }`;

  return (
    <DiffEditor
      ref={editorRef}
      diff={text}
      mode={mode}
      actions={actions}
      onAction={onAction}
      onContextMenu={onContextMenu}
      lineActionOp={lineActionOp}
      onLineAction={onLineAction}
      scrollResetKey={scrollResetKey}
      editable={editable}
      dirty={dirty}
      onDirty={onDirty}
      onSaveRequest={onSaveRequest}
      rebuildKey={rebuildKey}
      syntaxPath={syntaxPath}
    />
  );
}

function segStyle(active: boolean, side: "left" | "right"): React.CSSProperties {
  return {
    fontSize: "var(--fz-sm)",
    padding: "2px 8px",
    border: "1px solid var(--panel-border)",
    borderRadius: side === "left" ? "3px 0 0 3px" : "0 3px 3px 0",
    marginLeft: side === "right" ? -1 : 0,
    background: active ? "var(--button-active-bg, rgba(255,255,255,0.12))" : "transparent",
    color: "var(--panel-fg)",
    cursor: "pointer",
  };
}
