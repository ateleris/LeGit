// Pure conflict model for the Diff panel's resolve mode: parse git conflict
// markers (classic and diff3), build the synthetic TextDiff the existing
// DiffEditor renders (ours = Removed side, theirs = Added side, commons =
// Context), rewrite one block for a one-click choice, and reconstruct the
// full marker file from edited editor regions. No CodeMirror imports.

import type { DiffLine, TextDiff } from "../../lib/types";
import {
  detectEol,
  hasTrailingNewline,
  splitLines,
  type Eol,
  type ResolveRegions,
} from "./editModel";

export interface CommonSection {
  kind: "common";
  lines: string[];
}

export interface ConflictBlock {
  kind: "conflict";
  /** Text after `<<<<<<< ` (usually HEAD). */
  oursLabel: string;
  /** Text after `>>>>>>> ` (the merged branch/commit). */
  theirsLabel: string;
  ours: string[];
  /** diff3 `|||||||` section, kept verbatim for reconstruction; not shown. */
  base: string[] | null;
  baseLabel: string | null;
  theirs: string[];
}

export type Section = CommonSection | ConflictBlock;

export interface ParsedConflicts {
  sections: Section[];
  conflictCount: number;
  eol: Eol;
  trailingNewline: boolean;
}

const OURS_MARK = "<<<<<<<";
const BASE_MARK = "|||||||";
const SEP_MARK = "=======";
const THEIRS_MARK = ">>>>>>>";

function markerLabel(line: string, mark: string): string {
  return line.slice(mark.length).trim();
}

function isMark(line: string, mark: string): boolean {
  return line.startsWith(mark) && (line.length === mark.length || line[mark.length] === " ");
}

/** Parse a working-tree file's conflict markers. An unterminated conflict is
 *  emitted back as plain common lines so no content is ever dropped. */
export function parseConflicts(text: string): ParsedConflicts {
  const eol = detectEol(text);
  const trailingNewline = hasTrailingNewline(text);
  const lines = splitLines(text);
  const sections: Section[] = [];
  let common: string[] = [];
  const flushCommon = () => {
    if (common.length) {
      sections.push({ kind: "common", lines: common });
      common = [];
    }
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isMark(line, OURS_MARK)) {
      // Scan ahead for a complete block before committing to it.
      const oursLabel = markerLabel(line, OURS_MARK);
      const ours: string[] = [];
      let base: string[] | null = null;
      let baseLabel: string | null = null;
      const theirs: string[] = [];
      let phase: "ours" | "base" | "theirs" = "ours";
      let end = -1;
      let theirsLabel = "";
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j];
        if (phase !== "theirs" && isMark(l, BASE_MARK)) {
          phase = "base";
          base = [];
          baseLabel = markerLabel(l, BASE_MARK);
          continue;
        }
        if (phase !== "theirs" && l === SEP_MARK) {
          phase = "theirs";
          continue;
        }
        if (phase === "theirs" && isMark(l, THEIRS_MARK)) {
          theirsLabel = markerLabel(l, THEIRS_MARK);
          end = j;
          break;
        }
        if (phase === "ours") ours.push(l);
        else if (phase === "base") base!.push(l);
        else theirs.push(l);
      }
      if (end !== -1) {
        flushCommon();
        sections.push({ kind: "conflict", oursLabel, theirsLabel, ours, base, baseLabel, theirs });
        i = end + 1;
        continue;
      }
      // Unterminated: fall through, treat as a plain line.
    }
    common.push(line);
    i++;
  }
  flushCommon();

  return {
    sections,
    conflictCount: sections.filter((s) => s.kind === "conflict").length,
    eol,
    trailingNewline,
  };
}

/**
 * Build the synthetic diff: one hunk per conflict. The common run before a
 * conflict is that hunk's lead context; the common run after the LAST
 * conflict is appended to the last hunk as trailing context. Line numbers
 * count each side's "file as if that side were chosen".
 */
