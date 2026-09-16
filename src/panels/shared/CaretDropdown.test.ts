// Placement decision for the caret dropdown: it opens downward by default
// and flips upward when the menu would cross the viewport bottom (the commit
// composer sits at the bottom of the Working Changes panel, so its menu
// vanished behind the window edge). Regression: 2026-08-20.

import { describe, expect, it } from "vitest";
import { caretDropDirection, caretMenuPosition } from "./CaretDropdown";

const args = (over: Partial<Parameters<typeof caretDropDirection>[0]> = {}) => ({
  anchorTop: 100,
  anchorBottom: 120,
  menuHeight: 50,
  viewportHeight: 600,
  ...over,
});

describe("caretDropDirection", () => {
  it("opens downward when the menu fits below the anchor", () => {
    expect(caretDropDirection(args())).toBe("down");
  });

  it("flips upward when the menu would cross the viewport bottom", () => {
    expect(
      caretDropDirection(args({ anchorTop: 560, anchorBottom: 580 })),
    ).toBe("up");
  });

  it("stays downward when it fits exactly", () => {
    expect(
      caretDropDirection(args({ anchorTop: 530, anchorBottom: 550, menuHeight: 50 })),
    ).toBe("down");
  });

  it("falls back to downward when neither direction fits", () => {
    // A menu taller than the space on both sides: keep the default rather
    // than clipping at the top, where the first entries would be lost.
    expect(
      caretDropDirection(
        args({ anchorTop: 30, anchorBottom: 50, menuHeight: 500, viewportHeight: 400 }),
      ),
    ).toBe("down");
  });
});

// The menu's fixed-position coordinates: right-aligned to the anchor, below
// it (or above when flipped), clamped to the viewport's left edge.
describe("caretMenuPosition", () => {
  const anchorRect = { top: 100, bottom: 120, right: 300 };

  it("places the menu under the anchor, right-aligned", () => {
    expect(
      caretMenuPosition({ anchorRect, menuWidth: 120, menuHeight: 50, viewportHeight: 600, gap: 2 }),
    ).toEqual({ left: 180, top: 122 });
  });

  it("flips above the anchor near the viewport bottom", () => {
    expect(
      caretMenuPosition({
        anchorRect: { top: 560, bottom: 580, right: 300 },
        menuWidth: 120,
        menuHeight: 50,
        viewportHeight: 600,
        gap: 2,
      }),
    ).toEqual({ left: 180, top: 508 });
  });

  it("never leaves the viewport on the left", () => {
    expect(
      caretMenuPosition({
        anchorRect: { top: 100, bottom: 120, right: 80 },
        menuWidth: 120,
        menuHeight: 50,
        viewportHeight: 600,
        gap: 2,
      }).left,
    ).toBe(0);
  });
});
