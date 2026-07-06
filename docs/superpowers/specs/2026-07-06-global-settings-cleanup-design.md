# Global Settings cleanup — design

**Date:** 2026-07-06
**Status:** Implemented 2026-07-06. Shared `SettingsGroup`/`Section`/`Row`/
`FieldNote`/`GitConfigPill` extracted to `Settings/primitives.tsx` (de-duplicating
three copies of `Section`); Global Settings regrouped into four collapsible
categories with a top legend and a `Git config` pill on Line endings + Signing.
`SigningSettings` and `GlobalProfilesSection` now consume the shared primitives.
Repo Settings parity deferred to BACKLOG.

## Context

`GlobalSettingsPanel.tsx` has grown to ~1100 lines and renders a **flat stack of
15 sections** (git executable, layout, appearance, commits graph, diff viewer,
auto-refresh, confirm discard, auto-open panels, working-changes layout, branch
switching, mixed endings, line endings, signing, profiles, about). Each section
hand-rolls its own layout, so the panel has no visual hierarchy and no
consistent field template. Two sections were added this session, worsening it.

Goal: reorder and regroup the settings into a small set of **collapsible
categories**, give the whole panel **one consistent field template**, and make
the **git-config vs instant-LeGit** distinction visible. Pure frontend; **no
settings-storage change** (collapse state lives in `localStorage`).

Finding from the audit: almost every setting writes to LeGit's own global
settings and applies **instantly**. Only **Line endings** and **Signing** write
to actual **git config** (and already carry their own Save/apply controls). The
git-executable path is a LeGit setting with an Apply button.

## Scope

**In:**
- Regroup the 15 sections into **4 collapsible categories** (fixed order):
  1. **Appearance** — UI font size · Global dock placement · Commits graph
     metrics (kept inline; the group's collapse already hides this cluster —
     no extra popover) · Author avatars · Diff syntax highlighting · Working
     Changes layout
  2. **Behavior** — Auto-open panels · Confirm destructive actions · Branch
     switching (dirty behavior, pull strategy) · Auto-refresh · Warn on mixed
     line endings
  3. **Git** — Git executable · Line endings *(git config)* · Signing
     *(git config)* · Identity profiles
  4. **About**
- A **`SettingsGroup`** collapsible component (chevron + title + caption),
  expanded by default, collapse state persisted in `localStorage`
  (`legit.settings-group.<id>`, mirroring the existing `legit.commits-lane-link`
  pattern). No backend/settings change.
- A **`SettingsField`** primitive: `{ title, description?, scope?: "git",
  children }` → renders a title (+ a `Git config` pill when `scope === "git"`),
  a subtle description, and the control, in a consistent two-column layout that
  collapses to stacked at narrow width. All existing sections re-housed into it.
- A one-line **legend** at the top: "Most settings apply instantly. Items
  marked *Git config* change your Git configuration."
- Extract the settings primitives (`SettingsGroup`, `SettingsField`, and the
  existing `Row`) into `Settings/primitives.tsx` to shrink the panel file.

**Out (not now):**
- Left-nav / tabbed layout (rejected: the panel docks narrow).
- Persisting collapse state in backend settings (localStorage is enough).
- Reworking the RepoSettings panel (separate; only shares `SigningSettings`).
- Changing any setting's behavior, storage, or the commands behind them.

## Architecture

Pure frontend, all under `src/panels/Settings/`. No Rust, no new commands, no
settings schema change.

### New primitives — `Settings/primitives.tsx`

```tsx
// Collapsible category. Expanded by default; state persisted in localStorage.
function SettingsGroup({
  id: string,            // stable key for localStorage
  title: string,
  caption?: string,
  children: ReactNode,
}): JSX.Element

// One setting row: title (+ optional "Git config" pill), description, control.
function SettingsField({
  title: string,
  description?: ReactNode,
  scope?: "git",         // default = instant LeGit setting (no pill)
  children: ReactNode,   // the control(s)
}): JSX.Element
```

- `SettingsGroup`: header is a button (chevron + title + caption); toggling
  writes `localStorage["legit.settings-group." + id]`. Read on mount (default
  expanded). Body uses `hidden`/unmount when collapsed. Keyboard-accessible
  (button + `aria-expanded`).
- `SettingsField`: CSS grid `1fr auto`, control right-aligned, description in
  the first column under the title; `@media (max-width)` stacks it. The
  `Git config` pill and the top legend are the only *new* visual elements.

### Panel — `GlobalSettingsPanel.tsx`

- Replace the flat `<Section/>` stack with four `<SettingsGroup>`s in the order
  above, each containing the existing section components re-expressed with
  `SettingsField`.
- The existing per-setting logic (the `useSettingsStore` reads/writes, the
  git-executable Apply flow, line-endings/signing Save flows, profiles) is
  **unchanged** — only its presentation moves into `SettingsField`/`SettingsGroup`.
- Keep `SigningSettings` and `GlobalProfilesSection` as their own components
  (already separate files); wrap their invocation in a `SettingsField`/group.

### Theming & sizing (project conventions)

- **Every colour via `var(--token)`** — enforced by `noLiteralColors.test.ts`.
  The `Git config` pill needs an attention/config colour: reuse an existing
  token (e.g. `--status-modified`) rather than a literal; the "instant"/neutral
  chrome uses `--subtle-fg` / `--panel-border` / `--input-bg`. If no suitable
  token exists for the pill, add one in the 4 required places
  (`tokens.ts`, `defaults.ts`, `styles/theme.css`, both bundled themes) —
  enforced by `contract.test.ts`.
- **Every dimension font-relative** — `--fz-*` / `em` / `calc(var(--ui-font-size)*X)`;
  no fixed px chrome beyond hairlines.

## Error handling

No new failure modes: the underlying commands and their error surfacing are
untouched. A malformed/absent `localStorage` value falls back to "expanded".

## Testing

- **`contract.test.ts` / `noLiteralColors.test.ts`** must stay green (any new
  token added in all 4 places; no colour literals).
- **`tsc --noEmit`** clean.
- Manual/visual verification in the app (run from PowerShell): categories
  collapse/expand and persist across reopen; the git-config pill shows only on
  Line endings + Signing; instant settings still apply immediately; narrow-dock
  layout stacks correctly.
- No meaningful pure logic to unit-test (presentational refactor); the one bit
  of logic (localStorage read/parse) is trivial and covered by the fallback.

## Deferred (→ BACKLOG on completion)

- Persist collapse state server-side / sync across installs.
- Search/filter box over settings (only if the list keeps growing).
