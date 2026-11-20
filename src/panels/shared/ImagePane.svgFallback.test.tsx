// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { FilePreview } from "../../lib/types";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("./svgPaintCheck", () => ({ svgPaintedNothing: () => false }));

import { ImagePane, needsSvgSizeFallback } from "./ImagePane";

function preview(format: "svg" | "png"): Extract<FilePreview, { kind: "image" }> {
  return { kind: "image", format, size: 1234, base64: "PHN2Zy8+" };
}

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

function renderAndLoad(p: Extract<FilePreview, { kind: "image" }>) {
  act(() => root.render(<ImagePane preview={p} />));
  const img = container.querySelector("img");
  expect(img).not.toBeNull();
  // happy-dom images never decode, so naturalWidth/naturalHeight stay 0 -
  // exactly the engine report of a dimensionless SVG.
  act(() => {
    img!.dispatchEvent(new Event("load"));
  });
  return img!;
}

describe("needsSvgSizeFallback", () => {
  it("applies only to SVGs reporting no intrinsic size", () => {
    expect(needsSvgSizeFallback("svg", 0, 0)).toBe(true);
    expect(needsSvgSizeFallback("svg", 300, 0)).toBe(true);
    expect(needsSvgSizeFallback("svg", 24, 24)).toBe(false);
    expect(needsSvgSizeFallback("png", 0, 0)).toBe(false);
  });
});

describe("ImagePane dimensionless-SVG fallback", () => {
  it("sizes a dimensionless SVG explicitly so it renders", () => {
    const img = renderAndLoad(preview("svg"));
    expect(img.style.width).toBe("100%");
    expect(img.style.height).toBe("100%");
  });

  it("leaves non-SVG images on intrinsic sizing", () => {
    const img = renderAndLoad(preview("png"));
    expect(img.style.width).toBe("");
  });

  it("never captions a useless 0x0 dimension", () => {
    renderAndLoad(preview("svg"));
    expect(container.textContent).not.toContain("0×0");
    expect(container.textContent).toContain("SVG");
  });
});
