# Theme Simple Mode Implementation Plan

> **For agentic workers:** execute with superpowers:executing-plans (native,
> in-session). Subagent-driven development is disallowed in this repo.
> NO COMMITS: per the repo owner's standing rule, leave all work uncommitted;
> skip every commit step a workflow would normally add.

**Goal:** Seed-driven theme generation: 7 seed colors derive a complete,
AA-validated `.legit-theme.json`, surfaced in the Theme Editor as a seed row
with the full editor behind an Advanced disclosure.

**Architecture:** A pure derivation module (`src/theme/simple.ts` + small
color math in `src/theme/colorMath.ts`) maps seeds -> full palette, reuses
`DEFAULT_THEME`'s token bindings verbatim, then runs a bounded contrast-fix
pass over `CONTRAST_PAIRS`. The editor gains a `SeedRow` and wraps its
existing content in the `AdvancedSettings` disclosure.

**Tech Stack:** TypeScript only (no Rust changes - `ThemeDocument` is a
frontend-owned schema). Vitest. Existing helpers: `parseHexColor`,
`resolveBindingColor` (filters.ts), `contrastRatio` (contrast.ts),
`CONTRAST_PAIRS`/`PALETTE_CONTRACT` (tokens.ts), `DEFAULT_THEME`
(defaults.ts), `AdvancedSettings` (panels/Settings/primitives.tsx).

**Spec:** design/2026-10-14-theme-simple-mode.md

## Global Constraints

- Derivation must be effectively instant: hard iteration caps, no search;
  pinned by a perf test (50 derivations < 250 ms). A worse-contrast result
  with a warning beats waiting (owner requirement, 2026-10-14).
- Never emit silently-failing themes: cap-exceeded pairs surface as
  warnings returned by `deriveTheme`.
- No em-dashes or center dots in any output. Comments per repo rules.
- `seeds`/`seedFingerprint` are ADDITIVE `ThemeDocument` fields: absent in
  old files, preserved on round-trip, never required.
- Built-in themes are never modified; the editor's existing duplicate-to-
  edit flow is the only path to editing them.
- Every user-visible change gets a CHANGELOG bullet.

## Review Focus

- Seeds containing alpha (user pastes `#rrggbbaa`): seeds normalize to
  opaque; test in Task 3 (`normalizes alpha seeds`).
- Unsatisfiable seed pairs (mid-gray on mid-gray): derivation returns the
  capped theme plus warnings, UI shows them; tests in Tasks 3 and 4.
- Extraction from a theme missing conventional entries (hand-made file
  with gaps): fallback chain to DEFAULT seed values; test in Task 3.
- Regeneration under existing `panelOverrides`: overrides reference
  contract palette names which regeneration always provides - overrides
  must survive untouched; test in Task 3 (`regenerate preserves overrides`).
- Fingerprint stability against key order (JSON from disk vs generated):
  sorted-key serialization; test in Task 3 (`fingerprint ignores key order`).

---

### Task 1: ThemeDocument seed fields + validation round-trip

**Files:**
- Modify: `src/lib/types.ts` (ThemeDocument)
- Modify: `src/theme/validate.ts`
- Test: `src/theme/validate.test.ts`

**Interfaces:**
- Produces: `ThemeSeeds` interface and `ThemeDocument.seeds?: ThemeSeeds`,
  `ThemeDocument.seedFingerprint?: string` used by all later tasks.

- [ ] **Step 1: failing tests** - extend `validate.test.ts`: a valid theme
  with `seeds` (7 hex colors) and `seedFingerprint` validates and both
  fields survive `asTheme`; a theme with a malformed seed color fails
  validation naming the seed; a theme without the fields still validates.

```ts
const SEEDS = {
  background: "#1e1e1e", text: "#e0e0e0", primary: "#4a9eff",
  secondary: "#3fb2a8", error: "#e06c3c", warning: "#d9a033",
  success: "#4a9eff",
};
it("accepts and preserves seeds + fingerprint", () => {
  const doc = { ...validTheme(), seeds: SEEDS, seedFingerprint: "abc123" };
  expect(validateTheme(doc).ok).toBe(true);
  expect(asTheme(doc)?.seeds).toEqual(SEEDS);
  expect(asTheme(doc)?.seedFingerprint).toBe("abc123");
});
it("rejects a malformed seed color", () => {
  const doc = { ...validTheme(), seeds: { ...SEEDS, primary: "blue" } };
  const r = validateTheme(doc);
  expect(r.ok).toBe(false);
  expect(r.errors.some((e) => e.path.includes("seeds.primary"))).toBe(true);
});
```

