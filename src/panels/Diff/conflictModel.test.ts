import { describe, expect, it } from "vitest";
import {
  alignedBreakpoints,
  conflictAnchors,
  conflictsToDiff,
  parseConflicts,
  piecewiseMap,
  reconstructResolvedFile,
  resolveBlock,
} from "./conflictModel";

const CLASSIC = [
  "before",
  "<<<<<<< HEAD",
  "ours1",
  "ours2",
  "=======",
  "theirs1",
  ">>>>>>> feature/x",
  "after",
].join("\n") + "\n";

const DIFF3 = [
  "<<<<<<< HEAD",
  "ours",
  "||||||| base123",
  "orig",
  "=======",
  "theirs",
  ">>>>>>> feature/x",
].join("\n") + "\n";

describe("parseConflicts", () => {
  it("parses a classic conflict with surrounding common lines", () => {
    const p = parseConflicts(CLASSIC);
    expect(p.conflictCount).toBe(1);
    expect(p.sections).toEqual([
      { kind: "common", lines: ["before"] },
      {
        kind: "conflict",
        oursLabel: "HEAD",
        theirsLabel: "feature/x",
        ours: ["ours1", "ours2"],
        base: null,
        baseLabel: null,
        theirs: ["theirs1"],
      },
      { kind: "common", lines: ["after"] },
    ]);
    expect(p.eol).toBe("\n");
    expect(p.trailingNewline).toBe(true);
  });

  it("parses diff3-style base sections", () => {
    const p = parseConflicts(DIFF3);
    expect(p.conflictCount).toBe(1);
    const c = p.sections[0];
    expect(c).toMatchObject({
      kind: "conflict",
      base: ["orig"],
      baseLabel: "base123",
    });
  });

  it("treats an unterminated conflict as common lines (fail-safe)", () => {
    const p = parseConflicts("a\n<<<<<<< HEAD\nx\ny\n");
    expect(p.conflictCount).toBe(0);
    expect(p.sections).toEqual([
      { kind: "common", lines: ["a", "<<<<<<< HEAD", "x", "y"] },
    ]);
  });

  it("parses multiple conflicts and empty sides", () => {
    const text = [
      "<<<<<<< HEAD",
      "=======",
      "t1",
      ">>>>>>> b",
      "mid",
      "<<<<<<< HEAD",
      "o2",
      "=======",
      ">>>>>>> b",
    ].join("\n") + "\n";
    const p = parseConflicts(text);
    expect(p.conflictCount).toBe(2);
    expect((p.sections[0] as { ours: string[] }).ours).toEqual([]);
    expect((p.sections[2] as { theirs: string[] }).theirs).toEqual([]);
  });
});

describe("conflictsToDiff", () => {
  it("maps ours to Removed, theirs to Added, commons to Context", () => {
    const diff = conflictsToDiff(parseConflicts(CLASSIC), "a.txt");
    expect(diff.hunks).toHaveLength(1);
    const h = diff.hunks[0];
    expect(h.lines.map((l) => l.kind)).toEqual([
      "Context", // before
      "Removed", // ours1
      "Removed", // ours2
      "Added", // theirs1
      "Context", // after (trailing common on the last hunk)
    ]);
    expect(h.lines.map((l) => l.content)).toEqual([
      "before", "ours1", "ours2", "theirs1", "after",
    ]);
    // ours-side numbering: before(1) ours1(2) ours2(3) after(4)
    expect(h.old_start).toBe(1);
    expect(h.old_lines).toBe(4);
    // theirs-side numbering: before(1) theirs1(2) after(3)
    expect(h.new_start).toBe(1);
    expect(h.new_lines).toBe(3);
    expect(h.header).toContain("Conflict 1/1");
    expect(h.header).toContain("HEAD");
    expect(h.header).toContain("feature/x");
  });

  it("assigns commons between conflicts as the next hunk's lead context", () => {
    const text = [
      "<<<<<<< a", "o1", "=======", "t1", ">>>>>>> b",
      "mid1",
      "mid2",
      "<<<<<<< a", "o2", "=======", "t2", ">>>>>>> b",
    ].join("\n") + "\n";
    const diff = conflictsToDiff(parseConflicts(text), "a.txt");
    expect(diff.hunks).toHaveLength(2);
    expect(diff.hunks[0].lines.map((l) => l.content)).toEqual(["o1", "t1"]);
    expect(diff.hunks[1].lines.map((l) => l.content)).toEqual(["mid1", "mid2", "o2", "t2"]);
    // Second hunk's numbering starts after hunk 1 on each side.
    expect(diff.hunks[1].old_start).toBe(2); // o1(1) mid1(2)...
    expect(diff.hunks[1].new_start).toBe(2); // t1(1) mid1(2)...
  });
});

