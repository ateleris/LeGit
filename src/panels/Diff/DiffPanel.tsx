import { useCallback, useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRepoStore } from "../../store/repos";
import { useSummonTarget } from "../../store/summon";
import {
  repoDiff,
  repoDiscardHunk,
  repoStageHunk,
  repoUnstageHunk,
} from "../../lib/commands";
import type { DiffEntry, DiffRequest } from "../../lib/types";
import { formatAppError } from "../../lib/types";
import { invalidateRepoDomains } from "../../lib/repoInvalidation";
import { PanelLoadingBar } from "../shared/PanelLoadingBar";
import {
  PanelContextMenuProvider,
  usePanelContextMenu,
  type BaselineEntry,
} from "../Commits/menu/PanelContextMenu";
import { MenuItem } from "../Commits/menu/primitives";
import { DiffEditor, type DiffViewMode, type HunkAction } from "./DiffEditor";

const ACTION_TITLE: Record<HunkAction, string> = {
  stage: "Stage chunk",
  unstage: "Unstage chunk",
  discard: "Discard chunk",
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

/**
 * Diff panel — renders the diff for a single file received via the summon
 * mechanism (from Working Changes or Changed Files). Working-tree diffs expose
 * per-hunk stage/unstage/discard; commit diffs are read-only.
 */
export function DiffPanel() {
  const queryClient = useQueryClient();
  const [request, setRequest] = useState<DiffRequest | null>(null);
  const [mode, setMode] = useState<DiffViewMode>(() => loadPref(MODE_KEY, "inline"));
  const [contextMode, setContextMode] = useState<ContextMode>(() =>
    loadPref(CONTEXT_KEY, "chunked")
  );
  const [actionError, setActionError] = useState<string | null>(null);

  // A null payload means "no file selected" — reset to the placeholder.
  const onReceive = useCallback((payload: DiffRequest | null) => {
    setRequest(payload);
    setActionError(null);
  }, []);
  useSummonTarget<DiffRequest | null>("diff", onReceive);

  // Drop a diff that belongs to a repository the user has switched away from —
  // its content (and any stage/unstage actions) no longer apply.
  const activeRepoId = useRepoStore((s) => s.activeRepoId);
  useEffect(() => {
    setRequest((req) => (req && req.repoId !== activeRepoId ? null : req));
    setActionError(null);
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
    enabled: !!request,
    staleTime: 5_000,
  });

  const actions = actionsForSource(request);

  const onAction = useCallback(
    async (hunkIndex: number, action: HunkAction) => {
      if (!request) return;
      setActionError(null);
      try {
        if (action === "stage") {
          await repoStageHunk(request.repoId, request.path, hunkIndex);
        } else if (action === "unstage") {
          await repoUnstageHunk(request.repoId, request.path, hunkIndex);
        } else {
          await repoDiscardHunk(request.repoId, request.path, hunkIndex);
        }
        // Refresh the working-tree views and this diff so the hunk's new state
        // is reflected immediately.
        invalidateRepoDomains(queryClient, request.repoId, ["status", "log", "diff"]);
      } catch (e) {
        setActionError(formatAppError(e));
      }
    },
    [request, queryClient]
  );

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
      </div>

      {(isError || actionError) && (
        <pre className="legit-error" style={{ margin: "8px 12px", fontSize: "var(--fz-md)" }}>
          {actionError ?? formatAppError(error)}
        </pre>
      )}

      <div style={{ flex: 1, minHeight: 0 }}>
        <DiffBody data={data} mode={mode} actions={actions} onAction={onAction} request={request} />
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
}: {
  data: DiffEntry | undefined;
  mode: DiffViewMode;
  actions: HunkAction[];
  onAction: (hunkIndex: number, action: HunkAction) => void;
  request: DiffRequest;
}) {
  const { openMenu, closeMenu } = usePanelContextMenu();
  const onHunkContextMenu = useCallback(
    (hunkIndex: number, event: MouseEvent) => {
      const section = (
        <>
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
    [actions, onAction, openMenu, closeMenu]
  );

  if (!data) return null;

  if ("Binary" in data) {
    return (
      <div className="legit-panel__body">
        <span className="legit-subtle">Binary file — no text diff to show.</span>
      </div>
    );
  }
  if ("Submodule" in data) {
    return (
      <div className="legit-panel__body">
        <span className="legit-subtle">Submodule change.</span>
      </div>
    );
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

  return (
    <DiffEditor
      diff={text}
      mode={mode}
      actions={actions}
      onAction={onAction}
      onHunkContextMenu={onHunkContextMenu}
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
