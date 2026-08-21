// Compact toolbar text-field style: the standard toolbar control height
// (2em of --fz-sm, matching the segmented toggles and toolbar buttons).
// Extracted from the Commits panel's search field so other toolbar inputs
// (the Compare rev pickers) render at exactly the same height.

export const TOOLBAR_FIELD_STYLE: React.CSSProperties = {
  fontSize: "var(--fz-sm)",
  height: "2em",
  boxSizing: "border-box",
  padding: "0 6px",
  border: "1px solid var(--panel-border)",
  borderRadius: 3,
  background: "var(--input-bg)",
  color: "var(--panel-fg)",
};
