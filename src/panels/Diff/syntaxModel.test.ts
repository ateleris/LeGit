import { describe, expect, it } from "vitest";
import { javascriptLanguage } from "@codemirror/lang-javascript";
import {
  buildSideDocs,
  computeFileSyntaxSegments,
  computeSyntaxSegments,
  mapHighlightsToRows,
  syntaxVarFor,
  type SyntaxRow,
  type SyntaxSegment,
} from "./syntaxModel";

// Row helpers mirroring the shapes diffModel produces (only the fields the
// syntax model reads).
const hunk = (hunkIndex = 0): SyntaxRow => ({ kind: "Hunk", text: "@@", hunkIndex });
const ctx = (text: string, hunkIndex = 0): SyntaxRow => ({ kind: "Context", text, hunkIndex });
const add = (text: string, hunkIndex = 0): SyntaxRow => ({ kind: "Added", text, hunkIndex });
const del = (text: string, hunkIndex = 0): SyntaxRow => ({ kind: "Removed", text, hunkIndex });
const filler = (hunkIndex = 0): SyntaxRow => ({ kind: "Filler", text: "", hunkIndex });

describe("buildSideDocs", () => {
  it("reconstructs the old side (context + removed) and new side (context + added) per hunk", () => {
    const rows = [hunk(), ctx("a"), del("gone"), add("fresh"), ctx("b")];
    const docs = buildSideDocs(rows, "new");

    const oldDoc = docs.find((d) => d.text.includes("gone"))!;
    const newDoc = docs.find((d) => d.text.includes("fresh"))!;
    expect(oldDoc.text).toBe("a\ngone\nb");
    expect(newDoc.text).toBe("a\nfresh\nb");
    expect(oldDoc.lines.map((l) => l.row)).toEqual([1, 2, 4]);
    expect(newDoc.lines.map((l) => l.row)).toEqual([1, 3, 4]);
  });

  it("attributes context rows to the requested side only", () => {
    const rows = [hunk(), ctx("a"), del("gone"), add("fresh")];
    const docs = buildSideDocs(rows, "new");
    const oldDoc = docs.find((d) => d.text.includes("gone"))!;
    const newDoc = docs.find((d) => d.text.includes("fresh"))!;

    // Context row 1 appears in both docs but only the new doc owns it.
    expect(oldDoc.lines.find((l) => l.row === 1)!.attributed).toBe(false);
    expect(newDoc.lines.find((l) => l.row === 1)!.attributed).toBe(true);
    // Changed rows are always attributed to their own side.
    expect(oldDoc.lines.find((l) => l.row === 2)!.attributed).toBe(true);
    expect(newDoc.lines.find((l) => l.row === 3)!.attributed).toBe(true);
  });

  it("keeps hunks separate and ignores hunk-header and filler rows", () => {
    const rows = [hunk(0), add("one", 0), filler(0), hunk(1), add("two", 1)];
    const docs = buildSideDocs(rows, "new");
    expect(docs.map((d) => d.text).sort()).toEqual(["one", "two"]);
  });
});

describe("mapHighlightsToRows", () => {
  it("converts doc-offset ranges into row-local segments, splitting at line boundaries", () => {
    // Doc "abc\ndef": rows 5 and 7. Range [2, 5) spans "c" + "d".
    const doc = {
      text: "abc\ndef",
      lines: [
        { row: 5, attributed: true },
        { row: 7, attributed: true },
      ],
    };
    const out: SyntaxSegment[][] = Array.from({ length: 8 }, () => []);
    mapHighlightsToRows(doc, [{ from: 2, to: 5, cls: "cm-syn-string" }], out);
    expect(out[5]).toEqual([{ from: 2, to: 3, cls: "cm-syn-string" }]);
    expect(out[7]).toEqual([{ from: 0, to: 1, cls: "cm-syn-string" }]);
  });

  it("drops segments on lines the doc does not own", () => {
    const doc = {
      text: "abc\ndef",
      lines: [
        { row: 0, attributed: false },
        { row: 1, attributed: true },
      ],
    };
    const out: SyntaxSegment[][] = [[], []];
    mapHighlightsToRows(doc, [{ from: 0, to: 7, cls: "cm-syn-comment" }], out);
    expect(out[0]).toEqual([]);
    expect(out[1]).toEqual([{ from: 0, to: 3, cls: "cm-syn-comment" }]);
  });
});

