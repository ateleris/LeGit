// The confirm dialog opens near the pointer but never puts its action
// buttons under it (double-click safety), and always stays in the viewport.
import { describe, it, expect } from "vitest";
import { placeDialogNearPointer } from "./dialogPlacement";

const DIALOG = { width: 400, height: 200 };
const VIEWPORT = { width: 1600, height: 900 };

describe("placeDialogNearPointer", () => {
  it("puts the cursor just inside the dialog's top-left (title area)", () => {
    const pos = placeDialogNearPointer({ x: 500, y: 300 }, DIALOG, VIEWPORT);
    expect(pos).toEqual({ left: 484, top: 288 });
    // The cursor is inside the dialog, in its top strip - far from the
    // bottom-right button row.
    expect(500).toBeGreaterThan(pos.left);
    expect(300 - pos.top).toBeLessThan(DIALOG.height / 4);
  });

  it("clamps to the right and left viewport edges", () => {
    const right = placeDialogNearPointer({ x: 1590, y: 300 }, DIALOG, VIEWPORT);
    expect(right.left).toBe(VIEWPORT.width - DIALOG.width - 8);
    const left = placeDialogNearPointer({ x: 4, y: 300 }, DIALOG, VIEWPORT);
    expect(left.left).toBe(8);
  });

  it("flips fully above the cursor near the bottom edge (buttons never under the click point)", () => {
    const pos = placeDialogNearPointer({ x: 500, y: 880 }, DIALOG, VIEWPORT);
    // Dialog sits entirely above the cursor: its bottom edge is above y.
    expect(pos.top + DIALOG.height).toBeLessThan(880);
  });

  it("stays inside the viewport even for a tiny window", () => {
    const pos = placeDialogNearPointer({ x: 10, y: 10 }, DIALOG, { width: 420, height: 220 });
    expect(pos.left).toBeGreaterThanOrEqual(8);
    expect(pos.top).toBeGreaterThanOrEqual(8);
    expect(pos.left + DIALOG.width).toBeLessThanOrEqual(420 - 8 + 1);
    expect(pos.top + DIALOG.height).toBeLessThanOrEqual(220 - 8 + 1);
  });
});
