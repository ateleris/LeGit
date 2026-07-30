import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PanelError } from "../shared/PanelError";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FileCheck, FilePlus, FileX, GitFork } from "lucide-react";
import type { ReactNode } from "react";
import { useActiveRepo } from "../../store/repos";
import { useConfirmDestructive } from "../../store/settings";
import { useSummonStore, useSummonTarget } from "../../store/summon";
import { usePanelFocusEffect } from "../PanelApiContext";
import {
  repoFilesAtRevision,
  repoListFiles,
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
import { AddToGitignoreMenuItem } from "../shared/AddToGitignoreMenuItem";
import { CopyPathMenuSection } from "../shared/CopyPathMenuSection";
import { OpenInEditorMenuItem } from "../shared/OpenInEditorMenuItem";

/** Summon payload for browse-at-commit mode: `{ rev }` lists that commit's
 * tree; `{ rev: null }` returns to the working tree. */
export interface FilesAtRevRequest {
  rev: string | null;
}

/**
 * Files panel — the whole repository working tree as a browsable file list,
 * each file marked tracked / untracked / ignored. Lets you run History, Blame,
 * View, ignore/untrack, copy-path and reveal on any file, not just files in a
 * recent commit. Ignored files show only when the "Show ignored" toggle is on.
 *
 * Browse-at-commit mode (summoned with a `FilesAtRevRequest`) lists a
 * revision's tree instead. Untracked/ignored files do not exist at a commit
 * (git only records tracked content), so the kind distinction disappears and
 * on-disk actions (reveal, open in editor, untrack, gitignore) are hidden —
 * a listed path may not exist in the working tree at all.
 */
export function FilesPanel() {
  const repo = useActiveRepo();
  const queryClient = useQueryClient();
  // Ephemeral UI state (not a persisted setting): tree by default, ignored off.
  const [viewMode, setViewMode] = useState<ViewMode>("tree");
  const [showIgnored, setShowIgnored] = useState(false);
  const [filter, setFilter] = useState("");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  // Browse-at-commit mode; null = the live working tree.
  const [rev, setRev] = useState<string | null>(null);

  const { rowHeight, iconSize } = useFileRowMetrics();

  // Reset when the repo changes — the rev belongs to the previous repo.
  const prevRepoId = useRef(repo?.id);
  useEffect(() => {
    if (prevRepoId.current === repo?.id) return;
    prevRepoId.current = repo?.id;
    setRev(null);
    setSelectedPath(null);
  }, [repo?.id]);

  const onReceive = useCallback((payload: unknown) => {
    const p = payload as Partial<FilesAtRevRequest> | null;
    if (p && typeof p === "object" && "rev" in p) {
      setRev(typeof p.rev === "string" ? p.rev : null);
      setSelectedPath(null);
    }
  }, []);
  useSummonTarget("files", onReceive);

  // Keyed under the "status" domain: the watcher emits Status on any worktree
  // add/delete and on index/commit changes, so the tree refreshes live for
  // both untracked-set and tracked-set changes without a new domain.
  const live = useQuery<RepoFileEntry[]>({
    queryKey: [repo?.id, "status", "repo-files", showIgnored],
    queryFn: () => repoListFiles(repo!.id, showIgnored),
    enabled: !!repo && rev === null,
    staleTime: 5_000,
  });

  // A commit's tree is immutable: own key outside the "status" domain (no
  // watcher invalidation) and never stale.
  const atRev = useQuery<RepoFileEntry[]>({
    queryKey: [repo?.id, "files-at", rev],
    queryFn: () => repoFilesAtRevision(repo!.id, rev!),
    enabled: !!repo && rev !== null,
    staleTime: Infinity,
  });

  const { isFetching, isError, error, refetch } = rev === null ? live : atRev;
  const files = (rev === null ? live.data : atRev.data) ?? [];

  usePanelFocusEffect(useCallback(() => { refetch(); }, [refetch]));

  // path -> kind, for the icon resolver and per-row action gating.
  const kindByPath = useMemo(() => {
    const m = new Map<string, RepoFileKind>();
    for (const f of files) m.set(f.path, f.kind);
    return m;
  }, [files]);

  // Submodules / nested repos: no blob content exists at these paths, so the
  // blob actions (View, Blame) don't apply and selecting one must not open
  // File View (reading the path as a file errors).
  const submodulePaths = useMemo(() => {
    const s = new Set<string>();
    for (const f of files) if (f.submodule) s.add(f.path);
    return s;
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
      // Submodules / nested repos get the fork glyph (same as the FileTree
      // status icons use for submodule changes); the colour still follows
      // the kind so untracked nested repos keep the "new" tint.
      const Icon = submodulePaths.has(file.path) ? GitFork : meta.Icon;
      const label = submodulePaths.has(file.path) ? `${kind} submodule` : kind;
      return <Icon size={iconSize} color={meta.color} aria-label={label} />;
    },
    [kindByPath, submodulePaths, iconSize],
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

  // Selecting a file shows its content in File View — the working-tree copy
  // (no rev → worktree mode, works for tracked/untracked/ignored files) or,
  // in browse-at-commit mode, the file as of that rev.
  const viewInFileView = useCallback((path: string) => {
    useSummonStore.getState().summon("file-view", rev === null ? { path } : { path, rev });
  }, [rev]);

  const blamePayload = useCallback(
    (path: string) => (rev === null ? path : { path, rev }),
    [rev],
  );

  const handleSelect = useCallback(
    (file: FileTreeEntry) => {
      setSelectedPath(file.path);
      const submodule = submodulePaths.has(file.path);
      // A submodule row has no blob content - opening File View or blaming it
      // would just error. History still applies (commits move the pointer).
      if (!submodule) viewInFileView(file.path);
      // Retarget the history/blame panels only if they are already open
      // (notifyIfOpen never pops them up). Tracked files only, matching the
      // context menu - untracked/ignored files have no history to show.
      if ((kindByPath.get(file.path) ?? "tracked") === "tracked") {
        useSummonStore.getState().notifyIfOpen("file-history", file.path);
        if (!submodule) {
          useSummonStore.getState().notifyIfOpen("blame", blamePayload(file.path));
        }
      }
    },
    [viewInFileView, kindByPath, submodulePaths, blamePayload],
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
            {rev !== null && (
              <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span
                  className="legit-subtle"
                  style={{ fontSize: "var(--fz-sm)", fontFamily: "monospace" }}
                  title={`Browsing the tree of ${rev}`}
                >
                  at {rev.slice(0, 8)}
                </span>
                <button style={{ fontSize: "var(--fz-sm)" }} onClick={() => setRev(null)}>
                  Back to working tree
                </button>
              </span>
            )}
            <label
              style={{ display: "flex", alignItems: "center", gap: 4, fontSize: "var(--fz-sm)" }}
              title={rev !== null ? "Ignored files do not exist at a commit" : undefined}
            >
              <input
                type="checkbox"
                checked={showIgnored && rev === null}
                disabled={rev !== null}
                onChange={(e) => setShowIgnored(e.target.checked)}
              />
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
              title={
                rev === null
                  ? `${counts.tracked} tracked · ${counts.untracked} untracked · ${counts.ignored} ignored`
                  : undefined
              }
            >
              {rev === null ? (
                <>
                  {counts.tracked} tracked · {counts.untracked} new
                  {showIgnored && <> · {counts.ignored} ignored</>}
                </>
              ) : (
                <>{counts.tracked} files</>
              )}
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
                    atRev={rev !== null}
                    submodule={submodulePaths.has(file.path)}
                    onHistory={() => useSummonStore.getState().summon("file-history", file.path)}
                    onBlame={() => useSummonStore.getState().summon("blame", blamePayload(file.path))}
                    onView={() => viewInFileView(file.path)}
                    onReveal={() => reveal(file.path)}
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
                    atRev={rev !== null}
                    onReveal={() => reveal(dirPath)}
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
 * is the destructive step and therefore confirm-gated. In browse-at-commit
 * mode (`atRev`) the on-disk actions (open in editor, reveal, untrack,
 * gitignore) are hidden — the listed path may not exist in the working tree.
 * For a submodule (`submodule`) the blob actions (View, Blame) are disabled —
 * no file content exists at the path — and untrack/editor are hidden (proper
 * submodule removal lives in the Submodules section); History stays, since
 * commits move the submodule pointer.
 */
function FileMenuSection({
  path,
  kind,
  atRev,
  submodule,
  onHistory,
  onBlame,
  onView,
  onReveal,
  onUntrack,
  onClose,
}: {
  path: string;
  kind: RepoFileKind;
  atRev: boolean;
  submodule: boolean;
  onHistory: () => void;
  onBlame: () => void;
  onView: () => void;
  onReveal: () => void;
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
      <MenuItem disabled={!tracked || submodule} onClick={() => { onClose(); onBlame(); }}>
        {submodule ? "Blame (submodule)" : tracked ? "Blame" : "Blame (untracked)"}
      </MenuItem>
      <MenuItem disabled={submodule} onClick={() => { onClose(); onView(); }}>
        {submodule ? "View file (submodule)" : "View file"}
      </MenuItem>
      <CopyPathMenuSection path={path} onClose={onClose} />
      {!atRev && (
        <>
          {!submodule && <OpenInEditorMenuItem path={path} onClose={onClose} />}
          <MenuItem onClick={() => { onClose(); onReveal(); }}>Reveal in file manager</MenuItem>
          {tracked && !submodule ? (
            <MenuItem onClick={requestUntrack}>
              {confirmDestructive ? "Stop tracking & ignore…" : "Stop tracking & ignore"}
            </MenuItem>
          ) : kind === "untracked" ? (
            <AddToGitignoreMenuItem path={path} onClose={onClose} />
          ) : null}
        </>
      )}
    </>
  );
}

/** Context-menu section for a folder row: ignore the whole folder, copy,
 * reveal. In browse-at-commit mode only copy remains (the others act on the
 * working tree, where the folder may not exist). */
function DirMenuSection({
  dirPath,
  atRev,
  onReveal,
  onClose,
}: {
  dirPath: string;
  atRev: boolean;
  onReveal: () => void;
  onClose: () => void;
}) {
  return (
    <>
      <SectionLabel>{dirPath}/</SectionLabel>
      {!atRev && <AddToGitignoreMenuItem path={dirPath} isDir onClose={onClose} />}
      <CopyPathMenuSection path={dirPath} onClose={onClose} />
      {!atRev && (
        <MenuItem onClick={() => { onClose(); onReveal(); }}>Reveal in file manager</MenuItem>
      )}
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
