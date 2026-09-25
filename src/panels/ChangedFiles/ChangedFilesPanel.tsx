import { useCallback, useEffect, useMemo, useState } from "react";
import { PanelError } from "../shared/PanelError";
import { segStyle } from "../shared/segmented";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useActiveRepo } from "../../store/repos";
import { useSettingsStore, useConfirmDestructive } from "../../store/settings";
import { useSummonStore, useSummonTarget } from "../../store/summon";
import { usePanelFocusEffect } from "../PanelApiContext";
import { api } from "../../lib/commands";
import { invalidateRepoDomains } from "../../lib/repoInvalidation";
import { openSubmoduleRepo } from "../../lib/submodules";
import { usePanelViewState } from "../../store/panelViewState";
import { notify } from "../../store/notifications";
import type { CommitDetails, CommitFileChange, CommitId, DiffRequest } from "../../lib/types";
import { formatAppError } from "../../lib/errors";
import { PanelLoadingBar } from "../shared/PanelLoadingBar";
import { FileTree } from "../shared/FileTree/FileTree";
import { useFileRowMetrics } from "../shared/FileTree/useFileRowMetrics";
import type { FileTreeEntry, ViewMode } from "../shared/FileTree/buildTree";
import { PanelContextMenuProvider, useDestructiveMenuConfirm } from "../shared/menu/PanelContextMenu";
import { MenuItem, Separator } from "../shared/menu/primitives";
import { FileRowMenuSection } from "../shared/FileRowMenuSection";
import type { FileViewRequest } from "../FileView/FileViewPanel";
import { STALE } from "../../lib/queryTiming";
import { useStashes } from "../../lib/queries/useRepoQueries";

/**
 * Changed Files panel — receives a CommitId via the summon mechanism and shows
 * the files that commit changed (vs its first parent) as a tree or flat list.
 * Clicking a file summons the (future) Diff panel.
 */
