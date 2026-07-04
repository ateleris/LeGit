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
}: {
  title?: string;
  label: string;
  icon?: React.ReactNode;
  loading?: boolean;
  disabled?: boolean;
  onClick: () => void;
  /** "left" flattens the right edge (for split buttons with a caret half). */
  rounded?: "left";
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
    >
      <span>{label}</span>
    </Button>
  );
}
