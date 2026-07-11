import { useCallback, useMemo, useState } from "react";
import { PanelError } from "../shared/PanelError";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FileCheck, FilePlus, FileX } from "lucide-react";
import type { ReactNode } from "react";
import { useActiveRepo } from "../../store/repos";
import { useConfirmDestructive } from "../../store/settings";
import { useSummonStore } from "../../store/summon";
import { usePanelFocusEffect } from "../PanelApiContext";
import {
  repoListFiles,
  repoAddToGitignore,
  repoUntrackPath,
  repoRevealPath,
} from "../../lib/commands";
import { invalidateRepoDomains } from "../../lib/repoInvalidation";
import { notify } from "../../store/notifications";
import type { RepoFileEntry, RepoFileKind } from "../../lib/types";
import { formatAppError } from "../../lib/types";
import { PanelLoadingBar } from "../shared/PanelLoadingBar";
import { FileTree } from "../shared/FileTree/FileTree";
import { useFileRowMetrics } from "../shared/FileTree/useFileRowMetrics";
import type { FileTreeEntry, ViewMode } from "../shared/FileTree/buildTree";
import { PanelContextMenuProvider, useMenuConfirm } from "../Commits/menu/PanelContextMenu";
import { MenuItem, SectionLabel } from "../Commits/menu/primitives";
import { CopyPathMenuSection } from "../shared/CopyPathMenuSection";
import { OpenInEditorMenuItem } from "../shared/OpenInEditorMenuItem";

/**
 * Files panel — the whole repository working tree as a browsable file list,
 * each file marked tracked / untracked / ignored. Lets you run History, Blame,
 * View, ignore/untrack, copy-path and reveal on any file, not just files in a
 * recent commit. Ignored files show only when the "Show ignored" toggle is on.
 */
