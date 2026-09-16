// @vitest-environment happy-dom
// Regression: the caret menu rendered in place (position: absolute inside
// the panel DOM), so a dockview group stacked below the panel painted over
// it. The menu must escape every panel stacking context by portaling to
// document.body - while the anchor wrapper still counts as "inside" for
// dismissal.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useLayersStore } from "../../store/layers";
import { CaretDropdown } from "./CaretDropdown";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  useLayersStore.setState({ layers: [] });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const render = (onClose: () => void) =>
  act(async () =>
    root.render(
      <div style={{ position: "relative" }} data-testid="anchor">
        <button data-testid="trigger">v</button>
        <CaretDropdown onClose={onClose}>
          <div data-testid="menu-item">Entry</div>
        </CaretDropdown>
      </div>,
    ),
  );

describe("CaretDropdown portal", () => {
  it("renders the menu as a direct child of document.body, not inside the panel", async () => {
    await render(() => {});
    const item = document.querySelector("[data-testid=menu-item]")!;
    expect(host.contains(item)).toBe(false);
    expect(item.closest("body")).toBe(document.body);
  });

  it("a mousedown on the anchor or in the menu does not close; outside does", async () => {
    const onClose = vi.fn();
    await render(onClose);
    const down = (el: Element) =>
      act(async () => {
        el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      });
    await down(document.querySelector("[data-testid=trigger]")!);
    await down(document.querySelector("[data-testid=menu-item]")!);
    expect(onClose).not.toHaveBeenCalled();
    await down(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
