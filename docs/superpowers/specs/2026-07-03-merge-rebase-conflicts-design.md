# Merge, Rebase & Conflict Resolution — Design

**Date:** 2026-07-03
**Status:** Approved design, pending implementation plan
**Backlog items covered:** #2 branch operations (merge + rebase), #6 conflict
resolution, and "Diff viewer: inline editing".

## Goal

Add merge and rebase to LeGit with first-class conflict handling: the app must
be able to start the operation, explain the in-progress state, let the user
resolve conflicts (one-click ours/theirs/both per conflict, plus free manual
editing), and conclude or abort the operation. As a foundation, the diff
viewer becomes editable so users can fix small things directly in the diff
pane; the conflict-resolve view is built on the same editable primitive.

Out of scope (stays on the backlog): interactive rebase, a 3-way (ours | result
| theirs) merge view, merge/rebase from arbitrary commits, cherry-pick / revert
UI (their *state detection* ships here, their triggers do not).

## Guiding decisions

- **Conflicts are outcomes, not errors** — same pattern as `SwitchOutcome` /
  `StashApplyOutcome`. A conflicted merge is a partial success that crosses IPC
  as data.
- **Reuse the diff viewer wholesale.** No new resolve panel: the Diff panel
  gains a resolve mode, and conflicts render through the existing inline/split
  rendering primitive (`DiffEditor`) via a synthetic diff model.
- **Merge options in v1:** fast-forward mode (auto / no-ff / ff-only) and
  squash. Plain menu items, no dialog.
- **Rebase always runs with `--autostash`**; a stash-reapply conflict after a
  completed rebase is its own outcome (mirrors `StashPopConflicts`).
- **Entry points:** the shared branch menu sections (commit-row menu + ref
  chips, parity for free) and the Branches pane rows.

## Phasing

One spec, three implementation phases; each is valuable standalone and later
phases build on earlier ones.

1. **Phase 1 — Editable diff primitive.** Editability map, transaction filter,
   splice write-back, explicit save flow.
2. **Phase 2 — Merge/rebase operations + op-state.** Backend ops with outcome
   enums, repo-op-state detection, Working Changes banner, branch-menu
   triggers.
3. **Phase 3 — Resolve mode.** Conflict marker parsing to a synthetic diff,
   ours/theirs/both actions, editable conflict blocks, mark-resolved flow.

---

## Phase 1 — Editable diff viewer

### Editable document model

`DiffEditor` (`src/panels/Diff/DiffEditor.tsx`) gains an opt-in `editable`
capability. Editability is per-row, derived from the row model and enforced by
a CodeMirror transaction filter (reject changes touching read-only rows):

- **Working-tree diffs:** new-side rows are editable — Context + Added lines in
  the inline view; the right pane in the split view. Removed lines, hunk
  headers, fillers, and the split left pane are read-only.
- **Commit diffs:** fully read-only (unchanged behavior).

The decoration `StateField` currently assumes a frozen document
(`update: (value) => value`); it changes to map decorations through document
changes. An edited line drops its diff tinting and instead shows a
"modified, unsaved" line state (new theme tokens). Gutter line numbers may go
stale while dirty; they refresh on save.

### Write-back

A pure, unit-tested function

```
spliceEdits(originalFileText, rowModel, editedDoc) -> newFileText
```

maps each hunk's edited new-side text back into the full working-tree file at
the hunk's known new-side line range. It must preserve the file's EOL style
(CRLF vs LF) and trailing-newline state (encoded in tests). The result is
written via a new `write_worktree_file` backend command.

Saving is **explicit**: Ctrl+S plus a Save button that appears in the Diff
panel header when dirty. No auto-write, so the watcher/refetch loop cannot
fight the user mid-edit. After save, the diff refetches and re-renders (the
existing scroll anchor survives the refetch).

### Interaction rules while dirty

- Hunk/line stage/unstage/discard actions (and, in Phase 3, the
  Ours/Theirs/Both buttons) are disabled with a "Save first" tooltip.
- Watcher-driven diff refetches are deferred while dirty (an external change
  must not silently discard the edit).
- Switching the Diff panel to a different file prompts before discarding
  unsaved edits.

### Action parity

Per the existing invariant in `DiffEditor`: the editable capability, dirty
handling, and (later) resolve actions are wired through the shared helpers and
applied in **both** `mountInline` and `mountSplit`. No view-specific wiring.

---

## Phase 2 — Merge / rebase operations and op-state

### New types (`crates/legit-core/src/types.rs`)

