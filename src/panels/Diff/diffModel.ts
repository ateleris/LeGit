// Turns a parsed `TextDiff` into render-ready row models for the inline and
// split views, including intra-line (word-level) change segments so a modified
// line can show a light background on the whole line plus a stronger background
// on just the characters that changed.

import { renumberHeader } from "./expandModel";
import type { TextDiff, DiffLineKind } from "../../lib/types";

export type RowKind = DiffLineKind | "Hunk";

/** A changed character range within a line's text (half-open [from, to)). */
export interface Segment {
  from: number;
  to: number;
}

export interface DiffRow {
  kind: RowKind;
  /** Visible text for the row (no leading +/-/space marker). */
  text: string;
  /** 1-based line number on the old side, or null (added / hunk header). */
  oldNo: number | null;
  /** 1-based line number on the new side, or null (removed / hunk header). */
  newNo: number | null;
  /** Index of the hunk this row belongs to (hunk header rows included). */
  hunkIndex: number;
  /** Index within the hunk's `lines` (for line-level staging); -1 for headers. */
  lineIndex: number;
  /** Changed character ranges, for a modified (paired) added/removed line. */
  segments?: Segment[];
}

export type SplitRowKind = "Context" | "Added" | "Removed" | "Filler" | "Hunk";

export interface SplitRow {
  kind: SplitRowKind;
  text: string;
  /** Real file line number for this side, or null (filler / hunk header). */
  no: number | null;
  /** Index of the hunk this row belongs to. */
  hunkIndex: number;
  /** Index within the hunk's `lines` (for line-level staging); -1 for filler/header. */
  lineIndex: number;
  /** Changed character ranges, for a modified (paired) added/removed line. */
  segments?: Segment[];
}

interface Pending {
  text: string;
  no: number;
  lineIndex: number;
}

/**
 * Display label for a hunk header: just `@@ -a,b +c,d @@`, dropping the section
 * heading (function context) git appends after the closing `@@`.
 */
function hunkHeaderLabel(header: string): string {
  const m = header.match(/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/);
  return m ? m[0] : header;
}

/** Split a line into word / whitespace / single-punctuation tokens. */
function tokenize(s: string): { text: string; start: number }[] {
  const re = /\w+|\s+|[^\w\s]/g;
  const out: { text: string; start: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    out.push({ text: m[0], start: m.index });
  }
  return out;
}

/** Merge contiguous changed tokens into character ranges. */
function rangesFrom(
  tokens: { text: string; start: number }[],
  common: boolean[]
): Segment[] {
  const segs: Segment[] = [];
  let cur: Segment | null = null;
  for (let k = 0; k < tokens.length; k++) {
    if (common[k]) {
      cur = null;
      continue;
    }
    const from = tokens[k].start;
    const to = from + tokens[k].text.length;
    if (cur && cur.to === from) cur.to = to;
    else {
      cur = { from, to };
      segs.push(cur);
    }
  }
  return segs;
}

/**
 * Word-level diff of two lines via a token LCS: the tokens NOT on the longest
 * common subsequence are the changed ones. Returns the changed character ranges
 * on each side.
 */
function intralineSegments(
  oldStr: string,
  newStr: string
): { oldSegs: Segment[]; newSegs: Segment[] } {
  const A = tokenize(oldStr);
  const B = tokenize(newStr);
  const a = A.map((t) => t.text);
  const b = B.map((t) => t.text);

  // LCS length DP (suffix form), then a forward walk to mark matched tokens.
  const dp: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array(b.length + 1).fill(0)
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const aCommon = new Array(a.length).fill(false);
  const bCommon = new Array(b.length).fill(false);
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      aCommon[i] = true;
      bCommon[j] = true;
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return { oldSegs: rangesFrom(A, aCommon), newSegs: rangesFrom(B, bCommon) };
}

/**
 * Compute per-line changed segments for a block of removed/added lines, pairing
 * removed[i] with added[i]. Lines without a counterpart (pure add/remove) get
 * no segments.
 */
function blockSegments(dels: Pending[], adds: Pending[]): { del: Segment[][]; add: Segment[][] } {
  const del: Segment[][] = dels.map(() => []);
  const add: Segment[][] = adds.map(() => []);
  const paired = Math.min(dels.length, adds.length);
  for (let i = 0; i < paired; i++) {
    const { oldSegs, newSegs } = intralineSegments(dels[i].text, adds[i].text);
    del[i] = oldSegs;
    add[i] = newSegs;
  }
  return { del, add };
}

/** Gap above each hunk (0 = contiguous with the previous hunk / file start). */
function gapsAbove(diff: TextDiff): number[] {
  return diff.hunks.map((h, i) => {
    const prevEnd = i > 0 ? diff.hunks[i - 1].new_start + diff.hunks[i - 1].new_lines : 1;
    return Math.max(0, h.new_start - prevEnd);
  });
}

/** The header text for hunk `i`, extended over the run of following
 *  gapless hunks whose headers get skipped: the emitted header must
 *  describe everything visible below it, like a real diff header would. */
function mergedHeaderText(diff: TextDiff, i: number, gaps: number[]): string {
  let last = i;
  while (last + 1 < diff.hunks.length && gaps[last + 1] === 0) last++;
  const first = diff.hunks[i];
  if (last === i) return first.header;
  const end = diff.hunks[last];
  return renumberHeader(
    first.header,
    first.old_start,
    end.old_start + end.old_lines - first.old_start,
    first.new_start,
    end.new_start + end.new_lines - first.new_start,
  );
}

