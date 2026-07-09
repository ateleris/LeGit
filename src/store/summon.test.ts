import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DockviewApi } from "dockview";
import { useSummonStore } from "./summon";
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
