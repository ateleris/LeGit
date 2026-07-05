// Syntax highlighting for the diff views. The rendered document interleaves
// old/new/context lines, so a language parser can never run on it directly.
// Instead each hunk's two sides are reconstructed from the rows (old =
// context + removed, new = context + added), parsed independently, and the
// resulting highlight ranges are mapped back onto the rows as row-local
// segments. Multi-line constructs (block comments, template strings) within a
// hunk therefore highlight correctly; only constructs opened outside the
// hunk's context window mis-parse - the approximation every mainstream diff
// viewer accepts. Parsing per hunk (not per file) keeps a broken construct in
// one hunk from poisoning the next.
//
// Everything here is pure (rows + parser -> segments); language loading and
// editor decoration live in the DiffEditor integration.

import type { Parser } from "@lezer/common";
import { highlightTree, tagHighlighter, tags as t } from "@lezer/highlight";

/** A highlighted character range within a row's text (half-open [from, to)). */
export interface SyntaxSegment {
  from: number;
  to: number;
  /** `cm-syn-*` class(es); colours come from the `syntax.*` theme tokens. */
  cls: string;
}

/** The row fields the syntax model reads - satisfied by DiffRow and SplitRow. */
export interface SyntaxRow {
  kind: string;
  text: string;
  hunkIndex: number;
}

/** Which side a pane's context rows read their highlights from: "new" for the
 *  inline view and the split right pane, "old" for the split left pane (its
 *  old-side doc is the complete one there). */
export type ContextSide = "old" | "new";

/** One reconstructed hunk side. `lines[i]` names the row shown as doc line i;
 *  `attributed` marks the doc that owns the row's highlights (context rows
 *  appear in both docs for parsing fidelity but are owned by exactly one). */
export interface SideDoc {
  text: string;
  lines: { row: number; attributed: boolean }[];
}

/** Reconstruct each hunk's old/new side docs from the rendered rows. Docs
 *  with no attributed line are skipped by the caller (nothing to map back). */
export function buildSideDocs(rows: readonly SyntaxRow[], contextSide: ContextSide): SideDoc[] {
  interface Building {
    texts: string[];
    lines: { row: number; attributed: boolean }[];
  }
  const perHunk = new Map<number, { old: Building; new: Building }>();
  const building = (hunkIndex: number) => {
    let b = perHunk.get(hunkIndex);
    if (!b) {
      b = { old: { texts: [], lines: [] }, new: { texts: [], lines: [] } };
      perHunk.set(hunkIndex, b);
    }
    return b;
  };

  rows.forEach((row, i) => {
    const push = (side: "old" | "new", attributed: boolean) => {
      const doc = building(row.hunkIndex)[side];
      doc.texts.push(row.text);
      doc.lines.push({ row: i, attributed });
    };
    if (row.kind === "Removed") push("old", true);
    else if (row.kind === "Added") push("new", true);
    else if (row.kind === "Context") {
      push("old", contextSide === "old");
      push("new", contextSide === "new");
    }
    // Hunk headers and fillers are display chrome, not source text.
  });

  const docs: SideDoc[] = [];
  for (const { old, new: neu } of perHunk.values()) {
    for (const b of [old, neu]) {
      if (b.lines.length > 0) docs.push({ text: b.texts.join("\n"), lines: b.lines });
    }
  }
  return docs;
}

/** Split doc-offset highlight ranges at line boundaries and append them, in
 *  row-local coordinates, to `out[row]` - only for lines the doc owns. */
export function mapHighlightsToRows(
  doc: SideDoc,
  ranges: readonly { from: number; to: number; cls: string }[],
  out: SyntaxSegment[][]
): void {
  // Line start offsets (lines are joined with single "\n"s).
  const starts: number[] = [];
  let offset = 0;
  for (const line of doc.text.split("\n")) {
    starts.push(offset);
    offset += line.length + 1;
  }

  for (const range of ranges) {
    // First line whose span can overlap the range.
    let line = starts.findIndex((s, i) => range.from < (starts[i + 1] ?? Infinity) && range.to > s);
    if (line < 0) continue;
    for (; line < starts.length; line++) {
      const lineStart = starts[line];
      if (lineStart >= range.to) break;
      const lineEnd = (starts[line + 1] ?? doc.text.length + 1) - 1;
      const from = Math.max(range.from, lineStart);
      const to = Math.min(range.to, lineEnd);
      if (to <= from) continue;
      const { row, attributed } = doc.lines[line];
      if (!attributed) continue;
      out[row].push({ from: from - lineStart, to: to - lineStart, cls: range.cls });
    }
  }
}

