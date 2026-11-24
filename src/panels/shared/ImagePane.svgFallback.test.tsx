// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { FilePreview } from "../../lib/types";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("./svgPaintCheck", () => ({ svgPaintedNothing: () => false }));

import { ImagePane, svgPreviewFacts } from "./ImagePane";

function encodeBase64Utf8(text: string): string {
  let binary = "";
  for (const b of new TextEncoder().encode(text)) binary += String.fromCharCode(b);
  return btoa(binary);
}

const SIZELESS = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path stroke="currentColor" d="M0 0h1"/></svg>';
const SIZED = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><path d="M0 0h1"/></svg>';

function preview(
  format: "svg" | "png",
  markup: string = SIZELESS,
): Extract<FilePreview, { kind: "image" }> {
  return { kind: "image", format, size: 1234, base64: encodeBase64Utf8(markup) };
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

function renderAndLoad(p: Extract<FilePreview, { kind: "image" }>, natural = 0) {
  act(() => root.render(<ImagePane preview={p} />));
  const img = container.querySelector("img");
  expect(img).not.toBeNull();
  Object.defineProperty(img!, "naturalWidth", { value: natural, configurable: true });
  Object.defineProperty(img!, "naturalHeight", { value: natural, configurable: true });
  act(() => {
    img!.dispatchEvent(new Event("load"));
  });
  return img!;
}

describe("svgPreviewFacts", () => {
  it("flags a viewBox-only SVG that paints with currentColor", () => {
    expect(svgPreviewFacts(encodeBase64Utf8(SIZELESS))).toEqual({
      lacksIntrinsicSize: true,
      usesInheritedColor: true,
    });
  });

  it("reports nothing for a sized SVG with its own colours or an undecodable payload", () => {
    const none = { lacksIntrinsicSize: false, usesInheritedColor: false };
    expect(svgPreviewFacts(encodeBase64Utf8(SIZED))).toEqual(none);
    expect(svgPreviewFacts("%%%")).toEqual(none);
  });
});

describe("ImagePane dimensionless-SVG fallback", () => {
  // Chromium reports 150x150 for a viewBox-only SVG while laying it out with
  // no intrinsic size: the fallback must not depend on the reported size.
  it.each([0, 150])("sizes a viewBox-only SVG explicitly (engine reports %i)", (natural) => {
    const img = renderAndLoad(preview("svg"), natural);
    expect(img.style.width).toBe("20em");
    expect(img.style.height).toBe("auto");
    expect(container.textContent).not.toContain("150×150");
    expect(container.textContent).not.toContain("0×0");
    expect(container.textContent).toContain("SVG");
  });

  it("leaves a sized SVG on intrinsic sizing and captions its dimensions", () => {
    const img = renderAndLoad(preview("svg", SIZED), 24);
    expect(img.style.width).toBe("");
    expect(container.textContent).toContain("24×24");
  });

  it("hints that currentColor shows as black, only for SVGs that rely on it", () => {
    const img = renderAndLoad(preview("svg"));
    expect(container.textContent).toContain("currentColor shown as black");
    expect(img.getAttribute("src")).toBe(`data:image/svg+xml;base64,${encodeBase64Utf8(SIZELESS)}`);
    renderAndLoad(preview("svg", SIZED), 24);
    expect(container.textContent).not.toContain("currentColor");
  });

  it("leaves non-SVG images on intrinsic sizing", () => {
    const img = renderAndLoad(preview("png"));
    expect(img.style.width).toBe("");
  });
});