/** Flatten a text diff into interleaved rows for the inline view.
 *  `trailingExpander` appends a synthetic header row (hunkIndex -1) after
 *  the last hunk, carrying the expand-down control for the file tail.
 *  `skipGaplessHeaders` drops a header whose gap is fully revealed (read-
 *  only diffs: the header carries no actions, so nothing is lost and the
 *  hunks read as one continuous file). */
export function buildRows(
  diff: TextDiff,
  trailingExpander = false,
  skipGaplessHeaders = false,
): DiffRow[] {
  const rows: DiffRow[] = [];
  const gaps = gapsAbove(diff);
  diff.hunks.forEach((hunk, hunkIndex) => {
    if (!(skipGaplessHeaders && gaps[hunkIndex] === 0)) {
      const header = skipGaplessHeaders ? mergedHeaderText(diff, hunkIndex, gaps) : hunk.header;
      rows.push({
        kind: "Hunk",
        text: hunkHeaderLabel(header),
        oldNo: null,
        newNo: null,
        hunkIndex,
        lineIndex: -1,
      });
    }

    let oldNo = hunk.old_start;
    let newNo = hunk.new_start;
    let dels: Pending[] = [];
    let adds: Pending[] = [];

    const flush = () => {
      const { del, add } = blockSegments(dels, adds);
      dels.forEach((d, i) =>
        rows.push({
          kind: "Removed",
          text: d.text,
          oldNo: d.no,
          newNo: null,
          hunkIndex,
          lineIndex: d.lineIndex,
          segments: del[i],
        })
      );
      adds.forEach((a, i) =>
        rows.push({
          kind: "Added",
          text: a.text,
          oldNo: null,
          newNo: a.no,
          hunkIndex,
          lineIndex: a.lineIndex,
          segments: add[i],
        })
      );
      dels = [];
      adds = [];
    };

    hunk.lines.forEach((line, lineIndex) => {
      if (line.kind === "Context") {
        flush();
        rows.push({
          kind: "Context",
          text: line.content,
          oldNo: oldNo++,
          newNo: newNo++,
          hunkIndex,
          lineIndex,
        });
      } else if (line.kind === "Added") {
        adds.push({ text: line.content, no: newNo++, lineIndex });
      } else {
        dels.push({ text: line.content, no: oldNo++, lineIndex });
      }
    });
    flush();
  });
  if (trailingExpander && diff.hunks.length > 0) {
    rows.push({ kind: "Hunk", text: "", oldNo: null, newNo: null, hunkIndex: -1, lineIndex: -1 });
  }
  return rows;
}

/**
 * Build aligned left (old) / right (new) row arrays for the split view. A run of
 * removed lines is paired side-by-side with the following run of added lines;
 * the shorter side is padded with `Filler` rows so context lines stay aligned.
 * Both arrays always have the same length, with real file line numbers and the
 * same intra-line segments as the inline view.
 */
export function buildSplitRows(
  diff: TextDiff,
  trailingExpander = false,
  skipGaplessHeaders = false,
): { left: SplitRow[]; right: SplitRow[] } {
  const left: SplitRow[] = [];
  const right: SplitRow[] = [];
  const gaps = gapsAbove(diff);

  diff.hunks.forEach((hunk, hunkIndex) => {
    // The `@@` header spans both sides (kept aligned), mirroring the inline view.
    if (!(skipGaplessHeaders && gaps[hunkIndex] === 0)) {
      const label = hunkHeaderLabel(
        skipGaplessHeaders ? mergedHeaderText(diff, hunkIndex, gaps) : hunk.header,
      );
      left.push({ kind: "Hunk", text: label, no: null, hunkIndex, lineIndex: -1 });
      right.push({ kind: "Hunk", text: label, no: null, hunkIndex, lineIndex: -1 });
    }

    let oldNo = hunk.old_start;
    let newNo = hunk.new_start;
    let dels: Pending[] = [];
    let adds: Pending[] = [];

    const flush = () => {
      const { del, add } = blockSegments(dels, adds);
      const n = Math.max(dels.length, adds.length);
      for (let i = 0; i < n; i++) {
        left.push(
          dels[i]
            ? { kind: "Removed", text: dels[i].text, no: dels[i].no, hunkIndex, lineIndex: dels[i].lineIndex, segments: del[i] }
            : { kind: "Filler", text: "", no: null, hunkIndex, lineIndex: -1 }
        );
        right.push(
          adds[i]
            ? { kind: "Added", text: adds[i].text, no: adds[i].no, hunkIndex, lineIndex: adds[i].lineIndex, segments: add[i] }
            : { kind: "Filler", text: "", no: null, hunkIndex, lineIndex: -1 }
        );
      }
      dels = [];
      adds = [];
    };

    hunk.lines.forEach((line, lineIndex) => {
      if (line.kind === "Context") {
        flush();
        left.push({ kind: "Context", text: line.content, no: oldNo++, hunkIndex, lineIndex });
        right.push({ kind: "Context", text: line.content, no: newNo++, hunkIndex, lineIndex });
      } else if (line.kind === "Added") {
        adds.push({ text: line.content, no: newNo++, lineIndex });
      } else {
        dels.push({ text: line.content, no: oldNo++, lineIndex });
      }
    });
    flush();
  });

  if (trailingExpander && diff.hunks.length > 0) {
    left.push({ kind: "Hunk", text: "", no: null, hunkIndex: -1, lineIndex: -1 });
    right.push({ kind: "Hunk", text: "", no: null, hunkIndex: -1, lineIndex: -1 });
  }
  return { left, right };
}
