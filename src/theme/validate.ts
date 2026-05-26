// Front-end validation that mirrors the Rust validator in
// `src-tauri/src/commands/persistence.rs::validate_theme`. We run it here
// too so the Theme Editor can surface errors *before* round-tripping to the
// backend (DESIGN.md §6.5).

import type { ThemeDocument } from "../lib/types";

export interface ValidationError {
  field: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationError[];
  /** Warnings are non-fatal and do not block import. */
  warnings: ValidationError[];
}

const COLOR_HEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const FUNCTIONAL_COLOR = /^(rgb|rgba|hsl|hsla|oklch)\s*\(.*\)\s*$/i;

export function isValidColor(color: unknown): boolean {
  if (typeof color !== "string") return false;
  const trimmed = color.trim();
  return COLOR_HEX.test(trimmed) || FUNCTIONAL_COLOR.test(trimmed);
}

export function validateTheme(value: unknown, knownFormatVersion = 1): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationError[] = [];
  const push = (field: string, message: string) => errors.push({ field, message });

  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, errors: [{ field: "$root", message: "Theme must be a JSON object" }], warnings };
  }

  const obj = value as Record<string, unknown>;

  if (obj.format !== "legit-theme") {
    push("format", "Missing or incorrect `format: \"legit-theme\"`");
    return { ok: false, errors, warnings };
  }

  if (typeof obj.formatVersion !== "number") {
    push("formatVersion", "Missing or non-numeric `formatVersion`");
  } else if (obj.formatVersion > knownFormatVersion) {
    warnings.push({
      field: "formatVersion",
      message: `Theme uses formatVersion ${obj.formatVersion}, newer than this LeGit (max ${knownFormatVersion}). Importing anyway.`,
    });
  }

  if (typeof obj.name !== "string" || obj.name.trim() === "") {
    push("name", "`name` is required and must be a non-empty string");
  }

  const palette = obj.palette;
  if (palette === null || typeof palette !== "object" || Array.isArray(palette)) {
    push("palette", "`palette` must be an object of name -> color");
    return { ok: errors.length === 0, errors, warnings };
  }
  for (const [name, color] of Object.entries(palette as Record<string, unknown>)) {
    if (!isValidColor(color)) {
      push(`palette.${name}`, `Invalid color value: ${JSON.stringify(color)}`);
    }
  }

  const tokens = obj.tokens;
  if (tokens === null || typeof tokens !== "object" || Array.isArray(tokens)) {
    push("tokens", "`tokens` must be an object of token -> palette-name");
    return { ok: errors.length === 0, errors, warnings };
  }
  const paletteKeys = new Set(Object.keys(palette as Record<string, unknown>));
  for (const [token, paletteRef] of Object.entries(tokens as Record<string, unknown>)) {
    if (typeof paletteRef !== "string") {
      push(`tokens.${token}`, `Token must reference a palette name (string)`);
      continue;
    }
    if (!paletteKeys.has(paletteRef)) {
      push(`tokens.${token}`, `References undefined palette name '${paletteRef}'`);
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

/** Best-effort conversion of an arbitrary `unknown` to a typed ThemeDocument
 *  *only* if validation passes. */
export function asTheme(value: unknown): ThemeDocument | null {
  return validateTheme(value).ok ? (value as ThemeDocument) : null;
}