- [ ] **Step 2: run, confirm FAIL** (`npx vitest run src/theme/validate.test.ts`
  via PowerShell interop).
- [ ] **Step 3: implement** - add to `types.ts`:

```ts
/** Seed colors a simple-mode theme derives from (spec:
 * design/2026-10-14-theme-simple-mode.md). */
export interface ThemeSeeds {
  background: string;
  text: string;
  primary: string;
  secondary: string;
  error: string;
  warning: string;
  success: string;
}
// on ThemeDocument:
seeds?: ThemeSeeds;
/** Hash of the generated palette+tokens; mismatch = edited manually. */
seedFingerprint?: string;
```

  In `validate.ts`, when `seeds` is present require exactly the 7 keys with
  `isValidColor` values; `seedFingerprint` must be a string when present.
- [ ] **Step 4: run, confirm PASS; typecheck** (`tsc --noEmit`).

### Task 2: Color math helpers

**Files:**
- Create: `src/theme/colorMath.ts`
- Test: `src/theme/colorMath.test.ts`
- Modify: `src/theme/filters.ts` (export `formatHex` if not yet exported)

**Interfaces:**
- Produces (all take/return hex strings, lowercase `#rrggbb` or
  `#rrggbbaa`):
  `mixHex(a: string, b: string, t: number): string` (t=0 -> a, alpha from a),
  `withAlphaHex(c: string, alpha: number): string`,
  `luminanceHex(c: string): number` (WCAG relative luminance, 0..1),
  `isLightHex(c: string): boolean` (luminance > 0.45),
  `rotateHueHex(c: string, degrees: number): string`,
  `withLightnessHex(c: string, l: number): string` (HSL lightness 0..1),
  `saturateHex(c: string, factor: number): string`,
  `opaqueHex(c: string): string` (drops alpha).

- [ ] **Step 1: failing tests** - exact-value cases:

```ts
expect(mixHex("#000000", "#ffffff", 0.5)).toBe("#808080");
expect(withAlphaHex("#112233", 0.2)).toBe("#11223333");
expect(isLightHex("#f6f6f6")).toBe(true);
expect(isLightHex("#1e1e1e")).toBe(false);
expect(rotateHueHex("#ff0000", 120)).toBe("#00ff00");
expect(withLightnessHex("#ff0000", 0.9)).toBe("#ffcccc");
expect(opaqueHex("#11223344")).toBe("#112233");
// round-trips and clamping
expect(mixHex("#123456", "#123456", 0.3)).toBe("#123456");
expect(withLightnessHex("#808080", 2)).toBe("#ffffff");
```

- [ ] **Step 2: run, FAIL.**
- [ ] **Step 3: implement** on top of `parseHexColor`; HSL conversion
  local to the module; all outputs rounded then formatted via `formatHex`.
- [ ] **Step 4: run, PASS.**

### Task 3: Derivation engine (`deriveTheme`, `extractSeeds`, fingerprint)

**Files:**
- Create: `src/theme/simple.ts`
- Test: `src/theme/simple.test.ts`

**Interfaces:**
- Consumes: Task 1 types, Task 2 helpers, `DEFAULT_THEME`,
  `PALETTE_CONTRACT`, `CONTRAST_PAIRS`, `resolveBindingColor`,
  `contrastRatio`.
- Produces:
  `deriveTheme(seeds: ThemeSeeds, name: string): { doc: ThemeDocument; warnings: string[] }`
  (doc carries normalized seeds + seedFingerprint; tokens are
  `DEFAULT_THEME.tokens` verbatim; palette covers every
  `PALETTE_CONTRACT` name),
  `extractSeeds(doc: ThemeDocument): ThemeSeeds`,
  `themeFingerprint(doc: ThemeDocument): string` (over sorted-key JSON of
  palette+tokens only),
  `fingerprintMatches(doc: ThemeDocument): boolean`.

