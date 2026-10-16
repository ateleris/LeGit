// Simple-mode theme derivation (design/2026-10-14-theme-simple-mode.md):
// seven seed colors deterministically generate a complete theme document.
// Pure and fast by construction - fixed arithmetic per palette entry plus a
// hard-capped contrast-fix pass; a failing pair becomes a warning, never a
// longer search.

import type { ThemeDocument, ThemeSeeds, ThemeTokenBinding } from "../lib/types";
import {
  isLightHex,
  mixHex,
  opaqueHex,
  rotateHueHex,
  saturateHex,
  withAlphaHex,
  withLightnessHex,
} from "./colorMath";
import { contrastRatio } from "./contrast";
import { DEFAULT_THEME } from "./defaults";
import { parseHexColor, resolveBindingColor } from "./filters";
import { CONTRAST_PAIRS } from "./tokens";

export const SEED_KEYS = [
  "background",
  "text",
  "primary",
  "error",
  "warning",
  "success",
  "diffAdded",
  "diffRemoved",
] as const;

/** Fallbacks for extraction from themes missing conventional entries. */
const FALLBACK_SEEDS: ThemeSeeds = {
  background: "#1e1e1e",
  text: "#e0e0e0",
  primary: "#4a9eff",
  error: "#e58e26",
  warning: "#f1fa8c",
  success: "#3498db",
  diffAdded: "#3498db",
  diffRemoved: "#e58e26",
};

/** Mix ratios and alphas of the derivation, light-polarity aware where the
 * two differ. One table so tuning stays in one place. */
const RAMP = {
  surface: 0.04,
  surfaceDeep: 0.08,
  surfaceConsole: 0.03,
  border: 0.22,
  subtleFg: 0.33,
  hoverNudge: { dark: 0.12, light: 0.1 },
  chipFillAlpha: 0.16,
  chipBorderAlpha: 0.45,
  selectedAlpha: 0.2,
  washLine: { dark: 0.2, light: 0.18 },
  washWord: { dark: 0.45, light: 0.3 },
  hunkHeaderAlpha: 0.14,
  groupAlpha: 0.13,
  foldAlpha: 0.15,
  textHue: { dark: 0.68, light: 0.3 },
  ansi: { dark: 0.6, light: 0.38 },
  ansiBright: { dark: 0.72, light: 0.48 },
  lane: { dark: 0.62, light: 0.42 },
  syntax: { dark: 0.72, light: 0.34 },
} as const;

const pick = (table: { dark: number; light: number }, light: boolean) =>
  light ? table.light : table.dark;

function normalizeSeeds(seeds: ThemeSeeds): ThemeSeeds {
  const out = {} as Record<(typeof SEED_KEYS)[number], string>;
  for (const key of SEED_KEYS) out[key] = opaqueHex(seeds[key]).toLowerCase();
  return out;
}

/** Black or white, whichever reads better on `bg`. */
function onColor(bg: string): string {
  const black = contrastRatio("#000000", bg) ?? 0;
  const white = contrastRatio("#ffffff", bg) ?? 0;
  return black >= white ? "#000000" : "#ffffff";
}

