// @vitest-environment happy-dom
//
// The baked-in default layouts (captured from a live dockview, not built
// from the registry) must stay consistent with the panel registry: a panel
// rename/removal would otherwise break first launch and "Reset to default
// layout" silently, falling back to the programmatic builders at best.
import { describe, it, expect } from "vitest";
import { DEFAULT_GLOBAL_LAYOUT, DEFAULT_REPO_LAYOUT } from "./defaultLayouts";
import {
  GLOBAL_DOCKVIEW_TAB_COMPONENTS,
  GLOBAL_PANELS,
  REPO_DOCKVIEW_TAB_COMPONENTS,
  REPO_PANELS,
} from "./registry";

interface GridNode {
  type: string;
  data: GridNode[] | { views?: string[] };
}

function collectViews(node: GridNode, out: string[] = []): string[] {
  if (node.type === "leaf") {
    for (const v of (node.data as { views?: string[] }).views ?? []) out.push(v);
  } else {
    for (const child of node.data as GridNode[]) collectViews(child, out);
  }
  return out;
}

interface Layout {
  grid: { root: GridNode };
  panels: Record<string, { contentComponent?: string; tabComponent?: string }>;
}

function checkLayout(layout: Layout, panelIds: Set<string>, tabComponents: Set<string>) {
  const panelKeys = Object.keys(layout.panels);
  for (const id of panelKeys) {
    expect(panelIds, `panel "${id}" is not in the registry`).toContain(id);
    const p = layout.panels[id];
    expect(p.contentComponent).toBe(id);
    if (p.tabComponent !== undefined) {
      expect(tabComponents, `tab component "${p.tabComponent}"`).toContain(p.tabComponent);
    }
  }
  // Every view placed in the grid must have a panel entry, and vice versa.
  expect(collectViews(layout.grid.root).sort()).toEqual([...panelKeys].sort());
}

describe("DEFAULT_REPO_LAYOUT", () => {
  const ids = new Set(REPO_PANELS.map((p) => p.id));

  it("references only registered repo panels and tab components", () => {
    checkLayout(
      DEFAULT_REPO_LAYOUT.dockview as Layout,
      ids,
      new Set(Object.keys(REPO_DOCKVIEW_TAB_COMPONENTS)),
    );
  });

  it("placements and fallbacks only name registered panels", () => {
    for (const id of Object.keys(DEFAULT_REPO_LAYOUT.placements)) {
      expect(ids, `placement for "${id}"`).toContain(id);
    }
    for (const [id, pos] of Object.entries(DEFAULT_REPO_LAYOUT.fallbacks)) {
      expect(ids, `fallback for "${id}"`).toContain(id);
      expect(ids, `fallback reference "${pos.referencePanel}"`).toContain(pos.referencePanel);
    }
  });
});

describe("DEFAULT_GLOBAL_LAYOUT", () => {
  it("references only registered global panels and tab components", () => {
    checkLayout(
      DEFAULT_GLOBAL_LAYOUT as Layout,
      new Set(GLOBAL_PANELS.map((p) => p.id)),
      new Set(Object.keys(GLOBAL_DOCKVIEW_TAB_COMPONENTS)),
    );
  });
});
