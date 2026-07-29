# Renormalize line endings from Repo Settings

Date: 2026-07-29
Status: designed, not implemented
Builds on: `2026-07-17-line-ending-chips-commit-warning-design.md` (shipped:
config readout in `LineEndingsRepoSection`, per-file EOL chips, commit warning).

## Goal

Give the existing "Line endings (this repo)" section in Repo Settings the two
actions it is missing, so a user can fix repo-wide line-ending drift with
git's own mechanism instead of hand-running CLI commands:

1. Write a covers-all `.gitattributes` policy (`* text=auto`, optional
   `eol=lf` / `eol=crlf`).
2. Run `git add --renormalize -- .` and leave the result staged for review.

Motivating case (real repo, 2026-07-29): no `.gitattributes`,
`core.autocrlf=false`, editor re-saved 71 files with CRLF: 87 "modified"
paths of which only 5 carried real changes, and 9 files staged as CRLF
against an LF history. The attributes rule plus a renormalize clears the
phantom modifications without touching disk and fixes the index (see the
corrected `text=auto` finding under Key decisions: the rule alone is not
enough).

## Key decisions (from brainstorming)

- **Placement: option A.** Everything lives in `LineEndingsRepoSection`
  (RepoSettingsPanel.tsx). No Working Changes entry points, no new panel,
  no summon wiring (that was option C; rejected as unnecessary for v1).
- **Git-native only.** The feature never rewrites working-tree bytes. It
  writes `.gitattributes` and drives `git add --renormalize`. No dos2unix
  behaviour anywhere.
- **Preview via git itself, on a throwaway index.** The `add -n` dry run
  originally planned here turned out to list EVERY tracked file, not the
  ones that would change (found by the real-git harness during
  implementation). The preview instead simulates the run: `write-tree`
  snapshots the real index, `read-tree` rebuilds it under `GIT_INDEX_FILE`,
  `add --renormalize` runs against that copy, and
  `diff-index --cached <tree>` reports exactly which entries would change.
  The real index is never touched. The real run uses the same
  `write-tree` + `diff-index` bracket, so the outcome reports what actually
  changed rather than echoing the preview. No home-grown prediction.
- **`* text=auto` does NOT clear phantom modifications by itself.** Also a
  real-git finding: a CRLF-resaved file over an LF index stays "modified"
  in status (with an empty content diff) even after the attributes rule
  exists, until an add refreshes the stat cache. Renormalize is that
  refresh: it reports zero content changes yet clears the phantom entries.
  The UI copy reflects this (running with "no content changes" is still
  meaningful, so the action stays enabled at zero).
- **Staged, never committed.** The action ends with content staged for
  review in Working Changes. The `.gitattributes` file is likewise left as
  a normal working-tree change for the user to stage and commit.
- **Catch-all rule goes at the TOP of `.gitattributes`.** Last matching
  rule wins in gitattributes; appending `* text=auto eol=lf` at the end
  would silently override specific existing rules (e.g. `*.bat eol=crlf`).
  Insert at the top (after leading comments), never append.
- **Unstaged edits: warn, don't exclude (v1).** `git add --renormalize`
  stages the current content of every tracked file it touches, so real
  unstaged edits become staged. The confirm step states this with a count.
  A skip-modified-files pathspec is a possible later refinement, recorded
  in BACKLOG.md, not built now.
- **Zero is an outcome, not an error.** An already-normalized repo reports
  "0 files" as data (`RenormalizeOutcome`), mirroring `SwitchOutcome` /
  `StashApplyOutcome`.

## Backend (`legit-core`)

### Pure parser