export function derivePalette(seeds: ThemeSeeds): Record<string, string> {
  const s = normalizeSeeds(seeds);
  const light = isLightHex(s.background);
  const toward = (t: number) => mixHex(s.background, s.text, t);
  const nudge = (c: string) =>
    mixHex(c, light ? "#000000" : "#ffffff", pick(RAMP.hoverNudge, light));
  // A readable text-ish rendition of an arbitrary hue.
  const textHue = (c: string) => withLightnessHex(c, pick(RAMP.textHue, light));
  const ansiHue = (hue: number, sat = 0.75) =>
    saturateHex(withLightnessHex(rotateHueHex("#ff0000", hue), pick(RAMP.ansi, light)), sat / 0.75);
  const ansiBrightHue = (hue: number) =>
    withLightnessHex(rotateHueHex("#ff0000", hue), pick(RAMP.ansiBright, light));
  const laneHue = (hue: number) => withLightnessHex(rotateHueHex(s.primary, hue), pick(RAMP.lane, light));
  // The former Secondary seed, now derived: a fixed rotation of Primary
  // seeds the syntax wheel, remote chips, and the stash accent.
  const secondary = rotateHueHex(s.primary, 150);
  const synHue = (hue: number) => withLightnessHex(rotateHueHex(secondary, hue), pick(RAMP.syntax, light));
  const chip = (hue: string) => ({
    bg: withAlphaHex(hue, RAMP.chipFillAlpha),
    border: withAlphaHex(hue, RAMP.chipBorderAlpha),
    fg: textHue(hue),
  });

  const branch = chip(s.primary);
  const current = chip(rotateHueHex(s.primary, 110));
  const remote = chip(rotateHueHex(secondary, 60));
  const tag = chip(rotateHueHex(s.primary, 40));
  const head = chip(s.error);

  return {
    "main-bg": s.background,
    "main-fg": s.text,
    "panel-bg": toward(RAMP.surface),
    "panel-border": toward(RAMP.border),
    accent: s.primary,
    "accent-hover": nudge(s.primary),
    "accent-fg": onColor(s.primary),
    danger: s.error,
    "danger-hover": nudge(s.error),
    success: s.success,
    warning: s.warning,
    "subtle-fg": mixHex(s.text, s.background, RAMP.subtleFg),
    shadow: "#00000066",
    "input-bg": toward(RAMP.surfaceDeep),
    "console-bg": mixHex(s.background, light ? "#ffffff" : "#000000", RAMP.surfaceConsole),
    "stderr-fg": textHue(s.error),
    "ansi-black": light ? "#000000" : mixHex(s.background, "#000000", 0.6),
    "ansi-red": ansiHue(0),
    "ansi-green": ansiHue(140),
    "ansi-yellow": ansiHue(55),
    "ansi-blue": ansiHue(225),
    "ansi-magenta": ansiHue(300),
    "ansi-cyan": ansiHue(190),
    "ansi-white": light ? mixHex(s.text, s.background, 0.25) : "#e5e5e5",
    "ansi-bright-black": mixHex(s.text, s.background, 0.55),
    "ansi-bright-red": ansiBrightHue(0),
    "ansi-bright-green": ansiBrightHue(140),
    "ansi-bright-yellow": ansiBrightHue(55),
    "ansi-bright-blue": ansiBrightHue(225),
    "ansi-bright-magenta": ansiBrightHue(300),
    "ansi-bright-cyan": ansiBrightHue(190),
    "ansi-bright-white": light ? "#000000" : "#ffffff",
    "graph-lane-0": laneHue(0),
    "graph-lane-1": laneHue(60),
    "graph-lane-2": laneHue(120),
    "graph-lane-3": laneHue(180),
    "graph-lane-4": laneHue(240),
    "graph-lane-5": laneHue(300),
    "graph-lane-fallback": mixHex(s.text, s.background, 0.45),
    "status-added": textHue(s.diffAdded),
    "status-modified": textHue(s.warning),
    "status-deleted": textHue(s.diffRemoved),
    "status-renamed": textHue(s.primary),
    "row-selected-bg": withAlphaHex(s.primary, RAMP.selectedAlpha),
    "group-bg": withAlphaHex(s.primary, RAMP.groupAlpha),
    "group-fg": textHue(s.primary),
    "ref-branch-bg": branch.bg,
    "ref-branch-border": branch.border,
    "ref-branch-fg": branch.fg,
    "ref-branch-current-bg": current.bg,
    "ref-branch-current-border": current.border,
    "ref-branch-current-fg": current.fg,
    "ref-remote-bg": remote.bg,
    "ref-remote-border": remote.border,
    "ref-remote-fg": remote.fg,
    "ref-tag-bg": tag.bg,
    "ref-tag-border": tag.border,
    "ref-tag-fg": tag.fg,
    "ref-head-bg": head.bg,
    "ref-head-border": head.border,
    "ref-head-fg": head.fg,
    "ref-stash-fg": textHue(secondary),
    "ref-overflow-bg": withAlphaHex(s.text, 0.08),
    "ref-overflow-border": withAlphaHex(s.text, 0.25),
    "ref-other-bg": withAlphaHex(mixHex(s.text, s.background, 0.4), 0.15),
    "ref-other-border": withAlphaHex(mixHex(s.text, s.background, 0.4), 0.35),
    "diff-added-line": withAlphaHex(s.diffAdded, pick(RAMP.washLine, light)),
    "diff-added-word": withAlphaHex(s.diffAdded, pick(RAMP.washWord, light)),
    "diff-removed-line": withAlphaHex(s.diffRemoved, pick(RAMP.washLine, light)),
    "diff-removed-word": withAlphaHex(s.diffRemoved, pick(RAMP.washWord, light)),
    "diff-hunk-header": withAlphaHex(s.primary, RAMP.hunkHeaderAlpha),
    "merge-fold": withAlphaHex(mixHex(s.text, s.background, 0.4), RAMP.foldAlpha),
    "syn-keyword": synHue(0),
    "syn-string": synHue(150),
    "syn-number": synHue(90),
    "syn-comment": mixHex(s.text, s.background, 0.42),
    "syn-function": synHue(60),
    "syn-type": synHue(30),
    "syn-variable": synHue(210),
    "syn-property": synHue(240),
    "syn-operator": mixHex(s.text, s.background, 0.15),
    "syn-punctuation": mixHex(s.text, s.background, 0.35),
    "syn-constant": synHue(270),
    "syn-tag": synHue(330),
  };
}

