// Pure strip-model logic for repo tab groups: what the strip renders
// (buildStripModel), how tall it is (visibleDepth), and what a drag pointer
// means (classifyDrop). No DOM, no store - unit-tested in stripModel.test.ts.
// See design/2026-10-16-repository-groups.md.

import type { ItemRef, RepoGroup, RepoGroupsDoc, RepoSummary } from "../../lib/types";

/** Mirrors MAX_GROUP_DEPTH in src-tauri/src/repo_groups.rs (the enforcement
 * authority); this copy only gates drag previews. */
export const MAX_GROUP_DEPTH = 1;

/** MoveItem index meaning "at the parent's end" (u32::MAX; the backend
 * clamps to the list length). */
export const APPEND_AT_END = 4294967295;

export type StripNode =
  | {
      kind: "repo";
      repo: RepoSummary;
      depth: number;
      /** Per-repo tab color override from the doc (null = theme colors). */
      color: string | null;
    }
  | {
      kind: "group";
      group: RepoGroup;
      depth: number;
      /** Always populated, collapsed or not: the renderer hides them while
       * collapsed, but the height math needs the subtree. */
      children: StripNode[];
      openCount: number;
      containsActive: boolean;
    };

export function buildStripModel(
  doc: RepoGroupsDoc,
  openRepos: RepoSummary[],
  activeRepoId: string | null,
): StripNode[] {
  // `locator` is generated as optional (serde default) but every summary
  // carries one; a summary without it can only render via the append below.
  // With zero groups the strip is exactly the flat tab bar: openRepos (the
  // live store order, incl. the drag-reorder preview) is authoritative and a
  // stale doc order must not override it.
  if (doc.items.every((it) => it.kind === "repo")) {
    const colorOf = new Map<string, string | null>();
    for (const it of doc.items) {
      if (it.kind === "repo" && it.locator != null) colorOf.set(it.locator, it.color ?? null);
    }
    return openRepos.map((repo) => ({
      kind: "repo",
      repo,
      depth: 0,
      color: (repo.locator != null ? colorOf.get(repo.locator) : null) ?? null,
    }));
  }

  const byLocator = new Map<string, RepoSummary>();
  for (const r of openRepos) {
    if (r.locator) byLocator.set(r.locator, r);
  }
  const seen = new Set<string>();

  const walk = (items: RepoGroupsDoc["items"], depth: number): StripNode[] => {
    const nodes: StripNode[] = [];
    for (const it of items) {
      if (it.kind === "repo") {
        const repo = it.locator != null ? byLocator.get(it.locator) : undefined;
        if (it.locator != null && repo) {
          seen.add(it.locator);
          nodes.push({ kind: "repo", repo, depth, color: it.color ?? null });
        }
      } else {
        const children = walk(it.items, depth + 1);
        let openCount = 0;
        let containsActive = false;
        for (const c of children) {
          if (c.kind === "repo") {
            openCount += 1;
            containsActive ||= c.repo.id === activeRepoId;
          } else {
            openCount += c.openCount;
            containsActive ||= c.containsActive;
          }
        }
        // An all-closed group is a ghost: it exists and syncs, but renders
        // nowhere until a member reopens. A group with NO items at all only
        // exists in drag previews (normalize dissolves them on commit) and
        // stays visible until the drop.
        if (openCount === 0 && it.items.length > 0) continue;
        nodes.push({
          kind: "group",
          group: it,
          depth,
          children,
          openCount,
          containsActive,
        });
      }
    }
    return nodes;
  };

  const nodes = walk(doc.items, 0);
  // A just-opened repo may not be in the doc yet (the backend folds it in
  // asynchronously): it still renders, at the strip's end.
  for (const r of openRepos) {
    if (!r.locator || !seen.has(r.locator)) {
      nodes.push({ kind: "repo", repo: r, depth: 0, color: null });
    }
  }
  return nodes;
}

/** Header bands a node subtree occupies. Collapse NEVER changes a group's
 * height (a collapsed depth-2 group stays depth-2 tall), so this is the
 * structural depth of the rendered groups, collapse-independent. */
export function visibleDepth(nodes: StripNode[]): number {
  let depth = 0;
  for (const n of nodes) {
    if (n.kind === "group") {
      depth = Math.max(depth, 1 + visibleDepth(n.children));
    }
  }
  return depth;
}

export type DropTarget =
  | { kind: "insert"; parentId: string | null; index: number }
  | { kind: "merge"; target: ItemRef };

export interface DropItem {
  ref: ItemRef;
  left: number;
  width: number;
  /** Enclosing group id; null at root. */
  parentId: string | null;
  /** Index within the parent's rendered item list. */
  index: number;
  /** Ancestor group count (0 = root). */
  depth: number;
  isGroup: boolean;
  /** subtree_group_depth, as in the Rust module: 0 for a repo, 1 + deepest
   * child group level for a group. */
  subtreeDepth: number;
  /** A group with no items at all (a drag preview's kept placeholder). */
  isEmpty?: boolean;
}

