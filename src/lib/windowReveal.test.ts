// The Tauri window API needs a real webview, so the window is faked; the
// tests pin the reveal contract: focus is requested once, and a denied
// request (window not focused afterwards) must flash the taskbar instead
// of appearing silently behind the user's active window.
import { readFileSync } from "node:fs";
import { describe, test, expect, vi } from "vitest";

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => {
    throw new Error("not under Tauri");
  },
  UserAttentionType: { Critical: 1, Informational: 2 },
}));

import { UserAttentionType } from "@tauri-apps/api/window";
import { revealAndSignal } from "./windowReveal";

function fakeWindow(focusedAfterSetFocus: boolean) {
  const calls: string[] = [];
  return {
    calls,
    win: {
      show: vi.fn(async () => {
        calls.push("show");
      }),
      setFocus: vi.fn(async () => {
        calls.push("setFocus");
      }),
      isFocused: vi.fn(async () => focusedAfterSetFocus),
      requestUserAttention: vi.fn(async () => {
        calls.push("requestUserAttention");
      }),
    },
  };
}

describe("revealAndSignal", () => {
  test("focus granted: shows, focuses, no attention request", async () => {
    const { win, calls } = fakeWindow(true);
    await revealAndSignal(win);
    expect(calls).toEqual(["show", "setFocus"]);
    expect(win.requestUserAttention).not.toHaveBeenCalled();
  });

  test("focus denied: flashes the taskbar (informational)", async () => {
    const { win, calls } = fakeWindow(false);
    await revealAndSignal(win);
    expect(calls).toEqual(["show", "setFocus", "requestUserAttention"]);
    expect(win.requestUserAttention).toHaveBeenCalledWith(
      UserAttentionType.Informational
    );
  });
});

// Tauri's ACL silently rejects window calls whose permission is missing from
// the capability file (the reveal then falls back to the Rust-side 4s
// failsafe). `is-focused` is covered by core:window:default; the setters are
// not and need explicit grants.
describe("capability grants for the reveal", () => {
  test("every window call the reveal makes is permitted", () => {
    const capability = JSON.parse(
      readFileSync(
        new URL("../../src-tauri/capabilities/default.json", import.meta.url),
        "utf8"
      )
    ) as { permissions: string[] };
    for (const permission of [
      "core:window:default",
      "core:window:allow-show",
      "core:window:allow-set-focus",
      "core:window:allow-request-user-attention",
    ]) {
      expect(capability.permissions).toContain(permission);
    }
  });
});
