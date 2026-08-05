// Unit tests for the Tauri-driven window-focus source. The Tauri window API
// is mocked (it needs a real webview); the focusManager side is the real
// react-query singleton, so these tests pin the actual wiring.
import { describe, test, expect, vi, afterEach } from "vitest";
import { focusManager } from "@tanstack/react-query";

const tauri = vi.hoisted(() => ({
  handler: undefined as ((event: { payload: boolean }) => void) | undefined,
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onFocusChanged: (h: (event: { payload: boolean }) => void) => {
      tauri.handler = h;
      return Promise.resolve(() => {
        tauri.handler = undefined;
      });
    },
  }),
}));

import { initWindowFocusTracking, isWindowFocused } from "./windowFocus";

afterEach(() => {
  focusManager.setFocused(undefined);
});

describe("initWindowFocusTracking", () => {
  test("drives react-query's focusManager from Tauri window focus", () => {
    expect(isWindowFocused()).toBe(true); // default before any focus event
    initWindowFocusTracking();
    expect(tauri.handler).toBeDefined();

    tauri.handler!({ payload: false });
    expect(isWindowFocused()).toBe(false);
    expect(focusManager.isFocused()).toBe(false);

    tauri.handler!({ payload: true });
    expect(isWindowFocused()).toBe(true);
    expect(focusManager.isFocused()).toBe(true);
  });
});