/** Stable map key for an ItemRef. */
export function refKey(ref: ItemRef): string {
  return ref.kind === "repo" ? `repo:${ref.locator}` : `group:${ref.id}`;
}

export interface ItemMeta {
  parentId: string | null;
  /** Index within the parent's DOC item list (closed members count). */
  index: number;
  /** Ancestor group count (0 = root). */
  depth: number;
  /** subtree_group_depth: 0 for a repo, 1 + deepest child group for a group. */
  subtreeDepth: number;
}

/** Doc-position metadata for every addressable item, keyed by refKey. */
export function collectItemMeta(doc: RepoGroupsDoc): Map<string, ItemMeta> {
  const out = new Map<string, ItemMeta>();
  const subtree = (it: RepoGroupsDoc["items"][number]): number =>
    it.kind === "repo" ? 0 : 1 + Math.max(0, ...it.items.map(subtree));
  const walk = (
    items: RepoGroupsDoc["items"],
    parentId: string | null,
    depth: number,
  ): void => {
    items.forEach((it, index) => {
      const key =
        it.kind === "repo"
          ? it.locator != null
            ? `repo:${it.locator}`
            : null
          : `group:${it.id}`;
      if (key != null) {
        out.set(key, { parentId, index, depth, subtreeDepth: subtree(it) });
      }
      if (it.kind === "group") walk(it.items, it.id, depth + 1);
    });
  };
  walk(doc.items, null, 0);
  return out;
}

/** All groups in the doc, depth-first (for the "Move to group" menu). */
export function listGroups(doc: RepoGroupsDoc): Array<{ id: string; name: string }> {
  const out: Array<{ id: string; name: string }> = [];
  const walk = (items: RepoGroupsDoc["items"]): void => {
    for (const it of items) {
      if (it.kind === "group") {
        out.push({ id: it.id, name: it.name });
        walk(it.items);
      }
    }
  };
  walk(doc.items);
  return out;
}

/** A computed-style color (functional r-g-b notation or hex, user data from
 * a group override or getComputedStyle, never a theme literal) normalized to
 * the six-digit hex the native color input needs; null when unparseable. */
export function cssColorToHex(color: string): string | null {
  const c = color.trim();
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(c);
  const channel = (n: number) => Math.min(255, n).toString(16).padStart(2, "0");
  if (rgb) {
    return `#${channel(Number(rgb[1]))}${channel(Number(rgb[2]))}${channel(Number(rgb[3]))}`;
  }
  const hex = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.exec(c);
  if (!hex) return null;
  const h = hex[1];
  if (h.length === 3) {
    return `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`.toLowerCase();
  }
  return `#${h.slice(0, 6)}`.toLowerCase();
}

/** The doc as it would look after MoveItem - the live drag preview. Mirrors
 * the backend's convention: `index` counts the parent's items with the moved
 * item still in place. An emptied group is KEPT (it dissolves only when the
 * drop commits), which also keeps preview indices aligned with the backend's
 * (the empty group still occupies its slot during the real insert). */
export function previewMove(
  doc: RepoGroupsDoc,
  ref: ItemRef,
  parentId: string | null,
  index: number,
): RepoGroupsDoc {
  type Item = RepoGroupsDoc["items"][number];
  const isRef = (it: Item) =>
    it.kind === "repo"
      ? ref.kind === "repo" && it.locator === ref.locator
      : ref.kind === "group" && it.id === ref.id;

  let removed: Item | undefined;
  let origParent: string | null | undefined;
  let origIndex = 0;
  const strip = (items: Item[], parent: string | null): Item[] =>
    items
      .map((it): Item | null => {
        if (isRef(it)) {
          removed = it;
          origParent = parent;
          origIndex = items.indexOf(it);
          return null;
        }
        return it.kind === "group" ? { ...it, items: strip(it.items, it.id) } : it;
      })
      .filter((it): it is Item => it !== null);

  let items = strip(doc.items, null);
  if (!removed) return doc;
  let at = index;
  if (origParent === parentId && origIndex < index) at -= 1;

  const insert = (items: Item[], parent: string | null): Item[] => {
    if (parent === parentId) {
      const next = items.slice();
      next.splice(Math.min(Math.max(at, 0), next.length), 0, removed as Item);
      return next;
    }
    return items.map((it) =>
      it.kind === "group" ? { ...it, items: insert(it.items, it.id) } : it,
    );
  };
  items = insert(items, null);
  return { items };
}

