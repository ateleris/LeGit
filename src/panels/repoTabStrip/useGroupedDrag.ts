// The group-aware drag machine: live preview (the strip rearranges as if the
// drop already landed), center-dwell merge with highlight, and the stability
// stack - pointer-travel hysteresis, rest-settle, anti-bounce, and group
// containment. Pure logic lives in stripModel.ts; this hook owns the pointer
// lifecycle and the preview state. RepoTabBar assigns `layout.current` every
// render, AFTER deriving the display doc from `previewDoc`.

import { useLayoutEffect, useRef, useState } from "react";
import type { ItemRef, RepoGroupsDoc, RepoGroupsOp, RepoSummary } from "../../lib/types";
import {
  classifyDrop,
  collectItemMeta,
  type DropItem,
  type ItemMeta,
  listGroups,
  moveOpIndex,
  previewMove,
  refKey,
  type StripNode,
} from "./stripModel";

export const DRAG_THRESHOLD = 4; // px before a press becomes a drag
export const MERGE_DWELL_MS = 350; // center-zone rest before a drop means "group up"
// Hysteresis for the live preview: a re-layout shifts the snap zones under a
// stationary pointer, so only pointer TRAVEL since the last applied move may
// trigger the next one - never the layout shift itself (no cascades).
export const REARRANGE_HYSTERESIS = 16; // px
const SETTLE_MS = 150; // rest before a hysteresis-suppressed target applies

export interface DragLayout {
  stripNodes: StripNode[];
  renderMeta: Map<string, ItemMeta>;
  displayDoc: RepoGroupsDoc;
  groupsDoc: RepoGroupsDoc;
  openRepos: RepoSummary[];
}

