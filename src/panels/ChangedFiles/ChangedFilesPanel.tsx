import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useActiveRepo } from "../../store/repos";
import { useSettingsStore } from "../../store/settings";
import { useSummonStore, useSummonTarget } from "../../store/summon";
import { usePanelFocusEffect } from "../PanelApiContext";
import { repoCommitDetails, repoCommitFiles } from "../../lib/commands";
import type { CommitDetails, CommitFileChange, CommitId } from "../../lib/types";
import { formatAppError } from "../../lib/types";
import { FileTree } from "../shared/FileTree/FileTree";
import type { ViewMode } from "../shared/FileTree/buildTree";

/**
 * Changed Files panel — receives a CommitId via the summon mechanism and shows
 * the files that commit changed (vs its first parent) as a tree or flat list.
 * Clicking a file summons the (future) Diff panel.
 */
export function ChangedFilesPanel() {
  const repo = useActiveRepo();
  const [selectedId, setSelectedId] = useState<CommitId | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  // View mode is persisted in global settings so it's remembered across panel
  // re-opens and restarts. Defaults to flat until the user first toggles it.
  const viewMode: ViewMode =
    useSettingsStore((s) => s.settings?.changed_files_view_mode) === "tree" ? "tree" : "flat";
  const setViewMode = useSettingsStore((s) => s.setChangedFilesViewMode);

  useEffect(() => {
    setSelectedId(null);
    setSelectedPath(null);
  }, [repo?.id]);

  const onReceive = useCallback((id: unknown) => {
    if (typeof id === "string") {
      setSelectedId(id as CommitId);
      setSelectedPath(null);
    }
  }, []);
  useSummonTarget("changed-files", onReceive);

  const {
    data: files = [],
    isFetching,
    isError,
    error,
    refetch,
  } = useQuery<CommitFileChange[]>({
    queryKey: [repo?.id, "commit-files", selectedId],
    queryFn: () => repoCommitFiles(repo!.id, selectedId!),
    enabled: !!repo && !!selectedId,
    staleTime: 60_000,
  });

  // Shares React Query's cache with CommitDetailsPanel (identical key), so this
  // is free when that panel is also open — used only for the subject heading.
  const { data: details } = useQuery<CommitDetails>({
    queryKey: [repo?.id, "commit-details", selectedId],
    queryFn: () => repoCommitDetails(repo!.id, selectedId!),
    enabled: !!repo && !!selectedId,
    staleTime: 60_000,
  });

  usePanelFocusEffect(useCallback(() => { refetch(); }, [refetch]));

  const totals = useMemo(() => {
    let add = 0;
    let del = 0;
    for (const f of files) {
      add += f.additions;
      del += f.deletions;
    }
    return { add, del };
  }, [files]);

  const handleSelect = useCallback(
    (file: CommitFileChange) => {
      setSelectedPath(file.path);
      if (!repo || !selectedId) return;
      // No-op until the Diff panel exists ("diff" isn't a registered panel yet).
      useSummonStore.getState().summon("diff", {
        repoId: repo.id,
        commitId: selectedId,
        path: file.path,
        oldPath: file.old_path,
      });
    },
    [repo, selectedId],
  );

  if (!repo || !selectedId) {
    return (
      <div className="legit-panel">
        <div className="legit-panel__body">
          <span className="legit-subtle">Select a commit in Log to see its changed files.</span>
        </div>
      </div>
    );
  }

  const subject = details?.commit.message.split("\n")[0];

  return (
    <div className="legit-panel" style={{ display: "flex", flexDirection: "column" }}>
      <div className="legit-panel__toolbar" style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ display: "flex" }}>
          <button onClick={() => setViewMode("tree")} aria-pressed={viewMode === "tree"} style={segStyle(viewMode === "tree", "left")}>
            Tree
          </button>
          <button onClick={() => setViewMode("flat")} aria-pressed={viewMode === "flat"} style={segStyle(viewMode === "flat", "right")}>
            List
          </button>
        </div>
        <span
          className="legit-subtle"
          style={{ fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}
        >
          {files.length} file{files.length === 1 ? "" : "s"}
          {totals.add > 0 && (
            <> · <span style={{ color: "var(--status-added)" }}>+{totals.add}</span></>
          )}
          {totals.del > 0 && (
            <> <span style={{ color: "var(--status-deleted)" }}>−{totals.del}</span></>
          )}
          {subject && <> · {subject}</>}
          {" · "}
          <code>{selectedId.slice(0, 8)}</code>
        </span>
        {isFetching && (
          <span className="legit-subtle" style={{ fontSize: 11, marginLeft: "auto" }}>
            Loading…
          </span>
        )}
      </div>

      {isError && (
        <pre className="legit-error" style={{ margin: "8px 12px", fontSize: 12 }}>
          {formatAppError(error)}
        </pre>
      )}

      {!isError && files.length === 0 && !isFetching && (
        <div className="legit-panel__body">
          <span className="legit-subtle">No file changes.</span>
        </div>
      )}

      {files.length > 0 && (
        <FileTree files={files} viewMode={viewMode} selectedPath={selectedPath} onSelect={handleSelect} />
      )}
    </div>
  );
}

function segStyle(active: boolean, side: "left" | "right"): React.CSSProperties {
  return {
    fontSize: 11,
    padding: "2px 8px",
    border: "1px solid var(--panel-border)",
    borderRadius: side === "left" ? "3px 0 0 3px" : "0 3px 3px 0",
    marginLeft: side === "right" ? -1 : 0,
    background: active ? "var(--button-active-bg, rgba(255,255,255,0.12))" : "transparent",
    color: "var(--panel-fg)",
    cursor: "pointer",
  };
}
