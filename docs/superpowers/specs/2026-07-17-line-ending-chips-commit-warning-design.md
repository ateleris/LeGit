# Line-ending chips in Working Changes + commit warning

**Date:** 2026-07-17
**Status:** Approved

## Goal

Two additions around the existing line-ending chip (`LineEndingBadge` /
`RevertableLineEndingBadge`):

1. Show the chip directly on Working Changes file rows, so a line-ending
   change is visible without opening the file's diff. Attention-only: a chip
   appears only for a transition (e.g. `CRLF>LF`) or a `Mixed` file, never a
   passive `LF`/`CRLF` label on clean rows.
2. Warn before committing files whose staged content changes line endings
   relative to HEAD, via the panel's existing inline-confirm pattern.

Both features are gated by settings that mirror the `warn_on_mixed_endings`
shape: a global default with an optional per-repo override.

## Key decisions (from brainstorming)

- **Attention-only chips in the list.** A chip on every row is noise; the
  signal is "this file's endings change" or "this file is mixed".
- **Policy-aware, everywhere.** On repos where git converts endings by policy
  (`core.autocrlf`, `.gitattributes` `text`/`eol`), the working tree is CRLF
  while the index stores LF by design. A raw byte comparison would flag every
  modified text file. Instead, the working side is classified by its
  *check-in kind*: what `git add` would store after clean-filter
  normalization. The existing diff/merge working-vs-index chips adopt the
  same logic so the list and an open diff never disagree.
- **Chip labels never lie about disk state.** The label shows the raw
  on-disk kind; policy-awareness only decides whether the arrow/attention
  state (and the revert action) appears. On an autocrlf=true repo a modified
  file shows a plain `CRLF` chip with no arrow.
- **The commit warning compares index vs HEAD.** Both sides are git blobs,
  which is exactly what the commit records, so autocrlf cannot produce false
  positives there.
- **One batch backend command feeds both features** (and the diff panel's
  unstaged chip): fixed subprocess count regardless of file count, no
  per-row IPC.

## Backend

### New pure logic in `legit-core`

A pure, unit-tested function that returns a file's **check-in kind**: the
`LineEndingKind` git would store on `git add`, given:

- the raw file bytes (reusing `classify_line_endings`),
- the file's effective `text` attribute (`set` / `auto` / `unset` / absent),
- the resolved `core.autocrlf` value.

