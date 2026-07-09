import { describe, it, expect } from "vitest";
import { sanitizePaneviewLayout } from "./refsLayout";

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
