import { describe, expect, it } from "vitest";
import {
  FLYOUT_OVERLAP,
  MENU_SURFACE_PAD_Y,
  VIEWPORT_MARGIN,
  flyoutPosition,
} from "./flyoutPosition";

const viewport = { width: 1000, height: 800 };

const trigger = (left: number, top: number, width = 200, height = 24) => ({
  left,
  top,
  right: left + width,
  bottom: top + height,
});

describe("flyoutPosition", () => {
  it("opens to the right of the trigger, first entry aligned with the trigger row", () => {
    const pos = flyoutPosition(trigger(100, 300), { width: 220, height: 150 }, viewport);
    expect(pos.left).toBe(300 - FLYOUT_OVERLAP);
    expect(pos.top).toBe(300 - MENU_SURFACE_PAD_Y);
  });

  it("flips to the left when the right side would overflow", () => {
    const pos = flyoutPosition(trigger(700, 300), { width: 220, height: 150 }, viewport);
    expect(pos.left).toBe(700 - 220 + FLYOUT_OVERLAP);
  });

  it("clamps to the right viewport edge when neither side fits", () => {
    // Flyout wider than the space on either side of the trigger.
    const pos = flyoutPosition(trigger(100, 300, 850), { width: 900, height: 150 }, viewport);
    expect(pos.left).toBe(Math.max(VIEWPORT_MARGIN, viewport.width - 900 - VIEWPORT_MARGIN));
  });

  it("clamps the bottom edge into the viewport", () => {
    const pos = flyoutPosition(trigger(100, 750), { width: 220, height: 300 }, viewport);
    expect(pos.top).toBe(viewport.height - 300 - VIEWPORT_MARGIN);
  });

  it("never goes above the top margin, even for oversized flyouts", () => {
    const pos = flyoutPosition(trigger(100, 10), { width: 220, height: 2000 }, viewport);
    expect(pos.top).toBe(VIEWPORT_MARGIN);
  });
});
