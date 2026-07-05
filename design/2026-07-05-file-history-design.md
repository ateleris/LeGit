# File History panel - design (2026-07-05)

A per-file commit history panel that interoperates with the existing file
panels (Blame, File View, Diff, Commit Details) through the summon mechanism,
the way Blame already does.

## Goals

- Show the commits that touched one file, following renames.
- Every history entry hands off to the other panels: open the commit, view
  the file as of that commit, blame at that commit, show that commit's diff
  of the file, restore the working-tree file to that commit.
- Zero cost to the existing bulk log (the Commits panel's format is a hot
  path and must not grow per-commit file output).

## Non-goals (deliberate, YAGNI)

- Diffing two arbitrary picked versions from the history (Compare exists;
  can be added later as a selection mode).
- A working-tree pseudo-entry at the top of the list.
- Any persistence of panel state beyond the session.

## Backend (vertical slice)

New `GitBackend` method, NOT an extension of `log()`:

```rust
async fn file_history(
    &self,
    path: &Path,
    max_count: u32,
    skip: u32,
) -> Result<Vec<FileHistoryEntry>, GitError>;
```

- Invocation: `git log --follow -M --name-status
  --format=<FILE_HISTORY_FORMAT> --max-count=<n> --skip=<k> -- <path>`.
  `--follow` requires exactly one pathspec, which this API shape guarantees.
- `FileHistoryEntry { commit_id: CommitId, summary: String, author: String,
  timestamp: i64, path: String, old_path: Option<String> }`
  - `path` is the file's name AS OF THAT COMMIT. For commits before a
    rename, git's `--name-status` `R<score>\told\tnew` line gives the
    mapping; the walker emits the old name for older commits. This is what
    keeps "view/blame at this commit" working across renames - summoning
    with today's name against a pre-rename commit would fail.
  - `old_path` is set only on the commit that performed a rename (badge in
    the UI, and the `oldPath` for the Diff summon).
- Parser: pure `text -> Vec<FileHistoryEntry>` in `cli_impl/parsers/`
  (format constant next to it, per convention). Handles `M`/`A`/`D` and
  `R<score>` name-status lines; unknown statuses keep the current path.
- Why not reuse `log()`: file history needs `--follow` + `--name-status`;
  adding those to the shared format would put per-commit file output on the
  Commits panel's hot path and complicate its parser for no gain.

Tauri command `repo_file_history(repo_id, path, max_count, skip)`,
registered in `lib.rs`; wrapper in `lib/commands.ts`; type mirrored in
`lib/types.ts`.

### Tests (both harness levels, per CLAUDE.md)

- Parser unit tests: modified-only history; a rename (`R100`) walks the
  path back; added terminates history.
- `flow_tests.rs`: exact argument vector (incl. `--follow`, `--name-status`,
  `--max-count`/`--skip`, the `--` separator).
- `tests/git_flows.rs` (real git): commit, `git mv`, commit again; assert
  the pre-rename entry reports the old path and `file_at_revision` with
  that (rev, old path) returns the old content.

## Frontend

### Panel

- Registry id `file-history`, title "File History", scope `repo`,
  `defaultPlacement: { direction: "right", referencePanel: "log" }` (same
  family as Blame / File View).
- `summons: ["commit-details", "changed-files", "working-changes",
  "file-view", "blame", "diff"]`.
- Summon payload: `{ path: string }` (bare string also accepted, like
  Blame). Reset on repo switch (Blame's `prevRepoId` pattern).

### Data

- React Query, key `[repoId, "log", "file-history", path, pageCount]` -
  under the `log` domain so history rewrites invalidate it.
- Page size 200; a "Load more" footer fetches the next page via `skip` and
  appends. `staleTime` matching Blame (5s).

### Rows

- Content: subject (primary), then short sha, author, relative date
  (`formatRelative`), and a "renamed from <old>" badge on rename commits.
- Click: Blame's `openCommit` pattern - summon `commit-details` with the
  sha and `swapSummon("changed-files", "working-changes", sha)`.
- Context menu (shared `MenuItem` primitives + `SectionLabel`):
  - View file at this commit -> `summon("file-view", { path: entry.path,
    rev: sha })`
  - Blame at this commit -> `summon("blame", { path: entry.path, rev: sha })`
  - Diff in this commit -> `summon("diff", { repoId, path: entry.path,
    oldPath: entry.old_path, source: { kind: "commit", commit_id: sha } })`
  - Restore file to this commit -> `repoRestoreFileAtRevision(repoId, sha,
    entry.path)` then invalidate `status`/`log`/`diff`; destructive:
    inline menu confirm gated by `useConfirmDestructive()`.
- Busy/loading via the shared `PanelLoadingBar` (already debounced).

### Entry points

- Working Changes: file context menus (both lists), next to "Blame".
- Changed Files: the per-file commit menu (`FileAtCommitMenuSection`).
- Search: path results, next to "Blame".
- Blame: toolbar "History" button; File History's menu offers "Blame at
  this commit" back (reciprocal navigation).

### Colours / sizing

Everything through existing tokens (`legit-subtle`, panel tokens, shared
buttons); no new tokens needed. All dimensions font-relative per the global
scaling rule.

## Error handling

- Backend command failures surface git's stderr via `formatAppError`
  (existing envelope) in the panel body.
- A path with no history (e.g. never committed) renders an explicit
  empty-state line, not a blank panel.
- Restore failures notify via `notify.error(formatAppError(e))` like
  Changed Files.
