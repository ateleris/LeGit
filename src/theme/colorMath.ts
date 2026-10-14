// Small hex-color arithmetic for the simple-mode theme derivation
// (design/2026-10-14-theme-simple-mode.md). All functions take and return
// lowercase hex strings (#rrggbb or #rrggbbaa); non-hex input returns the
// input unchanged, mirroring resolveBindingColor's best-effort stance.

import { formatHex, parseHexColor, type Rgba } from "./filters";

type Hsl = { h: number; s: number; l: number; a: number };

function rgbaToHsl(c: Rgba): Hsl {
  const r = c.r / 255;
  const g = c.g / 255;
  const b = c.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  let s = 0;
  if (d !== 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
    else if (max === g) h = ((b - r) / d + 2) * 60;
    else h = ((r - g) / d + 4) * 60;
  }
  return { h, s, l, a: c.a };
}

function hslToRgba({ h, s, l, a }: Hsl): Rgba {
  const hue = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    hue < 60 ? [c, x, 0]
    : hue < 120 ? [x, c, 0]
    : hue < 180 ? [0, c, x]
    : hue < 240 ? [0, x, c]
    : hue < 300 ? [x, 0, c]
    : [c, 0, x];
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255, a };
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

function mapHsl(color: string, fn: (hsl: Hsl) => Hsl): string {
  const parsed = parseHexColor(color);
  if (!parsed) return color;
  return formatHex(hslToRgba(fn(rgbaToHsl(parsed))));
}

/** Linear interpolation from `a` to `b` (t = 0 -> a); alpha comes from `a`. */
export function mixHex(a: string, b: string, t: number): string {
  const ca = parseHexColor(a);
  const cb = parseHexColor(b);
  if (!ca || !cb) return a;
  const k = clamp01(t);
  return formatHex({
    r: ca.r + (cb.r - ca.r) * k,
    g: ca.g + (cb.g - ca.g) * k,
    b: ca.b + (cb.b - ca.b) * k,
    a: ca.a,
  });
}

export function withAlphaHex(color: string, alpha: number): string {
  const parsed = parseHexColor(color);
  if (!parsed) return color;
  return formatHex({ ...parsed, a: clamp01(alpha) });
}

export function opaqueHex(color: string): string {
  return withAlphaHex(color, 1);
}

/** WCAG relative luminance (0..1) of the color, alpha ignored. */
export function luminanceHex(color: string): number {
  const parsed = parseHexColor(color);
  if (!parsed) return 0;
  const lin = (channel: number) => {
    const v = channel / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(parsed.r) + 0.7152 * lin(parsed.g) + 0.0722 * lin(parsed.b);
}

export function isLightHex(color: string): boolean {
  return luminanceHex(color) > 0.45;
}

export function rotateHueHex(color: string, degrees: number): string {
  return mapHsl(color, (hsl) => ({ ...hsl, h: hsl.h + degrees }));
}

export function withLightnessHex(color: string, lightness: number): string {
  return mapHsl(color, (hsl) => ({ ...hsl, l: clamp01(lightness) }));
}

export function saturateHex(color: string, factor: number): string {
  return mapHsl(color, (hsl) => ({ ...hsl, s: clamp01(hsl.s * factor) }));
}
