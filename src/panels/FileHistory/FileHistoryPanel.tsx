import { useCallback } from "react";
import { usePanelViewState } from "../../store/panelViewState";
import { useActiveRepo } from "../../store/repos";
import { useConfirmDestructive } from "../../store/settings";
import { useSummonStore, useSummonTarget } from "../../store/summon";
import { usePanelFocusEffect } from "../PanelApiContext";
import type { DiffRequest, FileHistoryEntry, FileHistoryRequest } from "../../lib/types";
import { useQueryClient } from "@tanstack/react-query";
import { PanelLoadingBar } from "../shared/PanelLoadingBar";
import {
  PanelContextMenuProvider,
  useDestructiveMenuConfirm,
} from "../shared/menu/PanelContextMenu";
import { MenuItem, Separator } from "../shared/menu/primitives";
import { FileRowMenuSection } from "../shared/FileRowMenuSection";
import {
  FILE_HISTORY_PAGE_SIZE,
  FileHistoryList,
  restoreFileAtRevision,
  useFileHistoryQuery,
} from "./FileHistoryList";

/** Row-activation fan-out of the DOCKED panel (the history window deliberately
 *  does not use it - it updates its own diff pane instead). */
export function openCommitFromHistory(sha: string, path: string) {
  const summon = useSummonStore.getState();
  summon.summon("commit-details", sha);
  // Carry the file's path so Changed Files pre-selects it (opening its diff)
  // - we're browsing this file's history, so surface it without an extra click.
  summon.swapSummon("changed-files", "working-changes", { commitId: sha, selectPath: path });
  // Keep the Commits graph highlight in step (only if that panel is open).
  summon.notifyIfOpen("log", sha);
  // An open Files panel follows into browse-at-commit mode for this rev.
  summon.notifyIfOpen("files", { rev: sha });
}

/**
 * File History panel - the commits that touched one file, following renames.
 * Each row hands off to the other file panels the way Blame does: click opens
 * the commit; the context menu views/blames/diffs the file at that commit, or
 * restores the working-tree copy to it. Summoned with a path string (file
 * context menus, Blame's History button) or a `FileHistoryRequest`.
 */
export function FileHistoryPanel() {
  return (
    <PanelContextMenuProvider baseline={[]}>
      <FileHistoryBody />
    </PanelContextMenuProvider>
  );
}

function FileHistoryBody() {
  const repo = useActiveRepo();
  const queryClient = useQueryClient();
  const confirmDestructive = useConfirmDestructive();
  const destructiveMenuConfirm = useDestructiveMenuConfirm();
  // Per-repo view state (store/panelViewState.ts): the shown file survives a
  // layout apply's dock rebuild and panel close/reopen, and each repo keeps
  // its own across tab switches - it also covers the summoned-for-the-new-
  // repo delivery race that useRepoSwitchClear used to handle (writes key by
  // the active repo at call time).
  const [path, setPath] = usePanelViewState<string | null>("file-history.path", null);
  // Non-null: walk from this rev instead of HEAD (browse-at-commit mode).
  const [rev, setRev] = usePanelViewState<string | null>("file-history.rev", null);
  // How many pages to request; "Load more" bumps it, a new file resets it.
  const [pageCount, setPageCount] = usePanelViewState("file-history.pageCount", 1);
  // The commit whose details the last row click opened (highlight only) -
  // aligned with the history window's selection.
  const [selectedSha, setSelectedSha] = usePanelViewState<string | null>(
    "file-history.selected",
    null,
  );

  const onReceive = useCallback((payload: unknown) => {
    if (typeof payload === "string") {
      setPath(payload);
      setRev(null);
      setPageCount(1);
      setSelectedSha(null);
      return;
    }
    const p = payload as Partial<FileHistoryRequest> | null;
    if (p && typeof p.path === "string") {
      setPath(p.path);
      setRev(typeof p.rev === "string" ? p.rev : null);
      setPageCount(1);
      setSelectedSha(null);
    }
  }, [setPath, setRev, setPageCount, setSelectedSha]);
  useSummonTarget("file-history", onReceive);

  const { data: entries = [], isFetching, isError, error, refetch } = useFileHistoryQuery(
    repo?.id,
    path,
    rev,
    pageCount,
  );
  usePanelFocusEffect(useCallback(() => { refetch(); }, [refetch]));

  const renderMenu = useCallback(
    (entry: FileHistoryEntry, closeMenu: () => void) => {
      if (!repo) return null;
      const sha = entry.commit_id;
      return (
        <>
          {/* The editor entry opens the current working-tree file (not the
              content at this commit); for pre-rename entries the path may no
              longer exist - the launch failure surfaces as a toast. */}
          <FileRowMenuSection
            path={entry.path}
            header={`${sha.slice(0, 8)} · ${entry.path}`}
            rev={{ value: sha, label: "this commit" }}
            view
            onClose={closeMenu}
          />
          <Separator />
          <MenuItem
            onClick={() => {
              useSummonStore.getState().summon("diff", {
                repoId: repo.id,
                path: entry.path,
                source: { kind: "commit", commit_id: sha },
                oldPath: entry.old_path,
              } satisfies DiffRequest);
              closeMenu();
            }}
          >
            Diff in this commit
          </MenuItem>
          <Separator />
          <MenuItem
            onClick={() =>
              destructiveMenuConfirm(
                `Restore ${entry.path} to its content at ${sha.slice(0, 8)}?`,
                () => {
                  closeMenu();
                  void restoreFileAtRevision(queryClient, repo.id, entry);
                },
              )
            }
          >
            {confirmDestructive ? "Restore file to this commit…" : "Restore file to this commit"}
          </MenuItem>
        </>
      );
    },
    [repo, queryClient, confirmDestructive, destructiveMenuConfirm],
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

  if (!path) {
    return (
      <div className="legit-panel">
        <div className="legit-panel__body">
          <span className="legit-subtle" style={{ fontSize: "var(--fz-md)" }}>
            Show a file's history from a file's context menu, Search results, or
            the Blame panel.
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="legit-panel" style={{ display: "flex", flexDirection: "column" }}>
      <PanelLoadingBar active={isFetching} />
      <div className="legit-panel__toolbar" style={{ display: "flex", alignItems: "center", gap: "0.667em" }}>
        <span
          className="legit-subtle"
          style={{
            fontSize: "var(--fz-sm)",
            fontFamily: "monospace",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            minWidth: 0,
          }}
          title={path}
        >
          {path}
        </span>
        {rev !== null && (
          <span
            className="legit-subtle"
            style={{ fontSize: "var(--fz-sm)", fontFamily: "monospace", flexShrink: 0 }}
            title={`History walked from ${rev} (browse-at-commit mode)`}
          >
            from {rev.slice(0, 8)}
          </span>
        )}
      </div>

      <div className="legit-panel__body" style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 0 }}>
        <FileHistoryList
          entries={entries}
          busy={isFetching}
          error={isError ? error : null}
          maybeMore={entries.length === FILE_HISTORY_PAGE_SIZE * pageCount}
          onLoadMore={() => setPageCount((n) => n + 1)}
          selectedSha={selectedSha}
          onActivate={(entry) => {
            setSelectedSha(entry.commit_id);
            openCommitFromHistory(entry.commit_id, entry.path);
          }}
          renderMenu={renderMenu}
        />
      </div>
    </div>
  );
}
