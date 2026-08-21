import { describe, expect, it } from "vitest";
import { OVERFLOW_POPOVER_LAYOUT } from "./RefsCell";

// Regression (2026-08-20, release blocker): the "+N" ref-overflow popover was
// a flex-wrap ROW with a maxWidth - once the chips wrapped onto multiple
// lines the box kept its pre-wrap line width (a wrapped flex container never
// shrinks back to its longest line), leaving a large empty area right of the
// stacked chips. The fix is a COLUMN at max-content width: one chip per row,
// the popover always exactly as wide as its widest chip (plus padding).
// jsdom performs no layout, so this pins the style contract that makes the
// bug impossible rather than measured pixels.
describe("ref-overflow popover layout", () => {
  it("stacks chips as a column, never a wrapping row", () => {
    expect(OVERFLOW_POPOVER_LAYOUT.flexDirection).toBe("column");
    expect(OVERFLOW_POPOVER_LAYOUT.flexWrap).toBeUndefined();
  });

  it("shrink-fits the widest chip (max-content), with a cap for runaway names", () => {
    expect(OVERFLOW_POPOVER_LAYOUT.width).toBe("max-content");
    expect(OVERFLOW_POPOVER_LAYOUT.maxWidth).toBeDefined();
  });

  it("keeps a many-ref commit's popover on screen (bounded height + scroll)", () => {
    expect(OVERFLOW_POPOVER_LAYOUT.maxHeight).toBeDefined();
    expect(OVERFLOW_POPOVER_LAYOUT.overflowY).toBe("auto");
  });
});
