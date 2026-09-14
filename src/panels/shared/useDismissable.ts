import { useEffect, useId, useRef } from "react";
import type React from "react";
import { useLayersStore, type LayerKind } from "../../store/layers";
import { MENU_LAYER_ATTR } from "../Commits/menu/primitives";

/**
 * Shared dismissal for dropdowns/popovers: outside mousedown (capture phase,
 * so a stopPropagation elsewhere cannot keep the surface open) and Escape.
 * "Inside" is any insideRef subtree or any marked menu layer (submenu
 * flyouts portal to document.body). Include the trigger button's wrapper in
 * insideRefs, or its mousedown-close plus click-toggle would reopen the
 * surface.
 *
 * Escape is NOT handled here: while open the surface is a layer on the stack
 * (store/layers.ts) and the key dispatcher pops the topmost layer, so closing
 * a surface can never also exit a maximized panel. `kind` "menu" blocks
 * command resolution while open; "popover" (hover flyouts) does not.
 */
export function useDismissable(
  open: boolean,
  onClose: () => void,
  insideRefs: readonly React.RefObject<HTMLElement | null>[],
  kind: LayerKind = "menu",
): void {
  const layerId = useId();
  const refsRef = useRef(insideRefs);
  refsRef.current = insideRefs;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const { push, remove } = useLayersStore.getState();
    push({ id: layerId, kind, onDismiss: () => onCloseRef.current() });

    const controller = new AbortController();
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target instanceof Node ? e.target : null;
      if (!target) return;
      if (refsRef.current.some((r) => r.current?.contains(target))) return;
      if (target instanceof Element && target.closest(`[${MENU_LAYER_ATTR}]`)) return;
      onCloseRef.current();
    };
    document.addEventListener("mousedown", onMouseDown, { capture: true, signal: controller.signal });
    return () => {
      controller.abort();
      remove(layerId);
    };
  }, [open, kind, layerId]);
}
