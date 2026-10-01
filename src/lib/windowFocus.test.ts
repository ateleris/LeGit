// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { focusManager } from "@tanstack/react-query";

// Outside Tauri there is no window handle; the recovery listeners must
// register regardless (they are independent of the Tauri stream).
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onFocusChanged: () => Promise.resolve(() => {}),
  }),
}));

import { initWindowFocusTracking, isWindowFocused } from "./windowFocus";

describe("window focus tracking recovery", () => {
  beforeEach(() => {
    initWindowFocusTracking();
  });

  afterEach(() => {
    // Detach the DOM listeners and clear the manual focus override.
    focusManager.setEventListener(() => () => {});
    focusManager.setFocused(undefined);
  });

  // A lost Tauri `focused: true` event used to wedge the app "unfocused"
  // until restart: watcher invalidations only marked caches stale and the
  // refetchOnWindowFocus catch-up never fired. Any proof of focus must
  // correct the state.
  it("recovers a stale unfocused state on user interaction", () => {
    focusManager.setFocused(false);
    expect(isWindowFocused()).toBe(false);
    window.dispatchEvent(new Event("pointerdown"));
    expect(isWindowFocused()).toBe(true);
  });

  it("recovers a stale unfocused state when the window gains DOM focus", () => {
    focusManager.setFocused(false);
    window.dispatchEvent(new Event("focus"));
    expect(isWindowFocused()).toBe(true);
  });

  it("recovers on keyboard input", () => {
    focusManager.setFocused(false);
    window.dispatchEvent(new Event("keydown"));
    expect(isWindowFocused()).toBe(true);
  });

  it("never asserts unfocused on its own", () => {
    focusManager.setFocused(true);
    window.dispatchEvent(new Event("pointerdown"));
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    expect(isWindowFocused()).toBe(true);
  });
});