describe("computeSyntaxSegments (real JavaScript parser)", () => {
  const parser = javascriptLanguage.parser;

  const segText = (row: SyntaxRow, s: SyntaxSegment) => row.text.slice(s.from, s.to);

  it("highlights keywords and strings on added lines", () => {
    const rows = [hunk(), add('const x = "hi";')];
    const segs = computeSyntaxSegments(rows, parser, "new");
    const texts = segs[1].map((s) => `${segText(rows[1], s)}:${s.cls}`);
    expect(texts).toContain("const:cm-syn-keyword");
    expect(texts.some((t) => t.includes('"hi"') && t.includes("cm-syn-string"))).toBe(true);
  });

  it("highlights removed lines against the old side", () => {
    const rows = [hunk(), del("return 42;")];
    const segs = computeSyntaxSegments(rows, parser, "new");
    const texts = segs[1].map((s) => `${segText(rows[1], s)}:${s.cls}`);
    expect(texts).toContain("return:cm-syn-keyword");
    expect(texts).toContain("42:cm-syn-number");
  });

  it("carries multi-line constructs across lines of the same hunk side", () => {
    // A block comment opened on one added line and closed on the next: the
    // reason we tokenize the reconstructed side, not each line alone.
    const rows = [hunk(), add("/* first"), add("second */"), add("let y = 1;")];
    const segs = computeSyntaxSegments(rows, parser, "new");
    expect(segs[1].some((s) => s.cls === "cm-syn-comment")).toBe(true);
    expect(segs[2].some((s) => s.cls === "cm-syn-comment")).toBe(true);
    // ...and the code after the comment still highlights normally.
    expect(segs[3].map((s) => `${segText(rows[3], s)}:${s.cls}`)).toContain("let:cm-syn-keyword");
  });

  it("a broken construct in one hunk does not poison the next hunk", () => {
    const rows = [hunk(0), add("`unterminated template", 0), hunk(1), add("const z = 2;", 1)];
    const segs = computeSyntaxSegments(rows, parser, "new");
    expect(segs[3].map((s) => `${segText(rows[3], s)}:${s.cls}`)).toContain("const:cm-syn-keyword");
  });

  it("context rows get segments from the requested side and changed rows keep theirs", () => {
    const rows = [hunk(), ctx("function f() {"), del("  return 1;"), add("  return 2;"), ctx("}")];
    const segs = computeSyntaxSegments(rows, parser, "new");
    expect(segs[1].some((s) => s.cls === "cm-syn-keyword")).toBe(true); // function
    expect(segs[2].some((s) => s.cls === "cm-syn-keyword")).toBe(true); // return (old side)
    expect(segs[3].some((s) => s.cls === "cm-syn-keyword")).toBe(true); // return (new side)
    // No duplicate attribution: exactly one keyword segment on the context row.
    expect(segs[1].filter((s) => s.cls === "cm-syn-keyword")).toHaveLength(1);
  });

  it("leaves hunk headers and fillers untouched", () => {
    const rows = [hunk(), add("let a = 1;"), filler()];
    const segs = computeSyntaxSegments(rows, parser, "new");
    expect(segs[0]).toEqual([]);
    expect(segs[2]).toEqual([]);
  });
});

describe("computeFileSyntaxSegments (whole file, e.g. Blame)", () => {
  const parser = javascriptLanguage.parser;

  it("highlights a whole file with cross-line fidelity", () => {
    const lines = ["/* first", "second */", 'const x = "hi";'];
    const segs = computeFileSyntaxSegments(lines, parser);
    expect(segs).toHaveLength(3);
    expect(segs[0].some((s) => s.cls === "cm-syn-comment")).toBe(true);
    expect(segs[1].some((s) => s.cls === "cm-syn-comment")).toBe(true);
    const third = segs[2].map((s) => `${lines[2].slice(s.from, s.to)}:${s.cls}`);
    expect(third).toContain("const:cm-syn-keyword");
  });
});

describe("syntaxVarFor", () => {
  // Non-CodeMirror surfaces (Blame's custom rows) can't use the cm-syn-*
  // classes (they are scoped to the editor theme) - they inline the token
  // colour instead.
  it("maps a segment class to its theme-token var", () => {
    expect(syntaxVarFor("cm-syn-keyword")).toBe("var(--syntax-keyword)");
    // Multiple classes (a node carrying several tags): first one wins.
    expect(syntaxVarFor("cm-syn-string cm-syn-constant")).toBe("var(--syntax-string)");
  });
});
