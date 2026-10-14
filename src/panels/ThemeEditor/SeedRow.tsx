// Simple-mode face of the Theme Editor: seven seed swatches that regenerate
// the whole theme (design/2026-10-14-theme-simple-mode.md). The detailed
// palette/token editor lives behind the Advanced disclosure below this row.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ThemeDocument, ThemeSeeds } from "../../lib/types";
import { confirmDialog } from "../../store/confirm";
import { deriveTheme, extractSeeds, fingerprintMatches, themeContrastFailures } from "../../theme/simple";
import { FieldNote } from "../Settings/primitives";

export type SeedEditPlan = "regenerate" | "warn-overwrite";

/** Whether a seed edit may regenerate silently, or must warn first because
 * regenerating would overwrite content the seeds did not produce (a theme
 * never generated, or fine-tuned in the full editor since generation). */
export function seedEditPlan(doc: ThemeDocument): SeedEditPlan {
  return doc.seeds && fingerprintMatches(doc) ? "regenerate" : "warn-overwrite";
}

// Row-major order for the 4-column grid, pairing each column vertically:
// background/text, primary/success, warning/error, diff added/removed.
const SEED_LABELS: { key: keyof ThemeSeeds; label: string }[] = [
  { key: "background", label: "Background" },
  { key: "primary", label: "Primary" },
  { key: "warning", label: "Warning" },
  { key: "diffAdded", label: "Diff added" },
  { key: "text", label: "Text" },
  { key: "success", label: "Success" },
  { key: "error", label: "Error" },
  { key: "diffRemoved", label: "Diff removed" },
];

const SWATCH_STYLE: React.CSSProperties = {
  width: "calc(var(--ui-font-size) * 3)",
  height: "calc(var(--ui-font-size) * 2)",
  padding: 0,
  border: "1px solid var(--panel-border)",
  borderRadius: 4,
  background: "transparent",
};

/** One seed swatch. Dragging in the picker only updates the local value;
 * the derivation (and any overwrite confirm) runs ONCE on the native
 * `change` event - React's `onChange` fires for every intermediate value
 * while picking, which would queue a confirm dialog per wiggle (same
 * WebView behaviour PaletteEditor works around). */
function SeedSwatch({
  label,
  value,
  disabled,
  onCommit,
}: {
  label: string;
  value: string;
  disabled: boolean;
  onCommit: (value: string) => void;
}) {
  const [picker, setPicker] = useState(value);
  const commit = useRef(onCommit);
  commit.current = onCommit;

  // Follow outside changes (theme switch, regeneration) - but not mid-drag.
  useEffect(() => setPicker(value), [value]);

  // Callback ref, NOT a mount-time effect: the input is conditionally
  // rendered (read-only shows a static span), so the listener must attach
  // whenever the input APPEARS - a swatch mounted read-only and switched
  // editable later would otherwise never commit.
  const detach = useRef<(() => void) | null>(null);
  const attachPicker = useCallback((el: HTMLInputElement | null) => {
    detach.current?.();
    detach.current = null;
    if (!el) return;
    const onChange = () => commit.current(el.value);
    el.addEventListener("change", onChange);
    detach.current = () => el.removeEventListener("change", onChange);
  }, []);

  return (
    <label
      style={{
        display: "flex",
        alignItems: "center",
        gap: "0.667em",
        fontSize: "var(--fz-md)",
        color: "var(--subtle-fg)",
      }}
    >
      {disabled ? (
        // A plain swatch instead of a disabled <input type="color">: the
        // WebView mutes disabled colour inputs (same as PaletteEditor).
        <span aria-hidden style={{ ...SWATCH_STYLE, display: "inline-block", background: value }} />
      ) : (
        <input
          ref={attachPicker}
          type="color"
          className="legit-color-swatch"
          value={picker}
          aria-label={`${label} seed color`}
          onChange={(e) => setPicker(e.target.value)}
          style={{ ...SWATCH_STYLE, cursor: "pointer" }}
        />
      )}
      {label}
    </label>
  );
}

export function SeedRow({
  working,
  disabled = false,
  onApply,
}: {
  working: ThemeDocument;
  disabled?: boolean;
  /** Receives the regenerated document (palette/tokens/seeds replaced,
   *  identity fields and expert extras carried over). */
  onApply: (next: ThemeDocument) => void;
}) {
  const seeds = working.seeds ?? extractSeeds(working);
  const drifted = working.seeds !== undefined && !fingerprintMatches(working);
  // Computed from the live document - never stale, and a saved generated
  // theme with failing pairs shows its warnings again on reopen.
  const warnings = useMemo(
    () => (working.seeds && fingerprintMatches(working) ? themeContrastFailures(working) : []),
    [working],
  );

  const changeSeed = async (key: keyof ThemeSeeds, value: string) => {
    if (disabled) return;
    if (seedEditPlan(working) === "warn-overwrite") {
      // Workflow prompt, always shown (not gated by the destructive-confirm
      // setting): regenerating replaces hand-made palette/token content.
      const ok = await confirmDialog({
        title: "Regenerate theme",
        message:
          "This theme was not generated from these quick colors. Regenerating replaces its palette and token bindings and removes panel color overrides; fine-tuning made in the Advanced editor below is overwritten.",
        detail: working.name,
        confirmLabel: "Regenerate",
      });
      if (!ok) return;
    }
    const { doc } = deriveTheme({ ...seeds, [key]: value }, working.name, working);
    onApply(doc);
  };

  return (
    <div style={{ marginBottom: "1em" }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, minmax(0, max-content))",
          gap: "0.5em 2em",
          justifyItems: "start",
        }}
      >
        {SEED_LABELS.map(({ key, label }) => (
          <SeedSwatch
            key={key}
            label={label}
            value={seeds[key]}
            disabled={disabled}
            onCommit={(value) => void changeSeed(key, value)}
          />
        ))}
      </div>
      <FieldNote>
        Pick the quick colors and the full theme is generated from them with
        readable contrast; everything can still be fine-tuned under Advanced.
      </FieldNote>
      {drifted && (
        <FieldNote>
          Fine-tuned below: changing a quick color regenerates the theme and
          overwrites those edits (you will be asked first).
        </FieldNote>
      )}
      {warnings.length > 0 && (
        <div style={{ color: "var(--warning-fg)", fontSize: "var(--fz-sm)", marginTop: "0.333em" }}>
          Some combinations of these colors cannot reach readable contrast:
          <ul style={{ margin: "0.333em 0 0", paddingLeft: "1.5em" }}>
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
