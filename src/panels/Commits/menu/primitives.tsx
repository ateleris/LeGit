// Shared context-menu primitives. Previously duplicated in RefsCell.tsx and
// ColumnHeader.tsx; now the single source for every Commits-panel menu.

import { useState } from "react";

export function MenuItem({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  const [hover, setHover] = useState(false);
  return (
    <div
      onClick={disabled ? undefined : onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        padding: "6px 14px",
        cursor: disabled ? "default" : "pointer",
        whiteSpace: "nowrap",
        color: disabled ? "var(--subtle-fg, #777)" : "var(--panel-fg, #ccc)",
        background: hover && !disabled ? "var(--menu-hover-bg, rgba(255,255,255,0.08))" : "",
        opacity: disabled ? 0.6 : 1,
      }}
    >
      {children}
    </div>
  );
}

export function Separator() {
  return (
    <div
      style={{
        height: 1,
        margin: "4px 0",
        background: "var(--panel-border, rgba(255,255,255,0.10))",
      }}
    />
  );
}

export function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        padding: "4px 14px",
        fontSize: "var(--fz-sm)",
        color: "var(--subtle-fg, #888)",
        textTransform: "uppercase",
        letterSpacing: "0.04em",
        cursor: "default",
      }}
    >
      {children}
    </div>
  );
}
