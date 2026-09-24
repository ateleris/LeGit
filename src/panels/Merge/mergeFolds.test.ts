// Pins the merge view's fold arithmetic: how gap reveals eat into a folded
// common stretch, when a fold collapses entirely, and what the fold bar
// describes (the visible chunk BELOW it, like a diff hunk header).
import { describe, it, expect } from "vitest";
import { chunkBelowFold, foldBarLabel, foldRange, slotDirection } from "./mergeFolds";

const MIN = 3;

describe("foldRange", () => {
  it("shrinks by the reveals: down eats the top edge, up the bottom edge", () => {
    expect(foldRange({ from: 10, to: 30 }, { down: 5, up: 2 }, MIN)).toEqual({ from: 15, to: 28 });
  });

  it("collapses below the minimum remainder", () => {
    expect(foldRange({ from: 10, to: 14 }, { down: 2, up: 1 }, MIN)).toBeNull();
    // Exactly the minimum stays folded.
    expect(foldRange({ from: 10, to: 14 }, { down: 1, up: 1 }, MIN)).toEqual({ from: 11, to: 13 });
  });
});

describe("chunkBelowFold", () => {
  const bases = [
    { from: 0, to: 9 },
    { from: 20, to: 39 },
  ];

  it("runs from below the fold to the next active fold", () => {
    const chunk = chunkBelowFold(0, bases, [], 60, MIN);
    // Lines 10..19 (0-based) = start line 11, 10 lines.
    expect(chunk).toEqual({ start: 11, count: 10 });
  });

  it("runs to the end of the file when later folds have collapsed", () => {
    const reveals = [
      { down: 0, up: 0 },
      { down: 10, up: 10 }, // second fold fully revealed
    ];
    expect(chunkBelowFold(0, bases, reveals, 60, MIN)).toEqual({ start: 11, count: 50 });
  });

  it("is null once the fold itself has collapsed", () => {
    expect(chunkBelowFold(0, bases, [{ down: 8, up: 0 }], 60, MIN)).toBeNull();
  });
});

describe("foldBarLabel", () => {
  it("renders the hunk-header shape, or nothing for an empty chunk", () => {
    expect(foldBarLabel({ start: 11, count: 10 })).toBe("@@ -11,10 +11,10 @@");
    expect(foldBarLabel({ start: 5, count: 0 })).toBe("");
    expect(foldBarLabel(null)).toBe("");
  });
});

describe("slotDirection", () => {
  it("only reveals away from the file edges", () => {
    expect(slotDirection({ from: 0, to: 9 }, 60)).toBe("up");
    expect(slotDirection({ from: 50, to: 59 }, 60)).toBe("down");
    expect(slotDirection({ from: 20, to: 39 }, 60)).toBe("both");
  });
});
