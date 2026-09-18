// Edge → row-span conversion for the Commits panel graph column.
//
// A span marks the rows that must keep a pass-through line alive on the
// edge's target lane: every row strictly between the child commit's row and
// the parent commit's row. The cross-lane transition itself is rendered in
// the child's row (see cells/GraphCell.tsx), so intermediate rows always run
// on `toLane`.

import type { LaneEdge, LaneIndex } from "./types";

export interface EdgeSpan {
  fromRow: number;
  toRow: number;
  lane: LaneIndex;
}

/**
 * Computes pass-through spans for the given edges.
 *
 * Edges whose parent commit is not in the loaded window (the parent sits
 * beyond the load-more boundary) extend to `commitCount` so the lane line
 * continues to the bottom of the window instead of dead-ending half a row
 * below the child. Edges without intermediate rows (adjacent rows, self
 * edges) produce no span — the row-local stubs and arcs cover those.
 */
export function computeEdgeSpans(
  edges: LaneEdge[],
  rowIndexById: Map<string, number>,
  commitCount: number,
): EdgeSpan[] {
  const spans: EdgeSpan[] = [];
  for (const edge of edges) {
    const fromRow = rowIndexById.get(edge.fromCommitId) ?? -1;
    if (fromRow < 0) continue;
    const toRow = rowIndexById.get(edge.toCommitId) ?? commitCount;
    if (toRow - fromRow < 2) continue;
    spans.push({ fromRow, toRow, lane: edge.toLane });
  }
  return spans;
}

export interface StashConnectorSpan {
  /** The stash's row. */
  fromRow: number;
  /** The base commit's row. */
  toRow: number;
  /** The stash's lane — the lane the connector rides down and dies on. */
  lane: LaneIndex;
  /** The base commit's lane — the colour the connector paints in. */
  baseLane: LaneIndex;
}

/**
 * Stash-connector spans for the `stash_base_lane_color` setting: a stash's
 * first-parent edge rides the stash's OWN lane down to the base and dies
 * there as a jog (lanes.ts emits it same-lane), so painting the connector in
 * the base's colour touches rows the stash's own cell never draws — the
 * pass-through rows in between and the jog arc on the base's row. Stashes
 * whose base is outside the window, or already on the same lane, need no
 * recolouring and emit nothing.
 */
export function computeStashConnectorSpans(
  rows: readonly { id: string; parents: readonly string[] }[],
  stashIds: ReadonlySet<string>,
  assignments: Map<string, LaneIndex>,
  rowIndexById: Map<string, number>,
): StashConnectorSpan[] {
  const spans: StashConnectorSpan[] = [];
  for (const row of rows) {
    if (!stashIds.has(row.id)) continue;
    const base = row.parents[0];
    if (base === undefined) continue;
    const fromRow = rowIndexById.get(row.id);
    const toRow = rowIndexById.get(base);
    const lane = assignments.get(row.id);
    const baseLane = assignments.get(base);
    if (fromRow === undefined || toRow === undefined) continue;
    if (lane === undefined || baseLane === undefined || lane === baseLane) continue;
    spans.push({ fromRow, toRow, lane, baseLane });
  }
  return spans;
}
