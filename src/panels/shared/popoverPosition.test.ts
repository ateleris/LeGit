import { describe, expect, it } from "vitest";
import { clampToViewport, dropdownBelowAnchor } from "./popoverPosition";

const vp = { viewportWidth: 1000, viewportHeight: 600 };

describe("clampToViewport", () => {
  it("keeps a fitting popover at its anchor", () => {
    expect(clampToViewport({ x: 100, y: 100, width: 200, height: 150, ...vp }))
      .toEqual({ left: 100, top: 100 });
  });

  it("clamps off the right and bottom edges with the margin", () => {
    expect(clampToViewport({ x: 950, y: 580, width: 200, height: 150, ...vp }))
      .toEqual({ left: 1000 - 200 - 4, top: 600 - 150 - 4 });
  });

  it("never goes above the top-left margin, even for oversized popovers", () => {
    expect(clampToViewport({ x: 0, y: 0, width: 2000, height: 900, ...vp }))
      .toEqual({ left: 4, top: 4 });
  });

  it("honours a custom margin", () => {
    expect(clampToViewport({ x: 999, y: 599, width: 100, height: 100, margin: 8, ...vp }))
      .toEqual({ left: 1000 - 100 - 8, top: 600 - 100 - 8 });
  });
});

describe("dropdownBelowAnchor", () => {
  const anchor = { anchorRight: 990, anchorBottom: 30 };

  it("right-aligns under the anchor and caps the height to the space below", () => {
    expect(dropdownBelowAnchor({ ...anchor, menuWidth: 240, ...vp })).toEqual({
      left: 990 - 240,
      top: 34,
      maxHeight: 600 - 34 - 4,
    });
  });

  it("a short window shrinks maxHeight instead of letting the menu run off screen", () => {
    const r = dropdownBelowAnchor({ ...anchor, menuWidth: 240, viewportWidth: 1000, viewportHeight: 200 });
    expect(r.maxHeight).toBe(200 - 34 - 4);
  });

  it("never reports a negative maxHeight", () => {
    const r = dropdownBelowAnchor({ ...anchor, menuWidth: 240, viewportWidth: 1000, viewportHeight: 20 });
    expect(r.maxHeight).toBe(0);
  });

  it("keeps the menu inside the left edge when the anchor sits near it", () => {
    expect(dropdownBelowAnchor({ anchorRight: 100, anchorBottom: 30, menuWidth: 240, ...vp }).left).toBe(4);
  });

  it("keeps the menu inside the right edge", () => {
    expect(dropdownBelowAnchor({ anchorRight: 1005, anchorBottom: 30, menuWidth: 240, ...vp }).left).toBe(
      1000 - 240 - 4,
    );
  });

  it("honours a custom gap and margin", () => {
    expect(dropdownBelowAnchor({ ...anchor, menuWidth: 240, gap: 2, margin: 8, ...vp })).toEqual({
      left: 990 - 240,
      top: 32,
      maxHeight: 600 - 32 - 8,
    });
  });
});
