# Theme Editor: Simple mode (seed-derived themes)

Status: spec, not implemented. Companion to the token/palette system in
`src/theme/` (contract in `tokens.ts`, resolution in `resolveTheme`).

## Motivation

The full Theme Editor exposes every palette entry and token binding. That
power stays. But most people want to pick a handful of colors and have the
rest follow. Simple mode is that: a small set of SEED colors and a
deterministic derivation that generates a complete, AA-passing theme.

## Shape: a generator, not a new theme format

Simple mode GENERATES an ordinary `.legit-theme.json` (same palette + token
maps the full editor and `contract.test.ts` already understand). No
`formatVersion` bump; everything downstream (contrast suite, panel
overrides, settings sync, later expert editing) works unchanged.

Rejected alternative: palette entries that reference other entries live
(`{ref, filter}` at palette level). It needs a format bump, resolver and
editor changes, and buys nothing the generator doesn't - derivation
happens rarely (on a seed edit), not per frame.

## Seeds

| Seed            | Drives                                                        |
| --------------- | ------------------------------------------------------------- |
| Background      | All surfaces (app, panels, inputs, tabs, console) and washes.  |
| Text            | All foregrounds (main, subtle, headers).                       |
| Primary accent  | Selection, focus, buttons, active tab, markers; a fixed hue
|                 | rotation of it seeds syntax, remote chips and the stash accent.|
| Error           | danger family (error text, danger buttons).                    |
| Warning         | warning family.                                                |
| Success         | success family (verified/success text).                        |
| Diff added      | added diff washes, status-added.                               |
| Diff removed    | removed diff washes, status-deleted.                           |

Derived, never asked: `accent-fg` (black/white by contrast against the
accent), borders (bg/text mix), hover shades, every wash. The semantic trio
is prefilled (colourblind-friendly defaults matching today's built-ins) so
the common flow is really "pick 4 colors".

Polarity (light vs dark) is detected from the Background's luminance and
flips the direction of all lightness ramps. Light themes get DARKER hovers
and faded word washes (see design/2026-08-19-contrast-checks-aa.md and the
theme-authoring notes) - the derivation encodes that rule, not the user.

## Derivation rules (palette families)

Exact constants are an implementation concern, tuned until the benchmark
test (below) passes; the spec fixes the rule SHAPES:

- **Surface ladder**: `main-bg` = Background; `panel-bg`, `input-bg`,
  `console-bg`, `row-selected-bg`, hover washes = Background nudged toward
  Text by fixed steps (direction per polarity). `shadow` = black at fixed
  alpha.
- **Foreground ladder**: `main-fg` = Text; `subtle-fg` = Text mixed toward
  Background; `stderr-fg` from Error.
- **Accent family**: `accent` = Primary; `accent-hover` = polarity-aware
  nudge; `accent-fg` = black/white by contrast ratio.
- **Borders**: `panel-border` = Background/Text mix (~20-25%).
- **Semantic families**: `danger(-hover)`, `warning`, `success` from the
  trio; `status-*` and diff washes reuse them. Diff line/word washes are
  the semantic color at fixed alphas (line weaker than word), flipped
  per polarity so word washes stay AA-compatible on light themes.
- **Ref chips** (~20 entries): per chip type a hue - branch from Primary,
  remote from Secondary, tag/head/stash from wheel rotations - rendered as
  translucent fill + border + fg with polarity-aware lightness, mirroring
  the structure the built-ins use today.
- **Syntax (12) and ANSI (16)**: a hue wheel seeded by Primary and
  Secondary; lightness/saturation normalized against Background so every
  syntax color clears its 3:1 floor over the diff washes, and ANSI darks/
  brights stay distinguishable on the console surface.
- `merge-fold`, checkerboard, dnd overlay: neutral Background/Text mixes.

## The AA guarantee

After derivation, run the same composited contrast checks as
`contract.test.ts` (`CONTRAST_PAIRS`, washes composited over their `base`
stacks). Any failing pair adjusts the DERIVED side (never a seed): walk the
foreground's lightness away from the background in steps until the pair
passes; cap iterations and surface a per-seed warning in the UI if a seed
combination is unsatisfiable (e.g. mid-gray text on mid-gray background).
Generated themes therefore meet the same floors as built-ins by
construction, keeping the "themes aim for AA" rule without the author
knowing it exists.

## Document round-trip

`ThemeDocument` gains two OPTIONAL fields (additive, old files unaffected):

```jsonc
"seeds": { "background": "#...", "text": "#...", "primary": "#...",
            "secondary": "#...", "error": "#...", "warning": "#...",
            "success": "#..." },
"seedFingerprint": "<hash of the generated palette+tokens>"
```

- Editing a seed regenerates palette+tokens and updates the fingerprint.
  Identity and round-trip fields (author, description, $schema, lane chip
  filters, deprecated flags) are carried; panel overrides and custom
  palette entries are CLEARED - generating is a clean slate, and overrides
  may reference entries the generator does not produce.
- If the current palette/tokens no longer match `seedFingerprint` (the
  theme was fine-tuned in the full editor since), the seed row is marked
  "edited manually below" and the first seed edit warns that regenerating
  overwrites that fine-tuning; confirming regenerates and re-stamps.
  Declining leaves the theme untouched.
- A theme WITHOUT seeds shows EXTRACTED seeds (from the conventional
  palette entries: `main-bg`, `main-fg`, `accent`, ...); the first seed
  edit is the conversion, behind the same overwrite warning. There is no
  separate "convert" action. Built-ins are duplicated first (existing
  behaviour), never modified.

## UI (Theme Editor)

No mode switch: the SEED ROW is the editor's default face (swatch color
inputs, the unsatisfiable-seed warning slot, the "edited manually below"
marker), and the ENTIRE current editor (palette, token bindings, panel
overrides) moves into an `AdvancedSettings`-style disclosure below it -
the same progressive-disclosure pattern as the settings sections. The
disclosure auto-opens when the theme is expert-shaped (no seeds yet, or
fingerprint mismatch), so existing hand-tuned themes open looking like
today; a freshly generated simple theme opens with Advanced collapsed.
The existing live-preview path (`applyTheme` on change) covers both
halves unchanged.

## Testing

- `src/theme/simple.ts`: pure `deriveTheme(seeds): ThemeDocument` (+
  `extractSeeds(doc)`), unit-tested: determinism, polarity flip, ladder
  monotonicity, accent-fg choice, fingerprint stability.
- **Benchmark test**: extract seeds from the bundled Dark and Light themes,
  derive, and assert every `CONTRAST_PAIRS` floor passes on the result
  (the generator must be at least as safe as the hand-tuned themes; it
  does NOT have to reproduce them byte-for-byte).
- Adversarial seeds (low-contrast pairs, neon accents) must either pass
  after adjustment or report unsatisfiable - never emit a failing theme.
- Contract suite already covers generated files once saved; no new
  enforcement needed.

## Non-goals

- No live palette references / format bump.
- No auto-migration of existing user themes (conversion is explicit).
- No per-token editing in the seed row - that is what Advanced is for.
- Bundled themes stay hand-tuned; they are benchmarks, not consumers.
