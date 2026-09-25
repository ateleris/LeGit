// Pure theme-draft operations behind the Theme Editor: the palette/token
// rules from the project guide (rename auto-rebinds, delete only while
// unreferenced) live here so they are unit-testable without the panel.

import type { ThemeDocument, ThemeTokenBinding } from "../lib/types";
import {
  bindingRef,
  overridePaletteRefs,
  renamePaletteRefInOverrides,
  withRef,
} from "./filters";
import { DEFAULT_THEME } from "./defaults";

export interface RenamePatch {
  palette: Record<string, string>;
  tokens: Record<string, ThemeTokenBinding>;
  /** Present only when the document has overrides to rewrite. */
  panelOverrides?: ThemeDocument["panelOverrides"];
}

/** Rename a palette entry, rebinding every token and panel override that
 * references it. Null for a no-op (empty or unchanged name). */
export function renamePaletteEntry(
  doc: ThemeDocument,
  oldName: string,
  newName: string,
): RenamePatch | null {
  if (!newName || oldName === newName) return null;
  const palette = { ...doc.palette };
  palette[newName] = palette[oldName];
  delete palette[oldName];
  const tokens = { ...doc.tokens };
  for (const [token, binding] of Object.entries(tokens)) {
    if (bindingRef(binding) === oldName) tokens[token] = withRef(binding, newName);
  }
  const patch: RenamePatch = { palette, tokens };
  if (doc.panelOverrides) {
    patch.panelOverrides = renamePaletteRefInOverrides(doc.panelOverrides, oldName, newName);
  }
  return patch;
}

/** Every palette name a token binding or panel override references. */
export function paletteRefsInUse(doc: ThemeDocument): Set<string> {
  return new Set([
    ...Object.values(doc.tokens).map(bindingRef),
    ...overridePaletteRefs(doc.panelOverrides),
  ]);
}

/** Remove a palette entry. Null while a token or panel override still
 * references it (removing would leave the binding dangling). */
export function removePaletteEntry(
  doc: ThemeDocument,
  name: string,
): Record<string, string> | null {
  if (paletteRefsInUse(doc).has(name)) return null;
  const palette = { ...doc.palette };
  delete palette[name];
  return palette;
}

/** Add a fresh black palette entry under a non-colliding `new-color[-N]` name. */
export function addPaletteEntry(doc: ThemeDocument): {
  palette: Record<string, string>;
  name: string;
} {
  let name = "new-color";
  let i = 1;
  while (doc.palette[name]) name = `new-color-${++i}`;
  return { palette: { ...doc.palette, [name]: "#000000" }, name };
}

/** Drop a token's explicit binding so it inherits the built-in default the
 * same way an unset token does (mirrors resolveTheme). */
export function resetToken(
  doc: ThemeDocument,
  token: string,
): Record<string, ThemeTokenBinding> {
  const tokens = { ...doc.tokens };
  delete tokens[token];
  return tokens;
}

/** The binding a token actually renders with (mirrors resolveTheme): the
 * theme's own binding when it exists and points at a defined palette entry,
 * otherwise the built-in default's binding. */
export function effectiveBinding(
  doc: ThemeDocument,
  token: string,
): ThemeTokenBinding | undefined {
  const b = doc.tokens[token];
  return b !== undefined && doc.palette[bindingRef(b)] !== undefined
    ? b
    : DEFAULT_THEME.tokens[token];
}
