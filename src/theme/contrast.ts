// WCAG 2.x relative luminance + contrast ratio. Used by the Theme Editor's
// contrast indicator (DESIGN.md §6.7).
//
// Themes lean heavily on translucent washes (diff line tints, selected rows,
// ref chip fills), so a naive fg-vs-bg ratio over the raw hex misstates what
// actually renders. `contrastRatio` therefore takes an optional `base` — the
// opaque surface the bg sits on — and alpha-composites bg over base (and fg
// over that result) before measuring, mirroring the browser's source-over
// compositing.

import { parseHexColor } from "./filters";

interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** Source-over composite of a (possibly translucent) color onto an opaque one. */
function compositeOver(top: { r: number; g: number; b: number; a: number }, under: Rgb): Rgb {
  const a = top.a;
  return {
    r: top.r * a + under.r * (1 - a),
    g: top.g * a + under.g * (1 - a),
    b: top.b * a + under.b * (1 - a),
  };
}

function srgbToLinear(channel: number): number {
  const v = channel / 255;
  return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function relativeLuminance(rgb: Rgb): number {
  return (
    0.2126 * srgbToLinear(rgb.r) + 0.7152 * srgbToLinear(rgb.g) + 0.0722 * srgbToLinear(rgb.b)
  );
}

/**
 * WCAG contrast ratio of `fg` text over `bg`. When `bg` is translucent, `base`
 * is the surface it renders on — either one color or a layer stack ordered
 * nearest-first (e.g. a word highlight sits on the line wash on the panel);
 * the deepest layer is treated as opaque. Without a `base` the bg's alpha is
 * dropped, i.e. it is treated as opaque. A translucent `fg` is composited over
 * the effective background before measuring. Returns null for non-hex input
 * (functional or named CSS colors — valid palette values the JS mirror can't
 * evaluate).
 */
export function contrastRatio(
  fg: string,
  bg: string,
  base?: string | readonly string[],
): number | null {
  const fgRgba = parseHexColor(fg);
  const bgRgba = parseHexColor(bg);
  if (!fgRgba || !bgRgba) return null;
  const layers = base === undefined ? [] : typeof base === "string" ? [base] : base;
  let under: Rgb | null = null;
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = parseHexColor(layers[i]);
    if (!layer) return null;
    under = under ? compositeOver(layer, under) : layer;
  }
  const bgEff = under ? compositeOver(bgRgba, under) : bgRgba;
  const fgEff = compositeOver(fgRgba, bgEff);
  const l1 = relativeLuminance(fgEff);
  const l2 = relativeLuminance(bgEff);
  const [lighter, darker] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (lighter + 0.05) / (darker + 0.05);
}

export type WcagBadge = "AAA" | "AA" | "AA Large" | "Fail" | "n/a";

/**
 * Badge for a ratio. `null` means the colors couldn't be evaluated in JS
 * (non-hex palette values) — that is "unknown", not a failure: the rendered
 * UI may be perfectly readable.
 */
export function wcagBadge(ratio: number | null): WcagBadge {
  if (ratio === null) return "n/a";
  if (ratio >= 7) return "AAA";
  if (ratio >= 4.5) return "AA";
  if (ratio >= 3) return "AA Large";
  return "Fail";
}
