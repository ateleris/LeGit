import React, { useLayoutEffect, useRef, useState } from "react";
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

/** Caret dropdown shared by split buttons (the Commits toolbar's Pull/Push/
 *  Stash carets, the composer's commit-mode caret): a right-aligned panel
 *  under (or, near the viewport bottom, over) the anchor, dismissed via the
 *  shared useDismissable (outside mousedown + Escape). The anchor wrapper
 *  needs `position: relative` and contains the trigger, so it counts as
 *  inside and the trigger's own click still toggles. */
export function CaretDropdown({
  onClose,
  children,
}: {
  onClose: () => void;
  children: React.ReactNode;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const anchorRef = useRef<HTMLElement | null>(null);
  const [direction, setDirection] = useState<"down" | "up">("down");
  // Measure once on mount, before paint, so a flipped menu never flashes in
  // the clipped position. The anchor is the relative wrapper (parentElement:
  // the menu is rendered as its child).
  useLayoutEffect(() => {
    const menu = menuRef.current;
    const anchor = menu?.parentElement;
    anchorRef.current = anchor ?? null;
    if (!menu || !anchor) return;
    const a = anchor.getBoundingClientRect();
    setDirection(
      caretDropDirection({
        anchorTop: a.top,
        anchorBottom: a.bottom,
        menuHeight: menu.getBoundingClientRect().height + 2,
        viewportHeight: window.innerHeight,
      }),
    );
  }, []);
  useDismissable(true, onClose, [menuRef, anchorRef]);
  return (
    <div
      ref={menuRef}
      style={{
        position: "absolute",
        ...(direction === "down"
          ? { top: "100%", marginTop: "0.167em" }
          : { bottom: "100%", marginBottom: "0.167em" }),
        right: 0,
        zIndex: 11,
        background: "var(--panel-bg, #222)",
        border: "1px solid var(--panel-border)",
        borderRadius: 4,
        boxShadow: "0 2px 8px var(--shadow-color)",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </div>
  );
}
