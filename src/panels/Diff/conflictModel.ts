// Pure conflict model for the Merge panel: parse git conflict markers
// (classic and diff3), name the two sides, compose a block's result lines
// from per-line selections, and provide the anchors/spans the 3-way view
// needs for result-doc surgery and scroll alignment. No CodeMirror imports.

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

/** Resolved display names for the two conflict sides. `null` = unknown;
 *  the UI falls back to the bare side word (Current / Incoming). */
export interface ConflictSideNames {
  ours: string | null;
  theirs: string | null;
}

/**
 * Turns the raw conflict-marker labels into user-facing side names,
 * following what other clients converged on: "Current" = the side you are
 * on, "Incoming" = the side being brought in, each with the real ref name.
 * `HEAD` (git's usual ours label) is replaced by the current branch name;
 * during a rebase HEAD is detached, `currentBranch` is null, and the side
 * deliberately stays unnamed rather than guessing (theirs then carries
 * "<sha> (message)" straight from the marker, which is exactly right since
 * rebase inverts ours/theirs relative to intuition).
 *
 * A REOPENED conflict (`git checkout -m`) regenerates the markers with the
 * hardcoded stage labels "ours"/"theirs" instead of ref names: "ours"
 * resolves like HEAD, "theirs" falls back to `incomingName` (the op-state's
 * merge source, when the caller knows it) or stays unnamed.
 */
export function conflictSideNames(
  parsed: ParsedConflicts,
  currentBranch: string | null,
  incomingName: string | null = null,
): ConflictSideNames {
  const block = parsed.sections.find(
    (s): s is ConflictBlock => s.kind === "conflict",
  );
  if (!block) return { ours: null, theirs: null };
  const ours =
    block.oursLabel === "" || block.oursLabel === "HEAD" || block.oursLabel === "ours"
      ? currentBranch
      : block.oursLabel;
  const theirs =
    block.theirsLabel === "" || block.theirsLabel === "theirs"
      ? incomingName
      : block.theirsLabel;
  return { ours, theirs };
}

/** "Current 'main'" or the bare side word when the name is unknown. */
export function sideLabel(word: string, name: string | null): string {
  return name === null ? word : `${word} '${name}'`;
}

/**
 * Whether the merge panel must warn that the marker file changed on disk:
 * the view's baseline (`shown`) is frozen while the result is dirty, so an
 * external edit cannot be auto-reloaded without clobbering the in-progress
 * resolution - the user decides. A pristine view reloads silently instead
 * (never warns), and a dismissed warning stays quiet until the disk text
 * changes AGAIN (`dismissed` is the exact text the user chose to ignore).
 */
export function externalChangePending(
  shown: string | null,
  disk: string | null | undefined,
  dirty: boolean,
  dismissed: string | null,
): boolean {
  if (!dirty || shown == null || disk == null) return false;
  return disk !== shown && disk !== dismissed;
}

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

/** Per-line inclusion flags for one conflict block (merge view): index i
 *  covers the region's i-th line. The block checkbox derives from these
 *  (checked = all true, indeterminate = some). */
export interface LineSelection {
  ours: boolean[];
  theirs: boolean[];
}

/** The i-th conflict block of a parse (bounds-checked convenience). */
export function blockSection(parsed: ParsedConflicts, index: number): ConflictBlock {
  const blocks = parsed.sections.filter(
    (s): s is ConflictBlock => s.kind === "conflict",
  );
  const block = blocks[index];
  if (!block) throw new Error(`no conflict block ${index}`);
  return block;
}

/**
 * The lines a conflict block contributes to the result document for the
 * given per-line selection: selected ours lines then selected theirs lines
 * (document order); no line selected restores the full conflict markers so
 * nothing is decided implicitly. Region content is the (possibly edited)
 * source; the section supplies the marker labels.
 */
export function composeBlockLines(
  region: ResolveRegions,
  section: ConflictBlock,
  sel: LineSelection,
): string[] {
  const chosen = [
    ...region.ours.filter((_, i) => sel.ours[i]),
    ...region.theirs.filter((_, i) => sel.theirs[i]),
  ];
  if (chosen.length > 0) return chosen;
  if (sel.ours.some(Boolean) || sel.theirs.some(Boolean)) {
    // Selected lines exist but the regions are empty (deletion side chosen):
    // the block resolves to nothing.
    return [];
  }
  return conflictMarkerLines(section, region.ours, region.theirs);
}

/**
 * Locates each conflict region's 0-based start line in a side document by
 * CONTENT (sequential search), not by the marker file's structure. The
 * structural derivation (`conflictAnchors`) assumes the marker file's common
 * sections match the stage file line-for-line — which stops holding the
 * moment the user edits/saves commons in the result. An empty or unfindable
 * region anchors at the running search position (graceful degradation; the
 * scroll mapping clamps).
 */