/** Palette entries the contrast pass may move: derived text-ish colors.
 * Seeds (incl. `main-fg` = the Text seed) and surfaces are authoritative
 * and never adjusted. */
const ADJUSTABLE = (name: string) =>
  name === "subtle-fg" ||
  name === "accent-fg" ||
  name === "stderr-fg" ||
  name === "group-fg" ||
  name.startsWith("syn-") ||
  name.startsWith("status-") ||
  name.startsWith("graph-lane-") ||
  /^ref-.*-fg$/.test(name);

/** Derived translucent washes whose ALPHA may fade as a fallback when the
 * pair's fg is not adjustable (or is pinned the other way). */
const WASH_ADJUSTABLE = (name: string) =>
  name.startsWith("diff-") ||
  name === "merge-fold" ||
  name === "row-selected-bg" ||
  name === "group-bg" ||
  /^ref-.*-bg$/.test(name);

const MAX_STEPS_PER_PAIR = 15;
const MAX_WASH_STEPS = 10;
const PASSES = 2;
const MIN_WASH_ALPHA = 0.04;

function alphaOf(color: string): number {
  return parseHexColor(color)?.a ?? 1;
}

/** Contrast failures of a theme's enforced pairs, resolved like the contract
 * suite (missing tokens fall back to the built-in default binding). Also the
 * single source of simple-mode warnings, so they can never go stale. */
export function themeContrastFailures(doc: ThemeDocument): string[] {
  const color = (token: string): string | undefined => {
    const binding = (doc.tokens[token] ?? DEFAULT_THEME.tokens[token]) as
      | ThemeTokenBinding
      | undefined;
    return binding === undefined ? undefined : resolveBindingColor(binding, doc.palette);
  };
  const failures: string[] = [];
  for (const pair of CONTRAST_PAIRS) {
    if (pair.advisory) continue;
    const fg = color(pair.fg);
    const bg = color(pair.bg);
    if (!fg || !bg) continue;
    const base =
      pair.base === undefined
        ? undefined
        : typeof pair.base === "string"
          ? color(pair.base)
          : pair.base.map((b) => color(b) ?? "");
    const ratio = contrastRatio(fg, bg, base);
    const floor = pair.minRatio ?? 4.5;
    if (ratio !== null && ratio < floor) {
      failures.push(`${pair.label}: contrast ${ratio.toFixed(2)} below ${floor}`);
    }
  }
  return failures;
}

/** Bounded contrast-fix pass; mutates `palette`. Warnings are NOT collected
 * here - deriveTheme reports the FINAL state via themeContrastFailures, so a
 * later adjustment can never silence or invent a warning. Each adjustable
 * entry is pinned to one walk direction: a second pair needing the opposite
 * direction falls through to the wash fallback (or the final warning)
 * instead of oscillating a shared entry and regressing earlier pairs. */
function enforceContrast(palette: Record<string, string>): void {
  const tokens = DEFAULT_THEME.tokens;
  const color = (token: string): string | undefined => {
    const binding = tokens[token] as ThemeTokenBinding | undefined;
    return binding === undefined ? undefined : resolveBindingColor(binding, palette);
  };
  const baseColors = (base: string | readonly string[] | undefined): string | string[] | undefined =>
    base === undefined
      ? undefined
      : typeof base === "string"
        ? color(base)
        : base.map((b) => color(b) ?? "");
  const refOf = (token: string): string | undefined => {
    const binding = tokens[token] as ThemeTokenBinding | undefined;
    return typeof binding === "string" ? binding : binding?.ref;
  };
  const pinnedDirection = new Map<string, string>();
  for (let pass = 0; pass < PASSES; pass++) {
    for (const pair of CONTRAST_PAIRS) {
      if (pair.advisory) continue;
      const floor = pair.minRatio ?? 4.5;
      const ratio = () =>
        contrastRatio(color(pair.fg) ?? "", color(pair.bg) ?? "", baseColors(pair.base));
      let r = ratio();
      if (r === null || r >= floor) continue;
      const fgRef = refOf(pair.fg);
      if (fgRef && ADJUSTABLE(fgRef)) {
        // Walk the fg toward black or white, whichever reads better over
        // the COMPOSITED background (raw bg hex lies for translucent
        // washes: a 15%-alpha gray over a light panel is light, not dark).
        const bg = color(pair.bg) ?? "#000000";
        const base = baseColors(pair.base);
        const white = contrastRatio("#ffffff", bg, base) ?? 0;
        const black = contrastRatio("#000000", bg, base) ?? 0;
        const target = white >= black ? "#ffffff" : "#000000";
        const pinned = pinnedDirection.get(fgRef) ?? target;
        if (!pinnedDirection.has(fgRef)) pinnedDirection.set(fgRef, target);
        if (pinned === target) {
          for (let step = 0; step < MAX_STEPS_PER_PAIR; step++) {
            palette[fgRef] = mixHex(palette[fgRef], target, 0.15);
            r = ratio();
            if (r === null || r >= floor) break;
          }
          if (r !== null && r < floor) {
            // The geometric walk converges short of the target; land on it
            // exactly when that is what it takes.
            palette[fgRef] = target;
            r = ratio();
          }
        }
      }
      if (r !== null && r < floor) {
        // Fallback: fade the wash behind the text (bg side, derived only).
        const bgRef = refOf(pair.bg);
        if (bgRef && WASH_ADJUSTABLE(bgRef) && alphaOf(palette[bgRef]) < 1) {
          for (let step = 0; step < MAX_WASH_STEPS; step++) {
            const alpha = alphaOf(palette[bgRef]) * 0.8;
            if (alpha < MIN_WASH_ALPHA) break;
            palette[bgRef] = withAlphaHex(palette[bgRef], alpha);
            r = ratio();
            if (r === null || r >= floor) break;
          }
        }
      }
    }
  }
}

