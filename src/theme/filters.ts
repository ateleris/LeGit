// Token binding filters — derive a variant colour (hover shade, faded wash)
// from a palette entry, so themes don't need a separate palette colour for
// every state. A binding is either a bare palette name (no filter) or
// `{ ref, filter }`.
//
// The applied CSS uses `color-mix()` over the palette *variable*, so the
// palette → token indirection survives: live palette edits in the Theme
// Editor cascade through filtered tokens with no JS recomputation. The JS
// mirror below resolves concrete colours for the editor's swatches and
// WCAG contrast checks only.

import type { ThemeTokenBinding, TokenFilterId } from "../lib/types";

interface Rgba {
  r: number;
  g: number;
  b: number;
  /** 0..1 */
  a: number;
}

export interface TokenFilterDef {
  id: TokenFilterId;
  /** Dropdown label in the Theme Editor. */
  label: string;
  /** CSS value for the token var, given the palette `var(...)` expression. */
  css: (paletteVarExpr: string) => string;
  /** JS mirror of `css` for swatches/contrast — must match the recipe. */
  apply: (color: Rgba) => Rgba;
}

const mixChannel = (from: number, to: number, weight: number) =>
  Math.round(from + (to - from) * weight);

const mixToward = (c: Rgba, target: { r: number; g: number; b: number }, weight: number): Rgba => ({
  r: mixChannel(c.r, target.r, weight),
  g: mixChannel(c.g, target.g, weight),
  b: mixChannel(c.b, target.b, weight),
  a: c.a,
});

export const TOKEN_FILTERS: readonly TokenFilterDef[] = [
  {
    id: "lighter",
    label: "Lighter",
    css: (v) => `color-mix(in srgb, ${v}, white 15%)`,
    apply: (c) => mixToward(c, { r: 255, g: 255, b: 255 }, 0.15),
  },
  {
    id: "darker",
    label: "Darker",
    css: (v) => `color-mix(in srgb, ${v}, black 15%)`,
    apply: (c) => mixToward(c, { r: 0, g: 0, b: 0 }, 0.15),
  },
  {
    id: "faded",
    label: "Faded (45%)",
    // Mixing with transparent in srgb keeps the rgb and scales the alpha.
    css: (v) => `color-mix(in srgb, ${v}, transparent 55%)`,
    apply: (c) => ({ ...c, a: c.a * 0.45 }),
  },
  {
    id: "subtle",
    label: "Subtle (15%)",
    css: (v) => `color-mix(in srgb, ${v}, transparent 85%)`,
    apply: (c) => ({ ...c, a: c.a * 0.15 }),
  },
] as const;

export const TOKEN_FILTER_IDS: readonly TokenFilterId[] = TOKEN_FILTERS.map((f) => f.id);

const filterById = (id: TokenFilterId): TokenFilterDef | undefined =>
  TOKEN_FILTERS.find((f) => f.id === id);

export function isTokenFilterId(value: unknown): value is TokenFilterId {
  return typeof value === "string" && (TOKEN_FILTER_IDS as readonly string[]).includes(value);
}

// --- binding helpers ---------------------------------------------------------

/** The palette entry a binding references, regardless of form. */
export function bindingRef(binding: ThemeTokenBinding): string {
  return typeof binding === "string" ? binding : binding.ref;
}

/** The binding's filter, or null for the bare (unfiltered) form. */
export function bindingFilter(binding: ThemeTokenBinding): TokenFilterId | null {
  return typeof binding === "string" ? null : binding.filter;
}

/** Build a binding, collapsing "no filter" to the bare string form. */
export function makeBinding(ref: string, filter: TokenFilterId | null): ThemeTokenBinding {
  return filter ? { ref, filter } : ref;
}

/** Rebind to a different palette entry, keeping the filter. */
export function withRef(binding: ThemeTokenBinding, ref: string): ThemeTokenBinding {
  return makeBinding(ref, bindingFilter(binding));
}

/** The CSS value written for a token var, given the palette var expression. */
export function bindingCssValue(binding: ThemeTokenBinding, paletteVarExpr: string): string {
  const filter = bindingFilter(binding);
  const def = filter ? filterById(filter) : undefined;
  return def ? def.css(paletteVarExpr) : paletteVarExpr;
}

// --- JS colour mirror (editor swatches + contrast) ---------------------------

/** Parse a #rgb/#rgba/#rrggbb/#rrggbbaa hex colour; null for other formats. */
export function parseHexColor(color: string): Rgba | null {
  const m = color.trim().match(/^#([0-9a-fA-F]{3,8})$/);
  if (!m) return null;
  let hex = m[1];
  if (hex.length === 3 || hex.length === 4) {
    hex = hex
      .split("")
      .map((c) => c + c)
      .join("");
  }
  if (hex.length !== 6 && hex.length !== 8) return null;
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16),
    a: hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1,
  };
}

function formatHex(c: Rgba): string {
  const h = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  const rgb = `#${h(c.r)}${h(c.g)}${h(c.b)}`;
  return c.a >= 1 ? rgb : `${rgb}${h(c.a * 255)}`;
}

/**
 * Concrete colour for a binding (for editor swatches / contrast checks).
 * Non-hex palette values (rgb()/oklch()/…) can't be filtered in JS — the
 * unfiltered value is returned as a best effort; the *rendered* UI is always
 * correct because the browser evaluates the color-mix().
 */
export function resolveBindingColor(
  binding: ThemeTokenBinding,
  palette: Record<string, string>,
): string | undefined {
  const base = palette[bindingRef(binding)];
  if (base === undefined) return undefined;
  const filter = bindingFilter(binding);
  if (!filter) return base;
  const parsed = parseHexColor(base);
  const def = filterById(filter);
  if (!parsed || !def) return base;
  return formatHex(def.apply(parsed));
}
