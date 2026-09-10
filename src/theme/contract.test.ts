import { readdirSync, readFileSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CONTRAST_PAIRS, PALETTE_CONTRACT, TOKEN_CONTRACT } from "./tokens";
import { contrastRatio } from "./contrast";
import { DEFAULT_THEME } from "./defaults";
import { LANE_CHIP_DEFAULT_FILTERS, bindingRef, makeBinding, resolveBindingColor } from "./filters";
import type { ThemeTokenBinding, TokenFilterId } from "../lib/types";

// Read as a plain file: vite's `?raw` pipeline returns an empty string for
// .css under vitest, so the raw-import shortcut silently checks nothing.
const themeCss = readFileSync(new URL("../styles/theme.css", import.meta.url), "utf8");

// Enforces the "4 places" rule for theme tokens (see CLAUDE.md): every token
// in TOKEN_CONTRACT must exist in defaults.ts, styles/theme.css (:root
// fallback), and all bundled themes — and every binding must point at a real
// palette entry. Adding a token and forgetting a place fails here instead of
// silently rendering with fallback colours.

interface ThemeJson {
  laneColoredBranchChips?: boolean;
  laneChipFilters?: { fg?: TokenFilterId | null; border?: TokenFilterId | null; bg?: TokenFilterId | null };
  name?: string;
  palette: Record<string, string>;
  tokens: Record<string, string | { ref: string; filter: string }>;
}

// Every theme in themes/ ships as a built-in (tauri.conf.json bundles the
// whole directory), so the suites below enumerate the directory instead of a
// hardcoded list — a new bundled theme is enforced the moment the file lands.
const THEMES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "themes");
const THEME_EXT = ".legit-theme.json";
const bundledThemes: readonly (readonly [string, ThemeJson])[] = readdirSync(THEMES_DIR)
  .filter((f) => f.endsWith(THEME_EXT))
  .map(
    (f) =>
      [
        f.slice(0, -THEME_EXT.length),
        JSON.parse(readFileSync(join(THEMES_DIR, f), "utf8")) as ThemeJson,
      ] as const,
  );

describe("bundled theme discovery", () => {
  it("finds the canonical Light and Dark themes", () => {
    const names = bundledThemes.map(([label]) => label);
    expect(names).toContain("Light");
    expect(names).toContain("Dark");
  });

  // The picker and load path address themes by file stem, so a stem that
  // differs from the document's `name` shows users a different name than the
  // theme declares.
  it("every bundled theme's file stem matches its name field", () => {
    for (const [label, theme] of bundledThemes) {
      expect(theme.name, `${label}${THEME_EXT}: name field vs file stem`).toBe(label);
    }
  });
});

