import { describe, it, expect } from "vitest";
import { defaultPaneSizes, sanitizePaneviewLayout } from "./refsLayout";

const KNOWN = new Set(["branches", "remotes", "tags", "stashes", "reflog"]);
const isKnown = (name: string) => KNOWN.has(name);

function view(id: string, overrides: Record<string, unknown> = {}) {
  return {
    size: 22,
    expanded: false,
    headerSize: 22,
    data: {
      id,
      component: id,
      headerComponent: "default",
      title: id[0].toUpperCase() + id.slice(1),
    },
    ...overrides,
  };
}

describe("sanitizePaneviewLayout", () => {
  it("passes a valid layout through, patching headerSize and headerComponent", () => {
    const result = sanitizePaneviewLayout(
      { views: [view("branches"), view("stashes")], size: 1302 },
      isKnown,
      30,
    );
    expect(result).not.toBeNull();
    expect(result!.views.map((v) => v.data?.id)).toEqual([
      "branches",
      "stashes",
    ]);
    expect(result!.views.every((v) => v.headerSize === 30)).toBe(true);
    expect(
      result!.views.every((v) => v.data?.headerComponent === "default"),
    ).toBe(true);
    expect(result!.size).toBe(1302);
  });

  it("drops views whose component is no longer registered", () => {
    // The real-world case: a "submodules" pane existed in an experiment,
    // was removed from the code, but lived on in the persisted layout and
    // made dockview's fromJSON throw halfway through the restore.
    const result = sanitizePaneviewLayout(
      {
        views: [
          view("branches"),
          view("remotes"),
          view("tags"),
          view("stashes"),
          view("submodules"),
          view("reflog"),
        ],
        size: 1302,
      },
      isKnown,
      22,
    );
    expect(result!.views.map((v) => v.data?.id)).toEqual([
      "branches",
      "remotes",
      "tags",
      "stashes",
      "reflog",
    ]);
  });

  it("deduplicates views by id, keeping the first", () => {
    const result = sanitizePaneviewLayout(
      {
        views: [
          view("branches", { expanded: true }),
          view("stashes"),
          view("branches"),
        ],
      },
      isKnown,
      22,
    );
    expect(result!.views.map((v) => v.data?.id)).toEqual([
      "branches",
      "stashes",
    ]);
    expect(result!.views[0].expanded).toBe(true);
  });

  it("skips malformed view entries instead of failing the whole layout", () => {
    const result = sanitizePaneviewLayout(
      {
        views: [
          null,
          42,
          { data: null },
          { data: { id: 7, component: "branches" } },
          { data: { id: "tags" } },
          view("stashes"),
        ],
      },
      isKnown,
      22,
    );
    expect(result!.views.map((v) => v.data?.id)).toEqual(["stashes"]);
  });

  it("returns null for unusable input", () => {
    expect(sanitizePaneviewLayout(null, isKnown, 22)).toBeNull();
    expect(sanitizePaneviewLayout("nope", isKnown, 22)).toBeNull();
    expect(sanitizePaneviewLayout({}, isKnown, 22)).toBeNull();
    expect(sanitizePaneviewLayout({ views: "x" }, isKnown, 22)).toBeNull();
  });

  it("returns null when no views survive (caller falls back to defaults)", () => {
    expect(
      sanitizePaneviewLayout(
        { views: [view("submodules"), view("gone")] },
        isKnown,
        22,
      ),
    ).toBeNull();
  });

  it("omits size when the saved one is not a number", () => {
    const result = sanitizePaneviewLayout(
      { views: [view("branches")], size: "big" },
      isKnown,
      22,
    );
    expect(result).not.toBeNull();
    expect("size" in result!).toBe(false);
  });
});

// Regression for the zero-height Branches pane (2026-08-06): the default
// pane set is added into a still-unmeasured container, so without explicit
// sizes the first real layout gave ALL the height to the last expanded pane.
describe("defaultPaneSizes", () => {
  // The real default set: branches + stashes expanded, three collapsed.
  const panes = [
    { id: "branches", expanded: true },
    { id: "remotes", expanded: false },
    { id: "tags", expanded: false },
    { id: "stashes", expanded: true },
    { id: "reflog", expanded: false },
  ];

  it("splits the body space evenly across the expanded panes", () => {
    const sizes = defaultPaneSizes(1000, 22, panes);
    // body = 1000 - 5*22 = 890; share = 445; pane size includes its header.
    expect(sizes.get("branches")).toBe(467);
    expect(sizes.get("stashes")).toBe(467);
    expect(sizes.has("remotes")).toBe(false);
  });

  it("gives a single expanded pane the whole body", () => {
    const sizes = defaultPaneSizes(500, 20, [
      { id: "branches", expanded: true },
      { id: "remotes", expanded: false },
    ]);
    expect(sizes.get("branches")).toBe(20 + (500 - 40));
  });

  it("returns empty for an unmeasured container so the caller retries", () => {
    expect(defaultPaneSizes(0, 22, panes).size).toBe(0);
    expect(defaultPaneSizes(-5, 22, panes).size).toBe(0);
  });

  it("returns empty when nothing is expanded", () => {
    expect(defaultPaneSizes(800, 22, [{ id: "reflog", expanded: false }]).size).toBe(0);
  });

  it("treats a transient header-only height as not-yet-distributable", () => {
    // The dock group grows over a few frames after opening (74px observed
    // before the real 485px); a "distribution" at that moment would assign
    // header-only sizes and stop the caller's retry loop.
    expect(defaultPaneSizes(74, 22, panes).size).toBe(0);
    expect(defaultPaneSizes(50, 22, panes).size).toBe(0);
  });
});
