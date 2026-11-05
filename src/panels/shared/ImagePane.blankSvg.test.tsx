// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { FilePreview } from "../../lib/types";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const paintCheck = vi.hoisted(() => ({ svgPaintedNothing: vi.fn(() => false) }));
vi.mock("./svgPaintCheck", () => ({ svgPaintedNothing: paintCheck.svgPaintedNothing }));

import { ImagePane } from "./ImagePane";

const NOTICE = /scripts or external files/;

function preview(format: "svg" | "png"): Extract<FilePreview, { kind: "image" }> {
  return { kind: "image", format, size: 1234, base64: "PHN2Zy8+" };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  paintCheck.svgPaintedNothing.mockClear();
  paintCheck.svgPaintedNothing.mockReturnValue(false);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function renderPane(p: Extract<FilePreview, { kind: "image" }>) {
  act(() => root.render(<ImagePane preview={p} />));
}

function fireLoad() {
  const img = container.querySelector("img");
  expect(img).not.toBeNull();
  act(() => {
    img!.dispatchEvent(new Event("load"));
  });
}

describe("ImagePane blank-SVG notice", () => {
  it("shows the notice when a loaded SVG painted nothing", () => {
    paintCheck.svgPaintedNothing.mockReturnValue(true);
    renderPane(preview("svg"));
    fireLoad();
    expect(container.textContent).toMatch(NOTICE);
  });

  it("shows no notice when the SVG painted visible pixels", () => {
    renderPane(preview("svg"));
    fireLoad();
    expect(paintCheck.svgPaintedNothing).toHaveBeenCalled();
    expect(container.textContent).not.toMatch(NOTICE);
  });

  it("never runs the paint check for a raster format", () => {
    renderPane(preview("png"));
    fireLoad();
    expect(paintCheck.svgPaintedNothing).not.toHaveBeenCalled();
    expect(container.textContent).not.toMatch(NOTICE);
  });

  it("keeps the img mounted so a replaced preview can re-evaluate", () => {
    paintCheck.svgPaintedNothing.mockReturnValue(true);
    renderPane(preview("svg"));
    fireLoad();
    expect(container.textContent).toMatch(NOTICE);
    // The same pane gets the next file's preview: a healthy SVG clears it.
    paintCheck.svgPaintedNothing.mockReturnValue(false);
    renderPane(preview("svg"));
    fireLoad();
    expect(container.textContent).not.toMatch(NOTICE);
  });
});