const darkTheme = bundledThemes.find(([label]) => label === "Dark")?.[1];

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

  for (const [label, theme] of bundledThemes) {
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

// The shipped themes must pass our own readability bar: every contrast pair
// the Theme Editor surfaces must meet its floor — WCAG AA (4.5:1) by
// default, or the pair's declared `minRatio` (the syntax-over-diff-wash
// pairs use the 3:1 AA-Large tier) — measured the way the editor measures it
// (translucent backgrounds composited over their base surface stack). A
// palette tweak that drops a pair below its floor fails here instead of
// shipping.
describe("built-in themes meet every contrast pair's floor", () => {
  const baseList = (base: string | readonly string[] | undefined): readonly string[] =>
    base === undefined ? [] : typeof base === "string" ? [base] : base;

  for (const [label, theme] of bundledThemes) {
    it(`${label} meets the floor of every CONTRAST_PAIRS entry`, () => {
      const resolve = (token: string): string => {
        const binding = theme.tokens[token];
        expect(binding, `token "${token}" missing from ${label} theme`).toBeDefined();
        const color = resolveBindingColor(binding as ThemeTokenBinding, theme.palette);
        expect(color, `token "${token}" unresolvable in ${label} theme`).toBeDefined();
        return color!;
      };
      const failures: string[] = [];
      for (const pair of CONTRAST_PAIRS) {
        // Advisory pairs (syntax over word highlights) are informational
        // only — no floor to enforce.
        if (pair.advisory) continue;
        const ratio = contrastRatio(
          resolve(pair.fg),
          resolve(pair.bg),
          baseList(pair.base).map(resolve),
        );
        const floor = pair.minRatio ?? 4.5;
        if (ratio === null || ratio < floor) {
          failures.push(
            `${pair.label}: ${ratio === null ? "n/a" : ratio.toFixed(2)} (floor ${floor})`,
          );
        }
      }
      expect(
        failures,
        `${label} theme pairs below their contrast floor:\n${failures.join("\n")}`,
      ).toEqual([]);
    });
  }
});

describe("built-in Dark theme is the default theme", () => {
  // The shipped Dark theme and the embedded DEFAULT_THEME (the fallback every
  // theme resolves over) must be the same colours — otherwise "unset" tokens
  // in user themes would render differently from the theme users copy from.
  it("Dark.legit-theme.json palette and tokens equal DEFAULT_THEME", () => {
    expect(darkTheme).toBeDefined();
    expect(darkTheme!.palette).toEqual(DEFAULT_THEME.palette);
    expect(darkTheme!.tokens).toEqual(DEFAULT_THEME.tokens);
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

// Lane-coloured branch chips derive their background at render time
// (color-mix of the lane colour into the panel bg), which the token-pair
// machinery above cannot see. Mirror the mix numerically: any user can
// duplicate a built-in theme and enable the toggle, so EVERY bundled theme
// must keep the branch-chip text AA over every lane's wash.
// Lane-coloured chips derive every part from the lane colour at render time
// (per-theme laneChipFilters, defaults in LANE_CHIP_DEFAULT_FILTERS) - the
// token-pair machinery above cannot see that. Mirror the recipe numerically:
// any user can duplicate a built-in theme and enable the toggle, so every
// bundled theme must keep the chip label at the 3:1 floor over every lane's
// wash (AA-Large tier, like the syntax-over-diff-wash pairs: hue-derived
// text over a same-hue wash in an opt-in mode; the static default is full
// AA). Built-ins whose raw lane colours cannot carry a label declare a
// stronger fg filter in their own laneChipFilters.
describe("built-in themes keep branch-chip text AA over every lane wash", () => {
  const LANE_TOKENS = [
    "graph.lane.0",
    "graph.lane.1",
    "graph.lane.2",
    "graph.lane.3",
    "graph.lane.4",
    "graph.lane.5",
    "graph.lane.fallback",
  ] as const;

  for (const [label, theme] of bundledThemes) {
    it(`${label} keeps chip text readable over each lane wash`, () => {
      const resolve = (token: string): string => {
        const binding = theme.tokens[token];
        expect(binding, `token "${token}" missing from ${label} theme`).toBeDefined();
        const color = resolveBindingColor(binding as ThemeTokenBinding, theme.palette);
        expect(color, `token "${token}" unresolvable in ${label} theme`).toBeDefined();
        return color!;
      };
      // The lane-chip parts are the LANE colour with the theme's per-part
      // filters (or the defaults) applied - mirror that numerically.
      const filters = { ...LANE_CHIP_DEFAULT_FILTERS, ...(theme.laneChipFilters ?? {}) };
      const lanePart = (laneToken: string, filter: typeof filters.fg): string => {
        const binding = theme.tokens[laneToken];
        expect(binding, `token "${laneToken}" missing from ${label} theme`).toBeDefined();
        const color = resolveBindingColor(
          makeBinding(bindingRef(binding as ThemeTokenBinding), filter ?? null),
          theme.palette,
        );
        expect(color, `lane part unresolvable for "${laneToken}" in ${label}`).toBeDefined();
        return color!;
      };
      const panel = resolve("panel.bg");
      const failures: string[] = [];
      // 3:1 (the AA-Large tier), like the syntax-over-diff-wash pairs: the
      // label is hue-derived text over a same-hue wash, an opt-in aesthetic
      // mode whose static default stays full AA. Raw lane colours measure
      // 3.5-4.4 over their own 15% wash across the built-ins.
      const FLOOR = 3;
      for (const laneToken of LANE_TOKENS) {
        const fg = lanePart(laneToken, filters.fg);
        const bg = lanePart(laneToken, filters.bg);
        const ratio = contrastRatio(fg, bg, panel);
        if (ratio === null || ratio < FLOOR) {
          failures.push(`${laneToken}: ${ratio === null ? "n/a" : ratio.toFixed(2)}`);
        }
      }
      expect(
        failures,
        `${label} theme lane-chip washes below the ${FLOOR}:1 floor:\n${failures.join("\n")}`,
      ).toEqual([]);
    });
  }
});