describe("resolveBlock", () => {
  it("takes ours / theirs / both and preserves EOL + trailing newline", () => {
    expect(resolveBlock(CLASSIC, 0, "ours")).toBe("before\nours1\nours2\nafter\n");
    expect(resolveBlock(CLASSIC, 0, "theirs")).toBe("before\ntheirs1\nafter\n");
    expect(resolveBlock(CLASSIC, 0, "both")).toBe(
      "before\nours1\nours2\ntheirs1\nafter\n",
    );
    const crlf = CLASSIC.replace(/\n/g, "\r\n");
    expect(resolveBlock(crlf, 0, "theirs")).toBe("before\r\ntheirs1\r\nafter\r\n");
    const noTrail = CLASSIC.slice(0, -1);
    expect(resolveBlock(noTrail, 0, "ours")).toBe("before\nours1\nours2\nafter");
  });

  it("resolves only the addressed conflict; diff3 base is dropped", () => {
    const text = [
      "<<<<<<< a", "o1", "=======", "t1", ">>>>>>> b",
      "mid",
      "<<<<<<< a", "o2", "=======", "t2", ">>>>>>> b",
    ].join("\n") + "\n";
    expect(resolveBlock(text, 1, "theirs")).toBe(
      ["<<<<<<< a", "o1", "=======", "t1", ">>>>>>> b", "mid", "t2"].join("\n") + "\n",
    );
    expect(resolveBlock(DIFF3, 0, "ours")).toBe("ours\n");
  });
});

describe("reconstructResolvedFile", () => {
  it("rebuilds the marker file from edited regions (diff3 base kept verbatim)", () => {
    const p = parseConflicts(DIFF3);
    const out = reconstructResolvedFile(p, [
      { lead: [], ours: ["ours EDITED"], theirs: ["theirs", "extra"], trail: [] },
    ]);
    expect(out).toBe(
      [
        "<<<<<<< HEAD",
        "ours EDITED",
        "||||||| base123",
        "orig",
        "=======",
        "theirs",
        "extra",
        ">>>>>>> feature/x",
      ].join("\n") + "\n",
    );
  });

  it("re-emits edited lead/trail context and preserves CRLF", () => {
    const p = parseConflicts(CLASSIC.replace(/\n/g, "\r\n"));
    const out = reconstructResolvedFile(p, [
      { lead: ["BEFORE"], ours: ["ours1", "ours2"], theirs: ["theirs1"], trail: ["after", "added"] },
    ]);
    expect(out).toBe(
      ["BEFORE", "<<<<<<< HEAD", "ours1", "ours2", "=======", "theirs1", ">>>>>>> feature/x", "after", "added"]
        .join("\r\n") + "\r\n",
    );
  });
});

describe("conflictAnchors", () => {
  // 3-way scroll sync: for each conflict, the 0-based start line in the
  // centre (marker) doc and in each side's "file as if that side were
  // chosen" - the shape of the real index stages.
  it("locates each conflict in the centre and both side docs", () => {
    const two = [
      "a",            // common (1 line)
      "<<<<<<< HEAD", // conflict 0: centre line 1
      "o1",
      "o2",
      "=======",
      "t1",
      ">>>>>>> x",
      "b",            // common
      "<<<<<<< HEAD", // conflict 1
      "o3",
      "=======",
      "t2",
      "t3",
      ">>>>>>> x",
    ].join("\n") + "\n";
    const anchors = conflictAnchors(parseConflicts(two));
    expect(anchors.center).toEqual([1, 8]);
    // ours doc: a, o1, o2, b, o3 -> conflicts at 1 and 4
    expect(anchors.ours).toEqual([1, 4]);
    // theirs doc: a, t1, b, t2, t3 -> conflicts at 1 and 3
    expect(anchors.theirs).toEqual([1, 3]);
    // classic markers carry no base content
    expect(anchors.base).toBeNull();
  });

  it("derives base anchors for diff3 markers", () => {
    const diff3 = [
      "lead",
      "<<<<<<< HEAD",
      "ours",
      "||||||| base123",
      "orig1",
      "orig2",
      "=======",
      "theirs",
      ">>>>>>> x",
    ].join("\n") + "\n";
    const anchors = conflictAnchors(parseConflicts(diff3));
    expect(anchors.center).toEqual([1]);
    // base doc: lead, orig1, orig2 -> conflict content starts at line 1
    expect(anchors.base).toEqual([1]);
  });
});

describe("piecewiseMap / alignedBreakpoints", () => {
  it("interpolates linearly between breakpoints and clamps at the ends", () => {
    const xs = [0, 100, 200];
    const ys = [0, 50, 400];
    expect(piecewiseMap(0, xs, ys)).toBe(0);
    expect(piecewiseMap(50, xs, ys)).toBe(25);
    expect(piecewiseMap(150, xs, ys)).toBe(225);
    expect(piecewiseMap(-10, xs, ys)).toBe(0);
    expect(piecewiseMap(999, xs, ys)).toBe(400);
  });

  it("handles a single breakpoint (unscrollable pane)", () => {
    expect(piecewiseMap(123, [0], [0])).toBe(0);
  });

  it("builds monotone breakpoints from anchor tops, clamped to the scroll ranges", () => {
    const { xs, ys } = alignedBreakpoints([100, 900], 500, [80, 300], 400);
    // Anchor beyond the source scroll range is dropped (clamping would break
    // monotonicity), the ends are pinned to (0,0) and (max,max).
    expect(xs).toEqual([0, 100, 500]);
    expect(ys).toEqual([0, 80, 400]);
  });

  it("drops non-monotonic anchor pairs instead of producing a reversing map", () => {
    const { xs, ys } = alignedBreakpoints([100, 90], 500, [80, 200], 400);
    expect(xs).toEqual([0, 100, 500]);
    expect(ys).toEqual([0, 80, 400]);
  });
});
