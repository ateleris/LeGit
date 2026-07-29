// Pure positioning for submenu flyouts (see Submenu in primitives.tsx).
// Extracted so the open-direction / clamping rules are unit-testable without
// a DOM: the flyout prefers opening to the right of its trigger, flips to the
// left when it would overflow the viewport, and is clamped vertically.

/** Minimum gap kept between a menu surface and the viewport edge (px).
 *  Matches the MenuShell clamp. */
export const VIEWPORT_MARGIN = 4;

/** Horizontal overlap between trigger and flyout (px), so the pointer can
 *  travel across without a gap that would close the submenu. */
export const FLYOUT_OVERLAP = 2;

/** Vertical padding of a menu surface (px) — the flyout is shifted up by this
 *  much so its first entry aligns with the trigger row. */
export const MENU_SURFACE_PAD_Y = 4;

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Size {
  width: number;
  height: number;
}

export function flyoutPosition(trigger: Rect, flyout: Size, viewport: Size): { left: number; top: number } {
  // Horizontal: right of the trigger; flip to the left when that overflows.
  let left = trigger.right - FLYOUT_OVERLAP;
  if (left + flyout.width > viewport.width - VIEWPORT_MARGIN) {
    const flipped = trigger.left - flyout.width + FLYOUT_OVERLAP;
    left =
      flipped >= VIEWPORT_MARGIN
        ? flipped
        : Math.max(VIEWPORT_MARGIN, viewport.width - flyout.width - VIEWPORT_MARGIN);
  }

  // Vertical: first entry aligned with the trigger, clamped into the viewport.
  const top = Math.max(
    VIEWPORT_MARGIN,
    Math.min(trigger.top - MENU_SURFACE_PAD_Y, viewport.height - flyout.height - VIEWPORT_MARGIN),
  );

  return { left, top };
}
