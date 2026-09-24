// Pins the cross-pane alignment math: where each side's lines sit inside the
// result's conflict slot, how tall the slot is, and the spacer paddings that
// keep the panes level.
import { describe, it, expect } from "vitest";
import { computeAlignment, spacerPads } from "./mergeAlign";

describe("computeAlignment", () => {
  it("unresolved blocks: ours sits after the <<<<<<< line, theirs after =======", () => {
    // Block 0: 2 ours lines, 3 theirs lines, no base; still holding markers,
    // so the result block spans <<<<<<< + 2 + ======= + 3 + >>>>>>> = 7 lines.
    const out = computeAlignment(
      [{ len: 7, origin: null }],
      [0],
      { ours: [2], theirs: [3] },
    );
    expect(out.offOurs).toEqual([1]);
    expect(out.offTheirs).toEqual([1 + 2 + 1]);
    expect(out.slotLens).toEqual([7]);
  });

  it("diff3 base sections push the theirs offset further down", () => {
    // ours 2, base 4 (plus its ||||||| marker line), theirs 1.
    const out = computeAlignment(
      [{ len: 2 + 4 + 1 + 3, origin: null }],
      [4],
      { ours: [2], theirs: [1] },
    );
    expect(out.offTheirs).toEqual([1 + 2 + (1 + 4) + 1]);
  });

  it("composed blocks: offsets from the origin counts", () => {
    // Took 1 ours line and 2 theirs lines.
    const out = computeAlignment(
      [{ len: 3, origin: { ours: 1, theirs: 2 } }],
      [0],
      { ours: [2], theirs: [3] },
    );
    expect(out.offOurs).toEqual([0]);
    expect(out.offTheirs).toEqual([1]);
    // Slot must still fit each side pane's full block at its offset.
    expect(out.slotLens).toEqual([Math.max(3, 0 + 2, 1 + 3)]);
  });
});

describe("spacerPads", () => {
  it("pads above by the offset and below to fill the slot", () => {
    expect(spacerPads(7, 2, 1)).toEqual({ top: 1, bottom: 4 });
    expect(spacerPads(3, 3, 0)).toEqual({ top: 0, bottom: 0 });
  });
});
