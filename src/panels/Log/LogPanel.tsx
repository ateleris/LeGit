import { useCallback, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useActiveRepo } from "../../store/repos";
import { usePanelFocusEffect } from "../PanelApiContext";
import { useSummonStore } from "../../store/summon";
import { PanelLoadingBar } from "../shared/PanelLoadingBar";
import { repoLog } from "../../lib/commands";
import type { Commit, CommitId } from "../../lib/types";
import { formatAppError } from "../../lib/types";
import { formatRelative } from "../../lib/time";

const PAGE_SIZE = 500;

/** Log panel — flat, virtualised list of commits for the active repo. */
export function LogPanel() {
  const repo = useActiveRepo();
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<CommitId | null>(null);
  const [extraPages, setExtraPages] = useState(0);
  const parentRef = useRef<HTMLDivElement>(null);

  const totalToFetch = PAGE_SIZE * (1 + extraPages);

  const queryKey = [repo?.id, "log", totalToFetch];

  const { data: commits = [], isFetching, isError, error } = useQuery<Commit[]>({
    queryKey,
    queryFn: () => repoLog(repo!.id, totalToFetch, 0),
    enabled: !!repo,
    staleTime: 5_000,
  });

  const refetch = useCallback(() => {
    if (repo) queryClient.invalidateQueries({ queryKey: [repo.id, "log"] });
  }, [repo, queryClient]);

  usePanelFocusEffect(refetch);

  const rowVirtualizer = useVirtualizer({
    count: commits.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 40,
    overscan: 10,
  });

  const handleRowClick = useCallback(
    (commit: Commit) => {
      setSelectedId(commit.id);
      useSummonStore.getState().summon("commit-details", commit.id);
    },
    []
  );

  if (!repo) {
    return (
      <div className="legit-panel">
        <div className="legit-panel__body">
          <span className="legit-subtle">No repo open.</span>
        </div>
      </div>
    );
  }

  return (
    <div className="legit-panel" style={{ display: "flex", flexDirection: "column" }}>
      <PanelLoadingBar active={isFetching} />
      <div className="legit-panel__toolbar" style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <strong>Log</strong>
        <button style={{ marginLeft: "auto" }} onClick={refetch} disabled={isFetching}>
          Refresh
        </button>
      </div>

      {isError && (
        <pre className="legit-error" style={{ margin: "8px 12px", fontSize: "var(--fz-md)" }}>
          {formatAppError(error)}
        </pre>
      )}

      <div
        ref={parentRef}
        style={{ flex: 1, overflow: "auto", position: "relative" }}
      >
        <div
          style={{
            height: rowVirtualizer.getTotalSize(),
            width: "100%",
            position: "relative",
          }}
        >
          {rowVirtualizer.getVirtualItems().map((vItem) => {
            const commit = commits[vItem.index];
            const isSelected = commit.id === selectedId;
            return (
              <div
                key={vItem.key}
                data-index={vItem.index}
                ref={rowVirtualizer.measureElement}
                onClick={() => handleRowClick(commit)}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${vItem.start}px)`,
                  padding: "6px 12px",
                  cursor: "pointer",
                  background: isSelected
                    ? "var(--tab-active-bg, rgba(255,255,255,0.08))"
                    : "transparent",
                  borderBottom: "1px solid var(--panel-border, rgba(255,255,255,0.06))",
                  display: "grid",
                  gridTemplateColumns: "64px 1fr 140px 80px",
                  gap: "0 8px",
                  alignItems: "center",
                }}
              >
                <code style={{ fontSize: "var(--fz-sm)", color: "var(--subtle-fg)", whiteSpace: "nowrap" }}>
                  {commit.id.slice(0, 7)}
                </code>
                <span style={{ fontSize: "var(--fz-md)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {subjectOf(commit.message)}
                </span>
                <span style={{ fontSize: "var(--fz-sm)", color: "var(--subtle-fg)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {commit.author.name}
                </span>
                <span style={{ fontSize: "var(--fz-sm)", color: "var(--subtle-fg)", textAlign: "right", whiteSpace: "nowrap" }}>
                  {formatRelative(commit.timestamp)}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {commits.length >= totalToFetch && (
        <div style={{ padding: "8px 12px", borderTop: "1px solid var(--panel-border)" }}>
          <button onClick={() => setExtraPages((n) => n + 1)} disabled={isFetching}>
            Load more
          </button>
        </div>
      )}
    </div>
  );
}

function subjectOf(message: string): string {
  return message.split("\n")[0] ?? "";
}
