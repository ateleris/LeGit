// Mirrors the Rust validator's cases (persistence.rs::validate_theme tests):
// the two validators guard the same import path from opposite sides, and a
// divergence means one side accepts what the other rejects.

import { describe, test, expect } from "vitest";
import { asTheme, isValidColor, validateTheme } from "./validate";

const valid = () => ({
  format: "legit-theme",
  formatVersion: 1,
  name: "My Theme",
  palette: { base: "#101010", accent: "rgba(74, 158, 255, 0.5)" },
  tokens: { "panel.bg": "base", "accent": { ref: "accent", filter: "subtle" } },
});

describe("isValidColor", () => {
  test("accepts hex (3/4/6/8) and functional colors", () => {
    for (const c of ["#fff", "#ffff", "#4a9eff", "#4a9eff33", "rgb(1,2,3)", "hsla(1, 2%, 3%, .5)", "oklch(0.5 0.1 200)"]) {
      expect(isValidColor(c), c).toBe(true);
    }
  });
  test("rejects non-colors", () => {
    for (const c of ["red", "", 42, null, "#12345", "url(x)"]) {
      expect(isValidColor(c), String(c)).toBe(false);
    }
  });
});

describe("validateTheme", () => {
  test("accepts a valid document", () => {
    const r = validateTheme(valid());
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  test("rejects a wrong or missing format marker", () => {
    expect(validateTheme({ ...valid(), format: "nope" }).ok).toBe(false);
    expect(validateTheme({}).ok).toBe(false);
    expect(validateTheme(null).ok).toBe(false);
    expect(validateTheme([]).ok).toBe(false);
  });

  test("rejects an empty name", () => {
    const r = validateTheme({ ...valid(), name: "  " });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.field === "name")).toBe(true);
  });

  test("rejects an invalid palette color", () => {
    const doc = valid();
    doc.palette = { ...doc.palette, bad: "not-a-color" } as never;
    const r = validateTheme(doc);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.field === "palette.bad")).toBe(true);
  });

  test("rejects a token referencing an undefined palette name", () => {
    const doc = valid();
    doc.tokens = { ...doc.tokens, "panel.fg": "ghost" } as never;
    const r = validateTheme(doc);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.field === "tokens.panel.fg")).toBe(true);
  });

  test("rejects an unknown filter id", () => {
    const doc = valid();
    doc.tokens = { ...doc.tokens, "panel.fg": { ref: "base", filter: "sparkle" } } as never;
    const r = validateTheme(doc);
    expect(r.ok).toBe(false);
  });

  test("a newer formatVersion warns but imports", () => {
    const r = validateTheme({ ...valid(), formatVersion: 99 });
    expect(r.ok).toBe(true);
    expect(r.warnings.length).toBe(1);
  });

  test("asTheme gates on validity", () => {
    expect(asTheme(valid())).not.toBeNull();
    expect(asTheme({})).toBeNull();
  });
});
