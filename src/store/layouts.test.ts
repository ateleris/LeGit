// @vitest-environment happy-dom
//
// The `lastApplied` marker (View menu checkmark / panel "(active)" tag) must
// clear as soon as either dock changes - a drifted arrangement no longer IS
// the saved layout - while the apply operation's OWN layout-change events
// (fromJSON fires the same onDidLayoutChange as a user drag) must not clear
// the marker the apply just set.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock(import("../lib/commands"), async (importOriginal) => ({
  ...(await importOriginal()),
  listLayouts: vi.fn(async () => []),
  loadLayout: vi.fn(),
  saveLayout: vi.fn(async (name: string) => ({ name, path: "" })),
  renameLayout: vi.fn(async (_old: string, name: string) => ({ name, path: "" })),
  deleteLayout: vi.fn(async () => null),
}));
vi.mock("../panels/GlobalDock", () => ({
  buildDefaultGlobalLayout: vi.fn(),
  summonGlobalPanel: vi.fn(),
  restoreGlobalPanelInactive: vi.fn(),
}));
vi.mock("../panels/RepoDock", () => ({
  buildDefaultRepoLayout: vi.fn(),
}));

import { loadLayout } from "../lib/commands";
import { restoreGlobalPanelInactive, summonGlobalPanel } from "../panels/GlobalDock";
import { buildLayoutDocument } from "../panels/namedLayouts";
import { useDockviewStore } from "./dockview";
import { useLayoutsStore } from "./layouts";

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  useLayoutsStore.setState({ layouts: [], lastApplied: null });
  useDockviewStore.setState({ globalApi: null });
});

afterEach(() => {
  // Drain the apply's suppression-release timer so it never leaks into the
  // next test.
  vi.runAllTimers();
  vi.useRealTimers();
});

describe("layouts store: lastApplied invalidation", () => {
  it("a dock layout change clears the marker", () => {
    useLayoutsStore.setState({ lastApplied: "Reviewing" });
    useLayoutsStore.getState().noteDockLayoutChanged();
    expect(useLayoutsStore.getState().lastApplied).toBeNull();
  });

  it("apply()'s own change events are swallowed; later changes clear", async () => {
    vi.mocked(loadLayout).mockResolvedValue(
      buildLayoutDocument("Reviewing", { grid: {}, panels: {} }, null),
    );
    await useLayoutsStore.getState().apply("Reviewing");
    expect(useLayoutsStore.getState().lastApplied).toBe("Reviewing");
    // A change event arriving right after the apply (dockview may emit on a
    // later tick) is the apply's own - the marker survives it.
    useLayoutsStore.getState().noteDockLayoutChanged();
    expect(useLayoutsStore.getState().lastApplied).toBe("Reviewing");
    // Once the suppression window has passed, a change is the user's.
    vi.advanceTimersByTime(200);
    useLayoutsStore.getState().noteDockLayoutChanged();
    expect(useLayoutsStore.getState().lastApplied).toBeNull();
  });
});

describe("layouts store: Layouts panel restore on apply", () => {
  const doc = buildLayoutDocument("Reviewing", null, {
    dockview: {},
    placements: {},
    fallbacks: {},
  });
  // Only getPanel matters here: the document's global part is null, so the
  // fake api is never mutated.
  const fakeGlobalApi = (getPanel: () => unknown) =>
    ({ getPanel } as unknown as NonNullable<ReturnType<typeof useDockviewStore.getState>["globalApi"]>);

  it("never focus-summons the panel, and leaves it alone when the apply kept it", async () => {
    // Applying must not move focus to the Layouts panel (it applied a layout,
    // it didn't ask for the manager) - the focusing summon path is off-limits
    // here, and a panel the apply did not remove needs no restore either.
    vi.mocked(loadLayout).mockResolvedValue(doc);
    useDockviewStore.setState({ globalApi: fakeGlobalApi(() => ({})) });
    await useLayoutsStore.getState().apply("Reviewing");
    expect(summonGlobalPanel).not.toHaveBeenCalled();
    expect(restoreGlobalPanelInactive).not.toHaveBeenCalled();
  });

  it("restores the panel (inactive) when the apply removed it", async () => {
    vi.mocked(loadLayout).mockResolvedValue(doc);
    const getPanel = vi.fn().mockReturnValueOnce({}).mockReturnValue(undefined);
    useDockviewStore.setState({ globalApi: fakeGlobalApi(getPanel) });
    await useLayoutsStore.getState().apply("Reviewing");
    expect(summonGlobalPanel).not.toHaveBeenCalled();
    expect(restoreGlobalPanelInactive).toHaveBeenCalledWith("layouts");
  });

  it("does not restore a panel that was closed before the apply", async () => {
    vi.mocked(loadLayout).mockResolvedValue(doc);
    useDockviewStore.setState({ globalApi: fakeGlobalApi(() => undefined) });
    await useLayoutsStore.getState().apply("Reviewing");
    expect(restoreGlobalPanelInactive).not.toHaveBeenCalled();
  });
});
