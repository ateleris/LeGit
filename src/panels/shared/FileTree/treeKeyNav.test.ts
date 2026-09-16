import { describe, expect, it } from "vitest";
import type { Row } from "./buildTree";
import { horizontalKeyAction, verticalMoveTarget } from "./treeKeyNav";

const file: Row = { kind: "file", path: "a.txt", depth: 0, file: { path: "a.txt" } };
const dir = (collapsed: boolean): Row => ({
  kind: "dir",
  path: "src",
  label: "src",
  depth: 0,
  fileCount: 2,
  collapsed,
});

// Regression: Left/Right used to fall back to stepping the cursor through
// the list (duplicate of Up/Down, confusing next to Space-staging). They are
// fold keys ONLY: they act on folders and do nothing anywhere else.
describe("horizontalKeyAction", () => {
  it("ArrowRight expands a collapsed folder and nothing else", () => {
    expect(horizontalKeyAction("ArrowRight", dir(true))).toBe("toggle");
    expect(horizontalKeyAction("ArrowRight", dir(false))).toBeNull();
    expect(horizontalKeyAction("ArrowRight", file)).toBeNull();
    expect(horizontalKeyAction("ArrowRight", undefined)).toBeNull();
  });

  it("ArrowLeft collapses an expanded folder and nothing else", () => {
    expect(horizontalKeyAction("ArrowLeft", dir(false))).toBe("toggle");
    expect(horizontalKeyAction("ArrowLeft", dir(true))).toBeNull();
    expect(horizontalKeyAction("ArrowLeft", file)).toBeNull();
    expect(horizontalKeyAction("ArrowLeft", undefined)).toBeNull();
  });
});

// Up/Down move the SELECTION (like every native list), not just a browse
// cursor: landing on a file row selects it; a dir row moves the cursor only
// (dirs are not selectable entries); at a list edge nothing happens (no
// re-select churn re-opening the diff).
describe("verticalMoveTarget", () => {
  const rows: Row[] = [
    { kind: "file", path: "a.txt", depth: 0, file: { path: "a.txt" } },
    { kind: "dir", path: "src", label: "src", depth: 0, fileCount: 1, collapsed: false },
    { kind: "file", path: "src/one.ts", depth: 1, file: { path: "src/one.ts" } },
  ];

  it("moves to the adjacent row and reports a file to select", () => {
    expect(verticalMoveTarget(rows, 1, 1)).toEqual({ index: 2, selectPath: "src/one.ts" });
    expect(verticalMoveTarget(rows, 1, -1)).toEqual({ index: 0, selectPath: "a.txt" });
  });

  it("a dir row is cursor-only (no selection change)", () => {
    expect(verticalMoveTarget(rows, 0, 1)).toEqual({ index: 1, selectPath: null });
  });

  it("with no cursor yet, the first press lands on row 0", () => {
    expect(verticalMoveTarget(rows, -1, 1)).toEqual({ index: 0, selectPath: "a.txt" });
    expect(verticalMoveTarget(rows, -1, -1)).toEqual({ index: 0, selectPath: "a.txt" });
  });

  it("does nothing at the list edges and on an empty list", () => {
    expect(verticalMoveTarget(rows, 2, 1)).toBeNull();
    expect(verticalMoveTarget(rows, 0, -1)).toBeNull();
    expect(verticalMoveTarget([], -1, 1)).toBeNull();
  });
});
