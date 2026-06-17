import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useActiveRepo } from "../../store/repos";
import {
  useSettingsStore,
  COMMITS_ROW_HEIGHT_DEFAULT,
  COMMITS_LANE_WIDTH_DEFAULT,
  COMMITS_DOT_RADIUS_DEFAULT,
  COMMITS_LINE_WIDTH_DEFAULT,
  COMMITS_TEXT_SIZE_DEFAULT,
} from "../../store/settings";
import { useLaneLocks, useLaneLocksStore } from "../../store/laneLocks";
import { usePanelFocusEffect } from "../PanelApiContext";
import { useSummonStore } from "../../store/summon";
import { PanelLoadingBar } from "../shared/PanelLoadingBar";
import { invalidateRepoDomains } from "../../lib/repoInvalidation";
import { repoBranches, repoLog, repoStatus } from "../../lib/commands";
import type { Branch, Commit, CommitId, FileStatus, Signature } from "../../lib/types";
import { formatAppError } from "../../lib/types";
import { formatRelative } from "../../lib/time";
import { RefsCell } from "./cells/RefsCell";
import { SignatureBadge } from "./cells/SignatureBadge";
import { GraphCell, laneColor } from "./cells/GraphCell";
import { computeLanes } from "./graph/lanes";
import { computeEdgeSpans } from "./graph/spans";
import type { LaneEdge, LaneIndex, LaneResult, LockMap, RefsAtCommit } from "./graph/types";
import { useColumnState } from "./columns/useColumnState";
import { ColumnHeader } from "./columns/ColumnHeader";
import { LaneLockIndicator } from "./LaneLockIndicator";
import { PanelContextMenuProvider, type BaselineEntry } from "./menu/PanelContextMenu";
import {
  DEFAULT_WIDTHS,
  NON_HIDEABLE,
  NON_RESIZABLE,
} from "./columns/types";
import type { ColumnId } from "./columns/types";

const COLUMN_LABELS: Record<ColumnId, string> = {
  refs: "Refs",
  graph: "Graph",
  subject: "Subject",
  date: "Date",
  author: "Author",
  sha: "SHA",
};

// Line height (ROW_HEIGHT) and per-lane horizontal spacing (LANE_SPACING) are
// user-configurable via Global Settings; the values below are only the
// fallbacks used until the settings store has loaded. Both feed the layout:
// ROW_HEIGHT drives the virtualizer + grid row height, LANE_SPACING drives the
// graph column width and lock-indicator positions.
//
// Note on ROW_HEIGHT: rows carry no vertical padding so the SVG fills the full
// height and graph lines connect seamlessly between adjacent rows. Must NOT use
// vItem.size for the row height because vItem.size is the measured border-box
// height, which would create an infinite growth loop via measureElement.

const PAGE_SIZE = 500;

// Sentinel id for the synthetic "uncommitted changes" row prepended above HEAD.
// Chosen to never collide with a real 40-hex commit id.
export const WORKING_DIR_ID = "__legit_working_dir__";

// Placeholder signature for the synthetic working-dir row. Its author/date
// columns are rendered blank, so these values are never shown.
const EMPTY_SIGNATURE: Signature = {
  name: "",
  email: "",
  timestamp: 0,
  tz_offset_minutes: 0,
};

