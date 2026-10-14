import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import type { ThemeDocument, ThemeSeeds, ThemeTokenBinding } from "../lib/types";
import { CONTRAST_PAIRS, PALETTE_CONTRACT } from "./tokens";
import { contrastRatio } from "./contrast";
import { resolveBindingColor } from "./filters";
import { DEFAULT_THEME } from "./defaults";
import { isValidColor, validateTheme } from "./validate";
import { deriveTheme, extractSeeds, fingerprintMatches, themeFingerprint } from "./simple";

const DARK_SEEDS: ThemeSeeds = {
  background: "#1e1e1e",
  text: "#e0e0e0",
  primary: "#4a9eff",
  error: "#e58e26",
  warning: "#f1fa8c",
  success: "#3498db",
  diffAdded: "#3498db",
  diffRemoved: "#e58e26",
};

const LIGHT_SEEDS: ThemeSeeds = {
  background: "#f6f6f6",
  text: "#1f1f1f",
  primary: "#1d4ed8",
  error: "#a34a08",
  warning: "#8a5206",
  success: "#0369a1",
  diffAdded: "#0369a1",
  diffRemoved: "#a34a08",
};

function loadBundled(name: string): ThemeDocument {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  return JSON.parse(
    readFileSync(join(root, "themes", `${name}.legit-theme.json`), "utf8"),
  ) as ThemeDocument;
}

/** Mirror of contract.test's enforcement: failing non-advisory pairs. */
function pairFailures(doc: ThemeDocument): string[] {
  const color = (token: string): string | undefined => {
    const binding = doc.tokens[token] as ThemeTokenBinding | undefined;
    return binding === undefined ? undefined : resolveBindingColor(binding, doc.palette);
  };
  const failures: string[] = [];
  for (const pair of CONTRAST_PAIRS) {
    if (pair.advisory) continue;
    const fg = color(pair.fg);
    const bg = color(pair.bg);
    if (!fg || !bg) {
      failures.push(`${pair.label}: unresolved token`);
      continue;
    }
    const base =
      pair.base === undefined
        ? undefined
        : typeof pair.base === "string"
          ? color(pair.base)
          : pair.base.map((b) => color(b) ?? "");
    const ratio = contrastRatio(fg, bg, base);
    const floor = pair.minRatio ?? 4.5;
    if (ratio !== null && ratio < floor) {
      failures.push(`${pair.label}: ${ratio.toFixed(2)} < ${floor}`);
    }
  }
  return failures;
}

