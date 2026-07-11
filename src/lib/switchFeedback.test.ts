// The frontend mirror of the Rust switch classifier: each outcome variant
// must produce the right guidance. The Rust side is tested in legit-core;
// this pins the user-facing half so the two cannot drift apart silently.

import { describe, test, expect, vi, beforeEach } from "vitest";
import { notifySwitchOutcome, formatSwitchError, notifySwitchError } from "./switchFeedback";
import { notify } from "../store/notifications";
import type { SwitchOutcome } from "./types";

vi.mock("../store/notifications", () => ({
  notify: { info: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("notifySwitchOutcome", () => {
  test("clean switch stays silent", () => {
    notifySwitchOutcome({ kind: "clean" } as SwitchOutcome, "main");
    expect(notify.info).not.toHaveBeenCalled();
  });

  test("changes_stashed points at the Stashes panel", () => {
    notifySwitchOutcome({ kind: "changes_stashed" } as SwitchOutcome, "main");
    const msg = vi.mocked(notify.info).mock.calls[0][0] as string;
    expect(msg).toContain("stashed");
    expect(msg).toContain("Stashes panel");
  });

  test("pop conflicts say resolve-then-drop, never pop-again", () => {
    // On a conflicted pop the changes ARE in the working tree and git kept
    // the stash: "pop again" guidance would be wrong and lossy.
    notifySwitchOutcome(
      { kind: "stash_pop_conflicts", message: "CONFLICT" } as SwitchOutcome,
      "main",
    );
    const msg = vi.mocked(notify.info).mock.calls[0][0] as string;
    expect(msg).toContain("conflicts");
    expect(msg).toContain("kept");
    expect(msg).toContain("drop");
    expect(msg).not.toMatch(/pop (it|again)/i);
  });

  test("pop failure says the changes are still parked in the stash", () => {
    notifySwitchOutcome(
      { kind: "stash_pop_failed", message: "boom" } as SwitchOutcome,
      "main",
    );
    const msg = vi.mocked(notify.info).mock.calls[0][0] as string;
    expect(msg).toContain("safe in the stash");
  });
});

describe("formatSwitchError", () => {
  test("dirty-tree refusal gets the actionable message", () => {
    const e = {
      kind: "Git",
      details: { kind: "WouldOverwriteLocalChanges", details: "a.txt" },
    };
    const msg = formatSwitchError(e);
    expect(msg).toContain("overwrite uncommitted changes");
    expect(msg).toContain("auto-stash");
  });

  test("other errors show git's own message", () => {
    const e = {
      kind: "Git",
      details: { kind: "CommandFailed", details: { exit_code: 128, stderr: "fatal: nope" } },
    };
    expect(formatSwitchError(e)).toBe("fatal: nope");
  });

  test("notifySwitchError routes through notify.error", () => {
    notifySwitchError({ kind: "Io", details: "disk full" });
    expect(notify.error).toHaveBeenCalledWith("Io: disk full");
  });
});
