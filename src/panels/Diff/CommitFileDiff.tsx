// Read-only diff of one file in one commit - the history window's right pane.
// Shares the rendering body and view prefs (inline/split, chunks/full) with
// the Diff panel, so diff-viewer improvements reach both.

import { useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/commands";
import type { DiffEntry, DiffRequest, FileHistoryEntry } from "../../lib/types";
import { STALE } from "../../lib/queryTiming";
import { useSettingsStore } from "../../store/settings";
import { segStyle } from "../shared/segmented";
import { PanelError } from "../shared/PanelError";
import { PanelLoadingBar } from "../shared/PanelLoadingBar";
import { PanelContextMenuProvider } from "../shared/menu/PanelContextMenu";
import { DiffBody } from "./DiffBody";
import { type DiffEditorHandle, type DiffViewMode } from "./DiffEditor";
import {
  CHUNKED_CONTEXT,
  CONTEXT_KEY,
  FULL_FILE_CONTEXT,
  MODE_KEY,
  loadPref,
  type ContextMode,
} from "./viewPrefs";

export function commitDiffRequest(repoId: string, entry: FileHistoryEntry): DiffRequest {
  return {
    repoId,
    path: entry.path,
    oldPath: entry.old_path,
    source: { kind: "commit", commit_id: entry.commit_id },
  };
}

const noop = () => {};

export function CommitFileDiff({ repoId, entry }: { repoId: string; entry: FileHistoryEntry }) {
  const request = useMemo(() => commitDiffRequest(repoId, entry), [repoId, entry]);
  const [mode, setMode] = useState<DiffViewMode>(() => loadPref(MODE_KEY, "inline"));
  const [contextMode, setContextMode] = useState<ContextMode>(() =>
    loadPref(CONTEXT_KEY, "chunked")
  );
  const context = contextMode === "full" ? FULL_FILE_CONTEXT : CHUNKED_CONTEXT;
  const editorRef = useRef<DiffEditorHandle | null>(null);
  const syntaxEnabled = useSettingsStore((s) => s.settings?.diff_syntax_highlighting ?? false);

  const { data, isFetching, isError, error } = useQuery<DiffEntry>({
    queryKey: [repoId, "diff", request.source, request.path, request.oldPath, context],
    queryFn: () => api.repoDiff(repoId, request.source, request.path, request.oldPath ?? null, context),
    staleTime: STALE.live,
  });

  const chooseMode = (next: DiffViewMode) => {
    setMode(next);
    localStorage.setItem(MODE_KEY, next);
  };
  const chooseContext = (next: ContextMode) => {
    setContextMode(next);
    localStorage.setItem(CONTEXT_KEY, next);
  };

  return (
    <PanelContextMenuProvider baseline={[]}>
      <div className="legit-panel" style={{ display: "flex", flexDirection: "column", height: "100%" }}>
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
            {entry.commit_id.slice(0, 8)} · {request.path}
          </span>
        </div>

        {isError && <PanelError error={error} />}

        <div style={{ flex: 1, minHeight: 0 }}>
          <DiffBody
            data={data}
            mode={mode}
            actions={[]}
            onAction={noop}
            request={request}
            lineActionOp={null}
            onLineAction={noop}
            editable={false}
            dirty={false}
            onDirty={noop}
            onSaveRequest={noop}
            editorRef={editorRef}
            rebuildKey={0}
            syntaxPath={syntaxEnabled ? request.path : null}
          />
        </div>
      </div>
    </PanelContextMenuProvider>
  );
}
