import { describe, expect, it } from "vitest";
import { buildRows, buildSplitRows } from "./diffModel";
import type { TextDiff, DiffHunk } from "../../lib/types";

function hunk(oldStart: number, newStart: number, contextLines: number): DiffHunk {
  return {
    old_start: oldStart,
    old_lines: contextLines + 1,
    new_start: newStart,
    new_lines: contextLines + 1,
    header: `@@ -${oldStart},${contextLines + 1} +${newStart},${contextLines + 1} @@`,
    lines: [
      ...Array.from({ length: contextLines }, (_, i) => ({
        kind: "Context" as const,
        content: `ctx ${newStart + i}`,
      })),
      { kind: "Added" as const, content: "new line" },
      { kind: "Removed" as const, content: "old line" },
    ],
  };
}

/** Three hunks: 1 gapless with the file start (its header vanishes when
 *  skipping), 2 contiguous with 1 (vanishes too), 3 after a real gap. */
function diff(): TextDiff {
  return {
    old_path: "a.txt",
    new_path: "a.txt",
    hunks: [hunk(1, 1, 3), hunk(5, 5, 2), hunk(20, 20, 2)],
  };
}

const headers = (rows: { kind: string; text: string }[]) =>
  rows.filter((r) => r.kind === "Hunk").map((r) => r.text);

describe("buildRows gapless header skipping", () => {
  it("keeps every header verbatim when not skipping", () => {
    expect(headers(buildRows(diff()))).toEqual([
      "@@ -1,4 +1,4 @@",
      "@@ -5,3 +5,3 @@",
      "@@ -20,3 +20,3 @@",
    ]);
  });

  it("drops gapless headers and widens the surviving header above", () => {
    // Hunks 0 and 1 lose their headers (gap 0). No header row survives for
    // that run since hunk 0 sits at the file start; hunk 2 keeps its own.
    expect(headers(buildRows(diff(), false, true))).toEqual(["@@ -20,3 +20,3 @@"]);
  });

  it("extends a surviving header over the following gapless run", () => {
    // Move hunk 0 off the file start so its header survives; hunk 1 is
    // contiguous with it and vanishes, so hunk 0's header must span both:
    // old/new 3..6 (hunk 0) + 7..9 (hunk 1) = start 3, 7 lines.
    const d: TextDiff = {
      old_path: "a.txt",
      new_path: "a.txt",
      hunks: [hunk(3, 3, 3), hunk(7, 7, 2), hunk(20, 20, 2)],
    };
    expect(headers(buildRows(d, false, true))).toEqual([
      "@@ -3,7 +3,7 @@",
      "@@ -20,3 +20,3 @@",
    ]);
  });

  it("split view widens headers identically on both sides", () => {
    const d: TextDiff = {
      old_path: "a.txt",
      new_path: "a.txt",
      hunks: [hunk(3, 3, 3), hunk(7, 7, 2)],
    };
    const { left, right } = buildSplitRows(d, false, true);
    expect(headers(left)).toEqual(["@@ -3,7 +3,7 @@"]);
    expect(headers(right)).toEqual(["@@ -3,7 +3,7 @@"]);
  });
});
