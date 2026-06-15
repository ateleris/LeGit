// Geometry tests for the Commits panel graph cell renderer.
//
// GraphCell is a pure function component — we call it directly and walk the
// returned React element tree, asserting which <line>/<path> primitives are
// emitted and their exact coordinates. Lane centers sit at x = lane*40 + 20;
// rows are 40px tall, so the dot row center (halfRow) is y = 20.

import { describe, expect, it } from "vitest";
import { GraphCell } from "./GraphCell";
import type { LaneEdge, LaneIndex } from "../graph/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Collect descendant elements of the given intrinsic type ("line", "path"…). */
function collect(node: unknown, type: string, out: any[] = []): any[] {
  if (node == null || typeof node === "boolean") return out;
  if (Array.isArray(node)) {
    for (const child of node) collect(child, type, out);
    return out;
  }
  const el = node as { type?: unknown; props?: { children?: unknown } };
  if (el.type === type) out.push(el);
  if (el.props && "children" in el.props) collect(el.props.children, type, out);
  return out;
}

function edge(
  fromCommitId: string,
  toCommitId: string,
  fromLane: LaneIndex,
  toLane: LaneIndex,
): LaneEdge {
  return { fromCommitId, toCommitId, fromLane, toLane };
}

interface CellArgs {
  commitLane: LaneIndex;
  edges?: LaneEdge[];
  incomingEdges?: LaneEdge[];
  activeLanes?: ReadonlySet<LaneIndex>;
  ownLanePassThrough?: boolean;
}

function renderCell({
  commitLane,
  edges = [],
  incomingEdges = [],
  activeLanes = new Set(),
  ownLanePassThrough = false,
}: CellArgs) {
  return GraphCell({
    commitId: "self",
    commitLane,
    totalLanes: 3,
    activeLanes,
    edges,
    incomingEdges,
    rowHeight: 40,
    laneSpacing: 40,
    dotRadius: 5,
    lineWidth: 1.5,
    ownLanePassThrough,
  });
}

const topStubAt = (lines: any[], x: number) =>
  lines.filter(
    (l) => l.props.x1 === x && l.props.x2 === x && l.props.y1 === 0 && l.props.y2 === 20,
  );

const bottomStubAt = (lines: any[], x: number) =>
  lines.filter(
    (l) => l.props.x1 === x && l.props.x2 === x && l.props.y1 === 20 && l.props.y2 === 40,
  );

// ---------------------------------------------------------------------------
// Cross-lane transitions are drawn exactly once, in the child row
// ---------------------------------------------------------------------------

