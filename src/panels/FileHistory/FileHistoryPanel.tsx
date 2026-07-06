import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useActiveRepo } from "../../store/repos";
import { useConfirmDestructive } from "../../store/settings";
import { useSummonStore, useSummonTarget } from "../../store/summon";
import { usePanelFocusEffect } from "../PanelApiContext";
import { repoFileHistory, repoRestoreFileAtRevision } from "../../lib/commands";
import type { DiffRequest, FileHistoryEntry } from "../../lib/types";
import { formatAppError } from "../../lib/types";
import { formatRelative } from "../../lib/time";
import { invalidateRepoDomains } from "../../lib/repoInvalidation";
import { useQueryClient } from "@tanstack/react-query";
import { notify } from "../../store/notifications";
import { PanelLoadingBar } from "../shared/PanelLoadingBar";
import { Button } from "../shared/buttons";
import {
  PanelContextMenuProvider,
  usePanelContextMenu,
  useMenuConfirm,
} from "../Commits/menu/PanelContextMenu";
import { MenuItem, SectionLabel, Separator } from "../Commits/menu/primitives";

/** Page size for the history walk; a "Load more" footer fetches the next page. */
const PAGE_SIZE = 200;

/** Summon payload for showing a file's history (a bare string = the path). */
export interface FileHistoryRequest {
  path: string;
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
  const [path, setPath] = useState<string | null>(null);
  // How many pages to request; "Load more" bumps it, a new file resets it.
  const [pageCount, setPageCount] = useState(1);

  // Reset when the repo changes — the path belongs to the previous repo.
  const prevRepoId = useRef(repo?.id);
  useEffect(() => {
    if (prevRepoId.current === repo?.id) return;
    prevRepoId.current = repo?.id;
    setPath(null);
    setPageCount(1);
  }, [repo?.id]);

  const onReceive = useCallback((payload: unknown) => {
    if (typeof payload === "string") {
      setPath(payload);
      setPageCount(1);
      return;
    }
    const p = payload as Partial<FileHistoryRequest> | null;
    if (p && typeof p.path === "string") {
      setPath(p.path);
      setPageCount(1);
    }
  }, []);
  useSummonTarget("file-history", onReceive);

  const { data: entries = [], isFetching, isError, error, refetch } = useQuery<FileHistoryEntry[]>({
    // Under the "log" domain: history changes exactly when the log/worktree do.
    queryKey: [repo?.id, "log", "file-history", path, pageCount],
    queryFn: () => repoFileHistory(repo!.id, path!, PAGE_SIZE * pageCount, 0),
    enabled: !!repo && !!path,
    staleTime: 5_000,
  });
  usePanelFocusEffect(useCallback(() => { refetch(); }, [refetch]));

  // A full page implies there may be more; short page = end of history.
  const maybeMore = entries.length === PAGE_SIZE * pageCount;

  const openCommit = useCallback((sha: string, path: string) => {
    const summon = useSummonStore.getState();
    summon.summon("commit-details", sha);
    // Carry the file's path so Changed Files pre-selects it (opening its diff)
    // — we're browsing this file's history, so surface it without an extra click.
    summon.swapSummon("changed-files", "working-changes", { commitId: sha, selectPath: path });
    // Keep the Commits graph highlight in step (only if that panel is open).
    summon.notifyIfOpen("log", sha);
  }, []);

  const restore = useCallback(
    async (entry: FileHistoryEntry) => {
      if (!repo) return;
      try {
        await repoRestoreFileAtRevision(repo.id, entry.commit_id, entry.path);
        invalidateRepoDomains(queryClient, repo.id, ["status", "log", "diff"]);
        notify.success(`Restored ${entry.path} to ${entry.commit_id.slice(0, 8)} (staged)`);
      } catch (e) {
        notify.error(formatAppError(e));
      }
    },
    [repo, queryClient],
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
      <div className="legit-panel__toolbar" style={{ display: "flex", alignItems: "center", gap: 8 }}>
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
      </div>

      <div className="legit-panel__body" style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 0 }}>
        {isError ? (
          <pre className="legit-error" style={{ margin: 8, fontSize: "var(--fz-md)" }}>
            {formatAppError(error)}
          </pre>
        ) : entries.length === 0 && !isFetching ? (
          <span className="legit-subtle" style={{ display: "block", padding: 8, fontSize: "var(--fz-md)" }}>
            No history for this file.
          </span>
        ) : (
          <>
            {entries.map((entry) => (
              <HistoryRow
                key={`${entry.commit_id}-${entry.path}`}
                entry={entry}
                repoId={repo.id}
                onOpen={() => openCommit(entry.commit_id, entry.path)}
                onRestore={() => restore(entry)}
              />
            ))}
            {maybeMore && (
              <div style={{ padding: 8, textAlign: "center" }}>
                <Button disabled={isFetching} onClick={() => setPageCount((n) => n + 1)}>
                  Load more
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function HistoryRow({
  entry,
  repoId,
  onOpen,
  onRestore,
}: {
  entry: FileHistoryEntry;
  repoId: string;
  onOpen: () => void;
  onRestore: () => void;
}) {
  const { openMenu, closeMenu } = usePanelContextMenu();
  const confirmDestructive = useConfirmDestructive();
  const menuConfirm = useMenuConfirm();
  const sha = entry.commit_id;

  const summon = useSummonStore.getState;

  const menu = useMemo(
    () => (
      <>
        <SectionLabel>
          {sha.slice(0, 8)} · {entry.path}
        </SectionLabel>
        <MenuItem
          onClick={() => {
            summon().summon("file-view", { path: entry.path, rev: sha });
            closeMenu();
          }}
        >
          View file at this commit
        </MenuItem>
        <MenuItem
          onClick={() => {
            summon().summon("blame", { path: entry.path, rev: sha });
            closeMenu();
          }}
        >
          Blame at this commit
        </MenuItem>
        <MenuItem
          onClick={() => {
            summon().summon("diff", {
              repoId,
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
          onClick={() => {
            if (confirmDestructive) {
              menuConfirm(`Restore ${entry.path} to its content at ${sha.slice(0, 8)}?`, () => {
                closeMenu();
                onRestore();
              });
            } else {
              closeMenu();
              onRestore();
            }
          }}
        >
          {confirmDestructive ? "Restore file to this commit…" : "Restore file to this commit"}
        </MenuItem>
      </>
    ),
    [entry, repoId, sha, confirmDestructive, menuConfirm, closeMenu, onRestore, summon],
  );

  return (
    <button
      onClick={onOpen}
      onContextMenu={(e) => openMenu(e, menu)}
      title={`${sha.slice(0, 8)} · ${entry.author} · ${entry.summary}`}
      style={{
        display: "block",
        width: "100%",
        textAlign: "left",
        background: "transparent",
        border: "none",
        borderBottom: "1px solid var(--panel-border)",
        padding: "4px 8px",
        cursor: "pointer",
      }}
    >
      <span
        style={{
          display: "block",
          fontSize: "var(--fz-md)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {entry.summary}
      </span>
      <span
        className="legit-subtle"
        style={{
          display: "block",
          fontSize: "var(--fz-sm)",
          fontFamily: "monospace",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {sha.slice(0, 8)} · {entry.author} · {formatRelative(entry.timestamp)}
        {entry.old_path && (
          <span style={{ fontStyle: "italic" }}> · renamed from {entry.old_path}</span>
        )}
      </span>
    </button>
  );
}
