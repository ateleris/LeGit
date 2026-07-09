// Pure helpers for the editable diff viewer: EOL handling, splicing edited
// per-hunk text back into the original working-tree file, and rebuilding each
// hunk's new-side text from the edited document. No CodeMirror imports, so
// everything here is unit-testable headlessly.

export type Eol = "\n" | "\r\n";

export function detectEol(text: string): Eol {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

export function hasTrailingNewline(text: string): boolean {
  return text.endsWith("\n");
}

/** Rewrite every line break in `text` to `eol`. A CodeMirror document joins
 *  lines with "\n" regardless of the source file, so any save path that
 *  writes an editor document wholesale (the 3-way resolve view) must
 *  re-instate the file's real EOL or a CRLF file is silently normalized. */
export function applyEol(text: string, eol: Eol): string {
  return text.replace(/\r?\n/g, eol);
}

/** Split file text into lines without their EOLs; a trailing newline does not
 *  produce a final empty line. */
export function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split(/\r\n|\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** A hunk's new-side line range (1-based start, line count), from `DiffHunk`. */
export interface HunkRange {
  newStart: number;
  newLines: number;
}

/**
 * Replace each hunk's new-side line range in `originalText` with the edited
 * lines in `hunkTexts` (parallel to `hunks`). Splices bottom-up so earlier
 * hunks' line numbers stay valid while later ones change length. Preserves the
 * file's EOL style and trailing-newline state; stray `\r` on collected lines
 * (a CRLF file rendered in CodeMirror) is stripped before joining.
 */
export function spliceEdits(
  originalText: string,
  hunks: HunkRange[],
  hunkTexts: string[][]
): string {
  const eol = detectEol(originalText);
  const lines = splitLines(originalText);
  const order = hunks
    .map((_, i) => i)
    .sort((a, b) => hunks[b].newStart - hunks[a].newStart);
  for (const i of order) {
    const h = hunks[i];
    const replacement = hunkTexts[i].map((l) => l.replace(/\r$/, ""));
    // newStart is 1-based; git uses start 0 for an empty new side.
    const start = Math.max(h.newStart - 1, 0);
    lines.splice(start, h.newLines, ...replacement);
  }
  const body = lines.join(eol);
  return hasTrailingNewline(originalText) && lines.length > 0 ? body + eol : body;
}

/** The subset of a diff row the collector needs (DiffRow and SplitRow both fit). */
export interface RowMeta {
  kind: string;
  hunkIndex: number;
}

/** Regions of one conflict hunk collected from the edited editor document
 *  (consumed by conflictModel.composeResolvedFile). */
export interface ResolveRegions {
  lead: string[];
  ours: string[];
  theirs: string[];
  trail: string[];
}

/** One editor pane's current document plus its row-identity lookup. */
export interface PaneDoc {
  docLines: string[];
  rowIndexAt: (line: number) => number | null;
  rows: RowMeta[];
}

type ResolvePhase = "lead" | "ours" | "theirs" | "trail";

function emptyRegions(hunkCount: number): ResolveRegions[] {
  return Array.from({ length: hunkCount }, () => ({
    lead: [],
    ours: [],
    theirs: [],
    trail: [],
  }));
}

/** Row kinds whose text belongs to the new (working-tree) side of the file. */
const NEW_SIDE_KINDS = new Set(["Context", "Added"]);

/**
 * Rebuild each hunk's new-side text from the edited document. `rowIndexAt`
 * maps a 0-based doc line to its original row index, or null for a line the
 * user inserted. Inserted lines are attributed to the hunk of the nearest
 * preceding original row; the edit guard only permits insertions inside
 * editable regions, so that row always exists and belongs to the right hunk.
 */
export function collectHunkNewSideTexts(
  docLines: string[],
  rowIndexAt: (line: number) => number | null,
  rows: RowMeta[],
  hunkCount: number
): string[][] {
  const out: string[][] = Array.from({ length: hunkCount }, () => []);
  let lastHunk = -1;
  for (let i = 0; i < docLines.length; i++) {
    const rowIndex = rowIndexAt(i);
    if (rowIndex != null && rows[rowIndex]) {
      const row = rows[rowIndex];
      lastHunk = row.hunkIndex;
      if (NEW_SIDE_KINDS.has(row.kind)) out[row.hunkIndex].push(docLines[i]);
    } else if (lastHunk >= 0) {
      out[lastHunk].push(docLines[i]);
    }
  }
  return out;
}
