import { useEffect, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";

/* 3 iterations x 0.7s (see .legit-attention-pulse), plus slack. */
const PULSE_LIFETIME_MS = 2300;

/**
 * One-shot attention ring around `target`, portaled to <body> as a
 * fixed-position overlay: the ring must paint over neighbouring rows, and
 * the overflow-hidden cells would clip anything drawn in-flow.
 */
function AttentionPulse({
  target,
  borderRadius,
}: {
  target: HTMLElement;
  borderRadius?: React.CSSProperties["borderRadius"];
}) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [expired, setExpired] = useState(false);

  useLayoutEffect(() => {
    setRect(target.getBoundingClientRect());
  }, [target]);

  // Timeout instead of animationend: reduced-motion disables the animation,
  // so the end event may never fire.
  useEffect(() => {
    const timer = window.setTimeout(() => setExpired(true), PULSE_LIFETIME_MS);
    return () => window.clearTimeout(timer);
  }, []);

  if (!rect || expired) return null;
  return createPortal(
    <span
      className="legit-attention-pulse"
      style={{
        position: "fixed",
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        borderRadius,
        pointerEvents: "none",
      }}
    />,
    document.body,
  );
}

/**
 * Minimal in-place rename input for the Commits panel (subject cell and ref
 * chips): appears where the text was, Enter approves, Esc discards. It owns
 * its draft locally — the parent only learns the final value on save.
 *
 * A save with an unchanged or empty value is treated as cancel, so callers
 * never have to guard against no-op renames.
 */
export function InlineRenameInput({
  initialValue,
  onSave,
  onCancel,
  disabled = false,
  style,
  title,
  placeholder,
  pulse = false,
}: {
  initialValue: string;
  onSave: (value: string) => void;
  onCancel: () => void;
  disabled?: boolean;
  /** Merged over the base input style (font size, width, chip look, …). */
  style?: React.CSSProperties;
  title?: string;
  /** Hint shown while empty (e.g. "branch name…" for a create-new input). */
  placeholder?: string;
  /** Pulse an attention ring on mount - for inputs that appear away from
   *  where the user clicked (create-branch/-tag). */
  pulse?: boolean;
}) {
  const [draft, setDraft] = useState(initialValue);
  const [element, setElement] = useState<HTMLInputElement | null>(null);

  const save = () => {
    const value = draft.trim();
    if (value.length === 0 || value === initialValue) {
      onCancel();
      return;
    }
    onSave(value);
  };

  return (
    <>
      <input
        ref={setElement}
        autoFocus
        value={draft}
        disabled={disabled}
        title={title}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        // The row/chip underneath handles click (select row, open menus) — an
        // in-progress edit must not trigger those.
        onClick={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            save();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
          // Keep list-level shortcuts (arrows etc.) from acting while typing.
          e.stopPropagation();
        }}
        style={{ boxSizing: "border-box", ...style }}
      />
      {pulse && element && (
        <AttentionPulse target={element} borderRadius={style?.borderRadius} />
      )}
    </>
  );
}
