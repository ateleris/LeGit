// Shared toolbar button — the Fetch/Pull/Push style from the Commits panel's
// sync toolbar, reused across panel toolbars (Working Changes section
// actions, op-state banner, Diff toolbar, Tags). A labeled preset of the
// shared `Button` ghost variant (see buttons.tsx).

import { Button } from "./buttons";

export function ToolbarButton({
  title,
  label,
  icon,
  loading = false,
  disabled = false,
  onClick,
  rounded,
  style,
}: {
  title?: string;
  label: string;
  icon?: React.ReactNode;
  loading?: boolean;
  disabled?: boolean;
  onClick: () => void;
  /** "left" flattens the right edge (for split buttons with a caret half). */
  rounded?: "left";
  /** Overrides for hosts whose surface isn't panel-coloured (op-state banner). */
  style?: React.CSSProperties;
}) {
  return (
    <Button
      variant="ghost"
      title={title}
      disabled={disabled}
      loading={loading}
      icon={icon}
      onClick={onClick}
      rounded={rounded}
      style={style}
    >
      <span>{label}</span>
    </Button>
  );
}