describe("GraphCell cross-lane edges", () => {
  const mergeEdge = edge("self", "parent", 0, 1);

  it("child row draws the full transition arc, smooth into the lane below", () => {
    const cell = renderCell({ commitLane: 0, edges: [mergeEdge] });
    const paths = collect(cell, "path");
    expect(paths).toHaveLength(1);
    // Leaves the dot horizontally, runs straight, then a quarter circle
    // (r = halfRow) lands on lane 1 at the row bottom moving vertically
    // (down+right → sweep 1) so it continues seamlessly into the
    // pass-through / parent stub below.
    expect(paths[0].props.d).toBe("M 20 20 H 40 A 20 20 0 0 1 60 40");
  });

  it("child row draws the mirrored arc for a leftward transition", () => {
    const cell = renderCell({ commitLane: 1, edges: [edge("self", "parent", 1, 0)] });
    const paths = collect(cell, "path");
    expect(paths).toHaveLength(1);
    expect(paths[0].props.d).toBe("M 60 20 H 40 A 20 20 0 0 0 20 40");
  });

  it("spans multiple lanes with a longer horizontal run, same radius", () => {
    const cell = renderCell({ commitLane: 0, edges: [edge("self", "parent", 0, 2)] });
    const paths = collect(cell, "path");
    expect(paths).toHaveLength(1);
    expect(paths[0].props.d).toBe("M 20 20 H 80 A 20 20 0 0 1 100 40");
  });

  it("parent row draws a top stub on its own lane, not a second arc", () => {
    const cell = renderCell({ commitLane: 1, incomingEdges: [edge("child", "self", 0, 1)] });
    expect(collect(cell, "path")).toHaveLength(0);
    const lines = collect(cell, "line");
    expect(topStubAt(lines, 60)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Arc corner radius adapts to the smaller of the two metrics when they differ
// ---------------------------------------------------------------------------

describe("GraphCell arc radius with differing metrics", () => {
  // Narrow lanes (10px) but tall rows (40px): the corner radius is half the
  // smaller metric (= 5), so a multi-lane connector doesn't bulge out to the
  // half-row radius. Lane centres sit at x = lane*10 + 5.
  function renderNarrow(edges: LaneEdge[]) {
    return GraphCell({
      commitId: "self",
      commitLane: 0,
      totalLanes: 3,
      activeLanes: new Set<LaneIndex>(),
      edges,
      incomingEdges: [],
      rowHeight: 40,
      laneSpacing: 10,
      dotRadius: 5,
      lineWidth: 1.5,
    });
  }

  it("uses half the smaller metric as the corner radius", () => {
    const cell = renderNarrow([edge("self", "parent", 0, 2)]);
    const paths = collect(cell, "path");
    expect(paths).toHaveLength(1);
    // r = min(laneSpacing 10, rowHeight 40) / 2 = 5 — longer straight runs,
    // a 5px quarter-circle corner.
    expect(paths[0].props.d).toBe("M 5 20 H 20 A 5 5 0 0 1 25 25 V 40");
  });
});

// ---------------------------------------------------------------------------
// Self-edges (lane jogs at branch points) are drawn only as incoming arcs
// ---------------------------------------------------------------------------

describe("GraphCell jog (self) edges", () => {
  // Step-3 terminate edge from lanes.ts: fromCommitId === toCommitId.
  const jog = edge("self", "self", 1, 0);

  it("renders a single arc curving from the dying lane into the dot", () => {
    const cell = renderCell({ commitLane: 0, edges: [jog], incomingEdges: [jog] });
    const paths = collect(cell, "path");
    expect(paths).toHaveLength(1);
    // From the dot (20,20) up to the dying lane at the row top (60,0):
    // leaves the dot horizontally, quarter circle meets the line above
    // vertically (up+right → sweep 0).
    expect(paths[0].props.d).toBe("M 20 20 H 40 A 20 20 0 0 0 60 0");
  });

  it("does not draw a top stub from a jog alone", () => {
    const cell = renderCell({ commitLane: 0, edges: [jog], incomingEdges: [jog] });
    expect(topStubAt(collect(cell, "line"), 20)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Top stubs follow topology, not viewport position
// ---------------------------------------------------------------------------

describe("GraphCell top stubs", () => {
  it("draws no lines above a branch tip (no incoming edges)", () => {
    const cell = renderCell({ commitLane: 1 });
    expect(collect(cell, "line")).toHaveLength(0);
    expect(collect(cell, "path")).toHaveLength(0);
  });

  it("draws the top stub when a child connects straight down the lane", () => {
    const cell = renderCell({ commitLane: 0, incomingEdges: [edge("child", "self", 0, 0)] });
    const lines = collect(cell, "line");
    expect(topStubAt(lines, 20)).toHaveLength(1);
    expect(collect(cell, "path")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// A pass-through span on the commit's *own* lane keeps the vertical line whole
//
// Regression: when an unrelated edge's lane line transits straight through a
// commit on the same lane index (e.g. another branch whose parent sits below
// this commit on lane 1, with this commit being a branch tip with no incoming
// edges), the own-lane pass-through is suppressed to avoid double-drawing — so
// the own-lane vertical must be drawn full height instead, or the segment from
// the dot up to the transiting line disappears.
// ---------------------------------------------------------------------------

describe("GraphCell own-lane pass-through", () => {
  it("draws a full-height own-lane line when a span transits the commit", () => {
    // Branch-tip-like commit: no incoming edges, no first-parent continuation,
    // but a pass-through span covers this row on the commit's own lane.
    const cell = renderCell({ commitLane: 1, ownLanePassThrough: true });
    const lines = collect(cell, "line");
    // Both halves of the own lane (x = 1*40 + 20 = 60) are present, so the line
    // runs unbroken through the dot.
    expect(topStubAt(lines, 60)).toHaveLength(1);
    expect(bottomStubAt(lines, 60)).toHaveLength(1);
  });

  it("does not duplicate the bottom stub when continuation also applies", () => {
    const cell = renderCell({
      commitLane: 1,
      edges: [edge("self", "parent", 1, 1)], // first-parent continuation
      ownLanePassThrough: true,
    });
    const lines = collect(cell, "line");
    expect(topStubAt(lines, 60)).toHaveLength(1);
    expect(bottomStubAt(lines, 60)).toHaveLength(1);
  });

  it("draws nothing extra when the span is on a different lane", () => {
    // commitLane 1, pass-through on lane 2 is a normal pass-through, not an
    // own-lane transit — no own-lane stubs from this mechanism.
    const cell = renderCell({ commitLane: 1, activeLanes: new Set([1, 2]) });
    const lines = collect(cell, "line");
    expect(topStubAt(lines, 60)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Same-lane continuation and pass-throughs (regression guards)
// ---------------------------------------------------------------------------

describe("GraphCell continuation and pass-through lines", () => {
  it("draws the bottom stub for a same-lane first-parent edge", () => {
    const cell = renderCell({ commitLane: 0, edges: [edge("self", "parent", 0, 0)] });
    const lines = collect(cell, "line");
    const bottomStubs = lines.filter(
      (l) => l.props.x1 === 20 && l.props.x2 === 20 && l.props.y1 === 20 && l.props.y2 === 40,
    );
    expect(bottomStubs).toHaveLength(1);
  });

  it("draws full-height pass-through lines for active lanes", () => {
    const cell = renderCell({ commitLane: 0, activeLanes: new Set([0, 2]) });
    const lines = collect(cell, "line");
    const passThrough = lines.filter(
      (l) => l.props.x1 === 100 && l.props.y1 === 0 && l.props.y2 === 40,
    );
    expect(passThrough).toHaveLength(1);
    // The commit's own lane never gets a pass-through.
    expect(lines.filter((l) => l.props.x1 === 20)).toHaveLength(0);
  });
});
