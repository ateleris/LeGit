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
  setLayoutsOrder: vi.fn(async () => null),
}));
vi.mock("../layout/defaultLayouts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../layout/defaultLayouts")>()),
  buildDefaultGlobalLayout: vi.fn(),
  buildDefaultRepoLayout: vi.fn(),
}));
vi.mock("../layout/globalSummon", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../layout/globalSummon")>()),
  summonGlobalPanel: vi.fn(),
}));

import { loadLayout, listLayouts, setLayoutsOrder, saveLayout, renameLayout, deleteLayout } from "../lib/commands";
import { summonGlobalPanel } from "../layout/globalSummon";
import { buildLayoutDocument } from "../layout/namedLayouts";
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

describe("layouts store: applies never touch the global dock", () => {
  // A legacy document may still carry a global part; applying must ignore it
  // (layouts arrange the repository section only - the global section is app
  // chrome with its own state).
  const doc = buildLayoutDocument(
    "Reviewing",
    { grid: { root: {} } },
    { dockview: {}, placements: {}, fallbacks: {} },
  );

  it("does not read, mutate, or summon into the global dock", async () => {
    vi.mocked(loadLayout).mockResolvedValue(doc);
    const globalApi = new Proxy(
      {},
      {
        get() {
          throw new Error("apply must not touch the global dock");
        },
      },
    ) as unknown as NonNullable<ReturnType<typeof useDockviewStore.getState>["globalApi"]>;
    useDockviewStore.setState({ globalApi });
    await useLayoutsStore.getState().apply("Reviewing");
    expect(summonGlobalPanel).not.toHaveBeenCalled();
  });
});

// The `app.applyLayoutN` shortcuts apply "the Nth layout in list order", so
// the order is a persisted user decision, not a sort of the current names.
describe("layouts store: user-controlled order", () => {
  const entry = (name: string) => ({ name, path: `${name}.legit-layout.json` });

  // The backend is the source of truth: the reordered list only comes back
  // from `listLayouts` if `setOrder` actually persisted it.
  const persistToBackend = () => {
    let persisted: string[] = [];
    vi.mocked(setLayoutsOrder).mockImplementation(async (order: string[]) => {
      persisted = order;
      return null;
    });
    vi.mocked(listLayouts).mockImplementation(async () => persisted.map(entry));
  };

  it("persists the new order", async () => {
    persistToBackend();
    useLayoutsStore.setState({ layouts: [entry("Reviewing"), entry("Wide diff")] });
    await useLayoutsStore.getState().setOrder(["Wide diff", "Reviewing"]);
    expect(useLayoutsStore.getState().layouts.map((l) => l.name)).toEqual([
      "Wide diff",
      "Reviewing",
    ]);
  });

  // Dropped rows must not snap back to the old order for a frame while the
  // write is in flight.
  it("shows the new order before the write completes", async () => {
    persistToBackend();
    useLayoutsStore.setState({ layouts: [entry("Reviewing"), entry("Wide diff")] });
    const pending = useLayoutsStore.getState().setOrder(["Wide diff", "Reviewing"]);
    expect(useLayoutsStore.getState().layouts.map((l) => l.name)).toEqual([
      "Wide diff",
      "Reviewing",
    ]);
    await pending;
  });
});