- [ ] **Step 1: failing tests** (the engine's contract):

```ts
it("derives a complete palette", () => {
  const { doc } = deriveTheme(DARK_SEEDS, "t");
  for (const e of PALETTE_CONTRACT) expect(doc.palette[e.name]).toBeTruthy();
  expect(doc.tokens).toEqual(DEFAULT_THEME.tokens);
});
it("is deterministic and fingerprinted", () => {
  const a = deriveTheme(DARK_SEEDS, "t").doc;
  const b = deriveTheme(DARK_SEEDS, "t").doc;
  expect(a.palette).toEqual(b.palette);
  expect(a.seedFingerprint).toBe(themeFingerprint(a));
  expect(fingerprintMatches(a)).toBe(true);
  expect(fingerprintMatches({ ...a, palette: { ...a.palette, accent: "#123456" } })).toBe(false);
});
it("fingerprint ignores key order", () => {
  const { doc } = deriveTheme(DARK_SEEDS, "t");
  const reordered = { ...doc, palette: Object.fromEntries(Object.entries(doc.palette).reverse()) };
  expect(themeFingerprint(reordered)).toBe(themeFingerprint(doc));
});
it("normalizes alpha seeds", () => {
  const { doc } = deriveTheme({ ...DARK_SEEDS, primary: "#4a9eff88" }, "t");
  expect(doc.seeds?.primary).toBe("#4a9eff");
});
it("meets every contrast floor for seeds of both polarities", () => {
  for (const seeds of [DARK_SEEDS, LIGHT_SEEDS]) {
    const { doc, warnings } = deriveTheme(seeds, "t");
    expect(warnings).toEqual([]);
    expect(pairFailures(doc)).toEqual([]); // helper mirroring contract.test
  }
});
it("benchmark: seeds extracted from bundled Dark and Light pass all floors", () => {
  for (const file of ["Dark", "Light"]) {
    const theme = loadBundled(file);
    const { doc } = deriveTheme(extractSeeds(theme), theme.name);
    expect(pairFailures(doc)).toEqual([]);
  }
});
it("unsatisfiable seeds warn instead of looping", () => {
  const { warnings } = deriveTheme({ ...DARK_SEEDS, background: "#777777", text: "#888888" }, "t");
  expect(warnings.length).toBeGreaterThan(0);
});
it("extraction falls back on missing entries", () => {
  const sparse = { ...loadBundled("Dark"), palette: { "main-bg": "#101010" } };
  const s = extractSeeds(sparse as ThemeDocument);
  expect(s.background).toBe("#101010");
  expect(isValidColor(s.secondary)).toBe(true);
});
it("stays fast", () => {
  const t0 = performance.now();
  for (let i = 0; i < 50; i++) deriveTheme(DARK_SEEDS, "t");
  expect(performance.now() - t0).toBeLessThan(250);
});
```

- [ ] **Step 2: run, FAIL.**
- [ ] **Step 3: implement.** Structure of `simple.ts`:
  - `normalizeSeeds`: `opaqueHex` + lowercase each seed.
  - Polarity: `const light = isLightHex(seeds.background)`; a
    `toward(t: number)` helper = `mixHex(background, text, t)` and
    `nudge(c, amount)` = lightness +/- per polarity.
  - Palette families exactly as the spec lists them (surface ladder at
    6/10/16% mixes, borders at 22%, subtle-fg at 35% toward background,
    accent-fg by `contrastRatio` vs black/white, semantic hovers nudged,
    ANSI from a fixed hue table normalized per polarity, ref chips from
    primary/secondary hue rotations as `withAlphaHex(h, 0.2)` fills +
    borders + fgs, diff washes as semantic colors at polarity-tuned
    alphas, 12 syntax hues on a 30-degree wheel seeded by primary and
    secondary with polarity-normalized lightness).
  - Contrast pass: for each `CONTRAST_PAIRS` entry resolve fg/bg/base via
    `DEFAULT_THEME.tokens` -> palette, compute `contrastRatio`; while
    below `minRatio ?? 4.5`, step the FG's palette entry lightness away
    from the composited bg by 0.04, max 15 steps; run the whole pass at
    most twice; remaining failures push
    `"<label>: <ratio> < <floor>"` warnings. (Bounded: <= 2 * pairs * 15
    trivial arithmetic steps - the perf test enforces it.)
  - `themeFingerprint`: djb2 hash over `JSON.stringify` with recursively
    sorted keys of `{ palette, tokens }`, hex-encoded.
  - `extractSeeds` fallback chain per seed:
    background `main-bg`, text `main-fg`, primary `accent`,
    secondary `ansi-blue` else `rotateHueHex(primary, 150)`,
    error `danger`, warning `warning`, success `success`; any missing
    entry falls back to the Dark-theme seed constants.
- [ ] **Step 4: run, PASS** (tune ladder constants until the benchmark
  and polarity tests pass; constants live in one `RAMP` table at the top).
- [ ] **Step 5: full theme suite** (`npx vitest run src/theme`) - the
  generated docs are never written to `themes/`, so `contract.test.ts`
  must stay green untouched.

### Task 4: Theme Editor seed row + Advanced disclosure

**Files:**
- Create: `src/panels/ThemeEditor/SeedRow.tsx`
- Modify: `src/panels/ThemeEditor/ThemeEditorPanel.tsx`
- Modify: `CHANGELOG.md`
- Test: `src/panels/ThemeEditor/seedRowLogic.test.ts` (pure decision fn)

**Interfaces:**
- Consumes: Task 3 API, `AdvancedSettings` from
  `../Settings/primitives`, the panel's existing draft state + save path,
  `confirmDialog` (store/confirm) for the overwrite warning.
- Produces: `seedEditPlan(draft: ThemeDocument): "regenerate" | "warn-overwrite"`
  in `SeedRow.tsx` (exported for the test): `"regenerate"` when
  `draft.seeds` exists and `fingerprintMatches(draft)`, else
  `"warn-overwrite"` (covers both no-seeds conversion and manual drift).

- [ ] **Step 1: failing test** for `seedEditPlan` with the three draft
  shapes (seeded+matching, seeded+drifted, seedless).
- [ ] **Step 2: run, FAIL; implement the pure fn; run, PASS.**
- [ ] **Step 3: SeedRow UI.** Seven labeled `<input type="color">`
  swatches (seed values are opaque by construction) laid out in a flex
  row, values from `draft.seeds ?? extractSeeds(draft)`; an "edited
  manually below" `FieldNote` when seeds exist but the fingerprint
  mismatches; derivation warnings rendered as a warning-colored
  `FieldNote` list. On change: if plan is `"warn-overwrite"`, raise
  `confirmDialog` ("Regenerate theme from simple colors?", body: manual
  fine-tuning below will be overwritten) - a workflow prompt, always
  shown; on confirm (or plan `"regenerate"`) call
  `deriveTheme({ ...currentSeeds, [key]: value }, draft.name)`, keep
  `name/author/description/panelOverrides/laneChipFilters` from the
  draft, replace palette+tokens+seeds+fingerprint, and run the panel's
  existing live-apply path.
- [ ] **Step 4: Panel restructure.** In `ThemeEditorPanel`, render
  `<SeedRow .../>` first, then wrap the existing palette/token/contrast/
  overrides content in `<AdvancedSettings defaultOpen={expertShaped}>`
  where `expertShaped = !draft.seeds || !fingerprintMatches(draft)`.
  Mind the read-only built-in path: SeedRow renders disabled there (same
  rule as the rest of the editor).
- [ ] **Step 5: verify.** `tsc --noEmit`; full vitest run; CHANGELOG
  bullet under Added ("Theme Editor: simple mode - pick a handful of
  seed colors and the full theme is generated with AA-safe contrast;
  the detailed palette/token editor moved behind Advanced").

### Task 5: Final verification

- [ ] Full `npx vitest run` green; `tsc --noEmit` clean.
- [ ] Derive a sample theme from odd seeds in a node script, write it to a
  temp file, and run `validateTheme` on the parsed JSON (round-trip
  sanity outside vitest).
- [ ] Leave everything uncommitted.
