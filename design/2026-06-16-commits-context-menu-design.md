# Unified Commits panel context menu

**Date:** 2026-06-16
**Status:** Approved design, pending implementation plan

## Goal

Give the Commits panel a single, unified right-click context menu. Every
right-click — anywhere in the panel — opens *our* menu (never the browser's
native menu). Each menu has two tiers:

1. **Contextual entries** (top) — specific to what was clicked (a branch chip,
   the graph column, a column header, …).
2. **Baseline entries** (bottom) — always present regardless of target
   (currently just **Refresh**).

This also removes the standalone **Refresh** toolbar button (it becomes the
baseline menu entry) and reclaims that toolbar space.

The framework is built so future git operations (merge, rebase, cherry-pick,
checkout, copy SHA, …) slot into a chip's or row's contextual section without
touching the menu plumbing.

## Decisions (from brainstorming)

- **One unified menu system** (not separate per-element menus). The existing
  lock menu and column-header menu fold into it.
- **Ordering:** contextual entries on top, baseline at the bottom, separated by
  a divider. Background-only clicks show baseline with no divider.
- **Baseline set:** **Refresh** only, on *every* target (including the column
  header and empty background).
- **`Show locks for this repo…`** is contextual to the **graph column**, not
  baseline.
- **Column show/hide** stays as the **column header's** contextual section
  (same entries as today, just rendered through the unified menu).
- **Native menu suppression:** the panel fully suppresses the browser's default
  context menu (Reload, Save as, Print, Inspect, …) everywhere — replaced by
  our menu, at minimum the baseline.
- **Mechanism:** context provider + "section nodes" (Option 1 below), chosen
  over a centralized DOM-data-attribute handler because the lock section has
  stateful custom UI (input + validation error) that lives most naturally where
  its store access already is.

## 1. Architecture — `PanelContextMenuProvider`

A provider wraps the Commits panel body and owns everything shared:

- the **portal** render, **fixed positioning** with viewport clamping, and
  **dismiss** on outside-click / Escape;
- the shared **menu primitives** — `MenuItem`, `Separator`, `SectionLabel`, and
  the **lane-lock input widget** — extracted once into a shared module;
- the **baseline entries** (Refresh), defined once;
- an **`openMenu(event, contextualSection?)`** API exposed via React context.

### 1.1 The `openMenu` contract

```
openMenu(event: React.MouseEvent, contextualSection?: React.ReactNode): void
```

- Always calls `event.preventDefault()` (kills the native menu) and
  `event.stopPropagation()` (so an inner target wins over an outer one).
- Records `{ x, y }` from the event and the optional `contextualSection`.
- The provider renders, in order:
  1. `contextualSection` (if provided)
  2. a `<Separator/>` (only if a contextual section was provided)
  3. the baseline entries

`contextualSection` is a **React node**, not a data array — this lets a section
carry its own local state and hooks (the lock section's input value + error
live inside its own component).

### 1.2 Shared primitives module

Extract the menu primitives into a single module (e.g.
`src/panels/Commits/menu/`):

- `MenuItem` — replaces the duplicated copies in `RefsCell.tsx` and
  `ColumnHeader.tsx`. Supports `disabled`.
- `Separator`
- `SectionLabel`
- `MenuShell` — the positioned, dismissable portal container (the styling
  currently copy-pasted across `LockContextMenu` and `ColumnContextMenu`).
- `LaneLockSection` — the lock UI (label + 1-based input + Lock button +
  validation), extracted from `RefsCell`'s `LockContextMenu`.

After this, the bespoke `LockContextMenu` and `ColumnContextMenu` portal
components and their per-file `MenuItem`/`Separator` copies are deleted.

## 2. Target map

