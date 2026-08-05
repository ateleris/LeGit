// Placement for the confirmation dialog: near the pointer (context-menu
// style), never under it. Pure so the clamp/flip rules are unit-tested.

export interface Point {
  x: number;
  y: number;
}
export interface Size {
  width: number;
  height: number;
}

const MARGIN = 8;
// The cursor lands just inside the dialog's TOP-LEFT (title area): the
// action buttons sit at the bottom-right, so an accidental double-click at
// the trigger point can never hit them.
const OFFSET_X = 16;
const OFFSET_Y = 12;

/**
 * Where to place a dialog of `dialog` size for a pointer at `anchor`.
 * Preferred: top-left just under the cursor. Near the right/bottom edges
 * the position clamps into the viewport; if clamping would slide the
 * button row under the cursor (bottom edge), the dialog flips fully above
 * the cursor instead.
 */
export function placeDialogNearPointer(
  anchor: Point,
  dialog: Size,
  viewport: Size,
): { left: number; top: number } {
  const maxLeft = viewport.width - dialog.width - MARGIN;
  const maxTop = viewport.height - dialog.height - MARGIN;

  const left = Math.max(MARGIN, Math.min(anchor.x - OFFSET_X, maxLeft));

  let top = anchor.y - OFFSET_Y;
  if (top > maxTop) {
    // Not enough room below: place the whole dialog above the cursor, so
    // the cursor ends up under its bottom edge rather than on the buttons.
    top = anchor.y - dialog.height - MARGIN;
  }
  top = Math.max(MARGIN, Math.min(top, maxTop));
  return { left, top };
}