export function conflictsToDiff(parsed: ParsedConflicts, path: string): TextDiff {
  const hunks: TextDiff["hunks"] = [];
  const conflicts = parsed.conflictCount;
  let oursNo = 1;
  let theirsNo = 1;
  let pendingCommon: string[] = [];
  let index = 0;

  for (const section of parsed.sections) {
    if (section.kind === "common") {
      pendingCommon = pendingCommon.concat(section.lines);
      continue;
    }
    const lines: DiffLine[] = [];
    const oldStart = oursNo;
    const newStart = theirsNo;
    for (const l of pendingCommon) {
      lines.push({ kind: "Context", content: l });
      oursNo++;
      theirsNo++;
    }
    pendingCommon = [];
    for (const l of section.ours) {
      lines.push({ kind: "Removed", content: l });
      oursNo++;
    }
    for (const l of section.theirs) {
      lines.push({ kind: "Added", content: l });
      theirsNo++;
    }
    index++;
    hunks.push({
      old_start: oldStart,
      old_lines: 0, // fixed up below, after trailing context is attached
      new_start: newStart,
      new_lines: 0,
      header: `Conflict ${index}/${conflicts}: ours '${section.oursLabel}' vs theirs '${section.theirsLabel}'`,
      lines,
    });
  }
  // Trailing common lines belong to the last hunk as context.
  if (hunks.length > 0 && pendingCommon.length > 0) {
    const last = hunks[hunks.length - 1];
    for (const l of pendingCommon) {
      last.lines.push({ kind: "Context", content: l });
      oursNo++;
      theirsNo++;
    }
  }
  for (const h of hunks) {
    h.old_lines = h.lines.filter((l) => l.kind !== "Added").length;
    h.new_lines = h.lines.filter((l) => l.kind !== "Removed").length;
  }
  return { old_path: path, new_path: path, hunks };
}

// ---------------------------------------------------------------------------
// 3-way scroll alignment: conflict anchor lines per pane + piecewise mapping
// ---------------------------------------------------------------------------

/** For each conflict, its 0-based start line in the centre (marker) doc and
 *  in each side's "file as if that side were chosen" - the shape of the real
 *  index stages, assuming the working file still reflects the merge that
 *  produced the markers (edits degrade the alignment gracefully, never
 *  break it: the mapping clamps). `base` is derivable only from diff3
 *  markers; null under the classic conflict style. */
export interface ConflictAnchors {
  center: number[];
  ours: number[];
  theirs: number[];
  base: number[] | null;
}

export function conflictAnchors(parsed: ParsedConflicts): ConflictAnchors {
  const center: number[] = [];
  const ours: number[] = [];
  const theirs: number[] = [];
  const base: number[] = [];
  let haveBase = true;
  let c = 0;
  let o = 0;
  let t = 0;
  let b = 0;
  for (const section of parsed.sections) {
    if (section.kind === "common") {
      c += section.lines.length;
      o += section.lines.length;
      t += section.lines.length;
      b += section.lines.length;
      continue;
    }
    center.push(c);
    ours.push(o);
    theirs.push(t);
    base.push(b);
    // Centre doc: `<<<` + ours + (diff3: `|||` + base) + `===` + theirs + `>>>`.
    c += 1 + section.ours.length + (section.base ? 1 + section.base.length : 0) + 1 + section.theirs.length + 1;
    o += section.ours.length;
    t += section.theirs.length;
    if (section.base) b += section.base.length;
    else haveBase = false;
  }
  return { center, ours, theirs, base: haveBase ? base : null };
}

/** Piecewise-linear map of `x` through matched ascending breakpoints;
 *  clamps outside the ends. `xs`/`ys` are same-length, length >= 1. */
