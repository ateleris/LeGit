import { describe, expect, it } from "vitest";
import type { GroupItem, RepoGroupsDoc, RepoSummary } from "../../lib/types";
import {
  buildStripModel,
  classifyDrop,
  collectItemMeta,
  cssColorToHex,
  type DropItem,
  listGroups,
  MAX_GROUP_DEPTH,
  moveOpIndex,
  previewMove,
  visibleDepth,
} from "./stripModel";

function summary(locator: string): RepoSummary {
  return {
    id: `id-${locator}`,
    path: locator,
    name: locator,
    host: null,
    locator,
    watch_error: null,
  };
}
function repo(locator: string): GroupItem {
  return { kind: "repo", locator, remote_key: null };
}
function group(
  id: string,
  items: GroupItem[],
  opts: { collapsed?: boolean } = {},
): GroupItem {
  return {
    kind: "group",
    id,
    name: id,
    color: null,
    collapsed: opts.collapsed ?? false,
    items,
  };
}
const doc = (items: GroupItem[]): RepoGroupsDoc => ({ items });

describe("buildStripModel", () => {
  it("flat doc yields plain repo nodes (zero groups = today's strip)", () => {
    const nodes = buildStripModel(doc([repo("a"), repo("b")]), [summary("a"), summary("b")], null);
    expect(nodes).toHaveLength(2);
    expect(nodes.every((n) => n.kind === "repo" && n.depth === 0)).toBe(true);
  });

  it("zero-group strips follow the openRepos order, not the doc", () => {
    // The flat live drag-reorder previews through openRepos; a stale doc
    // (the backend folds order in asynchronously) must not override it.
    const nodes = buildStripModel(
      doc([repo("b"), repo("a")]),
      [summary("a"), summary("b")],
      null,
    );
    expect(nodes.map((n) => (n.kind === "repo" ? n.repo.locator : "?"))).toEqual(["a", "b"]);
  });

  it("carries per-repo color overrides from the doc", () => {
    const nodes = buildStripModel(
      doc([{ kind: "repo", locator: "a", remote_key: null, color: "#abc" }, repo("b")]),
      [summary("a"), summary("b")],
      null,
    );
    expect(nodes[0]).toMatchObject({ kind: "repo", color: "#abc" });
    expect(nodes[1]).toMatchObject({ kind: "repo", color: null });
  });

  it("appends open repos missing from the doc", () => {
    const nodes = buildStripModel(doc([repo("a")]), [summary("a"), summary("x")], null);
    expect(nodes).toHaveLength(2);
    expect(nodes[1]).toMatchObject({ kind: "repo", repo: { locator: "x" } });
  });

  it("closed members and all-closed groups render nothing", () => {
    const nodes = buildStripModel(
      doc([group("g1", [repo("a"), repo("closed")]), group("ghost", [repo("gone")])]),
      [summary("a")],
      null,
    );
    expect(nodes).toHaveLength(1);
    const g = nodes[0];
    if (g.kind !== "group") throw new Error("expected a group node");
    expect(g.group.id).toBe("g1");
    expect(g.children).toHaveLength(1);
  });

  it("collapsed group reports open count, active containment, and keeps children", () => {
    const nodes = buildStripModel(
      doc([group("g1", [repo("a"), group("g2", [repo("b")])], { collapsed: true })]),
      [summary("a"), summary("b")],
      "id-b",
    );
    const g = nodes[0];
    if (g.kind !== "group") throw new Error("expected a group node");
    // children stay in the model (the renderer hides them; depth math needs them)
    expect(g.children).toHaveLength(2);
    expect(g.openCount).toBe(2);
    expect(g.containsActive).toBe(true);
  });
});

