import React, { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { LayerKind } from "../../store/layers";
import { MENU_LAYER_ATTR } from "../shared/menu/primitives";
import { useDismissable } from "./useDismissable";
import { clampToViewport } from "./popoverPosition";

/**
 * Fixed-position dismissable surface, portaled to document.body, measured
 * after render and clamped into the viewport (no hardcoded size estimates).
 * Callers style the surface (background, border, padding) via `style`.
 */
export function Popover({
  x,
  y,
  onClose,
  insideRefs = [],
  kind = "menu",
  style,
  children,
  ...divProps
}: {
  x: number;
  y: number;
  onClose: () => void;
  /** Extra elements that count as inside (e.g. a combobox's input). */
  insideRefs?: readonly React.RefObject<HTMLElement | null>[];
  /** Layer kind: "menu" blocks shortcuts while open; hover flyouts pass "popover". */
  kind?: LayerKind;
  style?: React.CSSProperties;
  children: React.ReactNode;
} & Omit<React.HTMLAttributes<HTMLDivElement>, "style">) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos(
      clampToViewport({
        x,
        y,
        width: r.width,
        height: r.height,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      }),
    );
  }, [x, y]);

  useDismissable(true, onClose, [ref, ...insideRefs], kind);

  return createPortal(
    <div
      ref={ref}
      {...{ [MENU_LAYER_ATTR]: "" }}
      {...divProps}
      style={{ position: "fixed", left: pos.left, top: pos.top, zIndex: 9999, ...style }}
    >
      {children}
    </div>,
    document.body,
  );
}
