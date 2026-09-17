// @vitest-environment happy-dom
//
// `app.applyLayoutN` applies the Nth layout in list order, so the chip is how
// a user sees which shortcut a given layout currently answers to.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import { LayoutShortcutChip } from "./LayoutShortcutChip";
import { useKeymapStore } from "../../keys/keymap";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  useKeymapStore.getState().reset({ "app.applyLayout2": ["F5"] });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const render = (index: number) => {
  act(() => {
    root.render(<LayoutShortcutChip index={index} />);
  });
};

describe("LayoutShortcutChip", () => {
  it("shows the binding of the slot the row occupies", () => {
    render(1);
    expect(host.textContent).toBe("F5");
  });

  it("shows nothing for a slot with no binding", () => {
    render(0);
    expect(host.textContent).toBe("");
  });

  it("shows nothing past the ninth layout - there is no tenth shortcut", () => {
    useKeymapStore.getState().reset({ "app.applyLayout10": ["F5"] });
    render(9);
    expect(host.textContent).toBe("");
  });
});
