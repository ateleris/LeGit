import { readdirSync, readFileSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CONTRAST_PAIRS, PALETTE_CONTRACT, TOKEN_CONTRACT } from "./tokens";
import { contrastRatio } from "./contrast";
import { DEFAULT_THEME } from "./defaults";
import { bindingRef, resolveBindingColor } from "./filters";
import type { ThemeTokenBinding } from "../lib/types";
import lightThemeJson from "../../themes/Light.legit-theme.json";
import darkThemeJson from "../../themes/Dark.legit-theme.json";

// Read as a plain file: vite's `?raw` pipeline returns an empty string for
// .css under vitest, so the raw-import shortcut silently checks nothing.
const themeCss = readFileSync(new URL("../styles/theme.css", import.meta.url), "utf8");

// Enforces the "4 places" rule for theme tokens (see CLAUDE.md): every token
// in TOKEN_CONTRACT must exist in defaults.ts, styles/theme.css (:root
// fallback), and all bundled themes — and every binding must point at a real
// palette entry. Adding a token and forgetting a place fails here instead of
// silently rendering with fallback colours.

interface ThemeJson {
  palette: Record<string, string>;
  tokens: Record<string, string | { ref: string; filter: string }>;
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
        DEFAULT_THEME.palette[bindingRef(binding!)],
        `token "${t.name}" binds to unknown palette entry "${JSON.stringify(binding)}" in defaults.ts`,
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
        const ref = typeof binding === "string" ? binding : binding!.ref;
        expect(
          theme.palette[ref],
          `token "${t.name}" binds to unknown palette entry "${JSON.stringify(binding)}" in ${label} theme`,
        ).toBeDefined();
      }
    });
  }
});

// CONTRAST_PAIRS drives the Theme Editor's WCAG section; a pair referencing a
// renamed/removed token would silently check the default fallback instead of
// what the theme renders.
describe("contrast pairs reference contract tokens", () => {
  it("every fg/bg/base in CONTRAST_PAIRS is a TOKEN_CONTRACT name", () => {
    const names = new Set(TOKEN_CONTRACT.map((t) => t.name));
    for (const pair of CONTRAST_PAIRS) {
      expect(names.has(pair.fg), `pair "${pair.label}": unknown fg token "${pair.fg}"`).toBe(true);
      expect(names.has(pair.bg), `pair "${pair.label}": unknown bg token "${pair.bg}"`).toBe(true);
      const bases =
        pair.base === undefined ? [] : typeof pair.base === "string" ? [pair.base] : pair.base;
      for (const base of bases) {
        expect(names.has(base), `pair "${pair.label}": unknown base token "${base}"`).toBe(true);
      }
    }
  });

  it("pair labels are unique (they key the editor rows)", () => {
    const labels = CONTRAST_PAIRS.map((p) => p.label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

// The shipped themes must pass our own readability bar: at least WCAG AA
// (4.5:1) on every contrast pair the Theme Editor surfaces, measured the way
// the editor measures it (translucent backgrounds composited over their base
// surface stack). A palette tweak that drops a pair below AA fails here
// instead of shipping.
describe("built-in themes meet AA on every contrast pair", () => {
  const baseList = (base: string | readonly string[] | undefined): readonly string[] =>
    base === undefined ? [] : typeof base === "string" ? [base] : base;

  for (const [label, theme] of [
    ["Light", lightTheme],
    ["Dark", darkTheme],
  ] as const) {
    it(`${label} scores at least 4.5:1 on every CONTRAST_PAIRS entry`, () => {
      const resolve = (token: string): string => {
        const binding = theme.tokens[token];
        expect(binding, `token "${token}" missing from ${label} theme`).toBeDefined();
        const color = resolveBindingColor(binding as ThemeTokenBinding, theme.palette);
        expect(color, `token "${token}" unresolvable in ${label} theme`).toBeDefined();
        return color!;
      };
      const failures: string[] = [];
      for (const pair of CONTRAST_PAIRS) {
        const ratio = contrastRatio(
          resolve(pair.fg),
          resolve(pair.bg),
          baseList(pair.base).map(resolve),
        );
        if (ratio === null || ratio < 4.5) {
          failures.push(`${pair.label}: ${ratio === null ? "n/a" : ratio.toFixed(2)}`);
        }
      }
      expect(
        failures,
        `${label} theme pairs below AA (4.5:1):\n${failures.join("\n")}`,
      ).toEqual([]);
    });
  }
});

describe("built-in Dark theme is the default theme", () => {
  // The shipped Dark theme and the embedded DEFAULT_THEME (the fallback every
  // theme resolves over) must be the same colours — otherwise "unset" tokens
  // in user themes would render differently from the theme users copy from.
  it("Dark.legit-theme.json palette and tokens equal DEFAULT_THEME", () => {
    expect(darkTheme.palette).toEqual(DEFAULT_THEME.palette);
    expect(darkTheme.tokens).toEqual(DEFAULT_THEME.tokens);
  });
});

// The reverse direction: every contract token must be CONSUMED somewhere
// (`var(--token)` in a component/inline style, a CSS rule, or a `--dv-*`
// mapping). A token nobody reads still shows up as an editable control in
// the Theme Editor and does nothing - and once the contract is public,
// removing it breaks user themes. Catch it before it ships instead.
describe("every contract token is consumed", () => {
  const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

  function listSourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...listSourceFiles(full));
      else if (/\.(ts|tsx|css)$/.test(entry.name) && !/\.test\./.test(entry.name)) out.push(full);
    }
    return out;
  }

  it("every token in TOKEN_CONTRACT is referenced via var() outside theme.css", () => {
    const consumed = new Set<string>();
    for (const file of listSourceFiles(SRC)) {
      // theme.css only *defines* the fallbacks; a token referenced nowhere
      // else is still dead. (applyTheme writes vars generically, so it
      // cannot "consume" any specific token either.)
      if (file.replace(/\\/g, "/").endsWith("styles/theme.css")) continue;
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)/g)) consumed.add(m[1]);
    }
    const dead = TOKEN_CONTRACT.filter((t) => !consumed.has(tokenVar(t.name))).map(
      (t) => t.name,
    );
    expect(
      dead,
      `Tokens defined in TOKEN_CONTRACT but consumed nowhere (dead Theme Editor controls):\n${dead.join("\n")}`,
    ).toEqual([]);
  });
});

