// Apply a theme document to the document root by writing CSS custom
// properties (DESIGN.md §6.2). No JavaScript is involved in the actual
// re-paint — the browser cascades.

import type { ThemeDocument, ThemeTokenBinding } from "../lib/types";
import { DEFAULT_THEME } from "./defaults";
import { TOKEN_CONTRACT } from "./tokens";
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

  root.dataset.legitTheme = resolved.name;
}

/** The CSS value a binding resolves to: the palette entry's variable,
 *  possibly wrapped in the filter's `color-mix()` so palette edits still
 *  cascade live. */
function tokenCssValue(binding: ThemeTokenBinding): string {
  return bindingCssValue(binding, `var(${paletteVar(bindingRef(binding))})`);
}