Rules (git's clean-filter behaviour):

- `-text` / `binary` attr, or content detected as binary: no conversion.
- `text` attr set: CRLF normalized to LF on check-in.
- `text=auto`, or no attr with `autocrlf=true|input`: CRLF normalized to LF
  when the content looks like text.
- No attr and `autocrlf=false` (or unset): no conversion.
- Lone CR is never converted by git; only CRLF is.

`core.eol` affects checkout only and is ignored for check-in classification.

### New command: `repo_line_ending_status(repo_id)`

Returns a summary for the changed files reported by `git status`. Every
classifiable changed file gets an entry (the Diff header needs
`working_raw` for its passive label even when nothing is noteworthy);
attention-only filtering happens client-side:

```
LineEndingStatusEntry {
  path: String,
  unstaged: Option<LineEndingTransition>,  // check-in kind of working file vs index kind
  staged: Option<LineEndingTransition>,    // index kind vs HEAD kind
  mixed: bool,                             // working file has mixed endings
  working_raw: Option<LineEndingKind>,     // raw on-disk kind, for the chip label
}
LineEndingTransition { from: LineEndingKind, to: LineEndingKind }
```

Transition direction is old-side to new-side, matching the existing chip's
arrow: `unstaged` is `from` = index kind, `to` = the working file's check-in
kind; `staged` is `from` = HEAD kind, `to` = index kind. `unstaged`/`staged`
are `Some` only when `from != to` and both sides are classifiable. A file staged as newly `Mixed` (HEAD side was uniform) counts
as a staged transition. Untracked/added files have no old side and produce
an entry only when `mixed`.

Subprocess budget is fixed regardless of file count:

1. `git status --porcelain -z` (changed paths + which sides to inspect),
2. `git check-attr -z text eol --stdin` for those paths,
3. one `git cat-file --batch` streaming the needed index (`:path`) and HEAD
   (`HEAD:path`) blobs,
4. direct reads of working files.

Guards match the existing indicator: 2 MB cap per file/blob (skip when
over), binary content skipped, missing sides (new file, deleted file, no
HEAD yet) produce no transition. The command is registered in
`collect_commands!` and wrapped in `src/lib/commands.ts` with types mirrored
in `src/lib/types.ts`, like every command.

### Real-git validation (`tests/git_flows.rs`)

Per the project rule, assumptions about git behaviour are encoded against
the real binary, not just commented:

- `git cat-file --batch` accepts `:path` and `HEAD:path` object names.
- `git check-attr -z text eol` output shape for set/auto/unset/absent.
- With `autocrlf=true`, a CRLF working file stages an LF blob (our check-in
  kind matches what git actually stored); with `autocrlf=false` it stages
  CRLF unchanged.
- Lone-CR content is not normalized.

## Frontend

### Shared summary query

One React Query per repo: key `[repoId, "status", "line-ending-summary"]`,
fetching `repo_line_ending_status`. It lives under the `status` domain so
the watcher and `invalidateRepoDomains` keep it fresh. The query is disabled
entirely when both settings are off. Consumers look entries up by path in a
memoized map.

### FileTree: `renderBadge` prop

`FileTree` gains an optional `renderBadge?: (file: FileTreeEntry) =>
ReactNode`, rendered always-visible in `FileRowView` between the filename
and the +/- counts (`renderActions` stays hover-only and untouched).

### Working Changes rows

`WorkingChangesPanel` passes `renderBadge` for both sections, backed by the
summary map (zero per-row IPC):

- **Unstaged section:** entry has `unstaged` transition or `mixed` -> chip.
  Transitions render the clickable revert chip: same menu, same
  `useConfirmDestructive`-gated inline confirm, same revert command as the
  diff panel's chip (shared component/helpers, not a copy). Click uses
  `stopPropagation` so the row is not selected/opened. `Mixed`-only chips
  are passive.
- **Staged section:** entry has `staged` transition -> passive chip. The
  revert action rewrites the working file and would not change the staged
  blob, so it is not offered there.

Chip visuals reuse the existing `chipStyle` (existing tokens
`--status-modified`, `--subtle-fg`, `--panel-border`; no new tokens). Sizes
already derive from the font scale.

### Existing chips become policy-aware

`useLineEndingChip` changes only for the working-vs-index case (`rev=null,
oldRev=":"`), used by the Diff panel's unstaged chip and the Merge panel's
chip: it reads the shared summary query instead of issuing two per-file
`repo_line_ending_kind` calls. The arrow, attention colour, and revert offer
appear only when the summary reports a real (policy-aware) transition; the
label continues to show the raw on-disk kind (`working_raw`). FileView and
Blame (single-side labels) and commit-vs-commit diffs (two blobs, policy
irrelevant) keep the current per-file query path unchanged.

## Commit warning

In `WorkingChangesPanel`'s commit flow, alongside the existing inline
confirms (detached HEAD, amend of pushed commit): when
`warn_on_line_ending_commit` is effective-on and the summary reports staged
transitions, `requestCommit` shows an inline confirm box before committing:

> 2 files change line endings: `foo.ts` CRLF>LF, `bar.ts` LF>CRLF.
> Commit anyway?

At most 5 files are listed, with a `+N more` tail. The gate joins the
panel's existing confirm sequence (one inline box at a time), ordered after
the detached-HEAD and amend-pushed confirms; confirm proceeds, cancel
aborts. The message-building logic is a pure helper with a vitest.

This warning is informational (the data is the summary already on hand); it
is independent of the destructive-confirmation setting and gated only by its
own setting.

## Settings

Two new settings, exactly mirroring `warn_on_mixed_endings` plumbing
(`GlobalSettings` + `RepoSettings` override in `src-tauri/src/state.rs`,
settings store, GlobalSettingsPanel line-endings section, RepoSettingsPanel
override row):

- `line_ending_chips_in_changes`: default **true**. Shows the attention-only
  chips in Working Changes.
- `warn_on_line_ending_commit`: default **true**. Enables the commit
  warning.

Effective value = repo override if set, else global (same resolution helper
pattern as `effective_warn`).

## Testing

- **legit-core unit tests:** check-in-kind function (attr x autocrlf x
  content matrix, lone-CR, binary, mixed), transition derivation.
- **`git_flows.rs`:** the four real-git assumptions listed above.
- **vitest:** commit-warning message builder; summary-map lookup helper if
  extracted.
- **Existing suites:** no new theme tokens, so `contract.test.ts` and
  `noLiteralColors.test.ts` are unaffected; `cargo test -p legit-core` and
  `tsc` run from WSL, vitest from PowerShell per the project's verification
  split.

## Out of scope

- Offering the revert action on staged rows (would need a
  revert-and-restage flow).
- Suppressing chips for `.gitattributes` `eol=` checkout-direction effects
  beyond check-in normalization.
- Any change to FileView/Blame single-side labels.
