// @vitest-environment happy-dom
//
// Persisted-layout parsing: the same parser backs the repo dock's startup
// restore and the saved-default snapshot ("Save as default layout"), so its
// tolerance rules are pinned here - envelope format, bare-layout backward
// compatibility, and never throwing on garbage.
import { describe, it, expect } from "vitest";
import {
  parseRepoLayoutEnvelope,
  sanitizeDockviewLayout,
  substituteSlotPanels,
  SLOT_PAIRS,
} from "./layoutSnapshot";

describe("parseRepoLayoutEnvelope", () => {
  it("parses the envelope format", () => {
    const raw = JSON.stringify({
      dockview: { grid: {} },
      placements: { log: "group-1", diff: "group-2" },
      fallbacks: { diff: { referencePanel: "log", direction: "right" } },
    });
    const env = parseRepoLayoutEnvelope(raw);
    expect(env).not.toBeNull();
    expect(env!.dockview).toEqual({ grid: {} });
    expect(env!.placements).toEqual({ log: "group-1", diff: "group-2" });
    expect(env!.fallbacks).toEqual({ diff: { referencePanel: "log", direction: "right" } });
  });

  it("treats a bare layout (no dockview field) as the layout itself", () => {
    const raw = JSON.stringify({ grid: { root: {} }, panels: {} });
    const env = parseRepoLayoutEnvelope(raw);
    expect(env).not.toBeNull();
    expect(env!.dockview).toEqual({ grid: { root: {} }, panels: {} });
    expect(env!.placements).toEqual({});
    expect(env!.fallbacks).toEqual({});
  });

  it("drops malformed placement and fallback entries but keeps the rest", () => {
    const raw = JSON.stringify({
      dockview: {},
      placements: { log: "group-1", bad: 42 },
      fallbacks: { diff: { referencePanel: "log", direction: "right" }, bad: "nope" },
    });
    const env = parseRepoLayoutEnvelope(raw);
    expect(env!.placements).toEqual({ log: "group-1" });
    expect(env!.fallbacks).toEqual({ diff: { referencePanel: "log", direction: "right" } });
  });

  it("returns null for missing, non-JSON, or non-object input", () => {
    expect(parseRepoLayoutEnvelope(null)).toBeNull();
    expect(parseRepoLayoutEnvelope("")).toBeNull();
    expect(parseRepoLayoutEnvelope("not json {")).toBeNull();
    expect(parseRepoLayoutEnvelope('"a string"')).toBeNull();
    expect(parseRepoLayoutEnvelope("null")).toBeNull();
  });
});

describe("sanitizeDockviewLayout", () => {
  const KNOWN = new Set(["log", "diff"]);
  const leaf = (id: string, views: string[], activeView = views[0]) => ({
    type: "leaf",
    data: { views, activeView, id },
    size: 100,
  });
  const panel = (id: string) => ({ id, contentComponent: id, title: id });

  it("passes a fully-known layout through structurally intact", () => {
    const layout = {
      grid: { root: { type: "branch", data: [leaf("1", ["log"]), leaf("2", ["diff"])], size: 200 }, width: 200, height: 100, orientation: "HORIZONTAL" },
      panels: { log: panel("log"), diff: panel("diff") },
      activeGroup: "2",
    };
    expect(sanitizeDockviewLayout(layout, KNOWN)).toEqual(layout);
  });

  it("prunes retired panels from views and the panels map", () => {
    const layout = {
      grid: { root: { type: "branch", data: [leaf("1", ["log", "search"], "search")], size: 100 } },
      panels: { log: panel("log"), search: panel("search") },
      activeGroup: "1",
    };
    const out = sanitizeDockviewLayout(layout, KNOWN) as {
      grid: { root: { data: { data: { views: string[]; activeView: string } }[] } };
      panels: Record<string, unknown>;
    };
    expect(out.grid.root.data[0].data.views).toEqual(["log"]);
    // The retired panel was the active view - falls back to a surviving one.
    expect(out.grid.root.data[0].data.activeView).toBe("log");
    expect(Object.keys(out.panels)).toEqual(["log"]);
  });

  it("drops groups left empty and clears a dangling activeGroup", () => {
    const layout = {
      grid: { root: { type: "branch", data: [leaf("1", ["log"]), leaf("2", ["search"])], size: 200 } },
      panels: { log: panel("log"), search: panel("search") },
      activeGroup: "2",
    };
    const out = sanitizeDockviewLayout(layout, KNOWN) as {
      grid: { root: { data: unknown[] } };
      activeGroup?: string;
    };
    expect(out.grid.root.data).toHaveLength(1);
    expect(out.activeGroup).toBeUndefined();
  });

  it("rewrites persisted panel titles from the registry titles map", () => {
    // Layouts persist titles verbatim, so a registry rename (e.g. "Git Log"
    // to "Git Command Log") must be re-applied on restore or existing saved
    // layouts keep the stale tab title forever.
    const layout = {
      grid: { root: { type: "branch", data: [leaf("1", ["log", "diff"])], size: 100 } },
      panels: {
        log: { id: "log", contentComponent: "log", title: "Stale Title" },
        diff: panel("diff"),
      },
      activeGroup: "1",
    };
    const out = sanitizeDockviewLayout(layout, KNOWN, { log: "Fresh Title" }) as {
      panels: Record<string, { title: string }>;
    };
    expect(out.panels.log.title).toBe("Fresh Title");
    // Panels without a registry entry keep their persisted title.
    expect(out.panels.diff.title).toBe("diff");
  });

  it("injects a title into panels persisted without one", () => {
    // The baked default layouts omit titles entirely (registry-owned), and
    // dockview would otherwise fall back to showing the raw panel id.
    const layout = {
      grid: { root: leaf("1", ["log"]) },
      panels: { log: { id: "log", contentComponent: "log" } },
    };
    const out = sanitizeDockviewLayout(layout, KNOWN, { log: "Commits" }) as {
      panels: Record<string, { title?: string }>;
    };
    expect(out.panels.log.title).toBe("Commits");
  });

  it("strips a maximizedNode marker so a restore never re-maximizes", () => {
    // dockview serializes the RESTING layout plus a `maximizedNode` marker
    // when a group is maximized, and fromJSON re-applies the marker. Focus
    // mode is transient, so a persisted layout must restore un-maximized.
    const layout = {
      grid: {
        root: { type: "branch", data: [leaf("1", ["log"]), leaf("2", ["diff"])], size: 200 },
        maximizedNode: { location: [0] },
      },
      panels: { log: panel("log"), diff: panel("diff") },
      activeGroup: "1",
    };
    const out = sanitizeDockviewLayout(layout, KNOWN) as { grid: Record<string, unknown> };
    expect("maximizedNode" in out.grid).toBe(false);
    // The rest of the grid survives untouched.
    expect(out.grid.root).toEqual(layout.grid.root);
  });

  it("returns null when nothing usable remains or the shape is foreign", () => {
    const layout = {
      grid: { root: leaf("1", ["search"]) },
      panels: { search: panel("search") },
    };
    expect(sanitizeDockviewLayout(layout, KNOWN)).toBeNull();
    expect(sanitizeDockviewLayout(null, KNOWN)).toBeNull();
    expect(sanitizeDockviewLayout({ garbage: true }, KNOWN)).toBeNull();
  });
});

