// Segmented two-button toggle style (Tree | List), shared by the Files panel
// and the Branches section. Extracted verbatim from FilesPanel. `solo` is the
// same chrome for a standalone on/off toggle sitting next to a segment pair.

export function segStyle(active: boolean, side: "left" | "right" | "solo"): React.CSSProperties {
  return {
    fontSize: "var(--fz-sm)",
    padding: "0.167em 0.667em",
    border: "1px solid var(--panel-border)",
    borderRadius: side === "left" ? "3px 0 0 3px" : side === "right" ? "0 3px 3px 0" : 3,
    marginLeft: side === "right" ? -1 : 0,
    background: active ? "var(--button-active-bg, rgba(255,255,255,0.12))" : "transparent",
    color: "var(--panel-fg)",
    cursor: "pointer",
  };
}
