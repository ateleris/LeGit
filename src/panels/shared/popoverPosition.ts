/** Clamp a fixed-position popover into the viewport (MenuShell's rule). */
export function clampToViewport(args: {
  x: number;
  y: number;
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
  margin?: number;
}): { left: number; top: number } {
  const m = args.margin ?? 4;
  return {
    left: Math.max(m, Math.min(args.x, args.viewportWidth - args.width - m)),
    top: Math.max(m, Math.min(args.y, args.viewportHeight - args.height - m)),
  };
}

/** Place a dropdown below its anchor, right-aligned to it, with the height
 * capped to the viewport space under the anchor - a short window scrolls the
 * menu internally instead of clipping its bottom. */
export function dropdownBelowAnchor(args: {
  anchorRight: number;
  anchorBottom: number;
  menuWidth: number;
  viewportWidth: number;
  viewportHeight: number;
  gap?: number;
  margin?: number;
}): { left: number; top: number; maxHeight: number } {
  const m = args.margin ?? 4;
  const top = args.anchorBottom + (args.gap ?? 4);
  return {
    left: Math.max(m, Math.min(args.anchorRight - args.menuWidth, args.viewportWidth - args.menuWidth - m)),
    top,
    maxHeight: Math.max(0, args.viewportHeight - top - m),
  };
}
