import { useEffect, useRef } from "react";
import type React from "react";
import { MENU_LAYER_ATTR } from "../Commits/menu/primitives";

/**
 * Shared dismissal for dropdowns/popovers: outside mousedown (capture phase,
 * so a stopPropagation elsewhere cannot keep the surface open) and Escape.
 * "Inside" is any insideRef subtree or any marked menu layer (submenu
 * flyouts portal to document.body). Include the trigger button's wrapper in
 * insideRefs, or its mousedown-close plus click-toggle would reopen the
 * surface. Escape is consumed (stopPropagation): closing a surface must not
 * also exit a maximized panel - see isUnclaimedEscape in store/dockview.ts.
 */
export function useDismissable(
  open: boolean,
  onClose: () => void,
  insideRefs: readonly React.RefObject<HTMLElement | null>[],
): void {
  const refsRef = useRef(insideRefs);
  refsRef.current = insideRefs;

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target instanceof Node ? e.target : null;
      if (!target) return;
      if (refsRef.current.some((r) => r.current?.contains(target))) return;
      if (target instanceof Element && target.closest(`[${MENU_LAYER_ATTR}]`)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    document.addEventListener("mousedown", onMouseDown, { capture: true, signal: controller.signal });
    document.addEventListener("keydown", onKey, { signal: controller.signal });
    return () => controller.abort();
  }, [open, onClose]);
}
