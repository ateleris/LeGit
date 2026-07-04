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
