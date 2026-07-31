# File history from the browsed rev

**Date:** 2026-07-31
**Status:** Approved
**Backlog item:** "Files panel rev mode: file history from the browsed rev"

## Problem

The Files panel's browse-at-commit mode (shipped 2026-07-30) lists the tree of
an arbitrary rev, and its context menu offers "File history". That summon
carries only the path, and the backend walk
(`git log --follow -M --name-status -- <path>`) always starts at HEAD.

Verified against real git (2026-07-31, the backlog's claim was imprecise):
a file merely deleted or renamed away since the browsed rev still yields
history from a HEAD walk (git lists the touching commits including the
delete/rename). The genuinely broken cases are:

- **Browsed rev outside HEAD's ancestry** (an old tag or side-branch commit,
  reachable in the walked refs but not from HEAD): the file never existed in
  HEAD's history, so the HEAD walk returns nothing - "File history" comes up
  empty while the user is looking right at the file.
- **Semantic mismatch**: even when non-empty, a HEAD walk includes commits
  newer than the browsed rev - not "the history of the file I am looking
  at".

## Design

Thread an optional **start rev** through the existing file-history vertical
slice. When present, it is inserted as the log's starting revision (before the
`--` pathspec separator); when absent, behavior is unchanged (HEAD walk).

1. **`legit-core`** - `GitBackend::file_history` gains a
   `start_rev: Option<&str>` parameter. `cli_impl` pushes the rev into the
   argument vector immediately before `--`. `--follow`/`-M` behave the same
   when walking from an explicit rev.
2. **Tauri command** - `repo_file_history` gains `start_rev: Option<String>`,
   passed through.
3. **Frontend** - `repoFileHistory` (`src/lib/commands.ts`) gains an optional
   `startRev` argument. `FileHistoryRequest` (the summon payload of the
   File History panel) gains an optional `rev`. The panel stores it alongside
   `path`, includes it in the query key, and passes it to the query. A summon
   with a bare path (or without `rev`) clears it, restoring the HEAD walk.
4. **Files panel wiring** - in browse-at-commit mode, both history entry
   points send `{ path, rev }` instead of the bare path:
   - the context menu's "File history" (`FilesPanel.tsx`, `onHistory`),
   - the row-click `notifyIfOpen("file-history", ...)`.
   Worktree mode keeps sending the bare path. All other summoners (Blame's
   History button, Working Changes / Changed Files rows) are untouched and
   keep the HEAD walk.
5. **Header indicator** - like the Files panel's "at `abc12345`" chip, the
   File History panel shows a small "from `abc12345`" note while the walk
   starts at a rev, so a truncated history is explainable at a glance. It
   disappears when a bare-path summon arrives. Colors come from existing
   theme tokens (reuse the Files panel chip's tokens; no new tokens).

## Out of scope (unchanged)

- Pagination: "Load more" keeps working; the rev rides along in the query
  key, so pages stay consistent per rev.
- Row actions (view / blame / diff / restore): already operate on each
  entry's commit; nothing rev-mode-specific.
- Untracked-at-that-rev files: the menu item already disables for untracked
  files.

## Testing

- **Real git** (`crates/legit-core/tests/git_flows.rs`):
  - side-branch repro: a file added on a branch not merged into main; from
    HEAD the walk is empty, with `start_rev` at the branch tip it returns
    the file's commits (the bug this feature fixes).
  - start-rev scoping: with `start_rev` at a pre-delete commit the walk
    excludes the later delete commit (history matches the browsed tree).
  - one rename case from an explicit rev to confirm `--follow` still tracks
    renames when the walk starts at a rev.
- **Arg construction** (`cli_impl/flow_tests.rs`, `FakeExecutor`): the rev
  lands immediately before `--` when `start_rev` is `Some`, and is absent
  when `None`.
- Frontend wiring is thin (payload field + query key); no new UI seam is
  introduced, so no dedicated frontend unit test beyond what exists.