describe("visibleDepth", () => {
  it("never changes when groups collapse (collapse keeps every height)", () => {
    const open = [summary("a"), summary("b"), summary("c")];
    const depthOf = (items: GroupItem[]) =>
      visibleDepth(buildStripModel(doc(items), open, null));
    expect(depthOf([group("g1", [repo("a"), group("g2", [repo("b")])]), repo("c")])).toBe(2);
    expect(
      depthOf([group("g1", [repo("a"), group("g2", [repo("b")], { collapsed: true })]), repo("c")]),
    ).toBe(2);
    expect(
      depthOf([group("g1", [repo("a"), group("g2", [repo("b")])], { collapsed: true }), repo("c")]),
    ).toBe(2);
    expect(depthOf([repo("c")])).toBe(0);
  });
});

describe("collectItemMeta / listGroups", () => {
  it("reports doc indices, depth and subtree depth per item", () => {
    const d = doc([
      repo("a"),
      group("g1", [repo("closed"), repo("b"), group("g2", [repo("c")])]),
    ]);
    const meta = collectItemMeta(d);
    expect(meta.get("repo:a")).toEqual({ parentId: null, index: 0, depth: 0, subtreeDepth: 0 });
    expect(meta.get("group:g1")).toEqual({ parentId: null, index: 1, depth: 0, subtreeDepth: 2 });
    // doc index 1: the closed member before it still counts
    expect(meta.get("repo:b")).toEqual({ parentId: "g1", index: 1, depth: 1, subtreeDepth: 0 });
    expect(meta.get("group:g2")).toEqual({ parentId: "g1", index: 2, depth: 1, subtreeDepth: 1 });
    expect(meta.get("repo:c")).toEqual({ parentId: "g2", index: 0, depth: 2, subtreeDepth: 0 });
    expect(listGroups(d)).toEqual([
      { id: "g1", name: "g1" },
      { id: "g2", name: "g2" },
    ]);
  });
});

describe("previewMove / moveOpIndex", () => {
  const locs = (d: RepoGroupsDoc): string[] => {
    const out: string[] = [];
    const walk = (items: GroupItem[]) => {
      for (const it of items) {
        if (it.kind === "repo") {
          if (it.locator) out.push(it.locator);
        } else walk(it.items);
      }
    };
    walk(d.items);
    return out;
  };

  it("moves within a parent with the item-in-place index convention", () => {
    const d = doc([repo("a"), repo("b"), repo("c")]);
    // a into the b|c gap: index 2 counted with a still in place
    expect(locs(previewMove(d, { kind: "repo", locator: "a" }, null, 2))).toEqual(["b", "a", "c"]);
    expect(locs(previewMove(d, { kind: "repo", locator: "c" }, null, 0))).toEqual(["c", "a", "b"]);
  });

  it("moves across parents and keeps emptied groups until the drop", () => {
    const d = doc([group("g1", [repo("a")]), repo("b")]);
    const out = previewMove(d, { kind: "repo", locator: "a" }, null, 2);
    expect(locs(out)).toEqual(["b", "a"]);
    // the emptied group stays as a placeholder (and keeps indices aligned
    // with the backend, which dissolves it only in the final normalize)
    expect(out.items[0]).toMatchObject({ kind: "group", id: "g1", items: [] });
    const into = previewMove(doc([group("g1", [repo("a")]), repo("b")]), { kind: "repo", locator: "b" }, "g1", 0);
    expect(locs(into)).toEqual(["b", "a"]);
  });

  it("buildStripModel renders a structurally empty group (preview state)", () => {
    const nodes = buildStripModel(doc([group("g1", []), repo("b")]), [summary("b")], null);
    expect(nodes).toHaveLength(2);
    expect(nodes[0]).toMatchObject({ kind: "group", openCount: 0, children: [] });
  });

  it("moveOpIndex converts a preview position into the backend's convention", () => {
    const orig = { parentId: null, index: 0, depth: 0, subtreeDepth: 0 };
    // same-parent forward: backend subtracts one, so send final + 1
    expect(moveOpIndex(orig, null, 1)).toBe(2);
    // backward and cross-parent: send the final index as-is
    expect(moveOpIndex({ ...orig, index: 2 }, null, 0)).toBe(0);
    expect(moveOpIndex(orig, "g1", 3)).toBe(3);
  });
});

