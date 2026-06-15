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