export function useGroupedDrag(deps: {
  tabEls: React.MutableRefObject<Map<string, HTMLDivElement>>;
  groupEls: React.MutableRefObject<Map<string, HTMLDivElement>>;
  applyOp: (op: RepoGroupsOp) => Promise<RepoGroupsDoc | null>;
  /** Focus the fresh group's rename input after a merge created it. */
  onGroupCreated: (id: string) => void;
  /** Suppress the click that belongs to a finished drag. */
  onDragEnd: () => void;
  isRenaming: () => boolean;
}) {
  const { tabEls, groupEls, applyOp, onGroupCreated, onDragEnd, isRenaming } = deps;
  const layout = useRef<DragLayout>({
    stripNodes: [],
    renderMeta: new Map(),
    displayDoc: { items: [] },
    groupsDoc: { items: [] },
    openRepos: [],
  });

  const [draggingKey, setDraggingKey] = useState<string | null>(null);
  const [mergeTarget, setMergeTarget] = useState<ItemRef | null>(null);
  /** The doc as if the pending insert already happened; rendered in place of
   * the store doc while dragging. */
  const [previewDoc, setPreviewDoc] = useState<RepoGroupsDoc | null>(null);
  /** The dragged element follows the pointer while its layout slot holds the
   * space (same feel as the flat reorder). */
  const [floatX, setFloatX] = useState(0);
  const floatXRef = useRef(0);
  const desiredClientLeftRef = useRef(0);

  const elForKey = (key: string): HTMLElement | undefined => {
    if (key.startsWith("group:")) return groupEls.current.get(key.slice("group:".length));
    const locator = key.slice("repo:".length);
    const repo = layout.current.openRepos.find((r) => r.locator === locator);
    return repo ? tabEls.current.get(repo.id) : undefined;
  };

  // The preview re-layout moves the dragged element's base position; recompute
  // the follow offset against the new layout before paint (in client space,
  // because groups nest positioned ancestors).
  useLayoutEffect(() => {
    if (!draggingKey) return;
    const el = elForKey(draggingKey);
    if (!el) return;
    const base = el.getBoundingClientRect().left - floatXRef.current;
    const next = desiredClientLeftRef.current - base;
    floatXRef.current = next;
    setFloatX(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewDoc, draggingKey]);

  const beginItemDrag = (e: React.PointerEvent, ref: ItemRef) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest(".legit-tab__close")) return;
    if (isRenaming()) return;
    const draggedKey = refKey(ref);
    const draggedMeta = layout.current.renderMeta.get(draggedKey);
    if (!draggedMeta) return;
    const groupsDoc = layout.current.groupsDoc;
    const info = {
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
      lastX: e.clientX,
      dwellKey: null as string | null,
      dwellSince: 0,
      mergeTarget: null as ItemRef | null,
      lastAppliedX: null as number | null,
      prevSlot: null as string | null,
    };
    let dwellTimer: ReturnType<typeof setTimeout> | null = null;
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    const grabOffset =
      e.clientX - (elForKey(draggedKey)?.getBoundingClientRect().left ?? e.clientX);

    const collectItems = (): DropItem[] => {
      const items: DropItem[] = [];
      const meta = layout.current.renderMeta;
      const visit = (nodes: StripNode[]) => {
        for (const n of nodes) {
          const r: ItemRef =
            n.kind === "repo"
              ? { kind: "repo", locator: n.repo.locator ?? "" }
              : { kind: "group", id: n.group.id };
          const key = refKey(r);
          if (key === draggedKey) continue; // the dragged subtree is no target
          const el =
            n.kind === "repo" ? tabEls.current.get(n.repo.id) : groupEls.current.get(n.group.id);
          const m = meta.get(key);
          if (el && m) {
            const rect = el.getBoundingClientRect();
            items.push({
              ref: r,
              left: rect.left,
              width: rect.width,
              parentId: m.parentId,
              index: m.index,
              depth: m.depth,
              isGroup: n.kind === "group",
              subtreeDepth: m.subtreeDepth,
              isEmpty: n.kind === "group" && n.group.items.length === 0,
            });
          }
          if (n.kind === "group") visit(n.children);
        }
      };
      visit(layout.current.stripNodes);
      return items;
    };

    const evaluate = (fromSettle = false) => {
      if (dwellTimer) {
        clearTimeout(dwellTimer);
        dwellTimer = null;
      }
      if (settleTimer) {
        clearTimeout(settleTimer);
        settleTimer = null;
      }
      const base = {
        pointerX: info.lastX,
        items: collectItems(),
        draggedRef: ref,
        draggedSubtreeDepth: draggedMeta.subtreeDepth,
      };
      const probe = classifyDrop({ ...base, dwellSatisfied: true });
      const candidate = probe.kind === "merge" ? refKey(probe.target) : null;
      const now = performance.now();
      if (candidate !== info.dwellKey) {
        info.dwellKey = candidate;
        info.dwellSince = now;
      }
      const dwellOk = candidate != null && now - info.dwellSince >= MERGE_DWELL_MS;
      if (dwellOk && probe.kind === "merge") {
        // Group formation keeps the highlight; the layout freezes meanwhile.
        info.mergeTarget = probe.target;
        setMergeTarget(probe.target);
      } else {
        info.mergeTarget = null;
        setMergeTarget(null);
        const result = classifyDrop({ ...base, dwellSatisfied: false });
        if (result.kind === "insert") {
          const meta = layout.current.renderMeta;
          const cur = meta.get(draggedKey);
          // A group that grew to make space keeps the item until the pointer
          // actually LEAVES its bounds: a target outside an enclosing group
          // is ignored while the pointer is still inside that group's rect.
          if (cur) {
            const within = (parentId: string | null, groupId: string): boolean => {
              let p = parentId;
              while (p != null) {
                if (p === groupId) return true;
                p = meta.get(`group:${p}`)?.parentId ?? null;
              }
              return false;
            };
            let anchor = cur.parentId;
            while (anchor != null) {
              const el = groupEls.current.get(anchor);
              if (el) {
                const r = el.getBoundingClientRect();
                if (
                  info.lastX >= r.left &&
                  info.lastX < r.right &&
                  !within(result.parentId, anchor)
                ) {
                  return;
                }
              }
              anchor = meta.get(`group:${anchor}`)?.parentId ?? null;
            }
          }
          const same =
            cur != null &&
            result.parentId === cur.parentId &&
            (result.index === cur.index || result.index === cur.index + 1);
          const travelled =
            fromSettle ||
            info.lastAppliedX == null ||
            Math.abs(info.lastX - info.lastAppliedX) >= REARRANGE_HYSTERESIS;
          const slotKey = `${result.parentId}:${result.index}`;
          // Settling may never bounce the item back into the slot it just
          // left: that re-target comes from the layout shift, not intent.
          const bounced = fromSettle && slotKey === info.prevSlot;
          if (!same && travelled && !bounced) {
            info.prevSlot = cur ? `${cur.parentId}:${cur.index}` : null;
            info.lastAppliedX = info.lastX;
            setPreviewDoc(
              previewMove(layout.current.displayDoc, ref, result.parentId, result.index),
            );
          } else if (!same && !travelled && slotKey !== info.prevSlot) {
            // Suppressed by hysteresis: a resting pointer still reaches the
            // slot after a short settle.
            settleTimer = setTimeout(() => evaluate(true), SETTLE_MS);
          }
        }
      }
      // A resting pointer still completes the dwell.
      if (candidate != null && !dwellOk) {
        dwellTimer = setTimeout(evaluate, MERGE_DWELL_MS - (now - info.dwellSince) + 10);
      }
    };

    const onMove = (ev: PointerEvent) => {
      if (!info.moved) {
        if (
          Math.abs(ev.clientX - info.startX) < DRAG_THRESHOLD &&
          Math.abs(ev.clientY - info.startY) < DRAG_THRESHOLD
        ) {
          return;
        }
        info.moved = true;
        setDraggingKey(draggedKey);
      }
      info.lastX = ev.clientX;
      // Follow the pointer: translate relative to the element's current
      // layout slot (which the live preview moves underneath it).
      desiredClientLeftRef.current = ev.clientX - grabOffset;
      const el = elForKey(draggedKey);
      if (el) {
        const base = el.getBoundingClientRect().left - floatXRef.current;
        const next = desiredClientLeftRef.current - base;
        floatXRef.current = next;
        setFloatX(next);
      }
      evaluate();
    };

    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      if (dwellTimer) clearTimeout(dwellTimer);
      if (settleTimer) clearTimeout(settleTimer);
      setDraggingKey(null);
      setMergeTarget(null);
      floatXRef.current = 0;
      setFloatX(0);
      if (!info.moved) {
        setPreviewDoc(null);
        return;
      }
      onDragEnd();
      if (info.mergeTarget) {
        const target = info.mergeTarget;
        const before = new Set(listGroups(groupsDoc).map((g) => g.id));
        void applyOp({ op: "merge_into_group", dragged: ref, target })
          .then((doc) => {
            const created = doc && listGroups(doc).find((g) => !before.has(g.id));
            if (created) onGroupCreated(created.id);
          })
          .finally(() => setPreviewDoc(null));
        return;
      }
      // Commit the previewed position (converted to the backend's
      // item-still-in-place index convention).
      const orig = collectItemMeta(groupsDoc).get(draggedKey);
      const fin = collectItemMeta(layout.current.displayDoc).get(draggedKey);
      if (orig && fin && (fin.parentId !== orig.parentId || fin.index !== orig.index)) {
        void applyOp({
          op: "move_item",
          item: ref,
          parent: fin.parentId,
          index: moveOpIndex(orig, fin.parentId, fin.index),
        }).finally(() => setPreviewDoc(null));
      } else {
        setPreviewDoc(null);
      }
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  return {
    layout,
    beginItemDrag,
    draggingKey,
    mergeTargetKey: mergeTarget ? refKey(mergeTarget) : null,
    setMergeTarget,
    previewDoc,
    floatX,
    elForKey,
  };
}
