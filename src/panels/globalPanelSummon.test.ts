// @vitest-environment happy-dom
//
// Behavior tests for summonGlobalPanel: opening a global panel from outside
// the dock (View menu). The regressions pinned here:
// - while the global region is collapsed, GlobalDock is unmounted and its api
//   is null, so a plain openGlobalPanel was a silent no-op;
// - the pending summon must run against the RESTORED layout (an api published
//   before the restore had the summoned panel wiped/buried by fromJSON);
// - React StrictMode mounts DockviewReact twice in dev - a summon consumed
//   only by the first, immediately-disposed instance never reached the
//   surviving dock (the "shows the pre-collapse tab" bug).
import { describe, test, expect, vi, beforeEach } from "vitest";
import type { DockviewApi } from "dockview-react";
import { useDockviewStore } from "../store/dockview";
import { useGlobalRegionStore } from "../store/globalRegion";
import { readyGlobalDock, summonGlobalPanel } from "./GlobalDock";
import { DEFAULT_GLOBAL_LAYOUT } from "./defaultLayouts";

/** Minimal api fake for the expanded path (no restore involved). */
function fakeApi(openPanels: Record<string, { focus: () => void }> = {}) {
  const added: { id: string }[] = [];
  const api = {
    getPanel: (id: string) => openPanels[id],
    addPanel: (opts: { id: string }) => {
      added.push(opts);
    },
  } as unknown as DockviewApi;
  return { api, added };
}

/** Dock fake for the full readyGlobalDock flow: fromJSON REPLACES the whole
 *  layout with `restoredPanels`, like dockview's real fromJSON. */
function fakeDock(restoredPanels: string[]) {
  const focused: string[] = [];
  const added: string[] = [];
  let panels: Record<string, unknown> = {};
  const openIds: string[] = [];
  const mkPanel = (id: string) => ({
    id,
    focus: () => focused.push(id),
    api: { setActive: () => focused.push(id) },
  });
  const api = {
    get panels() {
      return openIds;
    },
    groups: [] as unknown[],
    getPanel: (id: string) => panels[id],
    addPanel: (opts: { id: string }) => {
      added.push(opts.id);
      panels[opts.id] = mkPanel(opts.id);
      openIds.push(opts.id);
    },
    fromJSON: () => {
      panels = {};
      openIds.length = 0;
      for (const id of restoredPanels) {
        panels[id] = mkPanel(id);
        openIds.push(id);
      }
    },
    onDidAddGroup: () => ({ dispose() {} }),
    onDidLayoutChange: () => ({ dispose() {} }),
    toJSON: () => ({}),
  } as unknown as DockviewApi;
  return { api, added, focused };
}

beforeEach(() => {
  useDockviewStore.getState().setGlobalApi(null);
  useGlobalRegionStore.setState({ collapsed: false });
});

describe("summonGlobalPanel", () => {
  test("opens the panel immediately when the dock is mounted", () => {
    const { api, added } = fakeApi();
    useDockviewStore.getState().setGlobalApi(api);
    summonGlobalPanel("repositories");
    expect(added).toEqual([expect.objectContaining({ id: "repositories" })]);
  });

  test("focuses an already-open panel instead of duplicating it", () => {
    const focus = vi.fn();
    const { api, added } = fakeApi({ "theme-editor": { focus } });
    useDockviewStore.getState().setGlobalApi(api);
    summonGlobalPanel("theme-editor");
    expect(focus).toHaveBeenCalled();
    expect(added).toEqual([]);
  });

  test("collapsed region: expands it and opens the panel when the dock initializes", async () => {
    useGlobalRegionStore.setState({ collapsed: true });
    summonGlobalPanel("theme-editor");
    // The summon must uncollapse the region so GlobalDock mounts...
    expect(useGlobalRegionStore.getState().collapsed).toBe(false);
    // ...and open the panel when the freshly mounted dock initializes
    // (restored layout does not contain it here, so it is added).
    const dock = fakeDock(["repositories"]);
    readyGlobalDock(dock.api);
    expect(dock.added).toContain("theme-editor");
    await Promise.resolve(); // let the pending summon expire
  });

  test("pending summon lands on the RESTORED layout, focused", async () => {
    // GlobalDock restores its persisted layout in readyGlobalDock; the
    // pending summon must run against the restored layout, not before it.
    localStorage.setItem(
      "legit.global-dock-layout",
      JSON.stringify(structuredClone(DEFAULT_GLOBAL_LAYOUT)),
    );
    try {
      useGlobalRegionStore.setState({ collapsed: true });
      summonGlobalPanel("global-settings");
      const dock = fakeDock(["repositories", "theme-editor", "global-settings"]);
      readyGlobalDock(dock.api);
      // The summoned panel already exists in the restored layout: it must be
      // focused there, not added before the restore (and then clobbered).
      expect(dock.focused).toContain("global-settings");
      expect(dock.added).toEqual([]);
    } finally {
      localStorage.removeItem("legit.global-dock-layout");
      await Promise.resolve(); // let the pending summon expire
    }
  });

  test("several summons while collapsed: the last one wins", async () => {
    useGlobalRegionStore.setState({ collapsed: true });
    summonGlobalPanel("repositories");
    summonGlobalPanel("global-settings");
    const dock = fakeDock(["repositories", "theme-editor", "global-settings"]);
    readyGlobalDock(dock.api);
    expect(dock.focused).toContain("global-settings");
    expect(dock.focused).not.toContain("repositories");
    await Promise.resolve(); // let the pending summon expire
  });

  test("dev StrictMode double-mount: the SECOND dock instance gets the summon too", async () => {
    // React StrictMode mounts DockviewReact twice (mount, dispose, remount)
    // within one effect flush. If the pending summon were consumed by the
    // first, immediately-disposed instance, the surviving second instance
    // would restore the old active tab and never see the summon - the
    // collapsed flow then showed the pre-collapse panel.
    useGlobalRegionStore.setState({ collapsed: true });
    summonGlobalPanel("theme-editor");
    const first = fakeDock(["repositories", "theme-editor", "global-settings"]);
    readyGlobalDock(first.api);
    expect(first.focused).toContain("theme-editor");
    const second = fakeDock(["repositories", "theme-editor", "global-settings"]);
    readyGlobalDock(second.api);
    expect(second.focused).toContain("theme-editor");
    // Once the effect flush's task ends, the summon is spent: a LATER mount
    // (the user collapses and re-expands by hand) must not replay it.
    await Promise.resolve();
    const third = fakeDock(["repositories", "theme-editor", "global-settings"]);
    readyGlobalDock(third.api);
    expect(third.focused).toEqual([]);
  });
});