/** The index to SEND for a MoveItem landing the item at (finalParent,
 * finalIndex) as seen in the preview: the backend decrements same-parent
 * forward moves, so those are sent one higher. */
export function moveOpIndex(
  orig: ItemMeta,
  finalParent: string | null,
  finalIndex: number,
): number {
  return orig.parentId === finalParent && finalIndex > orig.index ? finalIndex + 1 : finalIndex;
}

function sameRef(a: ItemRef, b: ItemRef): boolean {
  return (
    (a.kind === "repo" && b.kind === "repo" && a.locator === b.locator) ||
    (a.kind === "group" && b.kind === "group" && a.id === b.id)
  );
}

export function classifyDrop(args: {
  pointerX: number;
  /** The visible, hit-testable strip items, left-to-right (the dragged item
   * excluded). */
  items: DropItem[];
  dwellSatisfied: boolean;
  draggedRef: ItemRef;
  /** subtree_group_depth of the dragged item (0 repo, >=1 group). */
  draggedSubtreeDepth: number;
}): DropTarget {
  const { pointerX, items, dwellSatisfied, draggedRef, draggedSubtreeDepth } = args;

  const parentOf = new Map<string, string | null>();
  for (const it of items) {
    if (it.ref.kind === "group") parentOf.set(it.ref.id, it.parentId);
  }
  const isInsideDragged = (it: DropItem): boolean => {
    if (draggedRef.kind !== "group") return false;
    let p = it.parentId;
    while (p != null) {
      if (p === draggedRef.id) return true;
      p = parentOf.get(p) ?? null;
    }
    return false;
  };

  // Innermost item under the pointer (a group container overlaps its members).
  const under = items
    .filter((it) => pointerX >= it.left && pointerX < it.left + it.width)
    .sort((a, b) => b.depth - a.depth)[0];

  // Whether the dragged item may live INSIDE `group` without busting the cap.
  const fitsInside = (group: DropItem) =>
    group.depth + 1 + draggedSubtreeDepth <= MAX_GROUP_DEPTH;

  // An emptied group kept by the drag preview: dropping on it means "put the
  // item (back) inside", never "merge with the placeholder".
  if (under?.isEmpty && under.ref.kind === "group" && fitsInside(under)) {
    return { kind: "insert", parentId: under.ref.id, index: 0 };
  }

  // Only repo tabs are merge targets: dwelling on a group must not wrap the
  // group and the dragged item in a confusing new parent.
  if (under && dwellSatisfied && !under.isGroup) {
    const inCenter =
      pointerX >= under.left + under.width * 0.25 && pointerX < under.left + under.width * 0.75;
    const depthOk =
      under.depth + 1 + Math.max(under.subtreeDepth, draggedSubtreeDepth) <= MAX_GROUP_DEPTH;
    if (
      inCenter &&
      depthOk &&
      !sameRef(under.ref, draggedRef) &&
      !isInsideDragged(under)
    ) {
      return { kind: "merge", target: under.ref };
    }
  }

  if (under) {
    // Inside a group's rect but not over a child (its inner insets, header
    // area, or the gaps between members): insert INSIDE the group at the
    // nearest gap, so nested boundaries peel one level per edge crossed. A
    // collapsed group shows no children and keeps meaning "beside it".
    if (under.isGroup && fitsInside(under)) {
      const children = items
        .filter((it) => it.parentId === (under.ref as { id: string }).id)
        .sort((a, b) => a.left - b.left);
      if (children.length > 0) {
        let index = children[0].index;
        for (const c of children) {
          if (pointerX >= c.left + c.width / 2) index = c.index + 1;
        }
        return { kind: "insert", parentId: (under.ref as { id: string }).id, index };
      }
    }
    const before = pointerX < under.left + under.width / 2;
    let target = {
      parentId: under.parentId,
      index: before ? under.index : under.index + 1,
    };
    // Climb out of any enclosing group the dragged item cannot legally live
    // in (a dragged GROUP over a member tab must land BESIDE the group, not
    // nested inside it).
    const groupById = new Map(
      items
        .filter((it) => it.ref.kind === "group")
        .map((it) => [(it.ref as { id: string }).id, it] as const),
    );
    while (target.parentId != null) {
      const parent = groupById.get(target.parentId);
      if (!parent || fitsInside(parent)) break;
      target = {
        parentId: parent.parentId,
        index:
          pointerX < parent.left + parent.width / 2 ? parent.index : parent.index + 1,
      };
    }
    return { kind: "insert", ...target };
  }

  // In a gap (or past the ends): insert among the ROOT items.
  const roots = items.filter((it) => it.parentId === null);
  let index = 0;
  for (const it of roots) {
    if (pointerX >= it.left + it.width / 2) index = it.index + 1;
  }
  return { kind: "insert", parentId: null, index };
}
