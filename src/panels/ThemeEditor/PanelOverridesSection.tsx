import { useState } from "react";
import { DEFAULT_THEME } from "../../theme/defaults";
import { PANEL_OVERRIDE_TOKENS, TOKEN_CONTRACT } from "../../theme/tokens";
import {
  bindingFilter,
  bindingRef,
  resolveBindingColor,
  TOKEN_FILTERS,
} from "../../theme/filters";
import { effectiveBinding } from "../../theme/draftOps";
import { GLOBAL_PANELS, REPO_PANELS } from "../../layout/descriptors";
import type { ThemeDocument, TokenFilterId } from "../../lib/types";
import { SettingsGroup } from "../Settings/primitives";

/**
 * Per-panel token overrides: rebind the PANEL_OVERRIDE_TOKENS for one panel
 * (e.g. give the Commits panel its own background). Only the panel's own
 * subtree is affected — the tab strip, menus, dialogs, and toasts keep the
 * global colours.
 */
export function PanelOverridesSection({
  working,
  readOnly,
  onSet,
}: {
  working: ThemeDocument;
  readOnly: boolean;
  onSet: (panelId: string, token: string, paletteRef: string | null, filter: TokenFilterId | null) => void;
}) {
  const [panelId, setPanelId] = useState("log");
  const overriddenPanels = new Set(Object.keys(working.panelOverrides ?? {}));
  const mergedPalette = { ...DEFAULT_THEME.palette, ...working.palette };
  const entry = working.panelOverrides?.[panelId] ?? {};
  const caption =
    overriddenPanels.size > 0
      ? `${overriddenPanels.size} panel${overriddenPanels.size === 1 ? "" : "s"} overridden`
      : undefined;
  // Overridden panels render bold (font-weight is one of the few styles the
  // WebView applies to native <option>s).
  const optionStyle = (id: string) =>
    overriddenPanels.has(id) ? { fontWeight: 600 } : undefined;

  return (
    <SettingsGroup
      id="theme-editor.panel-overrides"
      title="Panel overrides"
      caption={caption}
      defaultOpen={false}
    >
      <div style={{ color: "var(--subtle-fg)", marginBottom: "0.667em" }}>
        Give a single panel its own surface colours. Panel tabs, menus, and dialogs
        keep the theme's global colours.
      </div>
      <label
        style={{ display: "inline-flex", alignItems: "center", gap: "0.5em", marginBottom: "0.667em" }}
      >
        Panel:
        <select value={panelId} onChange={(e) => setPanelId(e.target.value)}>
          <optgroup label="Repository">
            {REPO_PANELS.map((p) => (
              <option key={p.id} value={p.id} style={optionStyle(p.id)}>
                {p.title}
              </option>
            ))}
          </optgroup>
          <optgroup label="Global">
            {GLOBAL_PANELS.map((p) => (
              <option key={p.id} value={p.id} style={optionStyle(p.id)}>
                {p.title}
              </option>
            ))}
          </optgroup>
        </select>
      </label>
      {PANEL_OVERRIDE_TOKENS.map((token) => {
        const desc = TOKEN_CONTRACT.find((t) => t.name === token);
        const bound = entry[token];
        const boundValid = bound !== undefined && mergedPalette[bindingRef(bound)] !== undefined;
        // Inheriting rows show (dimmed) what the panel actually renders with:
        // the theme-wide effective binding.
        const current = boundValid ? bound : effectiveBinding(working, token);
        const currentRef = boundValid ? bindingRef(bound!) : "";
        const currentFilter = current ? bindingFilter(current) : null;
        const color = current ? resolveBindingColor(current, mergedPalette) : undefined;
        return (
          <div
            key={token}
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr 0.6fr 20px 24px",
              alignItems: "center",
              gap: "0.5em",
              padding: "0.167em 0",
              opacity: boundValid ? 1 : 0.65,
            }}
            title={
              boundValid
                ? `${desc?.documentation ?? token}\n\nOverridden for this panel.`
                : `${desc?.documentation ?? token}\n\nInheriting the theme-wide value. Picking a palette colour overrides it for this panel only.`
            }
          >
            <span style={{ fontFamily: "ui-monospace, monospace", fontSize: "var(--fz-md)" }}>
              {token}
            </span>
            <select
              value={currentRef}
              onChange={(e) =>
                onSet(panelId, token, e.target.value || null, boundValid ? currentFilter : null)
              }
              disabled={readOnly}
            >
              <option value="">Inherit</option>
              {Object.keys(working.palette).map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
            <select
              value={boundValid ? (currentFilter ?? "") : ""}
              title="Derive a variant of the palette colour instead of adding another palette entry"
              onChange={(e) =>
                onSet(panelId, token, currentRef, (e.target.value || null) as TokenFilterId | null)
              }
              disabled={readOnly || !boundValid}
            >
              <option value="">No filter</option>
              {TOKEN_FILTERS.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label}
                </option>
              ))}
            </select>
            {bound !== undefined ? (
              <button
                onClick={() => onSet(panelId, token, null, null)}
                disabled={readOnly}
                title="Remove the override (inherit the theme-wide value)"
                aria-label={`Remove ${token} override for this panel`}
                style={{
                  width: 20,
                  height: 20,
                  padding: 0,
                  lineHeight: 1,
                  fontSize: "var(--fz-md)",
                  background: "transparent",
                  border: "1px solid var(--panel-border)",
                  borderRadius: 3,
                  color: "var(--subtle-fg)",
                  cursor: readOnly ? "default" : "pointer",
                }}
              >
                ↺
              </button>
            ) : (
              <span />
            )}
            <span
              aria-hidden
              style={{
                display: "inline-block",
                width: 16,
                height: 16,
                borderRadius: 3,
                border: "1px solid var(--panel-border)",
                background: color ?? "transparent",
              }}
            />
          </div>
        );
      })}
    </SettingsGroup>
  );
}
