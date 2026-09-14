import { describe, expect, it } from "vitest";
import { clampToViewport } from "./popoverPosition";

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
