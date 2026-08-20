// The frontend mirror of the Rust switch classifier: each outcome variant
// must produce the right guidance. The Rust side is tested in legit-core;
// this pins the user-facing half so the two cannot drift apart silently.

import { describe, test, expect, vi, beforeEach } from "vitest";
import {
  notifySwitchOutcome,
  notifyRemoteCheckoutOutcome,
  formatSwitchError,
  notifySwitchError,
} from "./switchFeedback";
import { notify } from "../store/notifications";
import type { RemoteCheckoutOutcome, SwitchOutcome } from "./types";

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

describe("notifyRemoteCheckoutOutcome", () => {
  const outcome = (
    sw: SwitchOutcome,
    ff: RemoteCheckoutOutcome["fast_forward"],
  ): RemoteCheckoutOutcome => ({ local_branch: "topic", switch: sw, fast_forward: ff });

  test("clean switch + fast-forward says both, in one toast", () => {
    notifyRemoteCheckoutOutcome(
      outcome({ kind: "clean" }, { kind: "fast_forwarded" }),
      "origin/topic",
    );
    expect(notify.info).toHaveBeenCalledTimes(1);
    const msg = vi.mocked(notify.info).mock.calls[0][0] as string;
    expect(msg).toContain("Switched to 'topic'");
    expect(msg).toContain("fast-forwarded to 'origin/topic'");
  });

  test("clean switch that was already up to date stays silent", () => {
    // Parity with the plain clean switch: nothing surprising happened.
    notifyRemoteCheckoutOutcome(outcome({ kind: "clean" }, { kind: "up_to_date" }), "origin/topic");
    expect(notify.info).not.toHaveBeenCalled();
    expect(notify.error).not.toHaveBeenCalled();
  });

  test("clean switch with ff not attempted (setting off) stays silent", () => {
    notifyRemoteCheckoutOutcome(
      outcome({ kind: "clean" }, { kind: "not_attempted" }),
      "origin/topic",
    );
    expect(notify.info).not.toHaveBeenCalled();
  });

  test("divergence is surfaced and never claims a fast-forward", () => {
    notifyRemoteCheckoutOutcome(outcome({ kind: "clean" }, { kind: "diverged" }), "origin/topic");
    const msg = vi.mocked(notify.info).mock.calls[0][0] as string;
    expect(msg).toContain("diverged");
    expect(msg).toContain("origin/topic");
    expect(msg).not.toContain("fast-forwarded to");
  });

  test("an ff failure is an error toast that still reports the switch succeeded", () => {
    notifyRemoteCheckoutOutcome(
      outcome({ kind: "clean" }, { kind: "failed", message: "would be overwritten: a.txt" }),
      "origin/topic",
    );
    const msg = vi.mocked(notify.error).mock.calls[0][0] as string;
    expect(msg).toContain("Switched to 'topic'");
    expect(msg).toContain("would be overwritten: a.txt");
  });

  test("a non-clean switch keeps its stash guidance and still reports the ff", () => {
    notifyRemoteCheckoutOutcome(
      outcome({ kind: "changes_stashed" }, { kind: "fast_forwarded" }),
      "origin/topic",
    );
    const msgs = vi.mocked(notify.info).mock.calls.map((c) => c[0] as string).join("\n");
    expect(msgs).toContain("Stashes panel");
    expect(msgs).toContain("ast-forwarded");
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
