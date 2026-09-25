// The Commits graph's data model: lane assignments and edges for every row
// (real commits, injected stash nodes, and the synthetic working-dir row),
// plus the row-span lookups the renderer consumes. Pure derivation over the
// loaded rows; the panel keeps only view state.

import { useEffect, useMemo, useRef } from "react";
import type { VirtualItem } from "@tanstack/react-virtual";
import type { Commit, LaneLock } from "../../lib/types";
import { computeLanes } from "./graph/lanes";
import { computeEdgeSpans, computeStashConnectorSpans, type EdgeSpan, type StashConnectorSpan } from "./graph/spans";
import type { LaneEdge, LaneResult, LockMap, RefsAtCommit } from "./graph/types";
import { buildRefsAt, buildStashSelectorById } from "./commitRows";
import { WORKING_DIR_ID } from "./commitRows";

export function useGraphModel(args: {
  repoId: string;
  rows: readonly Commit[];
  commits: readonly Commit[];
  /** An author-filtered walk is an arbitrary subset: the graph column hides
   * and the lane walk is skipped entirely. */
  graphDisabled: boolean;
  lockMap: LockMap;
  rawLocks: readonly LaneLock[];
  stashBaseLaneColor: boolean;
}) {
  const { repoId, rows, commits, graphDisabled, lockMap, rawLocks, stashBaseLaneColor } = args;

  // refsAt map (commitId -> [refName,...]) from log decorations: branch and
  // tag refs feed the lane algorithm (via §H locks in Phase 6).
  const refsAt = useMemo((): RefsAtCommit => buildRefsAt(commits), [commits]);

  // Stash nodes (synthetic commits the backend injects into the log). Maps the
  // stash's commit id → its reflog selector (e.g. "stash@{0}"), driving the
  // distinct diamond dot and the stash context-menu actions.
  const stashSelectorById = useMemo(() => buildStashSelectorById(commits), [commits]);

  // Stability refs for load-more. previousAssignments are reused ONLY when the
  // new rows are a pure bottom-append of the previous ones (pagination): i.e.
  // the previous row ids are still an exact prefix. Any other change — a stash
  // created/dropped, the working-dir row appearing/disappearing, a branch op —
  // fails the prefix test and triggers a full recompute. (A length-only check
  // would misread a synthetic-node insertion as load-more and pin rows to
  // lanes that were chosen for a different graph shape.)
  const prevAssignmentsRef = useRef<Map<string, number> | undefined>(undefined);
  const prevRowIdsRef = useRef<string[] | undefined>(undefined);

  const resetPrevAssignments = () => {
    prevAssignmentsRef.current = undefined;
    prevRowIdsRef.current = undefined;
  };

  // Reset on repo or lock change — a full recompute is needed in both cases.
  useEffect(() => { resetPrevAssignments(); }, [repoId]);    // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { resetPrevAssignments(); }, [rawLocks]);  // eslint-disable-line react-hooks/exhaustive-deps

  // Lane assignments + edges for EVERY row — real commits, injected stash nodes,
  // and the synthetic working-dir row alike. Nothing is special-cased out of the
  // graph: each node's parents drive its lane and edges through the one
  // algorithm. The working-dir row hangs off HEAD and a stash hangs off its base
  // exactly as any childless commit would. Only the working-dir row is flagged
  // to inherit its parent's locked lane (it continues HEAD's line). Stashes
  // deliberately are NOT (revised 2026-08-06): they render on free side lanes
  // exactly as they do without a lock - flagging them piled every stash onto
  // the locked lane (design/2026-07-09-lane-lock-synthetic-nodes.md).
  const { assignments, edges: allEdges } = useMemo((): LaneResult => {
    const laneRows = graphDisabled ? [] : rows;
    const forGraph = laneRows.map((c) => ({
      id: c.id,
      parentIds: c.parents,
      inheritsParentLane: c.id === WORKING_DIR_ID || undefined,
    }));
    const prevIds = prevRowIdsRef.current;
    const isPrefixAppend =
      prevIds !== undefined &&
      prevAssignmentsRef.current !== undefined &&
      forGraph.length > prevIds.length &&
      prevIds.every((id, i) => id === forGraph[i].id);
    const result = computeLanes(
      forGraph,
      lockMap,
      refsAt,
      isPrefixAppend ? prevAssignmentsRef.current : undefined,
    );
    prevAssignmentsRef.current = result.assignments;
    prevRowIdsRef.current = forGraph.map((c) => c.id);
    return result;
  }, [rows, graphDisabled, lockMap, refsAt, stashSelectorById]);

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

  // Stash-connector spans (stash_base_lane_color): the stash's dying lane
  // paints in the base's colour across the rows it spans — the pass-throughs
  // in between and the jog arc at the base row (GraphCell laneColorOverrides).
  const stashConnectorSpans = useMemo(
    () =>
      stashBaseLaneColor
        ? computeStashConnectorSpans(
            rows,
            new Set(stashSelectorById.keys()),
            assignments,
            commitIndexById,
          )
        : [],
    [stashBaseLaneColor, rows, stashSelectorById, assignments, commitIndexById],
  );

  return {
    refsAt,
    stashSelectorById,
    assignments,
    edgesByCommit,
    incomingEdgesByCommit,
    commitIndexById,
    edgeSpans,
    stashConnectorSpans,
  };
}

/** The widest lane any visible row touches: each row's own lane plus every
 * lane with a live edge spanning it. Drives the graph column's width. */
export function maxVisibleLaneFor(
  visibleItems: readonly VirtualItem[],
  rows: readonly Commit[],
  assignments: ReadonlyMap<string, number>,
  edgeSpans: readonly EdgeSpan[],
): number {
  let max = 0;
  for (const vItem of visibleItems) {
    const rowIndex = vItem.index;
    const c = rows[rowIndex];
    if (!c) continue;
    const lane = assignments.get(c.id) ?? 0;
    if (lane > max) max = lane;
    for (const span of edgeSpans) {
      if (span.fromRow < rowIndex && rowIndex < span.toRow && span.lane > max) {
        max = span.lane;
      }
    }
  }
  return max;
}

export type { EdgeSpan, StashConnectorSpan };