describe("cssColorToHex", () => {
  it("normalizes computed-style and hex colors to #rrggbb", () => {
    expect(cssColorToHex("rgb(74, 158, 255)")).toBe("#4a9eff");
    expect(cssColorToHex("rgba(74, 158, 255, 0.13)")).toBe("#4a9eff");
    expect(cssColorToHex("#4a9eff22")).toBe("#4a9eff");
    expect(cssColorToHex("#abc")).toBe("#aabbcc");
    expect(cssColorToHex("transparent")).toBe(null);
  });
});

describe("classifyDrop", () => {
  // Two root tabs (a at 0-100, b at 110-210) and one root group g1
  // (220-320) whose own subtree is 1 deep.
  const items: DropItem[] = [
    { ref: { kind: "repo", locator: "a" }, left: 0, width: 100, parentId: null, index: 0, depth: 0, isGroup: false, subtreeDepth: 0 },
    { ref: { kind: "repo", locator: "b" }, left: 110, width: 100, parentId: null, index: 1, depth: 0, isGroup: false, subtreeDepth: 0 },
    { ref: { kind: "group", id: "g1" }, left: 220, width: 100, parentId: null, index: 2, depth: 0, isGroup: true, subtreeDepth: 1 },
  ];
  const dragged = { draggedRef: { kind: "repo", locator: "z" } as const, draggedSubtreeDepth: 0 };

  it("center dwell merges", () => {
    expect(
      classifyDrop({ pointerX: 50, items, dwellSatisfied: true, ...dragged }),
    ).toEqual({ kind: "merge", target: { kind: "repo", locator: "a" } });
  });

  it("fast pass through the center inserts", () => {
    const r = classifyDrop({ pointerX: 50, items, dwellSatisfied: false, ...dragged });
    expect(r.kind).toBe("insert");
  });

  it("at the depth cap the merge is never offered", () => {
    // target "a" sits at depth MAX-1 inside nested groups: merging would
    // create a group at depth MAX+... -> insert instead, despite the dwell.
    const deep: DropItem[] = [
      { ref: { kind: "repo", locator: "a" }, left: 0, width: 100, parentId: "g3", index: 0, depth: MAX_GROUP_DEPTH, isGroup: false, subtreeDepth: 0 },
    ];
    const r = classifyDrop({ pointerX: 50, items: deep, dwellSatisfied: true, ...dragged });
    expect(r.kind).toBe("insert");
  });

  it("rejects the dragged item's own descendants as merge targets", () => {
    const tree: DropItem[] = [
      { ref: { kind: "group", id: "g1" }, left: 0, width: 300, parentId: null, index: 0, depth: 0, isGroup: true, subtreeDepth: 1 },
      { ref: { kind: "repo", locator: "inner" }, left: 100, width: 100, parentId: "g1", index: 0, depth: 1, isGroup: false, subtreeDepth: 0 },
    ];
    const r = classifyDrop({
      pointerX: 150,
      items: tree,
      dwellSatisfied: true,
      draggedRef: { kind: "group", id: "g1" },
      draggedSubtreeDepth: 1,
    });
    expect(r.kind).toBe("insert");
  });

  it("groups are never merge targets - dwelling on one still inserts", () => {
    // items[2] is the group g1 (220-320): center + dwell must not offer the
    // confusing "wrap us both in a new group".
    const r = classifyDrop({ pointerX: 270, items, dwellSatisfied: true, ...dragged });
    expect(r.kind).toBe("insert");
  });

  it("an empty group under the pointer is entered, never merged with", () => {
    const emptyGroup: DropItem[] = [
      { ref: { kind: "group", id: "g1" }, left: 0, width: 120, parentId: null, index: 0, depth: 0, isGroup: true, subtreeDepth: 1, isEmpty: true },
    ];
    for (const dwellSatisfied of [true, false]) {
      expect(classifyDrop({ pointerX: 60, items: emptyGroup, dwellSatisfied, ...dragged })).toEqual(
        { kind: "insert", parentId: "g1", index: 0 },
      );
    }
  });

  it("a group's inner inset targets INSIDE the group at the nearest gap", () => {
    // G1 (0-300, root) holds a tab (40-260, doc index 0): the inset
    // corridors mean inside-the-group; outside the rect means beside it.
    const nested: DropItem[] = [
      { ref: { kind: "group", id: "g1" }, left: 0, width: 300, parentId: null, index: 0, depth: 0, isGroup: true, subtreeDepth: 1 },
      { ref: { kind: "repo", locator: "a" }, left: 40, width: 220, parentId: "g1", index: 0, depth: 1, isGroup: false, subtreeDepth: 0 },
    ];
    expect(classifyDrop({ pointerX: 10, items: nested, dwellSatisfied: false, ...dragged })).toEqual(
      { kind: "insert", parentId: "g1", index: 0 },
    );
    expect(classifyDrop({ pointerX: 290, items: nested, dwellSatisfied: false, ...dragged })).toEqual(
      { kind: "insert", parentId: "g1", index: 1 },
    );
    expect(classifyDrop({ pointerX: 310, items: nested, dwellSatisfied: false, ...dragged })).toEqual(
      { kind: "insert", parentId: null, index: 1 },
    );
  });

  it("a dragged GROUP never targets the inside of another group at the cap", () => {
    // g1 (root) wraps a tab; dragging a group over g1's inset must insert
    // BESIDE g1, since nesting it would exceed MAX_GROUP_DEPTH.
    const nested: DropItem[] = [
      { ref: { kind: "group", id: "g1" }, left: 0, width: 300, parentId: null, index: 1, depth: 0, isGroup: true, subtreeDepth: 1 },
      { ref: { kind: "repo", locator: "a" }, left: 40, width: 220, parentId: "g1", index: 0, depth: 1, isGroup: false, subtreeDepth: 0 },
    ];
    const r = classifyDrop({
      pointerX: 10,
      items: nested,
      dwellSatisfied: false,
      draggedRef: { kind: "group", id: "g2" },
      draggedSubtreeDepth: MAX_GROUP_DEPTH,
    });
    expect(r).toEqual({ kind: "insert", parentId: null, index: 1 });
  });

  it("a dragged GROUP over a member tab climbs out to beside the group", () => {
    // Hovering g1's member tab must not preview nesting: the target climbs
    // to g1's own level.
    const nested: DropItem[] = [
      { ref: { kind: "group", id: "g1" }, left: 0, width: 300, parentId: null, index: 1, depth: 0, isGroup: true, subtreeDepth: 1 },
      { ref: { kind: "repo", locator: "a" }, left: 40, width: 220, parentId: "g1", index: 0, depth: 1, isGroup: false, subtreeDepth: 0 },
    ];
    const drag = { draggedRef: { kind: "group", id: "g2" } as const, draggedSubtreeDepth: 1 };
    // left half of the tab -> before g1; right half -> after g1
    expect(classifyDrop({ pointerX: 60, items: nested, dwellSatisfied: false, ...drag })).toEqual(
      { kind: "insert", parentId: null, index: 1 },
    );
    expect(classifyDrop({ pointerX: 250, items: nested, dwellSatisfied: false, ...drag })).toEqual(
      { kind: "insert", parentId: null, index: 2 },
    );
  });

  it("a collapsed group (no visible children) still means beside it", () => {
    const collapsed: DropItem[] = [
      { ref: { kind: "group", id: "g1" }, left: 0, width: 100, parentId: null, index: 0, depth: 0, isGroup: true, subtreeDepth: 1 },
    ];
    const r = classifyDrop({ pointerX: 20, items: collapsed, dwellSatisfied: false, ...dragged });
    expect(r).toEqual({ kind: "insert", parentId: null, index: 0 });
  });

  it("inserts into the gap between two tabs", () => {
    const r = classifyDrop({ pointerX: 105, items, dwellSatisfied: true, ...dragged });
    expect(r).toEqual({ kind: "insert", parentId: null, index: 1 });
  });
});