```
FfMode        = Auto | NoFf | FfOnly
MergeOptions  = { ff: FfMode, squash: bool }   // squash=true ignores ff (git --squash never commits);
                                               // the menu items never combine them

MergeOutcome  = FastForwarded
              | Merged
              | Squashed                      // staged, not committed (git --squash)
              | AlreadyUpToDate
              | Conflicts { message }

RebaseOutcome = Completed
              | AlreadyUpToDate
              | Conflicts { message }
              | CompletedWithStashConflicts { message }   // rebase done, autostash pop conflicted

RepoOpState   = None
              | Merge { branch, message }                 // branch being merged, prepared MERGE_MSG
              | Rebase { onto_ref, head_name, current_step, total_steps }
              | CherryPick { sha }                        // detection only, no UI triggers yet
              | Revert { sha }                            // detection only

ConflictKind  = BothModified | BothAdded | DeletedByUs | DeletedByThem
ConflictEntry = { path, kind }
```

All serde + specta tagged enums, mirrored by hand in `src/lib/types.ts` as
usual.

### New `GitBackend` methods (`cli_impl`, all via `GitRunner`)

- `merge(target, opts) -> MergeOutcome`
- `merge_continue() -> MergeOutcome`, `merge_abort()`
- `rebase(onto) -> RebaseOutcome` — always passes `--autostash`
- `rebase_continue() -> RebaseOutcome`, `rebase_skip() -> RebaseOutcome`,
  `rebase_abort()`
- `op_state() -> RepoOpState`
- `conflict_entries() -> Vec<ConflictEntry>` — parser for
  `git ls-files -u -z` (pure, tested, format constant next to the parser)
- `resolve_take_side(path, side)` — `git checkout --ours|--theirs -- <path>`
  then `git add <path>`; for delete-conflicts where the chosen side has no
  stage entry, `git rm -- <path>` instead. `mark_resolved(path)` = stage.
- `read_worktree_file(path) -> text` / `write_worktree_file(path, text)`

Merge/rebase run without an `OperationId` (local, abort is the recovery path).

### Op-state detection

`git rev-parse --git-path MERGE_HEAD|rebase-merge|rebase-apply|CHERRY_PICK_HEAD|REVERT_HEAD`
plus existence checks on the returned paths (the standard GUI approach — the
paths come from git, only existence/content is read from disk). Rebase
progress and target come from the documented `rebase-merge/{head-name,msgnum,
end,onto}` files; the merge message from `MERGE_MSG`. File-content parsing is
pure functions with unit tests.

### Two encoded-in-test gotchas

1. **Editor neutralization.** `GitRunner` hardens with `GIT_EDITOR=false`, so
   `git merge --continue` / `git rebase --continue` would *fail* at the
   commit-message step. Both continue commands run with `-c core.editor=true`
   (accept the prepared message unchanged). Argument construction is
   unit-tested.
2. **Exit-code ambiguity.** Merge and rebase exit 1 both for conflicts and for
   real failures. Pure classifiers `classify_merge_error` /
   `classify_rebase_error` (tested) split `Conflicts` from
   `WouldOverwriteLocalChanges`, unrelated histories, and unknown refs.

Abort failures follow the `append_error_note` rule: a failed recovery step is
appended to the primary error, never silent.

### IPC & data freshness

New `src-tauri/src/commands/ops.rs` exposing the methods above
(`repo_merge`, `repo_merge_continue`, `repo_merge_abort`, `repo_rebase`,
`repo_rebase_continue`, `repo_rebase_skip`, `repo_rebase_abort`,
`repo_op_state`, `repo_conflict_entries`, `repo_resolve_take_side`,
`repo_read_worktree_file`, `repo_write_worktree_file`), registered in
`lib.rs`, wrapped in `src/lib/commands.ts`, types mirrored in
`src/lib/types.ts`.

New query domain `"opState"` (key `[repoId, "opState"]`). The watcher already
observes `.git`; changes to `MERGE_HEAD` / `rebase-merge` / `rebase-apply` /
`CHERRY_PICK_HEAD` / `REVERT_HEAD` invalidate `opState` + `status` + `log`.
Bonus: a conflicted **pull** (merge or rebase strategy) now recovers
gracefully — the banner below appears via the same state detection with no
pull-specific work.

### UI: entry points

Extend the shared `BranchMenuSection` (used by ref chips and commit-row menus
— parity for free) and the Branches pane row menu with, for any non-current
local branch (and remote-tracking branches, merge only):

- **Merge into '<current>'** group: *Merge*, *Merge (no fast-forward)*,
  *Merge (fast-forward only)*, *Squash merge* — plain menu items.
- **Rebase '<current>' onto this**.

Hidden while a repo operation is in progress. Feedback mirrors
`switchFeedback`: a `mergeFeedback.ts` maps outcomes to toasts/notices
(`Squashed` → "changes staged, commit when ready"; `Conflicts` → points at the
Working Changes banner; `CompletedWithStashConflicts` → explains the stash was
kept).