// A bogus token name behind a `var()` fallback (e.g. the historical
// `var(--fg, #ccc)` — `--fg` never existed) silently un-themes a colour: the
// fallback becomes the *only* value and the litmus test breaks. Every
// `var(--x…)` reference in the source must resolve to a variable the app
// actually defines.
describe("no references to undefined CSS variables", () => {
  const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

  function listSourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...listSourceFiles(full));
      else if (/\.(ts|tsx|css)$/.test(entry.name) && !/\.test\./.test(entry.name)) out.push(full);
    }
    return out;
  }

  it("every var(--x) reference points at a defined variable", () => {
    // Everything the app defines: declarations in src/styles/*.css, plus the
    // vars applyTheme writes (contract tokens + palette entries).
    const defined = new Set<string>();
    const stylesDir = join(SRC, "styles");
    for (const f of readdirSync(stylesDir)) {
      if (!f.endsWith(".css")) continue;
      const css = readFileSync(join(stylesDir, f), "utf8");
      for (const m of css.matchAll(/(?:^|[\s{;])(--[a-zA-Z0-9-]+)\s*:/gm)) defined.add(m[1]);
    }
    for (const t of TOKEN_CONTRACT) defined.add(tokenVar(t.name));
    for (const p of PALETTE_CONTRACT) defined.add(`--palette-${p.name}`);

    const violations: string[] = [];
    for (const file of listSourceFiles(SRC)) {
      const rel = relative(SRC, file).replace(/\\/g, "/");
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)/g)) {
        const name = m[1];
        if (name.startsWith("--dv-")) continue; // dockview-owned, defined by its CSS
        if (defined.has(name)) continue;
        const line = text.slice(0, m.index!).split("\n").length;
        violations.push(`${rel}:${line}: var(${name}) — no such variable`);
      }
    }
    expect(
      violations,
      `References to undefined CSS variables:\n${violations.join("\n")}`,
    ).toEqual([]);
  });
});