/** Stable stringify (recursively sorted keys). */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(",")}}`;
}

export function themeFingerprint(doc: ThemeDocument): string {
  const text = stableStringify({ palette: doc.palette, tokens: doc.tokens });
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16);
}

export function fingerprintMatches(doc: ThemeDocument): boolean {
  return doc.seedFingerprint !== undefined && doc.seedFingerprint === themeFingerprint(doc);
}

/** Derive a full theme from seeds. `carryFrom` preserves identity and
 * round-trip fields (author, description, $schema, lane chip filters,
 * deprecated flags) across a regeneration; panel overrides and custom
 * palette entries are cleared - generating is a clean slate. */
export function deriveTheme(
  seeds: ThemeSeeds,
  name: string,
  carryFrom?: ThemeDocument,
): { doc: ThemeDocument; warnings: string[] } {
  const normalized = normalizeSeeds(seeds);
  const palette = derivePalette(normalized);
  enforceContrast(palette);
  const doc: ThemeDocument = {
    format: "legit-theme",
    formatVersion: 1,
    name,
    ...(carryFrom?.$schema !== undefined && { $schema: carryFrom.$schema }),
    ...(carryFrom?.author !== undefined && { author: carryFrom.author }),
    ...(carryFrom?.description !== undefined && { description: carryFrom.description }),
    palette,
    tokens: { ...DEFAULT_THEME.tokens },
    ...(carryFrom?.laneColoredBranchChips !== undefined && {
      laneColoredBranchChips: carryFrom.laneColoredBranchChips,
    }),
    ...(carryFrom?.laneChipFilters !== undefined && { laneChipFilters: carryFrom.laneChipFilters }),
    ...(carryFrom?.stashBaseLaneColor !== undefined && {
      stashBaseLaneColor: carryFrom.stashBaseLaneColor,
    }),
    // Panel overrides are deliberately NOT carried: generating is a clean
    // slate, and overrides may reference palette entries the generator
    // does not produce (the regenerated theme would fail to save).
    seeds: normalized,
  };
  doc.seedFingerprint = themeFingerprint(doc);
  // Warnings describe the FINAL document, computed by the same function the
  // editor uses, so they can neither be silenced by a later adjustment nor
  // go stale against what is rendered.
  return { doc, warnings: themeContrastFailures(doc) };
}

/** Best-effort seeds from any theme, via the conventional palette entries. */
export function extractSeeds(doc: ThemeDocument): ThemeSeeds {
  const entry = (name: string): string | undefined => {
    const value = doc.palette[name];
    return value !== undefined && /^#[0-9a-fA-F]{3,8}$/.test(value.trim()) ? value.trim() : undefined;
  };
  const primary = entry("accent") ?? FALLBACK_SEEDS.primary;
  return normalizeSeeds({
    background: entry("main-bg") ?? FALLBACK_SEEDS.background,
    text: entry("main-fg") ?? FALLBACK_SEEDS.text,
    primary,
    error: entry("danger") ?? FALLBACK_SEEDS.error,
    warning: entry("warning") ?? FALLBACK_SEEDS.warning,
    success: entry("success") ?? FALLBACK_SEEDS.success,
    diffAdded: entry("diff-added-line") ?? entry("success") ?? FALLBACK_SEEDS.diffAdded,
    diffRemoved: entry("diff-removed-line") ?? entry("danger") ?? FALLBACK_SEEDS.diffRemoved,
  });
}
