import { describe, expect, it } from "vitest";
import { computeEdgeSpans, computeStashConnectorSpans } from "./spans";
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

describe("computeStashConnectorSpans", () => {
  const rows = [
    { id: "stash", parents: ["base"] },
    { id: "x", parents: ["base"] },
    { id: "base", parents: [] },
  ];
  const rowIndexById = new Map(rows.map((r, i) => [r.id, i]));

  it("spans from the stash row to the base row on the stash's lane, carrying the base lane", () => {
    const assignments = new Map([
      ["stash", 2],
      ["x", 1],
      ["base", 0],
    ]);
    expect(
      computeStashConnectorSpans(rows, new Set(["stash"]), assignments, rowIndexById),
    ).toEqual([{ fromRow: 0, toRow: 2, lane: 2, baseLane: 0 }]);
  });

  it("skips stashes whose base shares the lane (nothing to recolour)", () => {
    const assignments = new Map([
      ["stash", 0],
      ["x", 1],
      ["base", 0],
    ]);
    expect(
      computeStashConnectorSpans(rows, new Set(["stash"]), assignments, rowIndexById),
    ).toEqual([]);
  });

  it("skips stashes whose base is outside the loaded window", () => {
    const orphanRows = [{ id: "stash", parents: ["unloaded"] }];
    expect(
      computeStashConnectorSpans(
        orphanRows,
        new Set(["stash"]),
        new Map([["stash", 2]]),
        new Map([["stash", 0]]),
      ),
    ).toEqual([]);
  });

  it("skips parentless stash rows and non-stash rows", () => {
    const assignments = new Map([
      ["stash", 2],
      ["x", 1],
      ["base", 0],
    ]);
    expect(
      computeStashConnectorSpans(
        [{ id: "stash", parents: [] }],
        new Set(["stash"]),
        assignments,
        new Map([["stash", 0]]),
      ),
    ).toEqual([]);
    expect(computeStashConnectorSpans(rows, new Set(), assignments, rowIndexById)).toEqual([]);
  });
});