describe("substituteSlotPanels", () => {
  // Working Changes / Changed Files (and Diff / Merge) share one dock slot:
  // a layout naming one member means "the slot", and applying it must keep
  // the member currently showing - a selected commit's Changed Files stays
  // when the layout was saved with Working Changes, and vice versa.
  const leaf = (id: string, views: string[], activeView = views[0]) => ({
    type: "leaf",
    data: { views, activeView, id },
    size: 100,
  });
  const panel = (id: string) => ({ id, contentComponent: id, title: id });
  const wcLayout = () => ({
    grid: {
      root: {
        type: "branch",
        data: [leaf("1", ["log"]), leaf("2", ["working-changes", "diff"], "working-changes")],
        size: 200,
      },
    },
    panels: { log: panel("log"), "working-changes": panel("working-changes"), diff: panel("diff") },
    activeGroup: "2",
  });
  const open = (...ids: string[]) => (id: string) => ids.includes(id);

  it("declares the two slot pairs", () => {
    expect(SLOT_PAIRS).toContainEqual(["working-changes", "changed-files"]);
    expect(SLOT_PAIRS.some(([a, b]) =>
      (a === "diff" && b === "merge") || (a === "merge" && b === "diff"),
    )).toBe(true);
  });

  it("substitutes the saved member with the currently-showing one", () => {
    const out = substituteSlotPanels(wcLayout(), open("changed-files", "log")) as {
      grid: { root: { data: { data: { views: string[]; activeView: string } }[] } };
      panels: Record<string, { id: string; contentComponent: string; title?: string }>;
    };
    expect(Object.keys(out.panels).sort()).toEqual(["changed-files", "diff", "log"]);
    expect(out.panels["changed-files"].id).toBe("changed-files");
    expect(out.panels["changed-files"].contentComponent).toBe("changed-files");
    // The persisted title belongs to the replaced panel; sanitize (always run
    // after) injects the registry title.
    expect(out.panels["changed-files"].title).toBeUndefined();
    expect(out.grid.root.data[1].data.views).toEqual(["changed-files", "diff"]);
    expect(out.grid.root.data[1].data.activeView).toBe("changed-files");
  });

  it("substitutes in the other direction too", () => {
    const layout = {
      grid: { root: leaf("1", ["changed-files"]) },
      panels: { "changed-files": panel("changed-files") },
    };
    const out = substituteSlotPanels(layout, open("working-changes")) as {
      panels: Record<string, unknown>;
    };
    expect(Object.keys(out.panels)).toEqual(["working-changes"]);
  });

  it("keeps the saved member when it is itself the one showing", () => {
    const layout = wcLayout();
    expect(substituteSlotPanels(layout, open("working-changes", "log"))).toBe(layout);
  });

  it("does not substitute when the layout names both members", () => {
    const layout = {
      grid: { root: leaf("1", ["working-changes", "changed-files"]) },
      panels: {
        "working-changes": panel("working-changes"),
        "changed-files": panel("changed-files"),
      },
    };
    expect(substituteSlotPanels(layout, open("changed-files"))).toBe(layout);
  });

  it("does not substitute when neither or both members are currently open", () => {
    const layout = wcLayout();
    expect(substituteSlotPanels(layout, open("log"))).toBe(layout);
    expect(substituteSlotPanels(layout, open("working-changes", "changed-files"))).toBe(layout);
  });

  it("handles the Diff/Merge pair the same way", () => {
    const out = substituteSlotPanels(wcLayout(), open("working-changes", "merge")) as {
      grid: { root: { data: { data: { views: string[] } }[] } };
      panels: Record<string, unknown>;
    };
    expect(Object.keys(out.panels).sort()).toEqual(["log", "merge", "working-changes"]);
    expect(out.grid.root.data[1].data.views).toEqual(["working-changes", "merge"]);
  });

  it("passes foreign shapes through untouched", () => {
    expect(substituteSlotPanels(null, open("changed-files"))).toBeNull();
    const garbage = { garbage: true };
    expect(substituteSlotPanels(garbage, open("changed-files"))).toBe(garbage);
  });
});