export function FilesPanel() {
  const repo = useActiveRepo();
  const queryClient = useQueryClient();
  // Ephemeral UI state (not a persisted setting): tree by default, ignored off.
  const [viewMode, setViewMode] = useState<ViewMode>("tree");
  const [showIgnored, setShowIgnored] = useState(false);
  const [filter, setFilter] = useState("");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  const { rowHeight, iconSize } = useFileRowMetrics();

  // Keyed under the "status" domain: the watcher emits Status on any worktree
  // add/delete and on index/commit changes, so the tree refreshes live for
  // both untracked-set and tracked-set changes without a new domain.
  const {
    data: files = [],
    isFetching,
    isError,
    error,
    refetch,
  } = useQuery<RepoFileEntry[]>({
    queryKey: [repo?.id, "status", "repo-files", showIgnored],
    queryFn: () => repoListFiles(repo!.id, showIgnored),
    enabled: !!repo,
    staleTime: 5_000,
  });

  usePanelFocusEffect(useCallback(() => { refetch(); }, [refetch]));

  // path -> kind, for the icon resolver and per-row action gating.
  const kindByPath = useMemo(() => {
    const m = new Map<string, RepoFileKind>();
    for (const f of files) m.set(f.path, f.kind);
    return m;
  }, [files]);

  // Filter by path substring (case-insensitive), then map to the tree's shape.
  // Ignored files render dimmed; the icon comes from `renderFileIcon` below.
  const treeFiles = useMemo<FileTreeEntry[]>(() => {
    const needle = filter.trim().toLowerCase();
    return files
      .filter((f) => !needle || f.path.toLowerCase().includes(needle))
      .map((f) => ({ path: f.path, dimmed: f.kind === "ignored" }));
  }, [files, filter]);

  const counts = useMemo(() => {
    let tracked = 0;
    let untracked = 0;
    let ignored = 0;
    for (const f of files) {
      if (f.kind === "tracked") tracked++;
      else if (f.kind === "untracked") untracked++;
      else ignored++;
    }
    return { tracked, untracked, ignored };
  }, [files]);

  const renderFileIcon = useCallback(
    (file: FileTreeEntry): ReactNode => {
      const kind = kindByPath.get(file.path);
      const meta = ICON_META[kind ?? "tracked"];
      const Icon = meta.Icon;
      return <Icon size={iconSize} color={meta.color} aria-label={kind} />;
    },
    [kindByPath, iconSize],
  );

  const onIgnored = useCallback(
    async (action: () => Promise<void>, label: string) => {
      if (!repo) return;
      try {
        await action();
        invalidateRepoDomains(queryClient, repo.id, ["status"]);
        notify.success(label);
      } catch (e) {
        notify.error(formatAppError(e));
      }
    },
    [repo, queryClient],
  );

  const reveal = useCallback(
    async (path: string) => {
      if (!repo) return;
      try {
        await repoRevealPath(repo.id, path);
      } catch (e) {
        notify.error(formatAppError(e));
      }
    },
    [repo],
  );

  // Selecting a file shows its current working-tree content in File View (no
  // rev → worktree mode), which works for tracked, untracked and ignored files.
  const viewInFileView = useCallback((path: string) => {
    useSummonStore.getState().summon("file-view", { path });
  }, []);

  const handleSelect = useCallback(
    (file: FileTreeEntry) => {
      setSelectedPath(file.path);
      viewInFileView(file.path);
    },
    [viewInFileView],
  );

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
    <PanelContextMenuProvider baseline={[]}>
      {({ openMenu, closeMenu }) => (
        <div className="legit-panel" style={{ display: "flex", flexDirection: "column" }}>
          <PanelLoadingBar active={isFetching} />
          <div
            className="legit-panel__toolbar"
            style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}
          >
            <div style={{ display: "flex" }}>
              <button onClick={() => setViewMode("tree")} aria-pressed={viewMode === "tree"} style={segStyle(viewMode === "tree", "left")}>
                Tree
              </button>
              <button onClick={() => setViewMode("flat")} aria-pressed={viewMode === "flat"} style={segStyle(viewMode === "flat", "right")}>
                List
              </button>
            </div>
            <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: "var(--fz-sm)" }}>
              <input type="checkbox" checked={showIgnored} onChange={(e) => setShowIgnored(e.target.checked)} />
              Show ignored
            </label>
            <input
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter files…"
              style={{
                flex: 1,
                minWidth: 80,
                fontSize: "var(--fz-sm)",
                padding: "2px 6px",
                border: "1px solid var(--panel-border)",
                borderRadius: 3,
                background: "var(--input-bg)",
                color: "var(--panel-fg)",
              }}
            />
            <span
              className="legit-subtle"
              style={{ fontSize: "var(--fz-sm)", whiteSpace: "nowrap" }}
              title={`${counts.tracked} tracked · ${counts.untracked} untracked · ${counts.ignored} ignored`}
            >
              {counts.tracked} tracked · {counts.untracked} new
              {showIgnored && <> · {counts.ignored} ignored</>}
            </span>
          </div>

          {isError && (
            <PanelError error={error} />
          )}

          {!isError && treeFiles.length === 0 && !isFetching && (
            <div className="legit-panel__body">
              <span className="legit-subtle">
                {files.length === 0 ? "No files." : "No files match the filter."}
              </span>
            </div>
          )}

          {treeFiles.length > 0 && (
            <FileTree
              files={treeFiles}
              viewMode={viewMode}
              selectedPath={selectedPath}
              onSelect={handleSelect}
              rowHeight={rowHeight}
              iconSize={iconSize}
              renderFileIcon={renderFileIcon}
              onContextMenu={(file, e) =>
                openMenu(
                  e,
                  <FileMenuSection
                    path={file.path}
                    kind={kindByPath.get(file.path) ?? "tracked"}
                    onHistory={() => useSummonStore.getState().summon("file-history", file.path)}
                    onBlame={() => useSummonStore.getState().summon("blame", file.path)}
                    onView={() => viewInFileView(file.path)}
                    onReveal={() => reveal(file.path)}
                    onAddToGitignore={() =>
                      onIgnored(() => repoAddToGitignore(repo.id, file.path, false), `Ignored ${file.path}`)
                    }
                    onUntrack={() =>
                      onIgnored(() => repoUntrackPath(repo.id, file.path, false), `Stopped tracking ${file.path}`)
                    }
                    onClose={closeMenu}
                  />,
                )
              }
              onDirContextMenu={(_filePaths, dirPath, e) =>
                openMenu(
                  e,
                  <DirMenuSection
                    dirPath={dirPath}
                    onReveal={() => reveal(dirPath)}
                    onAddToGitignore={() =>
                      onIgnored(() => repoAddToGitignore(repo.id, dirPath, true), `Ignored ${dirPath}/`)
                    }
                    onClose={closeMenu}
                  />,
                )
              }
            />
          )}
        </div>
      )}
    </PanelContextMenuProvider>
  );
}