| Right-click target        | Contextual section (top)                                  | Baseline |
|---------------------------|-----------------------------------------------------------|----------|
| Column header             | Hide this column / Show columns (moved from `ColumnHeader`)| Refresh  |
| Graph column              | Show locks for this repo…                                 | Refresh  |
| Branch / fused chip       | Lock branch to lane… (+ future: merge, rebase…)           | Refresh  |
| Commit row (non-chip)     | *(future: checkout, cherry-pick, copy SHA…)* — none today | Refresh  |
| Empty background          | — (no contextual section, no divider)                     | Refresh  |

The branch-chip section is the existing `LaneLockSection`. The row contextual
section is empty for now, so a right-click on a plain row currently shows just
the baseline — but the wiring exists to add row actions later.

## 3. Wiring per region

- **Panel root** (`CommitsPanel`): wraps its body in `PanelContextMenuProvider`,
  passing the baseline entries (Refresh → existing `refetch`). An `onContextMenu`
  on the scrolling body calls `openMenu(e)` with **no** section for background
  clicks, guaranteeing native-menu suppression even on empty space.
- **`ColumnHeader`**: its `onContextMenu` calls `openMenu(e, <column section>)`.
  It keeps its drag/resize logic; only the menu rendering changes. Each header
  cell still contributes "Hide this column" + the "Show columns" list.
- **`RefsCell` branch chip**: `onContextMenu` calls
  `openMenu(e, <LaneLockSection refName=… />)`. The lock store access and the
  1-based input/validation stay inside `LaneLockSection`.
- **Graph column** (`GraphCell` wrapper / graph cell area): `onContextMenu`
  calls `openMenu(e, <ShowLocksItem/>)`, where the item triggers the panel-level
  lock-list dialog.

## 4. State that moves up

- The **lock-list dialog** (`LockListDialog`, currently owned by `RefsCell`)
  moves to panel level. The graph column's "Show locks for this repo…" entry
  opens it. `RefsCell` no longer owns dialog state.

## 5. Toolbar change

- Remove the **Refresh** `<button>` from `CommitsPanel`'s toolbar.
- The toolbar otherwise keeps the **Loading…** indicator while `isFetching`.
  (If desired later, the toolbar can be made conditional on `isFetching` like
  the Commit Details panel; not required here.)

## 6. Behavior details

- **Positioning:** unchanged from today's menus — clamp `left`/`top` so the menu
  stays inside the viewport. The provider estimates height from the rendered
  content (contextual section height + baseline count) the way
  `ColumnContextMenu` does today, or measures after mount.
- **Dismiss:** outside `mousedown`, Escape, and selecting any item. The
  lock-input row stops propagation on `mousedown` so clicking the input doesn't
  dismiss (preserved from current behavior).
- **Re-open on a new target:** opening a menu while one is open replaces it
  (new target, new position, new section).

## 7. Out of scope (designed-for, not built now)

- merge / rebase / cherry-pick / revert / checkout / copy SHA — these become
  additional `MenuItem`s in the branch-chip and commit-row contextual sections.
  No framework change required to add them.
- A keyboard shortcut to open the menu.
- Drag/resize behavior of column headers (unchanged).

## 8. Files touched (anticipated)

- **New:** `src/panels/Commits/menu/` — `PanelContextMenuProvider`,
  `MenuShell`, `MenuItem`, `Separator`, `SectionLabel`, `LaneLockSection`.
- `src/panels/Commits/CommitsPanel.tsx` — wrap body in provider, supply baseline
  (Refresh), background `onContextMenu`, remove Refresh button, own lock-list
  dialog.
- `src/panels/Commits/cells/RefsCell.tsx` — chip `onContextMenu` → `openMenu`
  with `LaneLockSection`; delete local `LockContextMenu`, `LockListDialog`
  ownership, and duplicated primitives.
- `src/panels/Commits/columns/ColumnHeader.tsx` — `onContextMenu` → `openMenu`
  with the column section; delete `ColumnContextMenu` and duplicated primitives.
- `src/panels/Commits/cells/GraphCell.tsx` (or its row wrapper) — add graph-column
  `onContextMenu` → `openMenu` with the Show-locks item.
