import { useState } from "react";

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
}: {
  initialValue: string;
  onSave: (value: string) => void;
  onCancel: () => void;
  disabled?: boolean;
  /** Merged over the base input style (font size, width, chip look, …). */
  style?: React.CSSProperties;
  title?: string;
}) {
  const [draft, setDraft] = useState(initialValue);

  const save = () => {
    const value = draft.trim();
    if (value.length === 0 || value === initialValue) {
      onCancel();
      return;
    }
    onSave(value);
  };

  return (
    <input
      autoFocus
      value={draft}
      disabled={disabled}
      title={title}
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
  );
}
