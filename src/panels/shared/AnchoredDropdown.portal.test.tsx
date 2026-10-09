// @vitest-environment happy-dom
// Regression: the tab-strip dropdowns (View, overflow, add-repo) rendered in
// place with position:absolute and no viewport-aware height, so on a short
// window their bottom entries were cut off below the window edge. The surface
// must portal to document.body and cap its height to the space under the
// anchor, scrolling internally.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AnchoredDropdown } from "./AnchoredDropdown";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const ANCHOR_RECT = { left: 950, right: 990, top: 4, bottom: 30 };
const MENU_WIDTH = 240;

let host: HTMLDivElement;
let root: Root;
const origRect = Element.prototype.getBoundingClientRect;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const id = this.getAttribute("data-testid");
    const rect = (r: { left: number; right: number; top: number; bottom: number }) =>
      ({ ...r, width: r.right - r.left, height: r.bottom - r.top, x: r.left, y: r.top }) as DOMRect;
    if (id === "anchor") return rect(ANCHOR_RECT);
    if (id === "menu") return rect({ left: 0, right: MENU_WIDTH, top: 0, bottom: 800 });
    return rect({ left: 0, right: 0, top: 0, bottom: 0 });
  };
});

afterEach(async () => {
  Element.prototype.getBoundingClientRect = origRect;
  await act(async () => root.unmount());
  host.remove();
});

function Harness() {
  return (
    <div data-testid="anchor">
      <button data-testid="trigger">View</button>
      <AnchoredDropdown data-testid="menu" role="menu">
        <div data-testid="menu-item">Entry</div>
      </AnchoredDropdown>
    </div>
  );
}

const render = () => act(async () => root.render(<Harness />));

describe("AnchoredDropdown", () => {
  it("portals the surface to document.body, out of the tab strip's DOM", async () => {
    await render();
    const item = document.querySelector("[data-testid=menu-item]")!;
    expect(host.contains(item)).toBe(false);
    expect(item.closest("body")).toBe(document.body);
  });

  it("right-aligns under the anchor and caps the height to the viewport", async () => {
    await render();
    const menu = document.querySelector<HTMLElement>("[data-testid=menu]")!;
    expect(menu.style.left).toBe(`${ANCHOR_RECT.right - MENU_WIDTH}px`);
    expect(menu.style.top).toBe(`${ANCHOR_RECT.bottom + 4}px`);
    expect(menu.style.maxHeight).toBe(`${window.innerHeight - (ANCHOR_RECT.bottom + 4) - 4}px`);
    expect(menu.style.overflowY).toBe("auto");
  });
});
