// Focus-mode toggle decision logic (store/dockview.ts `toggleMaximize`):
// which dock gets exited or maximized, and when the toggle must do nothing.
// The dockview APIs are faked structurally so the rules are pinned without a
// live dock.
import { describe, it, expect } from "vitest";
import { exitMaximized, isUnclaimedEscape, toggleMaximize, type MaximizeTarget } from "./dockview";

function fakeDock(opts: {
  maximized?: boolean;
  activePanel?: { visible: boolean };
}) {
  const calls: string[] = [];
  const dock: MaximizeTarget = {
    hasMaximizedGroup: () => opts.maximized ?? false,
    exitMaximizedGroup: () => calls.push("exit"),
    activePanel: opts.activePanel
      ? {
          api: { maximize: () => calls.push("maximize") },
          group: { api: { isVisible: opts.activePanel.visible } },
        }
      : undefined,
  };
  return { dock, calls };
}

describe("toggleMaximize", () => {
  it("maximizes the primary dock's active panel when nothing is maximized", () => {
    const primary = fakeDock({ activePanel: { visible: true } });
    const other = fakeDock({ activePanel: { visible: true } });
    expect(toggleMaximize(primary.dock, other.dock)).toBe("maximized");
    expect(primary.calls).toEqual(["maximize"]);
    expect(other.calls).toEqual([]);
  });

  it("exits a maximized primary dock instead of maximizing", () => {
    const primary = fakeDock({ maximized: true, activePanel: { visible: true } });
    expect(toggleMaximize(primary.dock, null)).toBe("exited");
    expect(primary.calls).toEqual(["exit"]);
  });

  it("exits a maximized OTHER dock before ever maximizing the primary", () => {
    // The exit must find the maximized group wherever it lives - a stale
    // maximize in the other dock would otherwise stack under a new one.
    const primary = fakeDock({ activePanel: { visible: true } });
    const other = fakeDock({ maximized: true });
    expect(toggleMaximize(primary.dock, other.dock)).toBe("exited");
    expect(other.calls).toEqual(["exit"]);
    expect(primary.calls).toEqual([]);
  });

  it("does nothing without an active panel", () => {
    const primary = fakeDock({});
    expect(toggleMaximize(primary.dock, null)).toBe("noop");
    expect(primary.calls).toEqual([]);
  });

  it("does nothing when the active panel's group is hidden", () => {
    // The console group starts collapsed via setVisible(false); maximizing a
    // hidden group would blank the whole dock (dockview does not un-hide the
    // maximized node itself).
    const primary = fakeDock({ activePanel: { visible: false } });
    expect(toggleMaximize(primary.dock, null)).toBe("noop");
    expect(primary.calls).toEqual([]);
  });

  it("does nothing when no dock is available", () => {
    expect(toggleMaximize(null, null)).toBe("noop");
  });
});

describe("exitMaximized", () => {
  it("exits the first dock that holds a maximized group and reports it", () => {
    const a = fakeDock({});
    const b = fakeDock({ maximized: true });
    expect(exitMaximized(a.dock, b.dock)).toBe(true);
    expect(a.calls).toEqual([]);
    expect(b.calls).toEqual(["exit"]);
  });

  it("reports false when nothing is maximized", () => {
    const a = fakeDock({});
    expect(exitMaximized(a.dock, null)).toBe(false);
    expect(a.calls).toEqual([]);
  });
});

describe("isUnclaimedEscape", () => {
  const esc = (over: Partial<{ key: string; defaultPrevented: boolean; target: unknown }> = {}) => ({
    key: "Escape",
    defaultPrevented: false,
    target: null as unknown,
    ...over,
  });

  it("accepts a plain Escape outside any editable target", () => {
    expect(isUnclaimedEscape(esc())).toBe(true);
    expect(isUnclaimedEscape(esc({ target: { tagName: "DIV", isContentEditable: false } }))).toBe(true);
  });

  it("rejects other keys", () => {
    expect(isUnclaimedEscape(esc({ key: "Enter" }))).toBe(false);
  });

  it("rejects an Escape a local handler already claimed via preventDefault", () => {
    // InlineRenameInput and RevPicker preventDefault their Esc.
    expect(isUnclaimedEscape(esc({ defaultPrevented: true }))).toBe(false);
  });

  it("rejects Escape originating from editable targets", () => {
    // Inline branch/stash editors and the commit search box handle their own
    // Esc without stopping propagation - the target guard covers them all.
    for (const tagName of ["INPUT", "TEXTAREA", "SELECT"]) {
      expect(isUnclaimedEscape(esc({ target: { tagName, isContentEditable: false } }))).toBe(false);
    }
    expect(isUnclaimedEscape(esc({ target: { tagName: "DIV", isContentEditable: true } }))).toBe(false);
  });
});
