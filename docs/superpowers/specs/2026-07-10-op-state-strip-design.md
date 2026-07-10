# Global op-state strip

**Date:** 2026-07-10
**Status:** approved

## Problem

The op-state banner (the only Continue / Skip / Abort surface for an
in-progress merge, rebase, cherry-pick, or revert) renders inside the
Working Changes panel. With that panel closed, a repo mid-operation shows no
trace of the state anywhere and offers no way to abort it. Reproduced in the
test repo (`../LeGit-Test`): merge started, all changes unstaged and
discarded, MERGE_HEAD still present, UI silent.

The backend is correct: `op_state()` reports `Merge` from MERGE_HEAD alone,
and `git merge --abort` succeeds on a clean tree. This is purely a missing
UI surface.

## Invariant

An in-progress multi-step git operation must always be visible and always
abortable, regardless of which panels are open.

## Design

Hoist the banner out of Working Changes into app chrome:

- `src/panels/OpStateStrip.tsx` (moved from
  `src/panels/WorkingChanges/OpStateBanner.tsx`): the existing
  `OpStateBanner` component, behavior unchanged (title per op kind, conflict
  count, Continue disabled while conflicts remain, Skip where applicable,
  Abort with inline destructive confirm gated by `useConfirmDestructive`,
  150ms delayed busy, `OP_DOMAINS` invalidation).
- New container `OpStateStrip` in the same file: reads
  `activeRepoId` from the repo store, `useOpState(activeRepoId)`, and the
  conflict count from the shared `[repoId, "status"]` React Query key
  (same key + fetcher as Working Changes, so the cache is shared and the
  strip's own subscription keeps it watcher-fresh when Working Changes is
  closed). The status query is enabled only while an op is in progress.
  Renders nothing when there is no active repo or op state is `none`.
- `AppLayout` renders `<ActiveRepoOpStateStrip />` directly below
  `RepoTabBar`, above the repo dock, in both `top` and `left` placements.
- `WorkingChangesPanel` drops its banner render and its now-unused
  `useOpState`; `conflictCount` stays (conflict-row menus need it).

No backend changes, no new commands, no new theme tokens (`--op-banner-*`
exist).

## Out of scope (BACKLOG)

Op-state indicator on background repo tabs (a repo other than the active one
can also be mid-operation).

## Verification

- Test repo repro: with Working Changes closed, the strip appears under the
  tab bar ("Merging … · all conflicts resolved") and Abort clears the state.
- `tsc` + vitest suites (vitest from PowerShell), `cargo test -p legit-core`
  untouched by this change.
