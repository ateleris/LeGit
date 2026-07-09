import { describe, expect, it } from "vitest";
import {
  applyEol,
  collectHunkNewSideTexts,
  detectEol,
  hasTrailingNewline,
  splitLines,
  spliceEdits,
  type RowMeta,
} from "./editModel";

describe("detectEol / splitLines / hasTrailingNewline", () => {
  it("detects CRLF when present", () => {
    expect(detectEol("a\r\nb\r\n")).toBe("\r\n");
    expect(detectEol("a\nb\n")).toBe("\n");
    expect(detectEol("")).toBe("\n");
  });

  it("splits lines dropping the trailing empty piece", () => {
    expect(splitLines("a\nb\n")).toEqual(["a", "b"]);
    expect(splitLines("a\r\nb")).toEqual(["a", "b"]);
    expect(splitLines("")).toEqual([]);
  });

  it("reports trailing newline", () => {
    expect(hasTrailingNewline("a\n")).toBe(true);
    expect(hasTrailingNewline("a")).toBe(false);
  });
});

describe("applyEol", () => {
  // A CodeMirror document always joins lines with "\n" (toString), so a doc
  // written back wholesale (the 3-way resolve save path) must have the file's
  // real EOL re-instated or a CRLF file is silently normalized to LF.
  it("re-instates CRLF on LF-joined editor text", () => {
    expect(applyEol("a\nb\nc\n", "\r\n")).toBe("a\r\nb\r\nc\r\n");
  });

  it("leaves LF text unchanged for an LF file", () => {
    expect(applyEol("a\nb\n", "\n")).toBe("a\nb\n");
  });

  it("normalizes stray CRLF a user pasted into the editor", () => {
    expect(applyEol("a\r\nb\n", "\n")).toBe("a\nb\n");
    expect(applyEol("a\r\nb\n", "\r\n")).toBe("a\r\nb\r\n");
  });

  it("preserves a missing trailing newline", () => {
    expect(applyEol("a\nb", "\r\n")).toBe("a\r\nb");
  });
});

describe("spliceEdits", () => {
  it("replaces a hunk's new-side range in the middle of a file", () => {
    const original = "one\ntwo\nthree\nfour\nfive\n";
    // Hunk covered lines 2-4 (three lines); user edited them down to two.
    const result = spliceEdits(
      original,
      [{ newStart: 2, newLines: 3 }],
      [["TWO", "3+4"]]
    );
    expect(result).toBe("one\nTWO\n3+4\nfive\n");
  });

  it("preserves CRLF line endings", () => {
    const original = "one\r\ntwo\r\nthree\r\n";
    const result = spliceEdits(original, [{ newStart: 2, newLines: 1 }], [["TWO"]]);
    expect(result).toBe("one\r\nTWO\r\nthree\r\n");
  });

  it("preserves a missing trailing newline", () => {
    const original = "one\ntwo";
    const result = spliceEdits(original, [{ newStart: 1, newLines: 1 }], [["ONE"]]);
    expect(result).toBe("ONE\ntwo");
  });

  it("handles multiple hunks without offset drift (splices bottom-up)", () => {
    const original = "a\nb\nc\nd\ne\nf\ng\n";
    const result = spliceEdits(
      original,
      [
        { newStart: 2, newLines: 1 },
        { newStart: 6, newLines: 1 },
      ],
      [
        ["B", "B2"], // grew by one line
        ["F"],
      ]
    );
    expect(result).toBe("a\nB\nB2\nc\nd\ne\nF\ng\n");
  });

  it("handles a hunk that grows and one that shrinks to empty", () => {
    const original = "a\nb\nc\nd\n";
    const result = spliceEdits(
      original,
      [
        { newStart: 1, newLines: 1 },
        { newStart: 3, newLines: 2 },
      ],
      [["a", "a2"], []]
    );
    expect(result).toBe("a\na2\nb\n");
  });

  it("strips stray carriage returns from collected lines (CRLF doc)", () => {
    const original = "one\r\ntwo\r\n";
    const result = spliceEdits(original, [{ newStart: 1, newLines: 1 }], [["ONE\r"]]);
    expect(result).toBe("ONE\r\ntwo\r\n");
  });
});

describe("collectHunkNewSideTexts", () => {
  // Inline-view row model of one hunk: header, context, removed, added, context.
  const rows: RowMeta[] = [
    { kind: "Hunk", hunkIndex: 0 },
    { kind: "Context", hunkIndex: 0 },
    { kind: "Removed", hunkIndex: 0 },
    { kind: "Added", hunkIndex: 0 },
    { kind: "Context", hunkIndex: 0 },
  ];

  it("collects context + added lines, skipping headers and removed", () => {
    const docLines = ["@@ -1,3 +1,3 @@", "ctx1", "old", "new", "ctx2"];
    const out = collectHunkNewSideTexts(docLines, (i) => i, rows, 1);
    expect(out).toEqual([["ctx1", "new", "ctx2"]]);
  });

  it("attributes user-inserted lines (no marker) to the preceding row's hunk", () => {
    // A line was inserted after "new": doc has 6 lines, line 4 has no marker.
    const docLines = ["@@ -1,3 +1,3 @@", "ctx1", "old", "new", "inserted", "ctx2"];
    const rowAt = (i: number) => (i <= 3 ? i : i === 4 ? null : 4);
    const out = collectHunkNewSideTexts(docLines, rowAt, rows, 1);
    expect(out).toEqual([["ctx1", "new", "inserted", "ctx2"]]);
  });

  it("skips filler rows (split view) and handles multiple hunks", () => {
    const splitRows: RowMeta[] = [
      { kind: "Hunk", hunkIndex: 0 },
      { kind: "Added", hunkIndex: 0 },
      { kind: "Filler", hunkIndex: 0 },
      { kind: "Hunk", hunkIndex: 1 },
      { kind: "Context", hunkIndex: 1 },
    ];
    const docLines = ["@@", "new0", "", "@@", "ctx1"];
    const out = collectHunkNewSideTexts(docLines, (i) => i, splitRows, 2);
    expect(out).toEqual([["new0"], ["ctx1"]]);
  });

  it("a deleted line simply no longer contributes", () => {
    // "new" was deleted: doc is 4 lines; markers skip original row 3.
    const docLines = ["@@ -1,3 +1,3 @@", "ctx1", "old", "ctx2"];
    const rowAt = (i: number) => (i <= 2 ? i : 4);
    const out = collectHunkNewSideTexts(docLines, rowAt, rows, 1);
    expect(out).toEqual([["ctx1", "ctx2"]]);
  });
});
