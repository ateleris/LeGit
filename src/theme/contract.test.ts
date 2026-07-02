import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PALETTE_CONTRACT, TOKEN_CONTRACT } from "./tokens";
import { DEFAULT_THEME } from "./defaults";
import lightThemeJson from "../../themes/Light.legit-theme.json";
import darkThemeJson from "../../themes/Dark.legit-theme.json";

// Read as a plain file: vite's `?raw` pipeline returns an empty string for
// .css under vitest, so the raw-import shortcut silently checks nothing.
const themeCss = readFileSync(new URL("../styles/theme.css", import.meta.url), "utf8");

// Enforces the "4 places" rule for theme tokens (see CLAUDE.md): every token
// in TOKEN_CONTRACT must exist in defaults.ts, styles/theme.css (:root
// fallback), and both bundled themes — and every binding must point at a real
// palette entry. Adding a token and forgetting a place fails here instead of
// silently rendering with fallback colours.

interface ThemeJson {
  palette: Record<string, string>;
  tokens: Record<string, string>;
}
const lightTheme = lightThemeJson as ThemeJson;
const darkTheme = darkThemeJson as ThemeJson;

const tokenVar = (name: string) => `--${name.replace(/\./g, "-")}`;

describe("theme token contract (4 places)", () => {
  it("DEFAULT_THEME binds every contract token to an existing palette entry", () => {
    for (const t of TOKEN_CONTRACT) {
      const binding = DEFAULT_THEME.tokens[t.name];
      expect(binding, `token "${t.name}" missing from defaults.ts`).toBeDefined();
      expect(
        DEFAULT_THEME.palette[binding!],
        `token "${t.name}" binds to unknown palette entry "${binding}" in defaults.ts`,
      ).toBeDefined();
    }
  });

  it("DEFAULT_THEME palette covers the palette contract", () => {
    for (const p of PALETTE_CONTRACT) {
      expect(
        DEFAULT_THEME.palette[p.name],
        `palette entry "${p.name}" missing from defaults.ts`,
      ).toBeDefined();
    }
  });

  it("theme.css defines a :root fallback var for every contract token", () => {
    for (const t of TOKEN_CONTRACT) {
      expect(
        themeCss.includes(`${tokenVar(t.name)}:`),
        `token "${t.name}" (${tokenVar(t.name)}) missing from styles/theme.css`,
      ).toBe(true);
    }
  });

  for (const [label, theme] of [
    ["Light", lightTheme],
    ["Dark", darkTheme],
  ] as const) {
    it(`${label}.legit-theme.json binds every contract token to an existing palette entry`, () => {
      for (const t of TOKEN_CONTRACT) {
        const binding = theme.tokens[t.name];
        expect(binding, `token "${t.name}" missing from ${label} theme`).toBeDefined();
        expect(
          theme.palette[binding!],
          `token "${t.name}" binds to unknown palette entry "${binding}" in ${label} theme`,
        ).toBeDefined();
      }
    });
  }
});
