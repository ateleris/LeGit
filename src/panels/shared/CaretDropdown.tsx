import React, { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MENU_LAYER_ATTR } from "../shared/menu/primitives";
import { useDismissable } from "./useDismissable";

/** Which way the caret dropdown opens. Down is the default; it flips up when
 * the menu would cross the viewport bottom (the commit composer sits at the
 * bottom of its panel, where a downward menu vanished behind the window
 * edge) - but only if it actually fits above, else the default clips less
 * badly (the first entries stay visible). */
export function caretDropDirection(args: {
  anchorTop: number;
  anchorBottom: number;
  menuHeight: number;
  viewportHeight: number;
}): "down" | "up" {
  if (args.anchorBottom + args.menuHeight <= args.viewportHeight) return "down";
  if (args.anchorTop - args.menuHeight >= 0) return "up";
  return "down";
}

/** Fixed-position coordinates for the portaled menu: right-aligned to the
 * anchor, under it (or over it when flipped near the viewport bottom), never
 * past the viewport's left edge. */
export function caretMenuPosition(args: {
  anchorRect: { top: number; bottom: number; right: number };
  menuWidth: number;
  menuHeight: number;
  viewportHeight: number;
  gap: number;
}): { left: number; top: number } {
  const { anchorRect, menuWidth, menuHeight, viewportHeight, gap } = args;
  const direction = caretDropDirection({
    anchorTop: anchorRect.top,
    anchorBottom: anchorRect.bottom,
    menuHeight: menuHeight + gap,
    viewportHeight,
  });
  return {
    left: Math.max(0, anchorRect.right - menuWidth),
    top: direction === "down" ? anchorRect.bottom + gap : anchorRect.top - menuHeight - gap,
  };
}

/** Caret dropdown shared by split buttons (the Commits toolbar's Pull/Push/
 *  Stash carets, the composer's commit-mode caret): a panel right-aligned
 *  under (or, near the viewport bottom, over) the anchor, dismissed via the
 *  shared useDismissable (outside mousedown + Escape via the layer stack).
 *  The menu PORTALS to document.body so it can never be painted over by a
 *  dockview group below the anchor's panel; the anchor is the wrapper
 *  element this component is rendered inside (it must contain the trigger,
 *  so the trigger's own click still toggles rather than reopening). */
export function CaretDropdown({
  onClose,
  children,
}: {
  onClose: () => void;
  children: React.ReactNode;
}) {
  const markerRef = useRef<HTMLElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const anchorRef = useRef<HTMLElement | null>(null);
  // Hidden until measured, so the menu never flashes at a wrong position.
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const menu = menuRef.current;
    const anchor = markerRef.current?.parentElement ?? null;
    anchorRef.current = anchor;
    if (!menu || !anchor) return;
    const a = anchor.getBoundingClientRect();
    const m = menu.getBoundingClientRect();
    // The old in-place layout used a 0.167em gap; compute it from the menu's
    // resolved font size so the offset keeps scaling with the UI font.
    const gap = parseFloat(getComputedStyle(menu).fontSize) * 0.167 || 2;
    setPos(
      caretMenuPosition({
        anchorRect: { top: a.top, bottom: a.bottom, right: a.right },
        menuWidth: m.width,
        menuHeight: m.height,
        viewportHeight: window.innerHeight,
        gap,
      }),
    );
  }, []);
  useDismissable(true, onClose, [menuRef, anchorRef]);
  return (
    <>
      {/* Invisible in-place marker: locates the anchor wrapper for
          positioning and dismissal after the menu itself moved to body. */}
      <span ref={markerRef} style={{ display: "none" }} />
      {createPortal(
        <div
          ref={menuRef}
          {...{ [MENU_LAYER_ATTR]: "" }}
          style={{
            position: "fixed",
            left: pos?.left ?? 0,
            top: pos?.top ?? 0,
            visibility: pos ? undefined : "hidden",
            zIndex: 9999,
            background: "var(--panel-bg, #222)",
            border: "1px solid var(--panel-border)",
            borderRadius: 4,
            boxShadow: "0 2px 8px var(--shadow-color)",
            whiteSpace: "nowrap",
          }}
        >
          {children}
        </div>,
        document.body,
      )}
    </>
  );
}
