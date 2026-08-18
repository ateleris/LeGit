import { useLayoutEffect, useRef, useState } from "react";

const DRAG_THRESHOLD = 4; // px before a press becomes a drag (RepoTabBar's value)

/**
 * Live pointer-based vertical drag-to-reorder - the RepoTabBar pattern,
 * vertical: the grabbed row follows the pointer via translateY while the
 * ORDER updates live, so the row visibly lands where it is dragged.
 *
 * `onReorder` fires live with every order change during the drag (drive the
 * rendered order from it); `onDrop` fires once on release with the final
 * order and whether it differs from the drag-start order (persist there
 * when the target is a saved setting). Presses on select/textarea/button
 * children never start a drag; callers should also set
 * `userSelect: "none"` on rows (they are drag handles) and
 * `position: relative` on the container (row offsets resolve against it).
 */
export function useRowDragReorder(opts: {
  container: React.RefObject<HTMLElement | null>;
  order: readonly string[];
  onReorder: (next: string[]) => void;
  onDrop?: (next: string[], changed: boolean) => void;
  disabled?: boolean;
}) {
  const { container } = opts;
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const itemEls = useRef(new Map<string, HTMLElement>());
  const dragInfo = useRef<{
    key: string;
    grabOffset: number;
    height: number;
    startY: number;
    startOrder: string[];
    order: string[];
    moved: boolean;
  } | null>(null);
  const desiredTopRef = useRef(0); // dragged row's intended top (content space)
  const [draggingKey, setDraggingKey] = useState<string | null>(null);
  const [dragY, setDragY] = useState(0);

  // After a live reorder the dragged row sits in a new slot; its offsetTop
  // changed, so recompute the follow offset against the new layout
  // (synchronously, before paint) to avoid a one-frame jump.
  const orderKey = opts.order.join(",");
  useLayoutEffect(() => {
    const info = dragInfo.current;
    if (!info || draggingKey === null) return;
    const el = itemEls.current.get(info.key);
    if (el) setDragY(desiredTopRef.current - el.offsetTop);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderKey, draggingKey]);

  const registerItem = (key: string) => (el: HTMLElement | null) => {
    if (el) itemEls.current.set(key, el);
    else itemEls.current.delete(key);
  };

  const beginDrag = (e: React.PointerEvent, key: string) => {
    if (optsRef.current.disabled || e.button !== 0) return;
    // Interactive children keep their own pointer behaviour.
    if ((e.target as HTMLElement).closest("select, textarea, button")) return;
    const body = container.current;
    const el = itemEls.current.get(key);
    if (!body || !el) return;
    const bRect = body.getBoundingClientRect();
    const pointerContentY = e.clientY - bRect.top + body.scrollTop;
    dragInfo.current = {
      key,
      grabOffset: pointerContentY - el.offsetTop, // where in the row it was grabbed
      height: el.offsetHeight,
      startY: e.clientY,
      startOrder: [...optsRef.current.order],
      order: [...optsRef.current.order],
      moved: false,
    };

    const onMove = (ev: PointerEvent) => {
      const info = dragInfo.current;
      const bc = container.current;
      if (!info || !bc) return;
      if (!info.moved) {
        if (Math.abs(ev.clientY - info.startY) < DRAG_THRESHOLD) return;
        info.moved = true;
        setDraggingKey(info.key);
      }
      const rect = bc.getBoundingClientRect();
      const pointerY = ev.clientY - rect.top + bc.scrollTop;
      const desiredTop = pointerY - info.grabOffset;
      desiredTopRef.current = desiredTop;
      const draggedCenter = desiredTop + info.height / 2;
      // Insert before the first row whose centre is below the dragged centre.
      let target = 0;
      for (const k of info.order) {
        if (k === info.key) continue;
        const rel = itemEls.current.get(k);
        if (!rel) continue;
        if (rel.offsetTop + rel.offsetHeight / 2 < draggedCenter) target++;
      }
      const without = info.order.filter((k) => k !== info.key);
      without.splice(target, 0, info.key);
      if (without.some((k, i) => k !== info.order[i])) {
        info.order = without;
        optsRef.current.onReorder(without);
      }
      // Keep the dragged row under the pointer regardless of its slot.
      const dEl = itemEls.current.get(info.key);
      setDragY(desiredTop - (dEl ? dEl.offsetTop : 0));
    };

    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      const info = dragInfo.current;
      dragInfo.current = null;
      setDraggingKey(null);
      setDragY(0);
      if (info?.moved) {
        const changed = info.order.some((k, i) => k !== info.startOrder[i]);
        optsRef.current.onDrop?.(info.order, changed);
      }
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  return { draggingKey, dragY, registerItem, beginDrag };
}
