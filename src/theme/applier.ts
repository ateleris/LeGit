// Apply a theme document to the document root by writing CSS custom
// properties (DESIGN-v0.1.md §6.2). No JavaScript is involved in the actual
// re-paint — the browser cascades.

import type { ThemeDocument, ThemeTokenBinding } from "../lib/types";
import { DEFAULT_THEME } from "./defaults";
import { PANEL_OVERRIDE_TOKENS, TOKEN_CONTRACT } from "./tokens";
import { bindingCssValue, bindingRef } from "./filters";

/** Replace `.` with `-` so a token like `panel.header.bg` becomes `panel-header-bg`. */
function tokenToVar(name: string): string {
  return `--${name.replace(/\./g, "-")}`;
}

function paletteVar(name: string): string {
  return `--palette-${name}`;
}

/**
 * Merge the supplied theme onto the built-in default. Unknown tokens are
 * preserved (§6.5), and missing tokens fall back to the default theme's
 * binding.
 */
export function resolveTheme(doc: ThemeDocument): ThemeDocument {
  const merged: ThemeDocument = {
    format: "legit-theme",
    formatVersion: doc.formatVersion ?? 1,
    name: doc.name,
    description: doc.description,
    author: doc.author,
    palette: { ...DEFAULT_THEME.palette, ...doc.palette },
    tokens: { ...DEFAULT_THEME.tokens, ...doc.tokens },
    laneColoredBranchChips: doc.laneColoredBranchChips ?? false,
    laneChipFilters: doc.laneChipFilters,
    stashBaseLaneColor: doc.stashBaseLaneColor ?? false,
    panelOverrides: doc.panelOverrides,
  };

  // For each known token, if it's missing or references an undefined palette
  // entry, fall back to the default's binding.
  for (const t of TOKEN_CONTRACT) {
    const bound = merged.tokens[t.name];
    if (!bound || !merged.palette[bindingRef(bound)]) {
      merged.tokens[t.name] = DEFAULT_THEME.tokens[t.name];
    }
  }
  return merged;
}

/** Write CSS variables for the resolved theme. */
export function applyTheme(doc: ThemeDocument, root: HTMLElement = document.documentElement) {
  const resolved = resolveTheme(doc);

  // Palette first so token vars can reference them.
  for (const [name, color] of Object.entries(resolved.palette)) {
    root.style.setProperty(paletteVar(name), color);
  }

  for (const [tokenName, binding] of Object.entries(resolved.tokens)) {
    root.style.setProperty(tokenToVar(tokenName), tokenCssValue(binding));
  }

  writePanelOverridesStyle(resolved, root.ownerDocument);

  root.dataset.legitTheme = resolved.name;
}

export const PANEL_OVERRIDES_STYLE_ID = "legit-panel-overrides";

// Panel ids are attribute-selector values in a live stylesheet; anything
// beyond this never names a real panel and could escape the selector.
const SAFE_PANEL_ID = /^[A-Za-z0-9_-]+$/;

/**
 * CSS rules for the theme's `panelOverrides`, scoped to each panel wrapper's
 * `data-panel-id` so the cascade re-colours the panel subtree. Tokens outside
 * PANEL_OVERRIDE_TOKENS, bindings referencing an undefined palette entry, and
 * malformed panel ids are skipped. Pass a *resolved* document so refs into
 * the default palette work; "" when nothing applies.
 */
export function panelOverridesCss(doc: ThemeDocument): string {
  const rules: string[] = [];
  for (const [panelId, overrides] of Object.entries(doc.panelOverrides ?? {})) {
    if (!SAFE_PANEL_ID.test(panelId)) continue;
    const decls: string[] = [];
    let borderValue: string | undefined;
    for (const [tokenName, binding] of Object.entries(overrides)) {
      if (!PANEL_OVERRIDE_TOKENS.includes(tokenName)) continue;
      if (doc.palette[bindingRef(binding)] === undefined) continue;
      const value = tokenCssValue(binding);
      if (tokenName === "panel.border") borderValue = value;
      decls.push(`${tokenToVar(tokenName)}: ${value};`);
    }
    if (decls.length > 0) {
      rules.push(`[data-panel-id="${panelId}"] { ${decls.join(" ")} }`);
    }
    if (borderValue !== undefined) {
      // The spaced-chrome group border is painted on .dv-groupview — an
      // ANCESTOR of the panel wrapper, out of the scoped var's reach.
      // Dockview keeps only the ACTIVE panel's element inside
      // .dv-content-container, so this follows the visible tab. The flush
      // look's separator lines are shared between two panels and stay global.
      rules.push(
        `.legit-panel-chrome .dv-groupview:has(.dv-content-container [data-panel-id="${panelId}"]) { border-color: ${borderValue}; }`,
      );
    }
  }
  return rules.join("\n");
}

/** Write (or clear) the dedicated `<style>` holding the panel-override rules. */
function writePanelOverridesStyle(resolved: ThemeDocument, doc: Document) {
  let el = doc.getElementById(PANEL_OVERRIDES_STYLE_ID);
  if (!el) {
    el = doc.createElement("style");
    el.id = PANEL_OVERRIDES_STYLE_ID;
    doc.head.appendChild(el);
  }
  el.textContent = panelOverridesCss(resolved);
}

/** The CSS value a binding resolves to: the palette entry's variable,
 *  possibly wrapped in the filter's `color-mix()` so palette edits still
 *  cascade live. */
function tokenCssValue(binding: ThemeTokenBinding): string {
  return bindingCssValue(binding, `var(${paletteVar(bindingRef(binding))})`);
}
