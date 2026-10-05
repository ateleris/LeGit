import React, { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MENU_LAYER_ATTR } from "./menu/primitives";
import { dropdownBelowAnchor } from "./popoverPosition";

/**
 * Dropdown surface for the tab-strip menus (View, repo overflow, add repo):
 * portaled to document.body, right-aligned under its anchor, height capped to
 * the viewport space below the anchor with internal scrolling so a short
 * window never clips the bottom entries. Hidden until measured so it never
 * flashes at a wrong position. The anchor is the wrapper element this
 * component is rendered inside, located via an in-place marker (a passed ref
 * would not be attached yet when the layout effect measures - CaretDropdown's
 * lesson). Dismissal stays with the caller - its useDismissable treats the
 * marked menu layer as inside.
 */
export function AnchoredDropdown({
  style,
  children,
  ...divProps
}: {
  style?: React.CSSProperties;
  children: React.ReactNode;
} & Omit<React.HTMLAttributes<HTMLDivElement>, "style">) {
  const markerRef = useRef<HTMLElement | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; maxHeight: number } | null>(null);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    const anchor = markerRef.current?.parentElement ?? null;
    if (!menu || !anchor) return;
    const measure = () => {
      const a = anchor.getBoundingClientRect();
      setPos(
        dropdownBelowAnchor({
          anchorRight: a.right,
          anchorBottom: a.bottom,
          menuWidth: menu.getBoundingClientRect().width,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
        }),
      );
    };
    measure();
    // The surface can change size while open (the add-repo menu swaps in its
    // clone/init forms), which moves the right-aligned left edge.
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(menu);
    return () => observer.disconnect();
  }, []);

  return (
    <>
      <span ref={markerRef} style={{ display: "none" }} />
      {createPortal(
        <div
          ref={menuRef}
          {...{ [MENU_LAYER_ATTR]: "" }}
          {...divProps}
          style={{
            position: "fixed",
            left: pos?.left ?? 0,
            top: pos?.top ?? 0,
            maxHeight: pos?.maxHeight,
            visibility: pos ? undefined : "hidden",
            overflowY: "auto",
            background: "var(--panel-bg)",
            color: "var(--panel-fg)",
            border: "1px solid var(--panel-border)",
            borderRadius: 4,
            boxShadow: "0 4px 10px var(--shadow-color)",
            zIndex: 9999,
            ...style,
          }}
        >
          {children}
        </div>,
        document.body,
      )}
    </>
  );
}
