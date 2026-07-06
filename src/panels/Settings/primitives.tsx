// Shared building blocks for the Settings panels (Global + Repo). Extracted so
// the field/section layout is defined once instead of duplicated per panel.

import { useState, type ReactNode } from "react";
import { ChevronDownIcon } from "../../icons";

/**
 * A collapsible top-level category (Appearance, Behavior, Git, About). Expanded
 * by default; the collapsed/expanded state is remembered per `id` in
 * localStorage — a pure UI preference, so it deliberately does NOT touch the
 * settings store. The uppercase header is the category label; the setting names
 * inside use `Section` (normal weight), giving a clear two-level hierarchy.
 */
export function SettingsGroup({
  id,
  title,
  caption,
  children,
}: {
  id: string;
  title: string;
  caption?: string;
  children: ReactNode;
}) {
  const key = `legit.settings-group.${id}`;
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(key) !== "collapsed";
    } catch {
      return true;
    }
  });
  const toggle = () =>
    setOpen((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(key, next ? "expanded" : "collapsed");
      } catch {
        /* private mode / quota — the toggle still works for the session */
      }
      return next;
    });

  return (
    <div style={{ marginBottom: 18 }}>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "100%",
          background: "transparent",
          border: "none",
          borderBottom: "1px solid var(--panel-border)",
          padding: "6px 0",
          cursor: "pointer",
          color: "var(--subtle-fg)",
          textAlign: "left",
        }}
      >
        <ChevronDownIcon
          size="1em"
          style={{
            flexShrink: 0,
            transform: open ? "none" : "rotate(-90deg)",
            transition: "transform 0.12s",
          }}
        />
        <span style={{ fontSize: "var(--fz-sm)", textTransform: "uppercase", letterSpacing: "0.09em", fontWeight: 700 }}>
          {title}
        </span>
        {caption && (
          <span style={{ fontSize: "var(--fz-sm)", textTransform: "none", letterSpacing: 0 }}>{caption}</span>
        )}
      </button>
      {open && <div style={{ marginTop: 12 }}>{children}</div>}
    </div>
  );
}

/**
 * One setting: a name (+ an optional "Git config" pill when it writes git
 * config rather than LeGit's own instant-apply settings) over its control(s).
 */
export function Section({
  title,
  scope,
  children,
}: {
  title: string;
  /** "git" marks a setting that writes git config (shown with a pill). */
  scope?: "git";
  children: ReactNode;
}) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: "var(--fz-lg)", fontWeight: 550 }}>{title}</span>
        {scope === "git" && <GitConfigPill />}
      </div>
      {children}
    </div>
  );
}

/** Pill marking a setting that changes the user's git configuration. */
export function GitConfigPill() {
  return (
    <span
      title="Changes your git configuration"
      style={{
        fontSize: "var(--fz-xs)",
        fontWeight: 700,
        letterSpacing: "0.04em",
        textTransform: "uppercase",
        color: "var(--status-modified)",
        border: "1px solid var(--status-modified)",
        borderRadius: 999,
        padding: "0 6px",
        lineHeight: 1.6,
        whiteSpace: "nowrap",
      }}
    >
      Git config
    </span>
  );
}

export function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "160px 1fr", gap: 6, padding: "2px 0" }}>
      <div className="legit-subtle">{label}</div>
      <div>{value}</div>
    </div>
  );
}

export function FieldNote({ children }: { children: ReactNode }) {
  return (
    <div style={{ fontSize: "var(--fz-sm)", color: "var(--subtle-fg)", marginTop: 4 }}>{children}</div>
  );
}