### UI: op-state banner (Working Changes)

A banner at the top of the Working Changes panel whenever
`op_state != None`:

- **Merge:** "Merging '<branch>' — N conflicts remaining", buttons
  **Continue** (disabled while N > 0; commits with the prepared `MERGE_MSG`)
  and **Abort**.
- **Rebase:** "Rebasing onto '<onto>' — step i/n", buttons **Continue**
  (disabled while conflicts remain), **Skip**, **Abort**.
- Abort is destructive: inline confirm, gated by `useConfirmDestructive()`
  (run immediately when the setting is off).
- Banner colors are new theme tokens, added in all 4 places (contract-test
  enforced). Busy states follow the 150ms-delay rule.

Conflicted file rows in Working Changes get menu actions: *Take ours* /
*Take theirs* (labels adapted per `ConflictKind` — e.g. "Take theirs
(delete file)" for `DeletedByThem`), *Mark resolved*, *Open* (summons the
Diff panel, which renders resolve mode per Phase 3).

---

## Phase 3 — Resolve mode in the Diff panel

### Conflict model

When the Diff panel shows a working-tree file whose status is `Conflicted`,
it reads the file via `read_worktree_file` and switches to **resolve mode**
(same panel, same summon flow, same inline/split toggle).

A pure model module `src/panels/Diff/conflictModel.ts` (vitest-tested):

- `parseConflicts(text)` — parses conflict marker blocks, both classic
  (`<<<<<<<`/`=======`/`>>>>>>>`) and diff3 style (with a `|||||||` base
  section; the base is parsed but not displayed in v1).
- `conflictsToDiff(sections) -> TextDiff` — builds a **synthetic diff** where
  each conflict region is a hunk: *ours* lines are the Removed side, *theirs*
  lines the Added side, shared lines Context. This feeds the existing
  `DiffEditor` unchanged, so inline view, split view (ours left / theirs
  right, filler-aligned, scroll-synced), word-level intra-line highlighting,
  theming, and font scaling are all inherited.
- `resolveBlock(text, conflictIndex, choice)` — rewrites one marker block for
  `ours | theirs | both` (both = ours then theirs), preserving EOL style and
  trailing-newline state (tested).

Gutter numbers show ours-side / theirs-side line numbering (the existing
old/new gutters, relabeled in resolve mode).

### Actions

`HunkAction` gains `"ours" | "theirs" | "both"`. The header `ActionWidget`
renders **[Ours] [Theirs] [Both]** on each conflict block through the same
shared helpers (`hunkActionWidget`, `contextMenuExtension`), so the
inline/split action-parity invariant covers resolve mode automatically.
Clicking one applies `resolveBlock` and writes back via
`write_worktree_file`; the refetch re-renders with one fewer conflict.

Both sides of a conflict block are **editable** (Phase 1 machinery) — unlike a
normal diff, ours and theirs are both real working-tree content, so edits to
either side splice back into the corresponding section of the marker block.
The same dirty rules apply (actions disabled while dirty, save first).

### Panel header in resolve mode

- "N conflicts remaining" count.
- **Mark resolved** — enabled at 0 remaining; if markers remain, still
  available behind a warning (markers can be legitimate content).
- Whole-file **Take ours** / **Take theirs** (via `resolve_take_side`) — also
  the only offering for **binary** conflicted files, which cannot be
  text-rendered.

When the last conflicted file in the repo is resolved, the op-state banner's
Continue button lights up (both are watcher-driven; no polling).

---

## Testing summary

- **Rust (pure functions, existing style):** op-state file parsing,
  `ls-files -u` parser, `classify_merge_error` / `classify_rebase_error`,
  continue-command argument construction (editor neutralization), outcome
  detection from merge/rebase output.
- **TypeScript (vitest):** `parseConflicts`, `conflictsToDiff`,
  `resolveBlock` (incl. CRLF / trailing-newline preservation), `spliceEdits`,
  editability-map derivation.
- **Theme:** new tokens covered automatically by `contract.test.ts` and
  `noLiteralColors.test.ts`.
- **Integration tests** (real git in a tempdir repo: conflict → resolve →
  continue/abort end to end) are deliberately deferred to the backlog's
  "Backend review: test coverage + git executor isolation" section — the
  codebase has no integration harness yet and building one is its own task.

## Risks / watch items

- The decoration `StateField` rework (frozen doc -> change-mapped) touches the
  shared primitive both diff views depend on; Phase 1 must land green before
  Phase 3 builds on it.
- Deferring watcher refetches while dirty needs care not to wedge freshness:
  defer, then run the newest pending invalidation on save/discard.
- `git checkout --ours/--theirs` on delete-conflicts has no stage entry for
  one side; the delete-conflict branch in `resolve_take_side` is encoded in
  tests.
