// Focus-mode toggle decision logic (store/dockview.ts `toggleMaximize`):
// which dock gets exited or maximized, and when the toggle must do nothing.
// The dockview APIs are faked structurally so the rules are pinned without a
// live dock.
import { beforeEach, describe, it, expect } from "vitest";
import { exitMaximized, toggleMaximize, wireMaximizeModeLayer, type MaximizeTarget } from "./dockview";
import { useLayersStore } from "./layers";

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

describe("wireMaximizeModeLayer", () => {
  beforeEach(() => {
    useLayersStore.setState({ layers: [] });
  });

  function fakeMaximizeSource() {
    let maximized = false;
    let cb: (() => void) | null = null;
    const calls: string[] = [];
    return {
      dock: {
        hasMaximizedGroup: () => maximized,
        exitMaximizedGroup: () => {
          calls.push("exit");
          maximized = false;
          cb?.();
        },
        onDidMaximizedGroupChange: (fn: () => void) => {
          cb = fn;
        },
      },
      maximize: () => {
        maximized = true;
        cb?.();
      },
      calls,
    };
  }

  it("keeps a mode layer on the stack while the dock is maximized", () => {
    const src = fakeMaximizeSource();
    wireMaximizeModeLayer(src.dock, "repo");
    expect(useLayersStore.getState().layers).toHaveLength(0);
    src.maximize();
    expect(useLayersStore.getState().layers.map((l) => `${l.id}/${l.kind}`)).toEqual([
      "maximize:repo/mode",
    ]);
    src.dock.exitMaximizedGroup();
    expect(useLayersStore.getState().layers).toHaveLength(0);
  });

  it("dismissing the layer exits the maximized group (the Escape path)", () => {
    const src = fakeMaximizeSource();
    wireMaximizeModeLayer(src.dock, "global");
    src.maximize();
    useLayersStore.getState().layers[0].onDismiss();
    expect(src.calls).toEqual(["exit"]);
    expect(useLayersStore.getState().layers).toHaveLength(0);
  });
});
