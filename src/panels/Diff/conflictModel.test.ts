import { describe, expect, it } from "vitest";
import {
  alignedBreakpoints,
  conflictAnchors,
  conflictSideNames,
  composeBlockLines,
  externalChangePending,
  locateRegionAnchors,
  precedingCommonLines,
  emptySelections,
  blockOrigin,
  foldableRanges,
  initialBlockRanges,
  markerViewSpans,
  blockSection,
  regionsFromParsed,
  parseConflicts,
  piecewiseMap,
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

describe("conflictSideNames", () => {
  it("resolves the HEAD marker to the current branch", () => {
    const names = conflictSideNames(parseConflicts(CLASSIC), "main");
    expect(names).toEqual({ ours: "main", theirs: "feature/x" });
  });

  it("keeps a non-HEAD ours label verbatim", () => {
    const text = ["<<<<<<< release/1.0", "o", "=======", "t", ">>>>>>> hotfix"].join("\n") + "\n";
    const names = conflictSideNames(parseConflicts(text), "main");
    expect(names).toEqual({ ours: "release/1.0", theirs: "hotfix" });
  });

  it("leaves ours unnamed when HEAD cannot be resolved (detached rebase)", () => {
    const names = conflictSideNames(parseConflicts(CLASSIC), null);
    expect(names.ours).toBeNull();
    expect(names.theirs).toBe("feature/x");
  });

  it("returns nulls for label-less markers and for no conflicts", () => {
    const bare = ["<<<<<<<", "o", "=======", "t", ">>>>>>>"].join("\n") + "\n";
    expect(conflictSideNames(parseConflicts(bare), null)).toEqual({ ours: null, theirs: null });
    expect(conflictSideNames(parseConflicts("just text\n"), "main")).toEqual({
      ours: null,
      theirs: null,
    });
  });

  it("resolves git's literal ours/theirs labels (checkout -m reopen)", () => {
    // `git checkout -m` (conflict reopen) regenerates the markers with the
    // hardcoded stage labels "ours"/"theirs" instead of ref names; they must
    // resolve like HEAD does, not show up verbatim in the pane headers.
    const reopened = ["<<<<<<< ours", "o", "=======", "t", ">>>>>>> theirs"].join("\n") + "\n";
    expect(conflictSideNames(parseConflicts(reopened), "main", "new_arch")).toEqual({
      ours: "main",
      theirs: "new_arch",
    });
    // No op-state fallback known: the side stays unnamed rather than "theirs".
    expect(conflictSideNames(parseConflicts(reopened), "main")).toEqual({
      ours: "main",
      theirs: null,
    });
  });

  it("prefers a real theirs ref label over the op-state fallback", () => {
    expect(conflictSideNames(parseConflicts(CLASSIC), "main", "merge-head")).toEqual({
      ours: "main",
      theirs: "feature/x",
    });
  });
});

describe("externalChangePending", () => {
  // The merge view freezes its baseline while the result is dirty; this
  // predicate decides when to tell the user the file changed on disk
  // underneath their in-progress resolution.
  it("flags a disk change only while the result is dirty", () => {
    expect(externalChangePending("a", "b", true, null)).toBe(true);
    // Pristine view: the panel auto-reloads instead of asking.
    expect(externalChangePending("a", "b", false, null)).toBe(false);
  });

  it("is quiet when disk matches the baseline or is not loaded yet", () => {
    expect(externalChangePending("a", "a", true, null)).toBe(false);
    expect(externalChangePending("a", undefined, true, null)).toBe(false);
    expect(externalChangePending(null, "b", true, null)).toBe(false);
  });

  it("stays dismissed for the same disk text, re-fires on a new change", () => {
    expect(externalChangePending("a", "b", true, "b")).toBe(false);
    expect(externalChangePending("a", "c", true, "b")).toBe(true);
  });
});

describe("regionsFromParsed", () => {
  it("mirrors conflictsToDiff's lead/trail attribution", () => {
    const text = [
      "before",
      "<<<<<<< HEAD", "o1", "=======", "t1", ">>>>>>> feature/x",
      "mid",
      "<<<<<<< HEAD", "o2", "=======", "t2", ">>>>>>> feature/x",
      "after",
    ].join("\n") + "\n";
    const regions = regionsFromParsed(parseConflicts(text));
    expect(regions).toEqual([
      { lead: ["before"], ours: ["o1"], theirs: ["t1"], trail: [] },
      { lead: ["mid"], ours: ["o2"], theirs: ["t2"], trail: ["after"] },
    ]);
  });
});

describe("composeBlockLines / markerViewSpans (merge view model)", () => {
  const TEXT3 = [
    "before",
    "<<<<<<< HEAD", "o1", "o2", "=======", "t1", ">>>>>>> feature/x",
    "mid",
    "<<<<<<< HEAD", "o3", "=======", "t3", ">>>>>>> feature/x",
  ].join("\n") + "\n";

  it("composes selected lines in document order (ours then theirs)", () => {
    const parsed = parseConflicts(TEXT3);
    const regions = regionsFromParsed(parsed);
    expect(
      composeBlockLines(regions[0], blockSection(parsed, 0), {
        ours: [true, false],
        theirs: [true],
      }),
    ).toEqual(["o1", "t1"]);
    expect(
      composeBlockLines(regions[0], blockSection(parsed, 0), {
        ours: [false, true],
        theirs: [false],
      }),
    ).toEqual(["o2"]);
  });

  it("no selected lines restores the conflict markers", () => {
    const parsed = parseConflicts(TEXT3);
    const regions = regionsFromParsed(parsed);
    expect(
      composeBlockLines(regions[0], blockSection(parsed, 0), {
        ours: [false, false],
        theirs: [false],
      }),
    ).toEqual(["<<<<<<< HEAD", "o1", "o2", "=======", "t1", ">>>>>>> feature/x"]);
  });

  it("markerViewSpans gives each block's start line and marker-view length", () => {
    const parsed = parseConflicts(TEXT3);
    expect(markerViewSpans(parsed)).toEqual([
      { start: 1, lines: 6 },
      { start: 8, lines: 5 },
    ]);
  });
});

describe("initialBlockRanges", () => {
  const LINES = [
    "before",
    "<<<<<<< HEAD", "o1", "o2", "=======", "t1", ">>>>>>> feature/x",
    "mid",
    "<<<<<<< HEAD", "o3", "=======", "t3", ">>>>>>> feature/x",
  ];
  const LF = LINES.join("\n") + "\n";

  it("gives each block's [from, to) character range in the result doc", () => {
    const ranges = initialBlockRanges(parseConflicts(LF), LF);
    expect(ranges).toEqual([
      { from: LF.indexOf("<<<<<<< HEAD"), to: LF.indexOf("mid") },
      { from: LF.lastIndexOf("<<<<<<< HEAD"), to: LF.length },
    ]);
  });

  it("counts a CRLF break as ONE position, like the CodeMirror doc", () => {
    // CodeMirror normalizes every line break to a single position, so a
    // CRLF file's ranges equal its LF twin's. Raw string offsets would
    // drift +1 per preceding line: block ranges then start BELOW their
    // `<<<<<<<` line, which broke marker highlighting, block replacement
    // and pane alignment on CRLF merge files.
    const crlf = LINES.join("\r\n") + "\r\n";
    expect(initialBlockRanges(parseConflicts(crlf), crlf)).toEqual(
      initialBlockRanges(parseConflicts(LF), LF),
    );
  });
});

describe("locateRegionAnchors", () => {
  it("matches the structural anchors on a pristine merge file", () => {
    const text = [
      "before",
      "<<<<<<< HEAD", "o1", "o2", "=======", "t1", ">>>>>>> b",
      "mid",
      "<<<<<<< HEAD", "o3", "=======", "t3", ">>>>>>> b",
      "after",
    ].join("\n") + "\n";
    const parsed = parseConflicts(text);
    const regions = regionsFromParsed(parsed);
    // The ours stage file: commons + ours regions.
    const oursDoc = ["before", "o1", "o2", "mid", "o3", "after"];
    expect(
      locateRegionAnchors(oursDoc, regions.map((r) => r.ours)),
    ).toEqual(conflictAnchors(parsed).ours);
  });

  it("finds regions even when the marker file's commons were edited", () => {
    // The side doc is unchanged; the searcher only depends on region content.
    const oursDoc = ["before", "o1", "o2", "mid", "o3", "after"];
    expect(locateRegionAnchors(oursDoc, [["o1", "o2"], ["o3"]])).toEqual([1, 4]);
  });

  it("resolves duplicate region content sequentially", () => {
    const doc = ["x", "dup", "y", "dup", "z"];
    expect(locateRegionAnchors(doc, [["dup"], ["dup"]])).toEqual([1, 3]);
  });

  it("anchors an empty region after the previous match", () => {
    const doc = ["a", "o1", "b"];
    expect(locateRegionAnchors(doc, [["o1"], []])).toEqual([1, 2]);
  });

  it("falls back to the search position when a region is missing", () => {
    const doc = ["a", "o1", "b"];
    expect(locateRegionAnchors(doc, [["o1"], ["edited-away"]])).toEqual([1, 2]);
  });

  // Regression (2026-08-18): an empty ours region (e.g. a rebase replaying
  // an append onto a shorter base) anchored at the raw search position,
  // which never advances past common lines - the first conflict's block
  // then anchored at line 0, putting the block checkbox ON the shared
  // context line and inserting the alignment spacer ABOVE it.
  it("anchors an empty first region after its preceding context", () => {
    // Stage doc: only the context line; the conflict contributes nothing.
    expect(locateRegionAnchors(["Roses are red"], [[]], [["Roses are red"]])).toEqual([1]);
  });

  it("anchors an empty later region after the context between conflicts", () => {
    const doc = ["a", "o1", "b", "c"];
    expect(
      locateRegionAnchors(doc, [["o1"], []], [["a"], ["b", "c"]]),
    ).toEqual([1, 4]);
  });

  it("ignores unfindable context (edited commons) gracefully", () => {
    const doc = ["a", "o1", "b"];
    expect(
      locateRegionAnchors(doc, [["o1"], []], [["a"], ["edited-away"]]),
    ).toEqual([1, 2]);
  });
});

// Regression (2026-08-18): an empty side (zero lines) got zero selection
// flags, so BOTH its gutter checkbox and the header side-all checkbox
// mapped over an empty array - dead controls; "take the empty side"
// (resolve the block to nothing) was unreachable by mouse.
describe("empty-side selection (synthetic flag)", () => {
  const EMPTY_OURS = [
    "Roses are red",
    "<<<<<<< HEAD",
    "=======",
    "Violets are blue",
    "Sugar is sweet",
    ">>>>>>> 19b013c",
  ].join("\n") + "\n";

  it("emptySelections gives an empty side one synthetic flag", () => {
    const parsed = parseConflicts(EMPTY_OURS);
    expect(emptySelections(parsed)).toEqual([{ ours: [false], theirs: [false, false] }]);
    expect(emptySelections(null)).toEqual([]);
  });

  it("keeps per-line flags for non-empty sides", () => {
    const parsed = parseConflicts(
      ["<<<<<<< HEAD", "o1", "o2", "=======", "t1", ">>>>>>> b"].join("\n") + "\n",
    );
    expect(emptySelections(parsed)).toEqual([{ ours: [false, false], theirs: [false] }]);
  });

  it("choosing the empty side composes the block to nothing", () => {
    const parsed = parseConflicts(EMPTY_OURS);
    const regions = regionsFromParsed(parsed);
    expect(
      composeBlockLines(regions[0], blockSection(parsed, 0), {
        ours: [true],
        theirs: [false, false],
      }),
    ).toEqual([]);
  });

  it("blockOrigin counts contributed lines, not raw flags", () => {
    const parsed = parseConflicts(EMPTY_OURS);
    const regions = regionsFromParsed(parsed);
    // The synthetic ours flag contributes no lines; a phantom count would
    // tint a line that is not part of the composed block.
    expect(blockOrigin(regions[0], { ours: [true], theirs: [false, false] })).toEqual({
      ours: 0,
      theirs: 0,
    });
    expect(blockOrigin(regions[0], { ours: [false], theirs: [true, false] })).toEqual({
      ours: 0,
      theirs: 1,
    });
  });
});

describe("precedingCommonLines", () => {
  it("collects the common lines before each conflict", () => {
    const text = [
      "before",
      "<<<<<<< HEAD", "o1", "=======", "t1", ">>>>>>> b",
      "mid1",
      "mid2",
      "<<<<<<< HEAD", "o2", "=======", "t2", ">>>>>>> b",
      "after",
    ].join("\n") + "\n";
    expect(precedingCommonLines(parseConflicts(text))).toEqual([
      ["before"],
      ["mid1", "mid2"],
    ]);
  });

  it("yields an empty context for a conflict at the file start", () => {
    const text = ["<<<<<<< HEAD", "o1", "=======", "t1", ">>>>>>> b"].join("\n") + "\n";
    expect(precedingCommonLines(parseConflicts(text))).toEqual([[]]);
  });
});

describe("foldableRanges", () => {
  it("folds the stretches between blocks, keeping context lines", () => {
    // blocks at 10 (3 lines) and 40 (2 lines), 60 lines total, context 3
    expect(
      foldableRanges([10, 40], [3, 2], 60, 3),
    ).toEqual([
      { from: 0, to: 6 },   // leading: 0..6 hidden (7,8,9 = context)
      { from: 16, to: 36 }, // between: after 10+3+3 .. before 40-3
      { from: 45, to: 59 }, // trailing: after 40+2+3
    ]);
  });

  it("skips gaps too small to be worth a placeholder", () => {
    // 2-line leading gap and a 1-line inter-block gap stay unfolded;
    // only the 3-line trailing stretch folds.
    expect(foldableRanges([5, 12], [2, 2], 20, 3)).toEqual([
      { from: 17, to: 19 },
    ]);
  });

  it("handles a block at the start and end of the file", () => {
    expect(foldableRanges([0], [3], 30, 3)).toEqual([{ from: 6, to: 29 }]);
    expect(foldableRanges([27], [3], 30, 3)).toEqual([{ from: 0, to: 23 }]);
  });

  it("returns nothing for no blocks or fully covered files", () => {
    expect(foldableRanges([], [], 100, 3)).toEqual([]);
    expect(foldableRanges([0], [10], 10, 3)).toEqual([]);
  });
});
