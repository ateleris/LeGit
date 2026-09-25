// The commits that touched one file: the shared list under both the docked
// File History panel and the file-history window. Presentational - each host
// runs `useFileHistoryQuery` itself and wires activation and the row menu.

import { keepPreviousData, useQuery, type QueryClient } from "@tanstack/react-query";
import { repoFileHistory, api } from "../../lib/commands";
import type { FileHistoryEntry } from "../../lib/types";
import { formatAppError } from "../../lib/errors";
import { formatRelative } from "../../lib/time";
import { invalidateRepoDomains } from "../../lib/repoInvalidation";
import { notify } from "../../store/notifications";
import { STALE } from "../../lib/queryTiming";
import { PanelError } from "../shared/PanelError";
import { Button } from "../shared/buttons";
import { usePanelContextMenu } from "../shared/menu/PanelContextMenu";

/** Page size for the history walk; a "Load more" footer fetches the next page. */
export const FILE_HISTORY_PAGE_SIZE = 200;

export function useFileHistoryQuery(
  repoId: string | undefined,
  path: string | null,
  rev: string | null,
  pageCount: number,
) {
  return useQuery<FileHistoryEntry[]>({
    // Under the "log" domain: history changes exactly when the log/worktree do.
    queryKey: [repoId, "log", "file-history", path, rev, pageCount],
    queryFn: () =>
      repoFileHistory(repoId!, path!, FILE_HISTORY_PAGE_SIZE * pageCount, 0, rev ?? undefined),
    enabled: !!repoId && !!path,
    staleTime: STALE.live,
    // Load more bumps the key: keep the loaded page rendered while the next
    // one arrives, so the window's selection sync never sees an empty list.
    placeholderData: keepPreviousData,
  });
}

/** Stage the file's content at `entry`'s commit back into the working tree. */
export async function restoreFileAtRevision(
  queryClient: QueryClient,
  repoId: string,
  entry: FileHistoryEntry,
) {
  try {
    await api.repoRestoreFileAtRevision(repoId, entry.commit_id, entry.path);
    invalidateRepoDomains(queryClient, repoId, ["status", "log", "diff"]);
    notify.success(`Restored ${entry.path} to ${entry.commit_id.slice(0, 8)} (staged)`);
  } catch (e) {
    notify.error(formatAppError(e));
  }
}

export function FileHistoryList({
  entries,
  busy,
  error,
  maybeMore,
  onLoadMore,
  selectedSha,
  onActivate,
  renderMenu,
}: {
  entries: FileHistoryEntry[];
  busy: boolean;
  /** Non-null renders the error state instead of rows. */
  error: unknown;
  maybeMore: boolean;
  onLoadMore: () => void;
  selectedSha?: string | null;
  onActivate: (entry: FileHistoryEntry) => void;
  renderMenu: (entry: FileHistoryEntry, closeMenu: () => void) => React.ReactNode;
}) {
  if (error != null) {
    return <PanelError error={error} margin={8} />;
  }
  if (entries.length === 0 && !busy) {
    return (
      <span
        className="legit-subtle"
        style={{ display: "block", padding: "0.667em", fontSize: "var(--fz-md)" }}
      >
        No history for this file.
      </span>
    );
  }
  return (
    <>
      {entries.map((entry) => (
        <HistoryRow
          key={`${entry.commit_id}-${entry.path}`}
          entry={entry}
          selected={selectedSha != null && entry.commit_id === selectedSha}
          onActivate={() => onActivate(entry)}
          renderMenu={renderMenu}
        />
      ))}
      {maybeMore && (
        <div style={{ padding: "0.667em", textAlign: "center" }}>
          <Button disabled={busy} onClick={onLoadMore}>
            Load more
          </Button>
        </div>
      )}
    </>
  );
}

function HistoryRow({
  entry,
  selected,
  onActivate,
  renderMenu,
}: {
  entry: FileHistoryEntry;
  selected: boolean;
  onActivate: () => void;
  renderMenu: (entry: FileHistoryEntry, closeMenu: () => void) => React.ReactNode;
}) {
  const { openMenu, closeMenu } = usePanelContextMenu();
  const sha = entry.commit_id;

  return (
    <button
      onClick={onActivate}
      onContextMenu={(e) => openMenu(e, renderMenu(entry, closeMenu))}
      aria-current={selected ? "true" : undefined}
      title={`${sha.slice(0, 8)} · ${entry.author} · ${entry.summary}`}
      style={{
        display: "block",
        width: "100%",
        textAlign: "left",
        background: selected ? "var(--graph-row-selected-bg)" : "transparent",
        border: "none",
        borderBottom: "1px solid var(--panel-border)",
        padding: "0.333em 0.667em",
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
