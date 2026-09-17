import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DockviewApi } from "dockview";
import { addRepoPanelWithoutSplitting, resolveSummonPlacement, useSummonStore } from "./summon";
import { useDockviewStore } from "./dockview";

/** Minimal dockview API fake: tracks open panels and addPanel calls. */
function fakeApi(openPanels: Record<string, { groupId: string }>) {
  const closed: string[] = [];
  const added: { id: string; position?: unknown }[] = [];
  const api = {
    groups: Object.values(openPanels).map((p) => ({ id: p.groupId })),
    getPanel: (id: string) => {
      const p = openPanels[id];
      if (!p) return undefined;
      return {
        id,
        group: { id: p.groupId },
        focus: vi.fn(),
        api: { close: () => closed.push(id) },
      };
    },
    addPanel: (opts: { id: string; position?: unknown }) => added.push(opts),
  };
  return { api: api as unknown as DockviewApi, closed, added };
}

beforeEach(() => {
  useSummonStore.setState({ placements: {}, fallbackPositions: {}, payloadQueue: {}, callbacks: {} });
});

describe("summon slot sharing (diff <-> merge)", () => {
  it("summoning diff while merge is open takes over merge's group and closes it", () => {
    const { api, closed, added } = fakeApi({ merge: { groupId: "g1" } });
    useDockviewStore.setState({ repoApi: api });

    useSummonStore.getState().summon("diff", { repoId: "r", path: "a.txt" });

    expect(added).toEqual([
      expect.objectContaining({
        id: "diff",
        position: { referenceGroup: "g1", direction: "within" },
      }),
    ]);
    expect(closed).toEqual(["merge"]);
    expect(useSummonStore.getState().payloadQueue["diff"]).toEqual({ repoId: "r", path: "a.txt" });
  });

  it("summoning merge while diff is open takes over diff's group and closes it", () => {
    const { api, closed, added } = fakeApi({ diff: { groupId: "g2" } });
    useDockviewStore.setState({ repoApi: api });

    useSummonStore.getState().summon("merge", { repoId: "r", path: "a.txt" });

    expect(added).toEqual([
      expect.objectContaining({
        id: "merge",
        position: { referenceGroup: "g2", direction: "within" },
      }),
    ]);
    expect(closed).toEqual(["diff"]);
  });

  it("summoning diff when it is already open just delivers the payload", () => {
    const { api, closed, added } = fakeApi({
      diff: { groupId: "g1" },
      merge: { groupId: "g2" },
    });
    useDockviewStore.setState({ repoApi: api });
    const received: unknown[] = [];
    useSummonStore.getState().registerTarget("diff", (p) => received.push(p));

    useSummonStore.getState().summon("diff", { repoId: "r", path: "a.txt" });

    expect(added).toEqual([]);
    expect(closed).toEqual([]);
    expect(received).toEqual([{ repoId: "r", path: "a.txt" }]);
  });

  it("summoning diff with neither open uses normal placement", () => {
    const { api, closed, added } = fakeApi({ "changed-files": { groupId: "g0" } });
    useDockviewStore.setState({ repoApi: api });

    useSummonStore.getState().summon("diff");

    expect(added).toHaveLength(1);
    expect(added[0].id).toBe("diff");
    expect(closed).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// resolveSummonPlacement — summons never split the layout: every path joins
// an existing group as a tab (remembered group, fallback reference's group,
// file-inspection companion, transitive default-reference walk, active group).
// ---------------------------------------------------------------------------

describe("resolveSummonPlacement", () => {
  const open = (...ids: string[]) => (id: string) => ids.includes(id);
  const groups = (...ids: string[]) => (id: string) => ids.includes(id);
  const none = () => false;

  it("restores into the remembered group while it still exists", () => {
    expect(
      resolveSummonPlacement("compare", { compare: "g7" }, {}, none, groups("g7")),
    ).toEqual({ kind: "group", groupId: "g7" });
  });

  it("joins the fallback reference's group when the remembered group is gone", () => {
    expect(
      resolveSummonPlacement(
        "compare",
        { compare: "g7" },
        { compare: { referencePanel: "log", direction: "right" } },
        open("log"),
        groups(),
      ),
    ).toEqual({ kind: "join", panelId: "log" });
  });

  it("skips a fallback whose reference panel is closed", () => {
    expect(
      resolveSummonPlacement(
        "compare",
        {},
        { compare: { referencePanel: "blame", direction: "right" } },
        open("log"),
        groups(),
      ),
    ).toEqual({ kind: "join", panelId: "log" });
  });

  it("collocates file-inspection panels with an open companion", () => {
    expect(resolveSummonPlacement("blame", {}, {}, open("file-view", "log"), groups())).toEqual({
      kind: "join",
      panelId: "file-view",
    });
  });

  it("memory beats collocation (a deliberately moved panel keeps its spot)", () => {
    expect(
      resolveSummonPlacement("blame", { blame: "g2" }, {}, open("file-view"), groups("g2")),
    ).toEqual({ kind: "group", groupId: "g2" });
  });

  it("file-inspection panels without a companion follow diff's reference chain", () => {
    // diff's defaultPlacement references changed-files.
    expect(
      resolveSummonPlacement("file-view", {}, {}, open("changed-files", "log"), groups()),
    ).toEqual({ kind: "join", panelId: "changed-files" });
  });

  it("cold summon joins the defaultPlacement reference's group instead of splitting", () => {
    expect(resolveSummonPlacement("file-history", {}, {}, open("log"), groups())).toEqual({
      kind: "join",
      panelId: "log",
    });
  });

  it("walks closed references transitively to an open ancestor", () => {
    // changed-files references commit-details (closed), which references log.
    expect(resolveSummonPlacement("changed-files", {}, {}, open("log"), groups())).toEqual({
      kind: "join",
      panelId: "log",
    });
  });

  it("falls back to the active group when nothing resolves", () => {
    expect(resolveSummonPlacement("compare", {}, {}, none, groups())).toEqual({
      kind: "default",
    });
  });
});

// ---------------------------------------------------------------------------
// addRepoPanelWithoutSplitting — the shared "open a closed panel" primitive
// behind summon() AND the View menu's openRepoPanel. Regression: the View
// menu had its own placement logic that still split by defaultPlacement.
// ---------------------------------------------------------------------------

describe("addRepoPanelWithoutSplitting", () => {
  function visApi(
    openPanels: Record<string, { groupId: string }>,
    hiddenGroups: string[] = [],
  ) {
    const added: { id: string; position?: unknown }[] = [];
    const unhidden: string[] = [];
    const panels: Record<string, { groupId: string }> = { ...openPanels };
    const groupApi = (groupId: string) => ({
      close: vi.fn(),
      isVisible: !hiddenGroups.includes(groupId),
      setVisible: (v: boolean) => {
        if (v) unhidden.push(groupId);
      },
    });
    const api = {
      groups: Object.values(openPanels).map((p) => ({ id: p.groupId })),
      getPanel: (id: string) => {
        const p = panels[id];
        if (!p) return undefined;
        return { id, group: { id: p.groupId, api: groupApi(p.groupId) }, focus: vi.fn() };
      },
      addPanel: (opts: { id: string; position?: { referencePanel?: string; referenceGroup?: string } }) => {
        added.push(opts);
        // Land the panel where the position says, so the unhide check finds it.
        const ref = opts.position?.referencePanel;
        const groupId =
          opts.position?.referenceGroup ?? (ref ? panels[ref]?.groupId : undefined) ?? "g-active";
        panels[opts.id] = { groupId };
      },
    };
    return { api: api as unknown as DockviewApi, added, unhidden };
  }

  it("joins the default reference's group instead of splitting (View-menu path)", () => {
    const { api, added } = visApi({ log: { groupId: "g-log" } });
    addRepoPanelWithoutSplitting(api, "compare");
    expect(added).toEqual([
      expect.objectContaining({
        id: "compare",
        position: { referencePanel: "log", direction: "within" },
      }),
    ]);
  });

  it("unhides a hidden group it lands in (collapsed console group)", () => {
    useSummonStore.setState({ placements: { "git-log": "g-console" } });
    const { api, added, unhidden } = visApi({ console: { groupId: "g-console" } }, ["g-console"]);
    addRepoPanelWithoutSplitting(api, "git-log");
    expect(added).toEqual([
      expect.objectContaining({
        id: "git-log",
        position: { referenceGroup: "g-console", direction: "within" },
      }),
    ]);
    expect(unhidden).toEqual(["g-console"]);
  });
});
