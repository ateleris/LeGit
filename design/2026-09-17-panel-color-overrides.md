# Per-panel colour overrides (theme-level)

A theme may rebind a curated set of surface tokens for individual panels, so
e.g. the Commits panel can carry a different background than the rest of the
app. Extends the theme format additively (DESIGN.md §6.5/§6.8 rules apply).

## Format

`ThemeDocument.panelOverrides` (optional):

```json
{
  "panelOverrides": {
    "log": {
      "panel.bg": "slate",
      "panel.fg": { "ref": "main-fg", "filter": "lighter" }
    }
  }
}
```

- Keys are panel ids (see `src/panels/descriptors.ts`); values map token ->
  binding, the same palette-ref-or-`{ref, filter}` shape as `tokens`.
- Only the tokens in `PANEL_OVERRIDE_TOKENS` (`src/theme/tokens.ts`) apply:
  `panel.bg`, `panel.fg`, `panel.border`, `panel.header.bg`,
  `panel.header.fg`, `subtle.fg`. The allowlist is part of the user-facing
  contract: adding is safe, removing breaks themes.
- Non-allowlisted tokens and malformed panel ids are preserved in the file,
  warned about on import, and never applied. Bindings to undefined palette
  entries are skipped at apply time (after merging over the default palette).
- `formatVersion` stays 1; absent field = no overrides, old files parse.

## Mechanism

Every panel already renders inside `<div data-panel-id={id}>` (registry
`wrap`). `applyTheme` writes the overrides as scoped rules into a dedicated
`<style id="legit-panel-overrides">`:

```css
[data-panel-id="log"] { --panel-bg: var(--palette-slate); }
```

CSS custom properties cascade, so the whole subtree re-colours with zero
component changes, and the palette -> token indirection survives (live palette
edits keep cascading). Deliberate limits: the dockview tab strip and portal
surfaces (menus, dialogs, toasts) live outside the panel subtree and keep the
global colours.

One piece of chrome is special-cased: the spaced-chrome group border
(`.legit-panel-chrome .dv-groupview`) is painted on an ANCESTOR of the panel
wrapper, out of the scoped var's reach. A `panel.border` override therefore
also emits

```css
.legit-panel-chrome .dv-groupview:has(.dv-content-container [data-panel-id="log"]) { border-color: …; }
```

Dockview keeps only the ACTIVE panel's element inside `.dv-content-container`,
so the group border follows the visible tab. The flush look's separator lines
stay global: one line borders two panels, so no single panel owns it.

## Editor & guards

- Theme Editor section "Panel overrides": panel picker (overridden panels
  marked ●) + one row per allowlisted token with an Inherit option; edits
  live-apply via `updateDraftPanelOverrides`.
- Palette rules extend to overrides: an entry referenced by an override can't
  be deleted; renaming rewrites override bindings
  (`overridePaletteRefs` / `renamePaletteRefInOverrides`).
- `contract.test.ts` re-checks every CONTRAST_PAIRS entry touched by an
  override, per panel, with the override merged over the theme's tokens - a
  built-in shipping an unreadable override fails the suite (currently none
  ship any; the checker is itself pinned by a synthetic failing fixture).

## Non-goals (this slice)

- Per-panel tab-strip colours (`panel.tab.*`): the tabs render outside the
  panel content element; needs separate dockview-level plumbing.
- A user-setting layer independent of the theme: rejected - override bindings
  reference palette entries, and a theme-independent layer would need literal
  colours, breaking the token litmus test.
- Editor contrast feedback for override scopes (the WCAG section shows only
  the global pairs; the contract test covers built-ins).