describe("deriveTheme", () => {
  test("derives a complete palette and reuses the default token map", () => {
    const { doc } = deriveTheme(DARK_SEEDS, "t");
    for (const entry of PALETTE_CONTRACT) {
      expect(doc.palette[entry.name], entry.name).toBeTruthy();
      expect(isValidColor(doc.palette[entry.name]), entry.name).toBe(true);
    }
    // Every DEFAULT_THEME palette entry exists too (tokens reference some
    // entries beyond the contract, e.g. graph lanes).
    for (const name of Object.keys(DEFAULT_THEME.palette)) {
      expect(doc.palette[name], name).toBeTruthy();
    }
    expect(doc.tokens).toEqual(DEFAULT_THEME.tokens);
    expect(doc.name).toBe("t");
    expect(doc.format).toBe("legit-theme");
  });

  test("is deterministic and fingerprinted", () => {
    const a = deriveTheme(DARK_SEEDS, "t").doc;
    const b = deriveTheme(DARK_SEEDS, "t").doc;
    expect(a.palette).toEqual(b.palette);
    expect(a.seedFingerprint).toBe(themeFingerprint(a));
    expect(fingerprintMatches(a)).toBe(true);
    expect(
      fingerprintMatches({ ...a, palette: { ...a.palette, accent: "#123456" } }),
    ).toBe(false);
  });

  test("fingerprint ignores key order", () => {
    const { doc } = deriveTheme(DARK_SEEDS, "t");
    const reordered = {
      ...doc,
      palette: Object.fromEntries(Object.entries(doc.palette).reverse()),
    };
    expect(themeFingerprint(reordered)).toBe(themeFingerprint(doc));
  });

  test("diff washes and file-status colors derive from the diff seeds", () => {
    const seeds = { ...DARK_SEEDS, diffAdded: "#22aa66", diffRemoved: "#cc4477" };
    const { doc } = deriveTheme(seeds, "t");
    expect(doc.palette["diff-added-line"].startsWith("#22aa66")).toBe(true);
    expect(doc.palette["diff-added-word"].startsWith("#22aa66")).toBe(true);
    expect(doc.palette["diff-removed-line"].startsWith("#cc4477")).toBe(true);
    expect(doc.palette["diff-removed-word"].startsWith("#cc4477")).toBe(true);
  });

  test("normalizes alpha seeds to opaque", () => {
    const { doc } = deriveTheme({ ...DARK_SEEDS, primary: "#4a9eff88" }, "t");
    expect(doc.seeds?.primary).toBe("#4a9eff");
  });

  test("meets every contrast floor for seeds of both polarities", () => {
    for (const seeds of [DARK_SEEDS, LIGHT_SEEDS]) {
      const { doc, warnings } = deriveTheme(seeds, "t");
      expect(warnings).toEqual([]);
      expect(pairFailures(doc)).toEqual([]);
    }
  });

  test("benchmark: seeds extracted from bundled Dark and Light pass all floors", () => {
    for (const file of ["Dark", "Light"]) {
      const theme = loadBundled(file);
      const { doc } = deriveTheme(extractSeeds(theme), theme.name);
      expect(pairFailures(doc)).toEqual([]);
    }
  });

  test("unsatisfiable seeds warn instead of looping", () => {
    const { warnings } = deriveTheme(
      { ...DARK_SEEDS, background: "#777777", text: "#888888" },
      "t",
    );
    expect(warnings.length).toBeGreaterThan(0);
  });

  // Seed sets that broke the first contrast-pass implementation (reviewer
  // findings 2026-10-14): shared-entry oscillation, targets only reachable
  // at pure white, popular dark palettes.
  const HARD_SEED_SETS: ThemeSeeds[] = [
    { background: "#111111", text: "#e0e0e0", primary: "#a3a666", error: "#cafe7e", warning: "#d9a033", success: "#dc92b1", diffAdded: "#dc92b1", diffRemoved: "#cafe7e" },
    { ...LIGHT_SEEDS, primary: "#0078d4" },
    { background: "#282a36", text: "#f8f8f2", primary: "#bd93f9", error: "#ff5555", warning: "#f1fa8c", success: "#50fa7b", diffAdded: "#50fa7b", diffRemoved: "#ff5555" },
    DARK_SEEDS,
    LIGHT_SEEDS,
  ];

  test("warnings always equal the FINAL failures (never silent, never stale)", () => {
    for (const seeds of HARD_SEED_SETS) {
      const { doc, warnings } = deriveTheme(seeds, "t");
      const labels = (list: string[]) => list.map((w) => w.split(":")[0]).sort();
      expect(labels(warnings)).toEqual(labels(pairFailures(doc)));
    }
  });

  test("never adjusts the text seed", () => {
    for (const seeds of HARD_SEED_SETS) {
      const { doc } = deriveTheme(seeds, "t");
      expect(doc.palette["main-fg"]).toBe(doc.seeds?.text);
    }
  });

  test("walks a derived fg all the way to pure white when that passes", () => {
    const { warnings } = deriveTheme({ ...LIGHT_SEEDS, primary: "#0078d4" }, "t");
    for (const label of ["Primary button", "Active repo tab", "Accent surface", "Operation banner"]) {
      expect(warnings.some((w) => w.startsWith(label)), label).toBe(false);
    }
  });

  test("stays fast, including adversarial seeds", () => {
    const t0 = performance.now();
    for (let i = 0; i < 10; i++) for (const seeds of HARD_SEED_SETS) deriveTheme(seeds, "t");
    expect(performance.now() - t0).toBeLessThan(500);
  });
});

describe("extractSeeds", () => {
  test("reads the conventional entries", () => {
    const seeds = extractSeeds(loadBundled("Dark"));
    expect(seeds.background).toBe("#1e1e1e");
    expect(seeds.text).toBe("#e0e0e0");
    expect(seeds.primary).toBe("#4a9eff");
    expect(seeds.error).toBe("#e58e26");
  });

  test("falls back on missing entries", () => {
    const sparse = {
      ...loadBundled("Dark"),
      palette: { "main-bg": "#101010" },
    } as ThemeDocument;
    const seeds = extractSeeds(sparse);
    expect(seeds.background).toBe("#101010");
    for (const value of Object.values(seeds)) {
      expect(isValidColor(value)).toBe(true);
    }
  });

  test("regenerate keeps identity + round-trip fields, clears overrides and custom entries", () => {
    const base = deriveTheme(DARK_SEEDS, "Mine").doc;
    const withExtras: ThemeDocument = {
      ...base,
      $schema: "https://example.invalid/legit-theme.json",
      author: "simon",
      description: "d",
      laneColoredBranchChips: true,
      stashBaseLaneColor: true,
      palette: { ...base.palette, "my-pink": "#ff66aa" },
      panelOverrides: { log: { "panel.bg": "my-pink" } },
    };
    const next = deriveTheme(extractSeeds(withExtras), withExtras.name, withExtras).doc;
    expect(next.author).toBe("simon");
    expect(next.description).toBe("d");
    expect(next.$schema).toBe("https://example.invalid/legit-theme.json");
    expect(next.laneColoredBranchChips).toBe(true);
    expect(next.stashBaseLaneColor).toBe(true);
    // Generating is a clean slate for expert content: panel overrides are
    // cleared, so stale custom entries are dropped too and the regenerated
    // theme always saves.
    expect(next.panelOverrides).toBeUndefined();
    expect(next.palette["my-pink"]).toBeUndefined();
    expect(validateTheme(next).ok).toBe(true);
  });
});
