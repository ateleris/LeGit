// Shared button set — the consolidation target tracked in BACKLOG.md.
// Variants map onto the existing token-backed styling, so no new theme
// tokens are needed:
//   default        → the global CSS `button` base (no className)
//   primary/danger → the global `.primary` / `.danger` classes
//   ghost          → transparent toolbar style (absorbed from ToolbarButton)
//   icon           → borderless icon-only row action (absorbed from the
//                    Working Changes IconButton)
// Sizing is font-relative throughout (em / --fz-*), per the global
// UI-font-size scaling rule. Accepts all native button props; `type`
// defaults to "button" so forms never submit by accident.

export type ButtonVariant = "default" | "primary" | "danger" | "ghost" | "icon";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  /** Leading icon; replaced by a spinner while `loading`. */
  icon?: React.ReactNode;
  /** Shows a spinner in the icon slot. Does NOT disable the button — a
   *  running op's button may stay clickable as its own Cancel. */
  loading?: boolean;
  /** Split-button halves: "left" flattens the right edge, "right" the left. */
  rounded?: "left" | "right";
}

function ghostStyle(disabled: boolean): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    fontSize: "var(--fz-sm)",
    // Pinned: the standard compact toolbar control is 2em of --fz-sm tall
    // (border-box) - the same height as toolbar text inputs/selects (e.g.
    // the Commits filter). .legit-panel__toolbar's min-height and its
    // button/input normalization rules derive from exactly this (global.css).
    lineHeight: 1.2,
    height: "2em",
    boxSizing: "border-box",
    padding: "0 8px",
    border: "1px solid var(--panel-border)",
    borderRadius: 3,
    background: "transparent",
    color: "var(--panel-fg)",
    cursor: disabled ? "default" : "pointer",
    opacity: disabled ? 0.5 : 1,
  };
}

function iconStyle(): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    background: "transparent",
    border: "none",
    color: "var(--subtle-fg)",
    cursor: "pointer",
    padding: "0 3px",
    fontSize: "var(--fz-lg)",
    lineHeight: 1,
  };
}

export function Button({
  variant = "default",
  icon,
  loading = false,
  rounded,
  className,
  style,
  disabled,
  type,
  children,
  ...rest
}: ButtonProps) {
  const variantClass = variant === "primary" || variant === "danger" ? variant : undefined;
  const base: React.CSSProperties =
    variant === "ghost" ? ghostStyle(!!disabled) : variant === "icon" ? iconStyle() : {};
  const radius =
    rounded === "left" ? "3px 0 0 3px" : rounded === "right" ? "0 3px 3px 0" : undefined;
  return (
    <button
      type={type ?? "button"}
      className={[variantClass, className].filter(Boolean).join(" ") || undefined}
      disabled={disabled}
      style={{ ...base, ...(radius ? { borderRadius: radius } : {}), ...style }}
      {...rest}
    >
      {loading ? <span className="legit-spinner" aria-hidden="true" /> : icon}
      {children}
    </button>
  );
}

/** Icon-only ghost button for row-hover actions (stage/unstage, delete ×). */
export function IconButton({
  children,
  ...rest
}: Omit<ButtonProps, "variant" | "icon" | "loading" | "rounded">) {
  return (
    <Button variant="icon" {...rest}>
      {children}
    </Button>
  );
}