`cli_impl/parsers/renormalize.rs`: all path output goes through
`--name-only -z` (NUL-separated, no quoting), so the parser is a trivial
`parse_name_only_z(text) -> Vec<String>` with no unquoting rules at all.
Command constants (`RENORMALIZE_ARGS`, `DIFF_INDEX_NAME_ONLY_Z`, the
preview's temp-index suffix) live next to it per convention.

### `GitBackend` methods

- `renormalize_preview(repo) -> Vec<String>`: the temp-index simulation
  (`write-tree`, `rev-parse --git-path index`, then `read-tree` /
  `add --renormalize` / `diff-index --cached <tree>` under
  `GIT_INDEX_FILE`). Leaves the temp index file for the command layer to
  remove best-effort.
- `renormalize(repo) -> RenormalizeOutcome`: `write-tree`, the real
  `add --renormalize -- .`, then `diff-index --cached <tree>` on the real
  index. Returns `RenormalizeOutcome { restaged: Vec<String> }` from that
  diff - the actual changes, not a prediction.
- `write_gitattributes_eol(repo, eol: Option<Eol>) -> ()`:
  creates `.gitattributes` at the repo root with `* text=auto` (+
  ` eol=lf` / ` eol=crlf` when given), or inserts that line at the top of
  an existing file (after any leading comment block). Refuses (typed error)
  if a covers-all rule already exists; the frontend hides the step in that
  case anyway (`gitattributes_covers_all` from the existing
  `LineEndingsView`).

`RenormalizeOutcome` goes in `types.rs` with serde + specta.

### Tests (both levels, per convention)

- `cli_impl/flow_tests.rs` (FakeExecutor): renormalize runs exactly
  dry-run then real add, in that order, and nothing else (no status, no
  commit, no stash). Preview runs only the dry run.
- `tests/git_flows.rs` (real binary, tempdir repos):
  1. Repo with CRLF blobs committed + `* text=auto` attributes: preview
     lists exactly those files WITHOUT touching the real index; renormalize
     restages them as LF; disk bytes untouched.
  2. Already-normalized repo: preview is empty, renormalize reports
     `restaged: []`, nothing staged.
  3. Phantom-modification semantics (corrected assumption): `* text=auto`
     alone leaves a CRLF-resaved file "modified" in status; renormalize
     reports zero content changes yet clears the phantom, disk untouched.
  4. Non-ASCII filenames arrive raw through the `-z` output.
  5. `write_gitattributes_eol` insertion position (unit-tested in the
     command layer, where the logic lives): an existing specific rule below
     the new `*` line still wins for its pattern.

## IPC (`src-tauri`)

Three commands in `commands/line_endings.rs`, registered in `lib.rs`
`collect_commands!`:

- `repo_renormalize_preview(repo_id) -> RenormalizePreview`
  (`{ files, unstaged_changes }`). Previews are serialized per repo
  session (`RepoSession::renormalize_preview_lock`): they share one
  throwaway-index path and git's `.lock` on it makes concurrent runs fail.
  The command removes the temp index AND its `.lock` before and after each
  run, so a preview killed mid-run self-heals instead of blocking all
  future previews (failure mode pinned in `git_flows.rs`,
  `stale_preview_lock_blocks_the_preview`).
- `repo_renormalize(repo_id) -> RenormalizeOutcome`
- `repo_write_gitattributes_eol(repo_id, eol: Option<String>) -> ()`

Hand-written wrappers in `src/lib/commands.ts`, types mirrored in
`src/lib/types.ts` (`RenormalizeOutcome`).

## Frontend (`LineEndingsRepoSection` only)

A "Normalize" block below the existing config rows:

- **Preview readout.** Fetched on the section's existing load/focus path
  (`load()` / `usePanelFocusEffect`). Shows "N tracked files would be
  renormalized" plus a collapsed file list (existing list styling). N = 0
  renders "Line endings are already normalized" with the action disabled.
- **Attributes step.** Shown only when `gitattributes_covers_all` is false:
  eol choice (lf / crlf / unset = platform via core.eol) and the exact line
  previewed in monospace before writing. After the write, both the
  `LineEndingsView` and the preview refetch (the phantom-modification set
  changes at this moment).
- **Renormalize action.** Reuses the section's inline `confirmPending`
  pattern, gated by `useConfirmDestructive()`: when the global setting is
  off, run immediately. Confirm text: file count from the preview, "result
  will be staged for review, nothing is committed", and, when unstaged
  modifications exist (from the existing status data), "restaging will also
  stage the current edits of N modified files".
- **Outcome.** "Restaged N files - staged for review, nothing committed"
  (or the zero message). Invalidate the `status` domain via
  `invalidateRepoDomains` so Working Changes refreshes.
- **Feedback conventions.** 150 ms delayed busy state with a `useRef`
  re-entry guard (WorkingChangesPanel `run()` pattern); errors through
  `formatAppError`; all colours via existing theme tokens (no new tokens
  needed).

## Out of scope

- Working-tree EOL rewriting of any kind.
- Auto-commit of the renormalize result or `.gitattributes`.
- Working Changes / banner entry points (option C).
- Per-pattern attribute editing beyond the single covers-all rule.
- Skip-files-with-unstaged-edits pathspec (deferred; warn instead).
