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
