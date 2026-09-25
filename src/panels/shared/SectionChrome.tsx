// Shared section chrome for panel bodies. (The context-menu SectionLabel in
// shared/menu/primitives is a different, menu-row-shaped element.)

import type { ReactNode } from "react";

/** Uppercase inline section label (Branches' and Stashes' list headers). */
export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <span
      style={{
        fontSize: "var(--fz-sm)",
        textTransform: "uppercase",
        letterSpacing: 0.5,
        color: "var(--subtle-fg)",
      }}
    >
      {children}
    </span>
  );
}

/** A titled block in a detail panel (Commit Details, Repositories). */
export function TitledSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ marginBottom: "1.333em" }}>
      {title && (
        <div
          style={{
            fontSize: "var(--fz-sm)",
            textTransform: "uppercase",
            letterSpacing: 0.5,
            color: "var(--subtle-fg)",
            marginBottom: "0.5em",
          }}
        >
          {title}
        </div>
      )}
      {children}
    </div>
  );
}