// Distinct icon per kind: tracked (known to git), new/untracked, ignored.
const ICON_META: Record<RepoFileKind, { Icon: typeof FileCheck; color: string }> = {
  tracked: { Icon: FileCheck, color: "var(--subtle-fg)" },
  untracked: { Icon: FilePlus, color: "var(--status-added)" },
  ignored: { Icon: FileX, color: "var(--subtle-fg)" },
};

/**
 * Context-menu section for one file. History/Blame apply to tracked files only.
 * The ignore action differs by kind: untracked files just get a `.gitignore`
 * line; tracked files must also stop being tracked (`git rm --cached`), which
 * is the destructive step and therefore confirm-gated.
 */
function FileMenuSection({
  path,
  kind,
  onHistory,
  onBlame,
  onView,
  onReveal,
  onAddToGitignore,
  onUntrack,
  onClose,
}: {
  path: string;
  kind: RepoFileKind;
  onHistory: () => void;
  onBlame: () => void;
  onView: () => void;
  onReveal: () => void;
  onAddToGitignore: () => void;
  onUntrack: () => void;
  onClose: () => void;
}) {
  const confirmDestructive = useConfirmDestructive();
  const menuConfirm = useMenuConfirm();
  const tracked = kind === "tracked";

  const requestUntrack = () => {
    const run = () => { onClose(); onUntrack(); };
    if (!confirmDestructive) return run();
    menuConfirm(`Stop tracking ${path} (kept on disk) and ignore it?`, run);
  };

  return (
    <>
      <SectionLabel>{path}</SectionLabel>
      <MenuItem disabled={!tracked} onClick={() => { onClose(); onHistory(); }}>
        {tracked ? "File history" : "File history (untracked)"}
      </MenuItem>
      <MenuItem disabled={!tracked} onClick={() => { onClose(); onBlame(); }}>
        {tracked ? "Blame" : "Blame (untracked)"}
      </MenuItem>
      <MenuItem onClick={() => { onClose(); onView(); }}>View file</MenuItem>
      <CopyPathMenuSection path={path} onClose={onClose} />
      <OpenInEditorMenuItem path={path} onClose={onClose} />
      <MenuItem onClick={() => { onClose(); onReveal(); }}>Reveal in file manager</MenuItem>
      {tracked ? (
        <MenuItem onClick={requestUntrack}>
          {confirmDestructive ? "Stop tracking & ignore…" : "Stop tracking & ignore"}
        </MenuItem>
      ) : kind === "untracked" ? (
        <MenuItem onClick={() => { onClose(); onAddToGitignore(); }}>Add to .gitignore</MenuItem>
      ) : null}
    </>
  );
}

/** Context-menu section for a folder row: ignore the whole folder, copy, reveal. */
function DirMenuSection({
  dirPath,
  onReveal,
  onAddToGitignore,
  onClose,
}: {
  dirPath: string;
  onReveal: () => void;
  onAddToGitignore: () => void;
  onClose: () => void;
}) {
  return (
    <>
      <SectionLabel>{dirPath}/</SectionLabel>
      <MenuItem onClick={() => { onClose(); onAddToGitignore(); }}>Add folder to .gitignore</MenuItem>
      <CopyPathMenuSection path={dirPath} onClose={onClose} />
      <MenuItem onClick={() => { onClose(); onReveal(); }}>Reveal in file manager</MenuItem>
    </>
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
