// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ReducedMotionNote } from "./ReducedMotionNote";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function installMatchMedia(matches: boolean) {
  window.matchMedia = ((query: string) => ({
    matches,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const render = () => act(async () => root.render(<ReducedMotionNote />));

describe("ReducedMotionNote", () => {
  it("names the Windows setting while the OS requests reduced motion", async () => {
    installMatchMedia(true);
    await render();
    expect(host.textContent).toContain("reduced motion");
    expect(host.textContent).toContain("Animation effects");
  });

  it("renders nothing while motion is allowed", async () => {
    installMatchMedia(false);
    await render();
    expect(host.textContent).toBe("");
  });
});
