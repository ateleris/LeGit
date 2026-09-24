// Front-end validation that mirrors the Rust validator in
// `src-tauri/src/commands/persistence.rs::validate_theme`. We run it here
// too so the Theme Editor can surface errors *before* round-tripping to the
// backend (DESIGN-v0.1.md §6.5).

import type { ThemeDocument } from "../lib/types";
import { isTokenFilterId, TOKEN_FILTER_IDS } from "./filters";
import { PANEL_OVERRIDE_TOKENS } from "./tokens";

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
// The whole value must be ONE colour: palette entries land verbatim in CSS
// custom properties, so a nested `(` would admit `url(...)` and trailing text
// a second declaration. Mirrors `is_valid_color` in persistence.rs.
const FUNCTIONAL_COLOR = /^(rgb|rgba|hsl|hsla|oklch)\([0-9a-z.%,/+\- ]+\)$/i;

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
  // A binding is a bare palette name, or { ref, filter } for derived colours.
  const checkBinding = (field: string, binding: unknown) => {
    let ref: unknown;
    if (typeof binding === "string") {
      ref = binding;
    } else if (binding !== null && typeof binding === "object" && !Array.isArray(binding)) {
      const b = binding as Record<string, unknown>;
      ref = b.ref;
      if (typeof b.ref !== "string") {
        push(field, "`ref` must be a palette name (string)");
        return;
      }
      if (!isTokenFilterId(b.filter)) {
        push(
          field,
          `Unknown filter ${JSON.stringify(b.filter)} (expected one of: ${TOKEN_FILTER_IDS.join(", ")})`,
        );
        return;
      }
    } else {
      push(field, "Token must be a palette name or { ref, filter }");
      return;
    }
    if (!paletteKeys.has(ref as string)) {
      push(field, `References undefined palette name '${ref}'`);
    }
  };
  for (const [token, binding] of Object.entries(tokens as Record<string, unknown>)) {
    checkBinding(`tokens.${token}`, binding);
  }

  const panelOverrides = obj.panelOverrides;
  if (panelOverrides !== undefined) {
    if (panelOverrides === null || typeof panelOverrides !== "object" || Array.isArray(panelOverrides)) {
      push("panelOverrides", "`panelOverrides` must be an object of panel-id -> token -> binding");
      return { ok: errors.length === 0, errors, warnings };
    }
    for (const [panelId, entry] of Object.entries(panelOverrides as Record<string, unknown>)) {
      if (!/^[A-Za-z0-9_-]+$/.test(panelId)) {
        warnings.push({
          field: `panelOverrides.${panelId}`,
          message: "Panel id contains characters LeGit never uses — this override will not apply.",
        });
      }
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        push(`panelOverrides.${panelId}`, "Panel entry must be an object of token -> binding");
        continue;
      }
      for (const [token, binding] of Object.entries(entry as Record<string, unknown>)) {
        if (!PANEL_OVERRIDE_TOKENS.includes(token)) {
          warnings.push({
            field: `panelOverrides.${panelId}.${token}`,
            message: `Not an overridable token (expected one of: ${PANEL_OVERRIDE_TOKENS.join(", ")}) — ignored.`,
          });
        }
        checkBinding(`panelOverrides.${panelId}.${token}`, binding);
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

/** Best-effort conversion of an arbitrary `unknown` to a typed ThemeDocument
 *  *only* if validation passes. */
export function asTheme(value: unknown): ThemeDocument | null {
  return validateTheme(value).ok ? (value as ThemeDocument) : null;
}
