import { LAYOUT_SHORTCUT_SLOTS } from "../../keys/registry";
import { useBindingLabel } from "../../keys/useBindingLabel";

const chipStyle: React.CSSProperties = {
  padding: "0.1em 0.5em",
  background: "var(--input-bg)",
  border: "1px solid var(--panel-border)",
  borderRadius: 4,
  color: "var(--subtle-fg)",
  fontSize: "var(--fz-sm)",
  whiteSpace: "nowrap",
};

/**
 * The `app.applyLayoutN` binding of the slot a layout occupies, live from the
 * keymap. Renders nothing while that slot is unbound (the shortcuts ship
 * unbound) or past the ninth layout.
 */
export function LayoutShortcutChip({ index }: { index: number }) {
  const slot = index < LAYOUT_SHORTCUT_SLOTS ? index + 1 : 0;
  const label = useBindingLabel(`app.applyLayout${slot}`);
  if (!label) return null;
  return (
    <span style={chipStyle} title={`Applies this layout (shortcut ${slot})`}>
      {label}
    </span>
  );
}
