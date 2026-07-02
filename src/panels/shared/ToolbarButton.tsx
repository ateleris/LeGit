// Shared toolbar button — the Fetch/Pull/Push style from the Commits panel's
// sync toolbar, extracted for reuse (Working Changes section actions, …).
// First step of the button consolidation tracked in BACKLOG.md.

/** Shared style for toolbar buttons (also used by split-button halves). */
export function toolbarBtnStyle(disabled: boolean): React.CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: 4,
    fontSize: "var(--fz-sm)",
    padding: "2px 8px",
    border: "1px solid var(--panel-border)",
    borderRadius: 3,
    background: "transparent",
    color: "var(--panel-fg)",
    cursor: disabled ? "default" : "pointer",
    opacity: disabled ? 0.5 : 1,
  };
}

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
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      style={{
        ...toolbarBtnStyle(disabled),
        borderRadius: rounded === "left" ? "3px 0 0 3px" : 3,
      }}
    >
      {loading ? <span className="legit-spinner" aria-hidden="true" /> : icon}
      <span>{label}</span>
    </button>
  );
}
