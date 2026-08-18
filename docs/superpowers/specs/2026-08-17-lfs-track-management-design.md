# Git LFS track/pattern-management UI

Date: 2026-08-17
Status: approved (design), pending implementation
Related: `2026-08-17-lfs-detection-warning-design.md` (probe slice + settings
section this extends). BACKLOG "Git LFS track/pattern-management UI".

## Scope (decided)

- Entry point: the Repo Settings "Git LFS" section only (no Files context
  menu in v1).
- Managed file: the repo-root `.gitattributes` only (matching `git lfs
  track` run at the root). Nested attribute files with LFS patterns are
  listed read-only.
- Explicitly out: `git lfs migrate` (converting already-committed files),
  file locking, any fetch action (dropped by decision, see BACKLOG).

## Backend (commands/lfs.rs; pure logic unit-tested like the line-endings writer)

Types (types.rs + hand-mirrored TS):
```rust
pub struct LfsPatternsView {
    pub root_patterns: Vec<String>,   // unquoted patterns, root .gitattributes order
    pub nested_files: Vec<String>,    // other .gitattributes files declaring filter=lfs
}
```

- `repo_lfs_patterns(repo_id) -> LfsPatternsView`
  Root: read `<root>/.gitattributes` (missing file = empty), pure
  `parse_lfs_patterns(text) -> Vec<String>`: lines whose attributes include
  `filter=lfs`; the pattern token supports gitattributes double-quoting
  (spaces). Nested: `git grep -l -e filter=lfs -- ':(glob)**/.gitattributes'`
  via the session runner (exit 1 = none), minus the root entry.
- `repo_lfs_track(repo_id, pattern) -> LfsPatternsView`
  Validation (error strings surface adjacent to the input): non-empty after
  trim, no `\n` or NUL, must not start with `#` or `!`. Write form:
  `<pattern> filter=lfs diff=lfs merge=lfs -text`, pattern double-quoted
  when it contains whitespace. Pure
  `add_lfs_pattern(existing: &str, pattern: &str) -> Option<String>`
  (None = already tracked, command no-ops and returns the view), appends at
  the end, preserves existing content, guarantees trailing newline, creates
  the file when missing.
- `repo_lfs_untrack(repo_id, pattern) -> LfsPatternsView`
  Pure `remove_lfs_pattern(existing: &str, pattern: &str) ->
  Result<Option<String>, String>`: Ok(Some(new)) = line removed;
  Ok(None) = pattern not present (no-op); Err(msg) when the matching line
  carries attributes beyond the standard set
  (`filter=lfs diff=lfs merge=lfs -text`, any subset containing
  `filter=lfs`) - the command refuses rather than silently dropping the
  user's other attributes, message says to edit `.gitattributes` directly.

The `.gitattributes` write is a worktree edit: it shows up as an
uncommitted change (watcher -> status domain) and the user commits it
manually, per the no-auto-commit philosophy.

## Frontend

Extends `LfsWarningRepoSection` in RepoSettingsPanel (rename stays; it
hosts warning toggle + status + management). Management block is visible
when `lfs.installed && lfs.initialized` (adoption path: works for a repo
with zero patterns; hidden when git-lfs is broken since committing would
corrupt content). Contents:

- Tracked-pattern rows (monospace) each with an Untrack button. No confirm
  dialog: reversible file edit, not data loss.
- Pattern input + Track button; validation/command errors render adjacent
  to the input (house convention), not as toasts.
- Read-only list of nested attribute files ("LFS patterns also defined
  in: assets/.gitattributes").
- Caption: tracking affects newly added files only; already-committed
  files keep their history (conversion = `git lfs migrate`, not offered);
  the change lands as an uncommitted `.gitattributes` edit.

Data: query `[repoId, "status", "lfs-patterns"]` (watcher refreshes on
outside edits, staleTime 5s) -> `repoLfsPatterns`. Track/untrack use the
returned view to update the cache and additionally invalidate
`[repoId, "lfs"]` so the uses-LFS probe (banner, Files icons) reacts to
the first/last pattern.

## Testing

- Rust unit tests next to the command (like `insert_covers_all_rule`'s):
  parse (plain, quoted, mixed-attr lines, non-LFS lines ignored), add
  (append, quoting, duplicate no-op, missing file, trailing newline),
  remove (standard line removed, absent pattern no-op, extra-attr line
  refused, quoted pattern matched).
- No new real-git case: the only git invocation is the already-pinned
  `git grep` pathspec.
- tsc + full vitest for wiring; no new tokens (contract suites unaffected).
