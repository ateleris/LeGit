# Refs panel: unified button design across sections

**Date:** 2026-07-31
**Status:** Approved

## Problem

The Refs panel's sections mix two button designs: Tags and Submodules render
row actions as the shared `ToolbarButton` (ghost `Button`, the Fetch/Pull/Push
look), while Branches, Remotes, Stashes, and Reflog use bare `<button>`
elements (solid `--button-bg` + border). The user wants the Tags design
everywhere.

## Design - one rule for all Refs sections

- Every row/strip ACTION becomes a `ToolbarButton` (ghost):
  - Branches: Checkout, Rename, Delete, Force Delete (and the remote-branch
    row's actions).
  - Remotes: Fetch (keeps its icon via the `icon` prop), Prune, Edit URLs,
    Rename, Remove.
  - Stashes: View diff, Apply, Pop, Branch, Rename, Drop.
  - Reflog: Checkout, Reset (and any other row actions).
- Unchanged (already the Tags design):
  - `Button variant="primary"` for create forms,
  - `Button variant="danger"` for destructive confirms,
  - bare `<button>` ONLY as Cancel/dismiss beside a danger confirm,
  - Remotes' link-style Cancel inside the "Fetching..."/"Pruning..." status
    line (a different affordance).
- No new components or tokens - call sites move onto the existing shared
  `ToolbarButton`/`Button`.

## Testing

Purely presentational JSX; no decision logic changes. Verified by tsc + the
existing suites (theme contract, no-literal-colors) and visually via HMR.