export function ChangedFilesPanel() {
  const repo = useActiveRepo();
  const queryClient = useQueryClient();
  // Per-repo view state (store/panelViewState.ts): survives a layout apply's
  // dock rebuild and the slot swap with Working Changes, and each repo keeps
  // its own selection across tab switches - it also covers the summoned-for-
  // the-new-repo delivery race that useRepoSwitchClear used to handle (writes
  // key by the active repo at call time).
  const [selectedId, setSelectedId] = usePanelViewState<CommitId | null>(
    "changed-files.selectedId",
    null,
  );
  const [selectedPath, setSelectedPath] = usePanelViewState<string | null>(
    "changed-files.selectedPath",
    null,
  );
  // A path the summoner asked us to pre-select once this commit's files load
  // (File History → "select this file's row and open its diff").
  const [pendingSelectPath, setPendingSelectPath] = useState<string | null>(null);

  // View mode is persisted in global settings so it's remembered across panel
  // re-opens and restarts. Defaults to flat until the user first toggles it.
  const viewMode: ViewMode =
    useSettingsStore((s) => s.settings?.changed_files_view_mode) === "tree" ? "tree" : "flat";
  const setViewMode = useSettingsStore((s) => s.setChangedFilesViewMode);

  // Row height and icons scale with the global UI font size.
  const { rowHeight, iconSize } = useFileRowMetrics();

  const onReceive = useCallback((payload: unknown) => {
    // Payload is either a bare commit SHA (most callers) or
    // `{ commitId, selectPath }` (File History, to pre-select a file's row).
    let id: string | null = null;
    let selectPath: string | null = null;
    if (typeof payload === "string") {
      id = payload;
    } else if (payload && typeof payload === "object" && typeof (payload as { commitId?: unknown }).commitId === "string") {
      const p = payload as { commitId: string; selectPath?: unknown };
      id = p.commitId;
      selectPath = typeof p.selectPath === "string" ? p.selectPath : null;
    }
    if (id === null) return;
    setSelectedId(id as CommitId);
    setSelectedPath(null);
    setPendingSelectPath(selectPath);
    // No file is selected for the new commit yet — clear the Diff and Merge
    // panels (only if open). Both are always tied to a file selection.
    // (When `selectPath` is set, the effect below opens the diff once files load.)
    useSummonStore.getState().notifyIfOpen("diff", null);
    useSummonStore.getState().notifyIfOpen("merge", null);
  }, [setSelectedId, setSelectedPath]);
  useSummonTarget("changed-files", onReceive);

  const {
    data: files = [],
    isFetching,
    isError,
    error,
    refetch,
  } = useQuery<CommitFileChange[]>({
    queryKey: [repo?.id, "commit-files", selectedId],
    queryFn: () => api.repoCommitFiles(repo!.id, selectedId!),
    enabled: !!repo && !!selectedId,
    staleTime: STALE.stable,
  });

  // Shares React Query's cache with CommitDetailsPanel (identical key), so this
  // is free when that panel is also open — used only for the subject heading.
  const { data: details } = useQuery<CommitDetails>({
    queryKey: [repo?.id, "commit-details", selectedId],
    queryFn: () => api.repoCommitDetails(repo!.id, selectedId!),
    enabled: !!repo && !!selectedId,
    staleTime: STALE.stable,
  });

  usePanelFocusEffect(useCallback(() => { refetch(); }, [refetch]));

  // Whether the shown "commit" is a stash entry (openStashDiff routes stash
  // SHAs here) - per-file restore then reads as "apply from stash". Shares
  // the stashes query cache with the Stashes panel.
  const { data: stashes = [] } = useStashes(repo?.id, { enabled: !!selectedId });
  const isStash = useMemo(
    () => stashes.some((s) => s.stash_sha === selectedId),
    [stashes, selectedId],
  );

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
    (file: FileTreeEntry) => {
      setSelectedPath(file.path);
      if (!repo || !selectedId) return;
      useSummonStore.getState().summon("diff", {
        repoId: repo.id,
        path: file.path,
        source: { kind: "commit", commit_id: selectedId },
        change: file.change,
        oldPath: file.old_path,
      } satisfies DiffRequest);
    },
    [repo, selectedId],
  );

  // Right-click targeting: the selection moves to the clicked row (it is what
  // the menu acts on, and the selection is what the detail views show), and
  // an ALREADY-OPEN diff follows it - but a right-click never force-opens one
  // (notifyIfOpen, unlike handleSelect's summon). Mirrors Working Changes.
  const selectForMenu = useCallback(
    (file: FileTreeEntry) => {
      setSelectedPath(file.path);
      if (!repo || !selectedId) return;
      useSummonStore.getState().notifyIfOpen("diff", {
        repoId: repo.id,
        path: file.path,
        source: { kind: "commit", commit_id: selectedId },
        change: file.change,
        oldPath: file.old_path,
      } satisfies DiffRequest);
    },
    [repo, selectedId],
  );

  // Consume a pending pre-select once this commit's files have loaded: select
  // the requested file's row and open its diff (File History flow). Matches on
  // the destination path; cleared once handled or if it never appears.
  useEffect(() => {
    if (!pendingSelectPath) return;
    const match = files.find((f) => f.path === pendingSelectPath);
    if (match) {
      handleSelect(match);
      setPendingSelectPath(null);
    }
  }, [files, pendingSelectPath, handleSelect]);

  const handleViewAtCommit = useCallback(
    (path: string) => {
      if (!selectedId) return;
      useSummonStore.getState().summon("file-view", {
        path,
        rev: selectedId,
      } satisfies FileViewRequest);
    },
    [selectedId],
  );

  const handleRestoreToCommit = useCallback(
    async (path: string) => {
      if (!repo || !selectedId) return;
      try {
        // Stash applies land unstaged (matching whole-stash apply); commit
        // restores keep their established staged behavior.
        if (isStash) {
          await api.repoApplyStashFile(repo.id, selectedId, path);
        } else {
          await api.repoRestoreFileAtRevision(repo.id, selectedId, path);
        }
        invalidateRepoDomains(queryClient, repo.id, ["status", "diff"]);
        notify.success(
          isStash
            ? `Applied ${path} from the stash (unstaged)`
            : `Restored ${path} to ${selectedId.slice(0, 8)} (staged)`,
        );
      } catch (e) {
        notify.error(formatAppError(e));
      }
    },
    [repo, selectedId, queryClient, isStash],
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
    <PanelContextMenuProvider baseline={[]}>
      {({ openMenu, closeMenu }) => (
    <div className="legit-panel" style={{ display: "flex", flexDirection: "column" }}>
      <PanelLoadingBar active={isFetching} />
      <div className="legit-panel__toolbar" style={{ display: "flex", alignItems: "center", gap: "0.667em" }}>
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
          style={{ fontSize: "var(--fz-sm)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}
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
      </div>

      {isError && (
        <PanelError error={error} />
      )}

      {!isError && files.length === 0 && !isFetching && (
        <div className="legit-panel__body">
          <span className="legit-subtle">No file changes.</span>
        </div>
      )}

      {files.length > 0 && (
        <FileTree
          files={files}
          viewMode={viewMode}
          selectedPath={selectedPath}
          onSelect={handleSelect}
          rowHeight={rowHeight}
          iconSize={iconSize}
          onContextMenu={(file, e) => {
            selectForMenu(file);
            openMenu(
              e,
              <FileAtCommitMenuSection
                file={file}
                commitId={selectedId}
                stash={isStash}
                onOpenSubmodule={() => {
                  // Select the pointer this commit recorded in the opened
                  // submodule (a stash entry is a commit too, so it works
                  // for both).
                  void openSubmoduleRepo(repo!.id, repo!.locator ?? repo!.path, file.path, {
                    kind: "commit",
                    commit_id: selectedId,
                  }).catch((err: unknown) => notify.error(formatAppError(err)));
                }}
                onView={() => handleViewAtCommit(file.path)}
                onRestore={() => handleRestoreToCommit(file.path)}
                onHistory={() => useSummonStore.getState().summon("file-history", file.path)}
                onBlame={() =>
                  useSummonStore.getState().summon("blame", { path: file.path, rev: selectedId })
                }
                onClose={closeMenu}
              />,
            );
          }}
        />
      )}
    </div>
      )}
    </PanelContextMenuProvider>
  );
}

/**
 * Context-menu section for one file of the selected commit: view its content
 * at that commit, or restore the working-tree copy to it (destructive:
 * overwrites local changes silently, so it is confirm-gated). Both are
 * disabled for files the commit deleted: there is no content at this commit.
 */
function FileAtCommitMenuSection({
  file,
  commitId,
  stash,
  onOpenSubmodule,
  onView,
  onRestore,
  onHistory,
  onBlame,
  onClose,
}: {
  file: FileTreeEntry;
  commitId: string;
  /** The shown "commit" is a stash entry - restore reads as "apply". */
  stash: boolean;
  onOpenSubmodule: () => void;
  onView: () => void;
  onRestore: () => void;
  onHistory: () => void;
  onBlame: () => void;
  onClose: () => void;
}) {
  const confirmDestructive = useConfirmDestructive();
  const destructiveMenuConfirm = useDestructiveMenuConfirm();
  const commitShort = commitId.slice(0, 8);
  const deleted = file.change === "Deleted";
  // A gitlink has no file content: view/blame/restore would error on it.
  const submodule = file.change === "SubmoduleChanged";

  const requestRestore = () => {
    destructiveMenuConfirm(
      stash
        ? `Overwrite ${file.path} with its stashed version?`
        : `Overwrite ${file.path} with its content at ${commitShort}?`,
      () => {
        onClose();
        onRestore();
      },
    );
  };
  const restoreLabel = stash
    ? confirmDestructive
      ? "Apply file from stash…"
      : "Apply file from stash"
    : confirmDestructive
      ? "Restore file to this commit…"
      : "Restore file to this commit";

  return (
    <>
      {submodule && (
        <MenuItem onClick={() => { onClose(); onOpenSubmodule(); }}>
          Open submodule
        </MenuItem>
      )}
      {/* Binary files are viewable too: the backend classifies content and
          the File View panel reports "binary file, N bytes" for them. */}
      <FileRowMenuSection
        path={file.path}
        rev={{ value: commitId, label: "this commit" }}
        deleted={deleted}
        deletedIn={stash ? "in this stash" : "in this commit"}
        submodule={submodule}
        view
        onView={onView}
        onHistory={onHistory}
        onBlame={onBlame}
        onClose={onClose}
      />
      <Separator />
      <MenuItem disabled={deleted} onClick={requestRestore}>
        {deleted
          ? stash
            ? "Apply file (deleted in this stash)"
            : "Restore file (deleted in this commit)"
          : restoreLabel}
      </MenuItem>
    </>
  );
}