/** Commits panel — virtualised, multi-column log of commits for the active repo. */
export function CommitsPanel() {
  const repo = useActiveRepo();
  const queryClient = useQueryClient();

  // User-configurable graph metrics (Global Settings). Fall back to defaults
  // until the settings store has loaded.
  const ROW_HEIGHT = useSettingsStore(
    (s) => s.settings?.commits_row_height ?? COMMITS_ROW_HEIGHT_DEFAULT,
  );
  const LANE_SPACING = useSettingsStore(
    (s) => s.settings?.commits_lane_width ?? COMMITS_LANE_WIDTH_DEFAULT,
  );
  const DOT_RADIUS = useSettingsStore(
    (s) => s.settings?.commits_dot_radius ?? COMMITS_DOT_RADIUS_DEFAULT,
  );
  const LINE_WIDTH = useSettingsStore(
    (s) => s.settings?.commits_line_width ?? COMMITS_LINE_WIDTH_DEFAULT,
  );
  const TEXT_SIZE = useSettingsStore(
    (s) => s.settings?.commits_text_size ?? COMMITS_TEXT_SIZE_DEFAULT,
  );

  const [selectedId, setSelectedId] = useState<CommitId | null>(null);
  const [extraPages, setExtraPages] = useState(0);
  const parentRef = useRef<HTMLDivElement>(null);

  // Column ordering, hiding, and widths — read from global settings on mount
  // and persisted (debounced) via `save_column_preferences`.
  const { state: colState, setOrder, setHidden, setWidth } = useColumnState();

  const totalToFetch = PAGE_SIZE * (1 + extraPages);

  // Load lane locks on mount / when the active repo changes.
  const loadLocks = useLaneLocksStore((s) => s.loadLocks);
  useEffect(() => {
    if (repo) loadLocks(repo.id);
  }, [repo?.id, loadLocks]);

  // Raw lock list from the store; used by the Refs context menu UI.
  const rawLocks = useLaneLocks(repo?.id ?? "");

  // Build a conflict-free LockMap for the lane algorithm. §H.5 says the
  // backend storage is permissive; if two locks claim the same lane (e.g.
  // from a hand-edited settings.json), the first one wins.
  const lockMap = useMemo((): LockMap => {
    const map: LockMap = {};
    const claimedLanes = new Set<number>();
    for (const lock of rawLocks) {
      if (claimedLanes.has(lock.laneIndex)) {
        console.warn(
          `[LeGit] Lane lock conflict: lane ${lock.laneIndex} claimed by "${lock.refName}" ` +
          `but already held by "${Object.entries(map).find(([, v]) => v === lock.laneIndex)?.[0]}". ` +
          `Ignoring this lock. Edit repo settings to resolve.`
        );
        continue;
      }
      map[lock.refName] = lock.laneIndex;
      claimedLanes.add(lock.laneIndex);
    }
    return map;
  }, [rawLocks]);

  const queryKey = [repo?.id, "log", totalToFetch];

  const { data: commits = [], isFetching, isError, error } = useQuery<Commit[]>({
    queryKey,
    queryFn: () => repoLog(repo!.id, totalToFetch, 0),
    enabled: !!repo,
    staleTime: 5_000,
    // Keep the current (smaller) page rendered while the larger page fetches.
    // Without this, the new totalToFetch query key has no cached data, the list
    // collapses to zero height, and the scroll position jumps back to the top.
    placeholderData: keepPreviousData,
  });

  // Branch list (for upstream tracking). Drives chip fusion: a local branch
  // and its configured upstream remote collapse into one chip when both sit on
  // the same commit.
  const { data: branches = [] } = useQuery<Branch[]>({
    queryKey: [repo?.id, "branches"],
    queryFn: () => repoBranches(repo!.id),
    enabled: !!repo,
    staleTime: 5_000,
  });

  // Working-tree status — drives the synthetic "uncommitted changes" row.
  const { data: status = [] } = useQuery<FileStatus[]>({
    queryKey: [repo?.id, "status"],
    queryFn: () => repoStatus(repo!.id),
    enabled: !!repo,
    staleTime: 5_000,
  });

  // Full local ref → full upstream ref (e.g. refs/heads/dev → refs/remotes/origin/dev).
  const upstreamMap = useMemo((): Map<string, string> => {
    const map = new Map<string, string>();
    for (const b of branches) {
      if (!b.is_remote && b.upstream) {
        map.set(`refs/heads/${b.name}`, b.upstream);
      }
    }
    return map;
  }, [branches]);

  const refetch = useCallback(() => {
    if (repo) {
      invalidateRepoDomains(queryClient, repo.id, ["log", "branches", "status"]);
    }
  }, [repo, queryClient]);

  usePanelFocusEffect(refetch);

  // Baseline context-menu entries — present on every right-click in the panel,
  // regardless of what was clicked.
  const baseline = useMemo<BaselineEntry[]>(
    () => [{ label: "Refresh", onClick: refetch, disabled: isFetching }],
    [refetch, isFetching],
  );

  // HEAD commit id — the parent of the synthetic working-dir row. Found from
  // log decorations (`HEAD` when detached, `HEAD -> branch` otherwise); falls
  // back to the newest loaded commit if no HEAD decoration is in the window.
  const headId = useMemo((): CommitId | null => {
    for (const c of commits) {
      for (const dec of c.decorations ?? []) {
        if (dec.type === "head" || dec.type === "headOf") return c.id;
      }
    }
    return commits[0]?.id ?? null;
  }, [commits]);

  // Synthetic "uncommitted changes" row, present only when the working tree is
  // dirty and a HEAD commit is known. Its node renders as a hollow ring.
  const workingDirRow = useMemo((): Commit | null => {
    if (status.length === 0 || headId === null) return null;
    const noun = status.length === 1 ? "file" : "files";
    return {
      id: WORKING_DIR_ID,
      parents: [headId],
      author: EMPTY_SIGNATURE,
      committer: EMPTY_SIGNATURE,
      message: `Uncommitted changes (${status.length} ${noun})`,
      timestamp: 0,
      signature: null,
      decorations: [],
    };
  }, [status.length, headId]);

  // Rows actually rendered: the synthetic row (when present) above the real
  // commits. Lane layout is computed on `commits` for stability, then augmented
  // with the synthetic node — so paging/recompute never see it.
  const rows = useMemo(
    () => (workingDirRow ? [workingDirRow, ...commits] : commits),
    [workingDirRow, commits],
  );

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  });

  // estimateSize closes over ROW_HEIGHT; re-measure when the user changes the
  // configured line height so existing rows pick up the new size.
  useEffect(() => {
    rowVirtualizer.measure();
  }, [ROW_HEIGHT, rowVirtualizer]);

  // Build the refsAt map (commitId -> [refName,...]) from log decorations.
  // Branch and tag refs feed the lane algorithm (via §H locks in Phase 6).
  const refsAt = useMemo((): RefsAtCommit => {
    const map = new Map<string, string[]>();
    for (const commit of commits) {
      const refs: string[] = [];
      for (const dec of commit.decorations ?? []) {
        // `headOf` carries the checked-out branch's ref — git folds it into
        // `HEAD -> refs/heads/x` and emits no separate `branch` decoration, so
        // include it here or a lock on the current branch reserves an empty lane.
        if (dec.type === "branch" || dec.type === "headOf") refs.push(dec.value);
        else if (dec.type === "tag") refs.push(dec.value);
      }
      if (refs.length > 0) map.set(commit.id, refs);
    }
    return map;
  }, [commits]);

  // Stability refs for load-more. previousAssignments are only passed to
  // computeLanes when the commit window GREW (load-more) — never on a
  // same-size recompute (refresh, lock change, etc.). Passing them on a
  // recompute of the same commits would set firstNewIndex = commits.length,
  // causing the walk to skip all commits and produce zero edges.
  const prevAssignmentsRef = useRef<Map<string, number> | undefined>(undefined);
  const prevCommitLengthRef = useRef(0);

  const resetPrevAssignments = () => {
    prevAssignmentsRef.current = undefined;
    prevCommitLengthRef.current = 0;
  };

  // Reset on repo or lock change — a full recompute is needed in both cases.
  useEffect(() => { resetPrevAssignments(); }, [repo?.id]);    // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { resetPrevAssignments(); }, [rawLocks]);    // eslint-disable-line react-hooks/exhaustive-deps

  // Compute lane assignments + edges. The persisted lock map for the active
  // repo feeds lane reservation; the lookahead algorithm handles the rest.
  const laneResult = useMemo((): LaneResult => {
    const forGraph = commits.map((c) => ({ id: c.id, parentIds: c.parents }));
    // Only use previous assignments on genuine load-more (commit count grew).
    const isLoadMore =
      commits.length > prevCommitLengthRef.current &&
      prevAssignmentsRef.current !== undefined;
    const result = computeLanes(forGraph, lockMap, refsAt, isLoadMore ? prevAssignmentsRef.current : undefined);
    prevAssignmentsRef.current = result.assignments;
    prevCommitLengthRef.current = commits.length;
    return result;
  }, [commits, lockMap, refsAt]);

  // Augment the lane result with the synthetic node: pin it to HEAD's lane and
  // add a same-lane edge down to HEAD, so a clean vertical connector joins them.
  const { assignments, edges: allEdges } = useMemo((): LaneResult => {
    if (!workingDirRow || headId === null) return laneResult;
    const headLane = laneResult.assignments.get(headId) ?? 0;
    const assignments = new Map(laneResult.assignments);
    assignments.set(WORKING_DIR_ID, headLane);
    const edges: LaneEdge[] = [
      ...laneResult.edges,
      { fromCommitId: WORKING_DIR_ID, toCommitId: headId, fromLane: headLane, toLane: headLane },
    ];
    return { assignments, edges, maxLane: Math.max(laneResult.maxLane, headLane) };
  }, [laneResult, workingDirRow, headId]);

  // Outgoing edge lookup: edges originating at each commit (child → parent).
  const edgesByCommit = useMemo(() => {
    const map = new Map<string, LaneEdge[]>();
    for (const edge of allEdges) {
      const arr = map.get(edge.fromCommitId) ?? [];
      arr.push(edge);
      map.set(edge.fromCommitId, arr);
    }
    return map;
  }, [allEdges]);

  // Incoming edge lookup: all edges arriving at each commit as parent.
  // GraphCell derives the top stub and jog arcs from these.
  const incomingEdgesByCommit = useMemo(() => {
    const map = new Map<string, LaneEdge[]>();
    for (const edge of allEdges) {
      const arr = map.get(edge.toCommitId) ?? [];
      arr.push(edge);
      map.set(edge.toCommitId, arr);
    }
    return map;
  }, [allEdges]);


  // Maps commitId → row index. Used to convert edges into row-span records.
  const commitIndexById = useMemo(
    () => new Map(rows.map((c, i) => [c.id, i])),
    [rows],
  );

  // Edge spans: for each edge, the lane that is "active" (waiting for the
  // parent commit) for the rows strictly between the two commit rows.
  const edgeSpans = useMemo(
    () => computeEdgeSpans(allEdges, commitIndexById, rows.length),
    [allEdges, commitIndexById, rows.length],
  );

  // Dynamic column width. getVirtualItems() always returns a new array
  // reference so we compute inline; also include active pass-through lanes
  // so the column is wide enough when a pass-through lane is wider than any
  // visible commit lane.
  const visibleItems = rowVirtualizer.getVirtualItems();

  // More commits may exist when the backend returned a full page. Once it
  // returns fewer than requested, the end of history has been reached.
  const hasMore = commits.length >= totalToFetch;

  // Infinite scroll: grow the fetch window when the user scrolls the last row
  // into view. The growing queryKey turns `isFetching` true, which guards
  // against re-triggering until the new page has arrived; once the taller list
  // renders, the last row is no longer in view, so it won't auto-page forever.
  const lastVisibleIndex = visibleItems[visibleItems.length - 1]?.index ?? 0;
  useEffect(() => {
    if (hasMore && !isFetching && lastVisibleIndex >= rows.length - 1) {
      setExtraPages((n) => n + 1);
    }
  }, [hasMore, isFetching, lastVisibleIndex, rows.length]);

  let maxVisibleLane = 0;
  for (const vItem of visibleItems) {
    const rowIndex = vItem.index;
    const c = rows[rowIndex];
    if (!c) continue;
    const lane = assignments.get(c.id) ?? 0;
    if (lane > maxVisibleLane) maxVisibleLane = lane;
    for (const span of edgeSpans) {
      if (span.fromRow < rowIndex && rowIndex < span.toRow && span.lane > maxVisibleLane) {
        maxVisibleLane = span.lane;
      }
    }
  }

  const handleRowClick = useCallback(
    (commit: Commit) => {
      setSelectedId(commit.id);
      const summon = useSummonStore.getState();
      if (commit.id === WORKING_DIR_ID) {
        // Working-dir row → show the staging/commit panel in the shared side
        // slot (swapping out Changed Files). No commit-details for the index.
        summon.swapSummon("working-changes", "changed-files");
        return;
      }
      summon.summon("commit-details", commit.id);
      // Show Changed Files in the shared slot (swapping out Working Changes).
      summon.swapSummon("changed-files", "working-changes", commit.id);
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

  // Grid column layout — driven by `colState` (order + widths + hidden).
  // The Graph column's width tracks the maximum visible lane; Subject is
  // always the elastic "1fr" filler. All others use the persisted px width
  // (or DEFAULT_WIDTHS if not yet set).
  const graphColWidth = (maxVisibleLane + 2) * LANE_SPACING;
  const visibleColumns = colState.order.filter(
    (id) => !colState.hidden.includes(id)
  );

  function colWidth(id: ColumnId): string {
    if (id === "graph") return `${graphColWidth}px`;
    if (id === "subject") return "1fr";
    const w = colState.widths[id] ?? DEFAULT_WIDTHS[id] ?? 100;
    return `${w}px`;
  }

  const GRID_COLUMNS = visibleColumns.map(colWidth).join(" ");

  const handleReorder = (
    draggedId: ColumnId,
    targetId: ColumnId,
    side: "left" | "right"
  ) => {
    if (draggedId === targetId) return;
    const newOrder = [...colState.order];
    const fromIdx = newOrder.indexOf(draggedId);
    if (fromIdx === -1) return;
    newOrder.splice(fromIdx, 1);
    const toIdx = newOrder.indexOf(targetId);
    if (toIdx === -1) return;
    const insertAt = toIdx + (side === "right" ? 1 : 0);
    newOrder.splice(insertAt, 0, draggedId);
    setOrder(newOrder);
  };
  const handleHide = (id: ColumnId) => {
    if (colState.hidden.includes(id)) return;
    setHidden([...colState.hidden, id]);
  };
  const handleShow = (id: ColumnId) =>
    setHidden(colState.hidden.filter((h) => h !== id));

  return (
    <PanelContextMenuProvider baseline={baseline}>
      {({ openMenu }) => (
        <div
          className="legit-panel"
          style={{ display: "flex", flexDirection: "column" }}
          // Catch-all: any right-click that isn't handled by a more specific
          // target (chip, header, graph cell) opens the baseline-only menu and
          // suppresses the native browser menu.
          onContextMenu={(e) => openMenu(e)}
        >
      {/* Loading indicator — thin top-edge bar, no layout shift. Refresh lives
          in the panel context menu (baseline entry). */}
      <PanelLoadingBar active={isFetching} />

      {isError && (
        <pre className="legit-error" style={{ margin: "8px 12px", fontSize: "var(--fz-md)" }}>
          {formatAppError(error)}
        </pre>
      )}

      {/* Column headers — sticky above the virtualised list */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: GRID_COLUMNS,
          gap: "0 8px",
          padding: "3px 12px",
          borderBottom: "1px solid var(--panel-border, rgba(255,255,255,0.10))",
          background: "var(--panel-bg, transparent)",
          position: "sticky",
          top: 0,
          zIndex: 1,
          minHeight: 22,
        }}
      >
        {visibleColumns.map((colId, colIndex) =>
          colId === "graph" ? (
            <div key="graph-header" style={{ position: "relative", overflow: "hidden" }}>
              <ColumnHeader
                colId={colId}
                // Header label intentionally blank; the graph column needs no
                // title. COLUMN_LABELS.graph is still used for the show/hide menu.
                label=""
                width={colWidth(colId)}
                isDraggable={true}
                isResizable={!NON_RESIZABLE.includes(colId)}
                isHideable={!NON_HIDEABLE.includes(colId)}
                order={colState.order}
                hidden={colState.hidden}
                labels={COLUMN_LABELS}
                onReorder={handleReorder}
                onHide={handleHide}
                onShow={handleShow}
                onResizeEnd={(id, w) => setWidth(id, w)}
                showSeparator={colIndex < visibleColumns.length - 1}
              />
              {/* Lock indicators: a lock icon per locked lane visible in the
                  current window (§F.7); click it to remove the lock. */}
              {rawLocks.map((lock) => {
                const laneIdx = lockMap[lock.refName];
                if (laneIdx === undefined) return null;
                return (
                  <LaneLockIndicator
                    key={lock.refName}
                    refName={lock.refName}
                    laneIndex={laneIdx}
                    laneSpacing={LANE_SPACING}
                    repoId={repo.id}
                    color={laneColor(laneIdx)}
                  />
                );
              })}
            </div>
          ) : (
            <ColumnHeader
              key={colId}
              colId={colId}
              label={COLUMN_LABELS[colId]}
              width={colWidth(colId)}
              isDraggable={true}
              isResizable={!NON_RESIZABLE.includes(colId)}
              isHideable={!NON_HIDEABLE.includes(colId)}
              order={colState.order}
              hidden={colState.hidden}
              labels={COLUMN_LABELS}
              onReorder={handleReorder}
              onHide={handleHide}
              onShow={handleShow}
              onResizeEnd={(id, w) => setWidth(id, w)}
              showSeparator={colIndex < visibleColumns.length - 1}
            />
          )
        )}
      </div>

      {/* Virtualised rows. A little top padding keeps the first row clear of
          the header so a tall chip on the top commit isn't clipped against it;
          it scrolls away with the content. */}
      <div
        ref={parentRef}
        style={{ flex: 1, overflow: "auto", position: "relative", paddingTop: 4 }}
      >
        <div
          style={{
            height: rowVirtualizer.getTotalSize(),
            width: "100%",
            position: "relative",
          }}
        >
          {visibleItems.map((vItem) => {
            const rowIndex = vItem.index;
            const commit = rows[rowIndex];
            const isSelected = commit.id === selectedId;
            const isWorkingDir = commit.id === WORKING_DIR_ID;
            const commitLane = assignments.get(commit.id) ?? 0;
            const edges = edgesByCommit.get(commit.id) ?? [];

            // Active lanes at this row: the commit's own lane plus every lane
            // that has a live edge spanning this row (strictly between its two
            // commit rows). Pass-through lines are drawn only for these lanes.
            // A span on the commit's *own* lane is suppressed as a pass-through
            // (to avoid double-drawing) but must still render the own-lane
            // vertical full height — flagged via `ownLanePassThrough`.
            const activeLanes = new Set<LaneIndex>([commitLane]);
            let ownLanePassThrough = false;
            for (const span of edgeSpans) {
              if (span.fromRow < rowIndex && rowIndex < span.toRow) {
                activeLanes.add(span.lane);
                if (span.lane === commitLane) ownLanePassThrough = true;
              }
            }
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
                  paddingLeft: 12,
                  paddingRight: 12,
                  cursor: "pointer",
                  background: isSelected
                    ? "var(--graph-row-selected-bg, rgba(255,255,255,0.08))"
                    : "transparent",
                  display: "grid",
                  gridTemplateColumns: GRID_COLUMNS,
                  gap: "0 8px",
                  alignItems: "center",
                  height: ROW_HEIGHT,
                }}
              >
                {visibleColumns.map((colId) => {
                  switch (colId) {
                    case "refs":
                      return (
                        <div key="refs" style={{ overflow: "hidden" }}>
                          <RefsCell
                            decorations={commit.decorations ?? []}
                            locks={rawLocks}
                            repoId={repo.id}
                            upstreamMap={upstreamMap}
                            textSize={TEXT_SIZE}
                          />
                        </div>
                      );
                    case "graph":
                      return (
                        <div
                          key="graph"
                          style={{
                            overflow: "visible",
                            alignSelf: "stretch",
                            display: "flex",
                            alignItems: "stretch",
                          }}
                        >
                          <GraphCell
                            commitId={commit.id}
                            commitLane={commitLane}
                            totalLanes={maxVisibleLane + 1}
                            activeLanes={activeLanes}
                            edges={edges}
                            incomingEdges={incomingEdgesByCommit.get(commit.id) ?? []}
                            rowHeight={ROW_HEIGHT}
                            laneSpacing={LANE_SPACING}
                            dotRadius={DOT_RADIUS}
                            lineWidth={LINE_WIDTH}
                            ownLanePassThrough={ownLanePassThrough}
                            hollow={isWorkingDir}
                          />
                        </div>
                      );
                    case "subject":
                      return (
                        <span
                          key="subject"
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 5,
                            fontSize: TEXT_SIZE,
                            fontStyle: isWorkingDir ? "italic" : undefined,
                            overflow: "hidden",
                          }}
                        >
                          {!isWorkingDir && (
                            <SignatureBadge signature={commit.signature} size={TEXT_SIZE} />
                          )}
                          <span
                            style={{
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {subjectOf(commit.message)}
                          </span>
                        </span>
                      );
                    case "date":
                      return (
                        <span
                          key="date"
                          style={{
                            fontSize: TEXT_SIZE,
                            color: "var(--subtle-fg)",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {isWorkingDir ? "" : formatRelative(commit.timestamp)}
                        </span>
                      );
                    case "author":
                      return (
                        <span
                          key="author"
                          style={{
                            fontSize: TEXT_SIZE,
                            color: "var(--subtle-fg)",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {isWorkingDir ? "" : commit.author.name}
                        </span>
                      );
                    case "sha":
                      return (
                        <span
                          key="sha"
                          style={{
                            fontSize: TEXT_SIZE,
                            color: "var(--subtle-fg)",
                            fontFamily: "monospace",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {isWorkingDir ? "" : commit.id.slice(0, 8)}
                        </span>
                      );
                    default:
                      return null;
                  }
                })}
              </div>
            );
          })}
        </div>
      </div>

      {/* Auto-loads the next page as the last row scrolls into view; the
          spinner indicates that fetch is in flight. */}
      {hasMore && isFetching && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
            padding: "8px 12px",
            borderTop: "1px solid var(--panel-border)",
          }}
        >
          <span className="legit-spinner" aria-hidden="true" />
          <span className="legit-subtle" style={{ fontSize: "var(--fz-sm)" }}>
            Loading more…
          </span>
        </div>
      )}
        </div>
      )}
    </PanelContextMenuProvider>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function subjectOf(message: string): string {
  return message.split("\n")[0] ?? "";
}
