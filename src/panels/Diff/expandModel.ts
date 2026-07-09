// Per-hunk context expansion for the chunked diff view (GitHub-style
// expanders): splice REAL context lines from the new-side file into a
// hunk's top/bottom, renumbering both sides. Context lines advance the old
// and new counters equally, so the old numbering shifts by the same amount.

import type { TextDiff } from "../../lib/types";

/** Extra context lines revealed above (`up`) / below (`down`) one hunk. */
export interface HunkExpansion {
  up: number;
  down: number;
}

/** `@@ -a,b +c,d @@<suffix>` with fresh numbers, keeping the suffix. */
function renumberHeader(header: string, oldStart: number, oldLines: number, newStart: number, newLines: number): string {
  const m = header.match(/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@(.*)$/);
  const suffix = m ? m[1] : "";
  return `@@ -${oldStart},${oldLines} +${newStart},${newLines} @@${suffix}`;
}

/**
 * Applies the expansions to a chunked diff. Gaps are shared fairly between
 * neighbours: the upper hunk's `down` is served first, the lower hunk's
 * `up` gets what remains. Everything clamps to the file edges.
 */
export function expandDiff(
  diff: TextDiff,
  newSideLines: readonly string[],
  expansions: ReadonlyMap<number, HunkExpansion>,
): TextDiff {
  if (expansions.size === 0) return diff;
  const total = newSideLines.length;
  const hunks = diff.hunks.map((h) => ({ ...h, lines: [...h.lines] }));

  // Resolve each gap's split first, against the ORIGINAL bounds.
  const ups: number[] = hunks.map(() => 0);
  const downs: number[] = hunks.map(() => 0);
  for (let i = 0; i < hunks.length; i++) {
    const want = expansions.get(i);
    if (!want) continue;
    const prevEnd = i > 0 ? hunks[i - 1].new_start + hunks[i - 1].new_lines : 1;
    const nextStart = i + 1 < hunks.length ? hunks[i + 1].new_start : total + 1;
    const gapAbove = Math.max(0, hunks[i].new_start - prevEnd);
    const gapBelow = Math.max(0, nextStart - (hunks[i].new_start + hunks[i].new_lines));
    // The gap above is shared with the previous hunk's `down`.
    ups[i] = Math.max(0, Math.min(want.up, gapAbove - (i > 0 ? downs[i - 1] : 0)));
    downs[i] = Math.min(want.down, gapBelow);
  }
  // Second pass: a lower hunk's `up` may not overlap the upper's `down`.
  for (let i = 1; i < hunks.length; i++) {
    const prevEnd = hunks[i - 1].new_start + hunks[i - 1].new_lines;
    const gapAbove = Math.max(0, hunks[i].new_start - prevEnd);
    ups[i] = Math.min(ups[i], Math.max(0, gapAbove - downs[i - 1]));
  }

  for (let i = 0; i < hunks.length; i++) {
    const h = hunks[i];
    const up = ups[i];
    const down = downs[i];
    if (up === 0 && down === 0) continue;
    if (up > 0) {
      const from = h.new_start - up; // 1-based
      const added = newSideLines
        .slice(from - 1, h.new_start - 1)
        .map((content) => ({ kind: "Context" as const, content }));
      h.lines = [...added, ...h.lines];
      h.new_start -= up;
      h.old_start -= up;
      h.new_lines += up;
      h.old_lines += up;
    }
    if (down > 0) {
      const end = h.new_start + h.new_lines; // 1-based line after the hunk
      const added = newSideLines
        .slice(end - 1, end - 1 + down)
        .map((content) => ({ kind: "Context" as const, content }));
      h.lines = [...h.lines, ...added];
      h.new_lines += down;
      h.old_lines += down;
    }
    h.header = renumberHeader(h.header, h.old_start, h.old_lines, h.new_start, h.new_lines);
  }
  return { ...diff, hunks };
}
