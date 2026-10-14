// @vitest-environment happy-dom
//
// Regression: the seed swatches commit on the NATIVE change event, and the
// input is conditionally rendered (read-only themes show a static span). A
// swatch mounted read-only and later switched editable must still commit -
// a mount-time listener effect misses the input appearing later.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { deriveTheme } from "../../theme/simple";
import { SeedRow } from "./SeedRow";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const SEEDS = {
  background: "#1e1e1e",
  text: "#e0e0e0",
  primary: "#4a9eff",
  error: "#e58e26",
  warning: "#f1fa8c",
  success: "#3498db",
  diffAdded: "#3498db",
  diffRemoved: "#e58e26",
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("SeedRow commit wiring", () => {
  it("commits a seed picked after switching from read-only to editable", async () => {
    const { doc } = deriveTheme(SEEDS, "t");
    const onApply = vi.fn();

    // Mounted read-only (built-in theme): static spans, no inputs.
    act(() => {
      root.render(<SeedRow working={doc} disabled={true} onApply={onApply} />);
    });
    expect(container.querySelector('input[type="color"]')).toBeNull();

    // Now editable (user theme / New): the inputs appear.
    act(() => {
      root.render(<SeedRow working={doc} disabled={false} onApply={onApply} />);
    });
    const input = container.querySelector('input[type="color"]') as HTMLInputElement;
    expect(input).not.toBeNull();

    await act(async () => {
      input.value = "#123456";
      input.dispatchEvent(new Event("change", { bubbles: false }));
    });

    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0][0].seeds.background).toBe("#123456");
  });
});
