# Open submodule at the entry's commit (2026-08-06)

## Problem

A changed submodule entry always reads "submodule X changed from `old` to
`new`". "Open submodule" opened the submodule's repo, but the user then had to
hunt for the SHA they had just been shown to inspect the submodule's state at
that pointer.

## Decision

After opening the submodule from a changed-file entry, select the entry's
**new pointer** (`new_sha`) in the submodule's Commits panel - if that commit
still exists locally. Selection only: this never checks the submodule out, it
just drives the log highlight + Commit Details so the state at that commit can
be inspected (Files-at-rev etc. from there).

## Mechanism

`openSubmoduleRepo(repoId, repoPath, path, source)` in `src/lib/submodules.ts`:

1. When `source` (a `DiffSource`) is given, resolve the entry's diff via the
   existing `repoDiff` and take `new_sha` (`submoduleSelectTarget`, pure +
   unit-tested). Resolved BEFORE the repo switch (needs the superproject
   session); best-effort - a failed lookup degrades to a plain open.
2. `openRepo(<repoPath>/<path>)` as before (dedupes by toplevel, activates the
   tab and sets the active repo before resolving).
3. Mirror the full row-click chain (`CommitsPanel.handleRowClick`):
   `summon("log", sha)` + `summon("commit-details", sha)` +
   `swapSummon("changed-files", "working-changes", sha)`. The log's existing
   pending-jump seek grows the fetch window until the commit loads and gives
   up quietly when the walk is exhausted (unfetched / gc'd target), so "if it
   still exists" needs no extra handling.

## The clear-on-repo-switch clobber (found during app verification)

Commit Details and Changed Files clear their selection when the active repo
changes. The chain's payloads are delivered right after `openRepo`, BEFORE
those panels re-render for the submodule repo - the blind clear then wiped
the just-delivered selection, so only the log highlight survived. Fixed by
`useRepoSwitchClear` (`src/panels/shared/`): summon adoption records the repo
the payload was delivered for (the active repo at delivery time), and the
clear effect keeps a selection targeting the repo being switched to. The
marker is one-shot; first-mount StrictMode behavior is preserved. Regression
tests: `useRepoSwitchClear.test.tsx`.

## Call sites and their sources

- Working Changes, unstaged `SubmoduleChanged` row: `working_unstaged`.
- Working Changes, staged `SubmoduleChanged` row: `working_staged`.
- Changed Files (historic commit or stash): `{ kind: "commit", commit_id }` -
  a stash entry is a commit, so the same source works.
- `SubmoduleDirty` rows and the `SubmoduleDirtyNotice` button stay a plain
  open: the pointer is unmoved, there is no commit to jump to.

## Deliberately out of scope

- No checkout of the submodule to the pointer (separate, destructive feature).
- No toast when the target commit is not found locally: the submodule still
  opens (visible feedback), and the give-up path is shared with other jump
  flows.