export function locateRegionAnchors(
  sideLines: readonly string[],
  regions: readonly (readonly string[])[],
): number[] {
  const anchors: number[] = [];
  let searchFrom = 0;
  for (const region of regions) {
    if (region.length === 0) {
      anchors.push(Math.min(searchFrom, sideLines.length));
      continue;
    }
    let found = -1;
    for (let i = searchFrom; i <= sideLines.length - region.length; i++) {
      let ok = true;
      for (let j = 0; j < region.length; j++) {
        if (sideLines[i + j] !== region[j]) {
          ok = false;
          break;
        }
      }
      if (ok) {
        found = i;
        break;
      }
    }
    if (found === -1) {
      anchors.push(Math.min(searchFrom, sideLines.length));
      continue;
    }
    anchors.push(found);
    searchFrom = found + region.length;
  }
  return anchors;
}

/** Hide at least this many lines before a fold placeholder pays for its
 *  own screen row. */
const MIN_FOLD_LINES = 3;

/**
 * The foldable common stretches of a pane in "Conflicts" view: everything
 * between/around the conflict blocks except `context` visible lines on each
 * side of every block. 0-based inclusive line ranges; gaps smaller than
 * MIN_FOLD_LINES stay unfolded (a placeholder row would not save space).
 */
export function foldableRanges(
  blockStarts: readonly number[],
  blockLens: readonly number[],
  totalLines: number,
  context: number,
): Array<{ from: number; to: number }> {
  const out: Array<{ from: number; to: number }> = [];
  if (blockStarts.length === 0) return out;
  const push = (from: number, to: number) => {
    if (to - from + 1 >= MIN_FOLD_LINES) out.push({ from, to });
  };
  push(0, blockStarts[0] - context - 1);
  for (let i = 0; i < blockStarts.length - 1; i++) {
    push(
      blockStarts[i] + blockLens[i] + context,
      blockStarts[i + 1] - context - 1,
    );
  }
  const last = blockStarts.length - 1;
  push(blockStarts[last] + blockLens[last] + context, totalLines - 1);
  return out;
}

/** Each block's 0-based start line and marker-view line count in the centre
 *  (marker) document — the initial result-doc surgery spans. */
export function markerViewSpans(
  parsed: ParsedConflicts,
): Array<{ start: number; lines: number }> {
  const spans: Array<{ start: number; lines: number }> = [];
  let c = 0;
  for (const section of parsed.sections) {
    if (section.kind === "common") {
      c += section.lines.length;
      continue;
    }
    const lines =
      1 +
      section.ours.length +
      (section.base ? 1 + section.base.length : 0) +
      1 +
      section.theirs.length +
      1;
    spans.push({ start: c, lines });
    c += lines;
  }
  return spans;
}

/** Each block's initial [from, to) character range in the result document,
 *  in CodeMirror positions: the editor normalizes every line break (LF and
 *  CRLF alike) to ONE position, so the offsets are accumulated over
 *  \r-stripped lines. Raw string offsets would drift one character per
 *  preceding CRLF line, starting every range below its `<<<<<<<` line.
 *  `docText` is the marker file with a guaranteed trailing newline. */
export function initialBlockRanges(
  parsed: ParsedConflicts,
  docText: string,
): Array<{ from: number; to: number }> {
  const lineStart: number[] = [0];
  for (const l of docText.split("\n")) {
    lineStart.push(lineStart[lineStart.length - 1] + l.replace(/\r$/, "").length + 1);
  }
  return markerViewSpans(parsed).map((sp) => ({
    from: lineStart[sp.start],
    to: lineStart[sp.start + sp.lines],
  }));
}

/**
 * The un-edited `ResolveRegions` straight from a parsed file — the same
 * lead/trail attribution `conflictsToDiff` uses (commons before a conflict
 * lead it; the final trailing commons close the last conflict). Used where
 * no editor holds live regions (the 3-way result preview).
 */
export function regionsFromParsed(parsed: ParsedConflicts): ResolveRegions[] {
  const out: ResolveRegions[] = [];
  let pending: string[] = [];
  for (const section of parsed.sections) {
    if (section.kind === "common") {
      pending = pending.concat(section.lines);
      continue;
    }
    out.push({ lead: pending, ours: [...section.ours], theirs: [...section.theirs], trail: [] });
    pending = [];
  }
  if (out.length > 0 && pending.length > 0) {
    out[out.length - 1] = { ...out[out.length - 1], trail: pending };
  }
  return out;
}
