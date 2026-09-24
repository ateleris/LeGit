import { useEffect, useRef, useState } from "react";

// Shared column widths so the control column lines up across the separate
// General and Commits-graph grids (both start at the same left origin, so
// identical label + gutter columns make their inputs/buttons align vertically).
// Em-based: they scale with the grids' --fz-lg font size.
export const SETTINGS_LABEL_COL = "10.5em";
export const SETTINGS_GUTTER_COL = "1.9em"; // matches the link IconButton width
export const SETTINGS_GRID_COLS = `${SETTINGS_LABEL_COL} ${SETTINGS_GUTTER_COL} min-content max-content`;

export function NumberField({
  label,
  value,
  min,
  max,
  step = 1,
  disabled,
  onCommit,
  grid = false,
  row,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  /** Rounding granularity for committed values. Defaults to whole numbers. */
  step?: number;
  disabled?: boolean;
  onCommit: (value: number) => void;
  /** Render as grid cells (label · input · range) via `display: contents`, so
   *  multiple fields align in a shared grid. Cells are placed at explicit
   *  columns 1/3/4 (column 2 is a gutter the caller uses for the link toggle). */
  grid?: boolean;
  /** 1-based grid row for this field's cells (grid mode). */
  row?: number;
}) {
  // Local draft so typing doesn't clamp/persist mid-edit.
  const [draft, setDraft] = useState(String(value));
  const inputRef = useRef<HTMLInputElement>(null);

  // Keep the field in sync when the stored value changes elsewhere (e.g. Reset).
  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  const commit = (raw: string) => {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
      setDraft(String(value));
      return;
    }
    const snapped = Math.round(parsed / step) * step;
    const clamped = Math.min(max, Math.max(min, snapped));
    setDraft(String(clamped));
    if (clamped !== value) onCommit(clamped);
  };

  // Commit on the native `change` event: it fires when the spinner arrows step
  // the value (so it applies immediately) and on blur/Enter, but not on every
  // typed keystroke — those only fire `input` (React onChange) and update the
  // draft. Reads `el.value` directly since the draft state update is async.
  const commitRef = useRef(commit);
  commitRef.current = commit;
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const onChangeNative = () => commitRef.current(el.value);
    el.addEventListener("change", onChangeNative);
    return () => el.removeEventListener("change", onChangeNative);
  }, []);

  const input = (
    <input
      ref={inputRef}
      type="number"
      min={min}
      max={max}
      step={step}
      value={draft}
      disabled={disabled}
      style={{ width: grid ? "5em" : 72, ...(grid ? { gridColumn: 3, gridRow: row } : {}) }}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
    />
  );
  const range = (
    <span
      className="legit-subtle"
      style={{
        fontSize: "var(--fz-sm)",
        fontVariantNumeric: "tabular-nums",
        ...(grid ? { gridColumn: 4, gridRow: row } : {}),
      }}
    >
      px ({min}–{max})
    </span>
  );

  if (grid) {
    // Cells participate in the parent grid at explicit columns (label 1,
    // input 3, range 4; column 2 is a gutter the caller uses for the link
    // toggle) so all fields align regardless of label length.
    return (
      <label style={{ display: "contents" }}>
        <span className="legit-subtle" style={{ gridColumn: 1, gridRow: row }}>{label}</span>
        {input}
        {range}
      </label>
    );
  }

  return (
    <label style={{ display: "flex", alignItems: "center", gap: "0.5em", fontSize: "var(--fz-lg)" }}>
      <span className="legit-subtle">{label}</span>
      {input}
      {range}
    </label>
  );
}
