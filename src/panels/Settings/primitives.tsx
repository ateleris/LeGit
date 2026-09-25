// Shared building blocks for the Settings panels (Global + Repo). Extracted so
// the field/section layout is defined once instead of duplicated per panel.

import { useState, type CSSProperties, type ReactNode } from "react";
import { ChevronDownIcon } from "../../icons";

function readStoredOpen(key: string, fallback: boolean): boolean {
  try {
    const stored = localStorage.getItem(key);
    if (stored === "collapsed") return false;
    if (stored === "expanded") return true;
    return fallback;
  } catch {
    return fallback;
  }
}

function writeStoredOpen(key: string, open: boolean) {
  try {
    localStorage.setItem(key, open ? "expanded" : "collapsed");
  } catch {
    /* private mode / quota — the toggle still works for the session */
  }
}

/** The category header band: sticky, full width, tinted. It assumes the
 * scroll container has `--ui-font-size * 0.667` horizontal padding (which the
 * band bleeds through, its own padding matching so the title stays aligned
 * with the content) and NO top padding (a stuck header would show content
 * scrolling past above it): hosts move that padding into the scrolled
 * content instead. */
const GROUP_HEADER_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.667em",
  width: "calc(100% + var(--ui-font-size) * 1.334)",
  margin: "0 calc(var(--ui-font-size) * -0.667)",
  // Opaque backing (content scrolls behind the stuck header): the band wash
  // layered over the panel background.
  background:
    "linear-gradient(var(--button-hover-bg), var(--button-hover-bg)), var(--panel-bg)",
  border: "none",
  // Explicit: the global `button` radius would round the band's corners
  // although it spans the full panel width.
  borderRadius: 0,
  padding: "0.5em calc(var(--ui-font-size) * 0.667)",
  position: "sticky",
  top: 0,
  zIndex: 1,
  color: "var(--subtle-fg)",
  textAlign: "left",
};

/**
 * A top-level category (Appearance, Branches, Git, About): a sticky
 * full-width band over the uppercase category label; the setting names inside
 * use `Section` (normal weight), giving a clear two-level hierarchy.
 *
 * The settings panels render groups permanently expanded (`collapsible`
 * false): the shell's nav, search and sticky bands replaced collapsing there.
 * Collapsing remains for the Theme Editor, whose heavy groups (Tokens,
 * Contrast) only render their children while open; that state is remembered
 * per `id` in localStorage — a pure UI preference, so it deliberately does
 * NOT touch the settings store.
 */
export function SettingsGroup({
  id,
  title,
  caption,
  defaultOpen = true,
  collapsible = true,
  children,
}: {
  id: string;
  title: string;
  caption?: string;
  /** Initial state when the user hasn't toggled this group yet. */
  defaultOpen?: boolean;
  collapsible?: boolean;
  children: ReactNode;
}) {
  const key = `legit.settings-group.${id}`;
  const [openState, setOpenState] = useState(() => readStoredOpen(key, defaultOpen));
  const open = !collapsible || openState;
  const toggle = () =>
    setOpenState((prev) => {
      const next = !prev;
      writeStoredOpen(key, next);
      return next;
    });

  const label = (
    <>
      <span style={{ fontSize: "var(--fz-sm)", textTransform: "uppercase", letterSpacing: "0.09em", fontWeight: 700 }}>
        {title}
      </span>
      {caption && (
        <span style={{ fontSize: "var(--fz-sm)", textTransform: "none", letterSpacing: 0 }}>{caption}</span>
      )}
    </>
  );

  return (
    <div style={{ marginBottom: "1.5em" }}>
      {collapsible ? (
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          style={{ ...GROUP_HEADER_STYLE, cursor: "pointer" }}
        >
          <ChevronDownIcon
            size="1em"
            style={{
              flexShrink: 0,
              transform: open ? "none" : "rotate(-90deg)",
              transition: "transform 0.12s",
            }}
          />
          {label}
        </button>
      ) : (
        <div style={GROUP_HEADER_STYLE}>{label}</div>
      )}
      {open && <div style={{ marginTop: "1em" }}>{children}</div>}
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
    <div style={{ marginBottom: "1.333em" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "0.667em", marginBottom: "0.5em" }}>
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
        padding: "0 0.5em",
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
    <div style={{ display: "grid", gridTemplateColumns: "160px 1fr", gap: "0.5em", padding: "0.167em 0" }}>
      <div className="legit-subtle">{label}</div>
      <div>{value}</div>
    </div>
  );
}

export function FieldNote({ children }: { children: ReactNode }) {
  return (
    <div style={{ fontSize: "var(--fz-sm)", color: "var(--subtle-fg)", marginTop: "0.333em" }}>{children}</div>
  );
}

/** The standard "writes to:" note under a setting's title, so the wording
 * cannot drift between sections. */
export function WritesTo({
  target = "global settings",
  note,
}: {
  target?: string;
  note?: string;
}) {
  return (
    <FieldNote>
      writes to: {target}
      {note ? ` (${note})` : ""}
    </FieldNote>
  );
}

/** One checkbox + label row in the settings-toggle shape. */
export function SettingCheckbox({
  id,
  label,
  checked,
  onChange,
  disabled,
  title,
  topGap = "0.667em",
}: {
  id: string;
  label: ReactNode;
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
  /** Tooltip on the label. */
  title?: string;
  /** Space above the row; bump it to visually separate a new cluster. */
  topGap?: string;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "0.667em", marginTop: topGap }}>
      <input type="checkbox" id={id} checked={checked} onChange={onChange} disabled={disabled} />
      <label htmlFor={id} style={{ fontSize: "var(--fz-lg)", cursor: "pointer" }} title={title}>
        {label}
      </label>
    </div>
  );
}

/** One radio option with an inline explanation, the radio-list row shape. */
export function SettingRadio({
  checked,
  onSelect,
  disabled,
  label,
  detail,
}: {
  checked: boolean;
  onSelect: () => void;
  disabled?: boolean;
  label: string;
  detail: string;
}) {
  return (
    <label
      style={{
        display: "flex",
        alignItems: "center",
        gap: "0.667em",
        cursor: disabled ? "default" : "pointer",
      }}
    >
      <input type="radio" checked={checked} onChange={onSelect} disabled={disabled} />
      <span style={{ fontSize: "var(--fz-lg)" }}>{label}</span>
      <span className="legit-subtle" style={{ fontSize: "var(--fz-sm)" }}>
        {detail}
      </span>
    </label>
  );
}

/** A Section holding a single toggle: title, writes-to note, one checkbox,
 * and optional trailing notes as children. */
export function ToggleSection({
  title,
  writesNote,
  id,
  label,
  checked,
  disabled,
  onToggle,
  children,
}: {
  title: string;
  /** Parenthesized part of the writes-to note, e.g. "applies to all repos". */
  writesNote?: string;
  id: string;
  label: ReactNode;
  checked: boolean;
  disabled?: boolean;
  onToggle: () => void;
  children?: ReactNode;
}) {
  return (
    <Section title={title}>
      <WritesTo note={writesNote} />
      <SettingCheckbox id={id} label={label} checked={checked} onChange={onToggle} disabled={disabled} />
      {children}
    </Section>
  );
}
