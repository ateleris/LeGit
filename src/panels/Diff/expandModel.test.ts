import { describe, expect, it } from "vitest";
import { expandDiff, type HunkExpansion } from "./expandModel";
import type { TextDiff } from "../../lib/types";

// New-side file: 30 numbered lines.
const FILE = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);

/** Two hunks: new lines 10-12 (edit) and 20-21 (edit), context 0 for easy
 *  math. Old side is offset by +2 (an earlier removal). */
function diff(): TextDiff {
  return {
    old_path: "a.txt",
    new_path: "a.txt",
    hunks: [
      {
        old_start: 12,
        old_lines: 3,
        new_start: 10,
        new_lines: 3,
        header: "@@ -12,3 +10,3 @@ function ten()",
        lines: [
          { kind: "Removed", content: "old ten" },
          { kind: "Added", content: "line 10" },
          { kind: "Added", content: "line 11" },
          { kind: "Added", content: "line 12" },
          { kind: "Removed", content: "old eleven" },
          { kind: "Removed", content: "old twelve" },
        ],
      },
      {
        old_start: 22,
        old_lines: 2,
        new_start: 20,
        new_lines: 2,
        header: "@@ -22,2 +20,2 @@",
        lines: [
          { kind: "Added", content: "line 20" },
          { kind: "Added", content: "line 21" },
          { kind: "Removed", content: "old twenty" },
          { kind: "Removed", content: "old twentyone" },
        ],
      },
    ],
  };
}

const exp = (m: Record<number, HunkExpansion>) => new Map(Object.entries(m).map(([k, v]) => [Number(k), v]));

describe("expandDiff", () => {
  it("returns the diff unchanged without expansions", () => {
    const d = diff();
    expect(expandDiff(d, FILE, new Map())).toEqual(d);
  });

  it("expands a hunk upward with real context lines and renumbers", () => {
    const out = expandDiff(diff(), FILE, exp({ 0: { up: 5, down: 0 } }));
    const h = out.hunks[0];
    expect(h.new_start).toBe(5);
    expect(h.old_start).toBe(7);
    expect(h.new_lines).toBe(8);
    expect(h.old_lines).toBe(8);
    expect(h.lines.slice(0, 5)).toEqual(
      ["line 5", "line 6", "line 7", "line 8", "line 9"].map((content) => ({
        kind: "Context",
        content,
      })),
    );
    // header renumbered, trailing section text preserved
    expect(h.header).toBe("@@ -7,8 +5,8 @@ function ten()");
  });

  it("expands downward and clamps against the next hunk's expansion", () => {
    // gap between hunks: new lines 13..19 (7 lines). down 5 then up 5 must
    // share it: down gets 5, up gets the remaining 2.
    const out = expandDiff(diff(), FILE, exp({
      0: { up: 0, down: 5 },
      1: { up: 5, down: 0 },
    }));
    const [h0, h1] = out.hunks;
    expect(h0.new_lines).toBe(8); // 3 + 5 down
    expect(h0.lines.slice(-5).map((l) => l.content)).toEqual([
      "line 13", "line 14", "line 15", "line 16", "line 17",
    ]);
    expect(h1.new_start).toBe(18); // only 2 of the requested 5 remained
    expect(h1.lines.slice(0, 2).map((l) => l.content)).toEqual(["line 18", "line 19"]);
  });

  it("clamps at the file edges", () => {
    const out = expandDiff(diff(), FILE, exp({
      0: { up: 99, down: 0 },
      1: { up: 0, down: 99 },
    }));
    expect(out.hunks[0].new_start).toBe(1);
    expect(out.hunks[0].lines[0]).toEqual({ kind: "Context", content: "line 1" });
    const h1 = out.hunks[1];
    expect(h1.new_start + h1.new_lines - 1).toBe(30);
    expect(h1.lines[h1.lines.length - 1]).toEqual({ kind: "Context", content: "line 30" });
  });
});
