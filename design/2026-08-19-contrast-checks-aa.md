# Contrast checks: compositing, coverage, and the AA floor for built-ins

*2026-08-19. Updates the Theme Editor's contrast indicator as originally
specified in DESIGN-v0.1 §6.7 ("Contrast indicator"). This note supersedes
that description; the historic file is left unchanged.*

## Motivation

The original contrast indicator compared a foreground and a background token
as raw hex values. Two problems had accumulated since:

1. **Alpha was silently ignored.** Themes lean heavily on translucent washes
   (diff line tints, ref chip fills, selected rows, banners). Scoring a wash
   as if opaque misstates the rendered contrast, in the built-in Dark theme's
   diff pairs by more than a full WCAG tier. The pairs that most needed the
   check were exactly the ones it got wrong.
2. **Coverage was stale.** The pair list predated most of the token contract:
   9 pairs against ~30 user-visible text-on-surface combinations (banners,
   panel tabs, hunk buttons, ref chips, muted text, hover states, ...).

## What changed

### Measurement (`src/theme/contrast.ts`)

- `contrastRatio(fg, bg, base?)` now alpha-composites before measuring. A
  translucent `bg` is composited (source-over) onto its `base` surface; a
  translucent `fg` is composited onto the effective background. Without a
  `base`, a translucent bg keeps the old opaque interpretation.
- `base` accepts a single token's colour or a **layer stack, nearest-first**,
  for surfaces that are themselves translucent. The canonical case is the
  diff word highlight: word bg sits on the line wash, which sits on
  `panel.bg`. The deepest layer is treated as opaque.
- `wcagBadge(null)` is now **"n/a"**, not "Fail". `null` means the colours
  could not be evaluated in JS (functional or named CSS colours are valid
  palette values); the rendered UI may be perfectly readable, so the editor
  shows an unknown state instead of a false failure.

### Pair list (`CONTRAST_PAIRS` in `src/theme/tokens.ts`)

Grown from 9 to 42 entries, each with a `label`, a `group` heading, and an
optional `base` (token or stack). Coverage now includes app chrome, muted and
semantic text, the accent surface, all tab variants, panel and accordion
headers, banners, button hover states, console prompt, the full diff surface
set (lines, word highlights, gutter, hunk header, merge fold, action and
discard buttons), the selected row, and the five main ref chips.

The Theme Editor renders the section grouped, failing pairs first within
their group, with a header caption ("all 42 pairs pass" / "N of 42 pairs
failing") so the collapsed-by-default section is informative at a glance.
Sample swatches nest inside their base surface(s) so translucent backgrounds
preview as they composite in the real UI.

`CONTRAST_PAIRS` is additive-only from the user's perspective (like the token
contract): pairs may be added freely; fg/bg/base names must stay within
`TOKEN_CONTRACT` (enforced by `contract.test.ts`).

## Policy: built-in themes always pass every pair's floor

The shipped Light and Dark themes must meet **every contrast pair's floor**,
measured with the compositing above: **4.5:1 (WCAG AA) by default**, or the
pair's declared `minRatio` where AA is deliberately relaxed (see the syntax
section below). This is enforced by `contract.test.ts` ("built-in themes meet
every contrast pair's floor"): a palette tweak that drops any pair below its
floor fails the suite instead of shipping. Themes created on request should
also aim for the same floors on all pairs; deliberately garish demo themes
are the only exception.

## Syntax highlighting coverage (added later on 2026-08-19)

Syntax colours are read as body text, so they get pairs too - 36 of them
(12 syntax tokens x 3 surfaces), generated programmatically at the end of
`CONTRAST_PAIRS`:

- **On plain code (`panel.bg`): AA (4.5:1).** This is where code is mostly
  read; both built-ins pass (Light's `syn-number`/`syn-type` were darkened
  slightly to clear it).
- **On the added/removed line washes: 3:1 (`minRatio: 3`, the WCAG AA-Large
  tier).** Holding full AA over the washes would force either a washed-out
  syntax palette (muted comments stop looking muted) or near-invisible line
  tints. Both built-ins already cleared 3:1 without changes.
- **On the word highlights: shown, but advisory (`advisory: true`).** Even
  high-contrast tokens only reach ~4.4 over the word washes, and
  keywords/comments sit near 2:1, so any enforceable floor there would push
  the word washes toward invisibility, defeating their purpose (word
  highlights are character-level emphasis spanning a few glyphs, not body
  text). The pairs are still listed so a theme author who cares about
  syntax-highlighted diffs can see and optimise the real numbers: an
  advisory pair shows its ratio and absolute WCAG tier in a neutral colour,
  never counts as "below target", and is not enforced for the built-ins.

In the editor, the contrast groups are individually collapsible (same
localStorage persistence as the top-level sections) with a per-group
"N below target" caption; the large "Syntax highlighting" group starts
collapsed because syntax highlighting in the diff viewer is opt-in. The section caption and
failing-first sorting count "below the pair's floor", while the badge always
names the absolute WCAG tier (its tooltip shows the pair's target).

## The 2026-08-19 retune

Bringing the built-ins up to AA required these changes (all values were
computed as the minimal adjustment that clears 4.5:1 on the pair's worst
composited surface):

**Dark** (mirrored into `defaults.ts` and the `theme.css` fallbacks, which
are pinned equal to Dark by tests):

- `accent-fg` white → deep navy `#183454`. White on the `#4a9eff` accent was
  2.75:1 across the accent surface, active repo tab, and primary button. The
  alternative (darkening the accent itself to hold white text) would have
  changed the theme's look far more than darkening the text.
- `subtle-fg` `#888888` → `#a1a1a1`. Fixes seven pairs at once; the binding
  constraint is muted text on the hunk-header wash, which is lighter than
  the panel.
- Word highlights switched from solid `success`/`danger` fills to dedicated
  translucent washes: new palette entries `diff-added-word` (`#3498db73`)
  and `diff-removed-word` (`#e58e2659`), also added to `PALETTE_CONTRACT`.
  Solid fills could not hold the line text at AA; a strong wash keeps the
  highlight clearly stronger than the 20% line tint while staying readable.

**Light**: same word-wash treatment (`#0369a1a6` / `#b45309bf`), plus
darkening of `subtle-fg`, `warning`, and the current-branch/remote/tag/HEAD
chip foregrounds. `danger-hover` now *darkens* (`#9d4e08`) instead of
lightening: no lighter orange can hold 4.5:1 under white button text.

**Bug found by the retune**: `ColumnHeader.tsx` drew the column drag-drop
indicator with `var(--accent-fg, #4a9eff)`; the fallback betrays that it
always meant `--accent`, and it only looked right while accent-fg happened to
be white. Corrected to `var(--accent)`.

## Adding a new pair (checklist)

When a new fg/bg token combination becomes user-visible text:

1. Add an entry to `CONTRAST_PAIRS` with a unique `label` and a `group`.
2. If the bg can be translucent, set `base` to the surface it renders on;
   use a nearest-first stack if that surface is itself translucent.
3. The floor defaults to AA (4.5:1). Declare `minRatio` only when AA would
   demonstrably neuter the design (document why), never for convenience.
4. Run the theme suites: the floor test will flag the built-ins if they fail
   the new pair; retune them (minimal adjustment, keep the design intent)
   rather than deleting the pair.