// Lezer tag -> cm-syn-* class. `tag.set` is walked most-specific-first, so a
// broad tag (t.comment) covers its subtypes and a specific mapping
// (t.function(t.variableName)) wins over its parent (t.variableName). The
// class set is deliberately small - it mirrors the `syntax.*` theme tokens.
const diffHighlighter = tagHighlighter([
  { tag: t.keyword, class: "cm-syn-keyword" },
  { tag: [t.string, t.special(t.string), t.regexp, t.character], class: "cm-syn-string" },
  { tag: t.number, class: "cm-syn-number" },
  { tag: [t.comment, t.meta], class: "cm-syn-comment" },
  {
    tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName, t.labelName],
    class: "cm-syn-function",
  },
  { tag: [t.typeName, t.className, t.namespace], class: "cm-syn-type" },
  { tag: t.variableName, class: "cm-syn-variable" },
  { tag: [t.propertyName, t.attributeName], class: "cm-syn-property" },
  { tag: [t.operator, t.derefOperator], class: "cm-syn-operator" },
  { tag: [t.punctuation, t.bracket], class: "cm-syn-punctuation" },
  { tag: [t.bool, t.null, t.atom, t.self, t.literal], class: "cm-syn-constant" },
  { tag: [t.tagName, t.heading], class: "cm-syn-tag" },
]);

/** Skip highlighting for very large content: parsing is synchronous on the
 *  main thread once the language has loaded. Shared by every consumer. */
export const MAX_SYNTAX_CHARS = 400_000;

/** Whole-file per-line highlight segments (full fidelity - the "document" IS
 *  the file). Used by surfaces that show a complete file in custom DOM,
 *  e.g. the Blame panel's rows. */
export function computeFileSyntaxSegments(
  lines: readonly string[],
  parser: Parser
): SyntaxSegment[][] {
  const rows: SyntaxRow[] = lines.map((text) => ({ kind: "Added", text, hunkIndex: 0 }));
  return computeSyntaxSegments(rows, parser, "new");
}

/** The theme-token colour behind each segment class, for surfaces that render
 *  outside CodeMirror (the `cm-syn-*` classes are scoped to the editor
 *  theme). An explicit map - never string-built - so an unexpected class can
 *  only ever fall back to `inherit`, not an undefined variable. */
const SYNTAX_VARS: Record<string, string> = {
  "cm-syn-keyword": "var(--syntax-keyword)",
  "cm-syn-string": "var(--syntax-string)",
  "cm-syn-number": "var(--syntax-number)",
  "cm-syn-comment": "var(--syntax-comment)",
  "cm-syn-function": "var(--syntax-function)",
  "cm-syn-type": "var(--syntax-type)",
  "cm-syn-variable": "var(--syntax-variable)",
  "cm-syn-property": "var(--syntax-property)",
  "cm-syn-operator": "var(--syntax-operator)",
  "cm-syn-punctuation": "var(--syntax-punctuation)",
  "cm-syn-constant": "var(--syntax-constant)",
  "cm-syn-tag": "var(--syntax-tag)",
};

/** `"cm-syn-keyword"` -> `"var(--syntax-keyword)"`. A segment carrying
 *  several classes (a node with multiple tags) uses the first. */
export function syntaxVarFor(cls: string): string {
  return SYNTAX_VARS[cls.split(" ")[0]] ?? "inherit";
}

/** Per-row highlight segments for the given rows: reconstruct each hunk side,
 *  parse it, and map the highlights back. Pure and synchronous - the caller
 *  supplies the (lazily loaded) parser. */
export function computeSyntaxSegments(
  rows: readonly SyntaxRow[],
  parser: Parser,
  contextSide: ContextSide
): SyntaxSegment[][] {
  const out: SyntaxSegment[][] = rows.map(() => []);
  for (const doc of buildSideDocs(rows, contextSide)) {
    if (!doc.lines.some((l) => l.attributed)) continue;
    const ranges: { from: number; to: number; cls: string }[] = [];
    highlightTree(parser.parse(doc.text), diffHighlighter, (from, to, cls) => {
      ranges.push({ from, to, cls });
    });
    mapHighlightsToRows(doc, ranges, out);
  }
  return out;
}