export function piecewiseMap(x: number, xs: number[], ys: number[]): number {
  if (x <= xs[0]) return ys[0];
  const last = xs.length - 1;
  if (x >= xs[last]) return ys[last];
  for (let i = 0; i < last; i++) {
    if (x <= xs[i + 1]) {
      const span = xs[i + 1] - xs[i];
      const f = span > 0 ? (x - xs[i]) / span : 0;
      return ys[i] + f * (ys[i + 1] - ys[i]);
    }
  }
  return ys[last];
}

/** Matched scroll breakpoints from per-pane anchor pixel offsets: pinned to
 *  (0, 0) and (srcMax, dstMax), keeping only anchor pairs that preserve
 *  strict monotonicity on BOTH axes (an anchor beyond a pane's scroll range,
 *  or out of order after clamping, would make the map reverse - drop it). */
export function alignedBreakpoints(
  src: number[],
  srcMax: number,
  dst: number[],
  dstMax: number
): { xs: number[]; ys: number[] } {
  const xs = [0];
  const ys = [0];
  for (let i = 0; i < Math.min(src.length, dst.length); i++) {
    const x = src[i];
    const y = dst[i];
    if (x <= xs[xs.length - 1] || x >= srcMax) continue;
    if (y <= ys[ys.length - 1] || y >= dstMax) continue;
    xs.push(x);
    ys.push(y);
  }
  if (srcMax > 0 && dstMax > 0) {
    xs.push(srcMax);
    ys.push(dstMax);
  }
  return { xs, ys };
}

export type ResolveChoice = "ours" | "theirs" | "both";

function joinLines(lines: string[], eol: Eol, trailingNewline: boolean): string {
  const body = lines.map((l) => l.replace(/\r$/, "")).join(eol);
  return trailingNewline && lines.length > 0 ? body + eol : body;
}

function conflictMarkerLines(c: ConflictBlock, ours: string[], theirs: string[]): string[] {
  const out = [`${OURS_MARK} ${c.oursLabel}`.trimEnd(), ...ours];
  if (c.base !== null) {
    out.push(`${BASE_MARK} ${c.baseLabel ?? ""}`.trimEnd(), ...c.base);
  }
  out.push(SEP_MARK, ...theirs, `${THEIRS_MARK} ${c.theirsLabel}`.trimEnd());
  return out;
}

/** Rewrite conflict #`conflictIndex` with the chosen side(s); all other
 *  content (including other conflicts) is preserved verbatim. */
export function resolveBlock(text: string, conflictIndex: number, choice: ResolveChoice): string {
  const parsed = parseConflicts(text);
  const out: string[] = [];
  let index = -1;
  for (const section of parsed.sections) {
    if (section.kind === "common") {
      out.push(...section.lines);
      continue;
    }
    index++;
    if (index !== conflictIndex) {
      out.push(...conflictMarkerLines(section, section.ours, section.theirs));
      continue;
    }
    if (choice === "ours" || choice === "both") out.push(...section.ours);
    if (choice === "theirs" || choice === "both") out.push(...section.theirs);
  }
  return joinLines(out, parsed.eol, parsed.trailingNewline);
}

/**
 * Rebuild the full marker file from the edited regions (one per conflict
 * hunk, in order). Region layout mirrors `conflictsToDiff`: lead context,
 * ours, theirs, and (last hunk only) trailing context; every common section
 * is exactly one hunk's lead or the final trail, so this covers the file.
 * diff3 base sections are re-emitted verbatim.
 */
export function reconstructResolvedFile(
  parsed: ParsedConflicts,
  regions: ResolveRegions[],
): string {
  const out: string[] = [];
  let index = -1;
  for (const section of parsed.sections) {
    if (section.kind === "common") continue; // covered by lead/trail regions
    index++;
    const r = regions[index];
    if (!r) continue;
    out.push(...r.lead);
    out.push(...conflictMarkerLines(section, r.ours, r.theirs));
    out.push(...r.trail);
  }
  return joinLines(out, parsed.eol, parsed.trailingNewline);
}
