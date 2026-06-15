import { describe, expect, it } from "vitest";
import { computeEdgeSpans } from "./spans";
import type { LaneEdge } from "./types";

function edge(
  fromCommitId: string,
  toCommitId: string,
  fromLane: number,
  toLane: number,
): LaneEdge {
  return { fromCommitId, toCommitId, fromLane, toLane };
}

const rowIndex = new Map([
  ["a", 0],
  ["b", 1],
  ["c", 2],
  ["d", 3],
]);

describe("computeEdgeSpans", () => {
  it("emits a span on the target lane for edges with intermediate rows", () => {
    const spans = computeEdgeSpans([edge("a", "c", 0, 1)], rowIndex, 4);
    expect(spans).toEqual([{ fromRow: 0, toRow: 2, lane: 1 }]);
  });

  it("skips adjacent-row edges (no intermediate rows)", () => {
    expect(computeEdgeSpans([edge("a", "b", 0, 1)], rowIndex, 4)).toEqual([]);
  });

  it("skips self (jog) edges", () => {
    expect(computeEdgeSpans([edge("b", "b", 1, 0)], rowIndex, 4)).toEqual([]);
  });

  it("extends spans to the bottom of the window when the parent is not loaded", () => {
    const spans = computeEdgeSpans([edge("b", "unloaded", 1, 1)], rowIndex, 4);
    expect(spans).toEqual([{ fromRow: 1, toRow: 4, lane: 1 }]);
  });

  it("ignores edges whose child is not in the window", () => {
    expect(computeEdgeSpans([edge("ghost", "c", 0, 0)], rowIndex, 4)).toEqual([]);
  });
});
