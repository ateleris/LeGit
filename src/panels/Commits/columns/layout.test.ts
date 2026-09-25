// Pins the pure column-layout rules extracted from CommitsPanel: visible-set
// filtering (the graph hides under an author filter) and drag reordering.
import { describe, it, expect } from "vitest";
import { computeColumnLayout, reorderColumns } from "./layout";
import { DEFAULT_ORDER, DEFAULT_WIDTHS } from "./types";
import type { ColumnState } from "./types";

const state: ColumnState = { order: [...DEFAULT_ORDER], hidden: [], widths: { ...DEFAULT_WIDTHS } };

describe("computeColumnLayout", () => {
  const args = {
    colState: state,
    authorFilterActive: false,
    maxVisibleLane: 2,
    laneSpacing: 20,
    uiFontSize: 12,
    maxWidths: {},
  };

  it("shows every non-hidden column and sizes the graph by the widest lane", () => {
    const layout = computeColumnLayout(args);
    expect(layout.visibleColumns).toEqual(state.order);
    expect(layout.graphColWidth).toBe((2 + 2) * 20);
    // One track per visible column (a track itself may contain spaces).
    expect(layout.gridColumns).toBe(layout.visibleColumns.map(layout.colWidth).join(" "));
  });

  it("hides the graph column under an author filter", () => {
    const layout = computeColumnLayout({ ...args, authorFilterActive: true });
    expect(layout.visibleColumns).not.toContain("graph");
  });

  it("respects hidden columns", () => {
    const layout = computeColumnLayout({
      ...args,
      colState: { ...state, hidden: ["author", "sha"] },
    });
    expect(layout.visibleColumns).not.toContain("author");
    expect(layout.visibleColumns).not.toContain("sha");
  });
});

describe("reorderColumns", () => {
  const order = ["refs", "graph", "subject", "date"] as const;

  it("inserts left or right of the target", () => {
    expect(reorderColumns(order, "date", "graph", "left")).toEqual([
      "refs",
      "date",
      "graph",
      "subject",
    ]);
    expect(reorderColumns(order, "refs", "subject", "right")).toEqual([
      "graph",
      "subject",
      "refs",
      "date",
    ]);
  });

  it("is a no-op for the same column or an unknown id", () => {
    expect(reorderColumns(order, "refs", "refs", "left")).toBeNull();
    expect(reorderColumns(order, "author", "refs", "left")).toBeNull();
  });
});
