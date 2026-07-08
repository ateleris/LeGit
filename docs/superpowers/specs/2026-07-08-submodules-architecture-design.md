# Submodule Integration - Architecture Design

**Date:** 2026-07-08
**Status:** Approved (umbrella design; each sub-project gets its own spec + plan)
**Scope:** Full submodule suite (display, navigation, operations, lifecycle, safety), delivered as five staged sub-projects.

## Motivation and current state

LeGit's v0.1 design reserved space for submodules (DESIGN-v0.1 §7.2) and the
scaffolding exists but is dead:

- `FileState::SubmoduleChanged` (`types.rs:161`) and
  `DiffEntry::Submodule(SubmoduleChange)` (`types.rs:302`) are defined and
  mirrored through TS, with a render branch in `DiffPanel.tsx:750` - but no
  parser produces either variant. A pointer bump today shows as an ordinary
  `Modified` file with a two-line `Subproject commit` text diff.
- `GitBackend::submodules()` is a `NotYet` stub (`cli_impl/mod.rs:1262`), not
  registered as a Tauri command.
- The only live feature is the clone form's `--recurse-submodules` checkbox.

Market survey conclusion (Fork, Tower, GitKraken, Sublime Merge, SmartGit,
SourceTree, TortoiseGit, VS Code, JetBrains, lazygit, magit): no tool gets
submodules fully right. The design below combines the best exemplars - the
SmartGit/Tower state model, Fork/SmartGit tab navigation, TortoiseGit's
update/push flag exposure and pointer diff, magit's removal semantics,
Tower's drift repair - while avoiding the documented failure modes
(GitKraken's forced auto-update and mid-batch stash corruption, SourceTree's
per-action recursive status calls and detached-HEAD-disarmed push warning,
Fork's leftover gitdirs).

## Decisions made during brainstorming

1. **Scope:** full suite (tiers 1-4), staged as five sub-projects.
2. **UI surface:** Submodules live as a collapsible section in the Refs
   panel's paneview - no dedicated panel.
3. **Nesting:** flat model. A superproject lists only its direct submodules;
   bulk operations offer `--recursive` toggles; drilling into a submodule tab
   shows that repo's own submodules the same way.
4. **Auto-update on superproject switch/pull:** on by default (per-repo off
   switch). Dirty submodules follow the global `SwitchDirtyBehavior`. On an
   `AutoStash` pop conflict the submodule is rolled back to its previous
   state (checkout old SHA, pop on the original base - clean) and reported.
   Local changes are never lost in any path.
5. **Status parsing:** migrate to porcelain v2 as a standalone prep
   sub-project with byte-for-byte parity, then build submodule state on the
   v2 `S<c><m><u>` flags (approach C). Porcelain v1 cannot distinguish
   "pointer moved" from "dirty inside" (both ` M`).

## Data model (`crates/legit-core/src/types.rs`)

`SubmoduleInfo` becomes the real shape, keyed by **name** (durable in
`.git/config` and `.git/modules/<name>`), displayed by **path**:

```rust
pub struct SubmoduleInfo {
    pub name: String,                    // durable key
    pub path: String,                    // display + `git -C` target
    pub url: Option<String>,             // effective URL (.git/config)
    pub gitmodules_url: Option<String>,  // .gitmodules value, for drift detection
    pub branch: Option<String>,          // .gitmodules `branch` field
    pub recorded_sha: Option<CommitId>,  // gitlink in HEAD
    pub checked_out_sha: Option<CommitId>,
    pub head_branch: Option<String>,     // None = detached
    pub state: SubmoduleState,
}
```

`SubmoduleState` is a struct of orthogonal flags (states combine; a single
enum cannot express "detached AND dirty AND pointer-moved"):

```rust
pub struct SubmoduleState {
    pub initialized: bool,     // registered in .git/config
    pub populated: bool,       // worktree checked out
    pub pointer_moved: bool,   // checked-out SHA != recorded SHA
    pub dirty_tracked: bool,   // modified tracked files inside
    pub dirty_untracked: bool, // untracked files inside
    pub conflicted: bool,      // unmerged gitlink
    pub orphan_gitlink: bool,  // gitlink without .gitmodules entry
    pub config_drift: bool,    // .gitmodules / .git/config / gitdir mismatch
}
```

The UI derives one primary badge by precedence:
conflict > drift > pointer-moved > dirty > detached > clean.

`SubmoduleChange` (diff model) grows `dirty: bool` and an optional commit
list (short SHA + subject per commit between old and new), fetched lazily.

## Sub-project 1 - Status porcelain v2 migration

- `STATUS_ARGS` moves from `--porcelain=v1 -z` to `--porcelain=v2 -z`
  (`parsers/status.rs`); `parse_status` is rewritten for the `1`/`2`/`u`/`?`
  record format.
- **Zero behavior change:** output stays `Vec<FileStatus>` identical to
  today. The `S<c><m><u>` and mode fields are parsed but not yet surfaced.
- Parity enforced by porting every existing status fixture test and adding
  real-binary cases in `tests/git_flows.rs`.
- The numstat enrichment passes (`NUMSTAT_*_ARGS`, `apply_numstat`) are
  untouched.
- Lands and soaks alone before any submodule work builds on it.

## Sub-project 2 - Tier 1: state model + display

**Enumeration** (new `parsers/submodules.rs`, format constants beside the
parser):

- `git ls-files --stage` mode-`160000` entries, joined by path against
  `git config -f .gitmodules -z --get-regexp '^submodule\.'` and
  `.git/config` registration (`submodule.<name>.url` / `.active`).
- One `git -C <sub> rev-parse` pass per *populated* submodule for
  HEAD SHA + branch/detached.
- Never `git submodule status` in bulk (spawns `git describe` per
  submodule - SourceTree's perf trap; same discipline as the "no `%G?` in
  bulk log" rule). Never `git submodule--helper` (internal; subcommands
  removed in git 2.36-2.38).
- New query domain `"submodules"`, refreshed on the branches cadence, not
  per status tick.

**Status:** v2 `S` flags emit `FileState::SubmoduleChanged` for pointer
moves (the existing `FileTree.tsx:94` icon comes alive). Dirty-inside-only
shows as a badge on the submodule row, not as a fake file modification.

**Diff:**

- `run_diff_text` pins `-c diff.submodule=short` on every parsed diff
  (user config `diff.submodule=log` broke magit's parser; LeGit is exposed
  identically).
- The diff parser detects `160000` mode / `Subproject commit` hunks and
  returns `DiffEntry::Submodule` with old/new SHA and dirty flag.
- `DiffPanel`'s dead branch becomes a real submodule view: old -> new SHA
  (copyable), lazy commit list between them (`git -C <sub> log old..new`),
  a distinct "target commit not fetched" state, dirty badges.
- New colors are theme tokens (4 places, per contract tests).

**Refs panel:** a Submodules pane in the existing paneview. Rows show path,
branch or `(detached)`, and the state badge; count in the header; the pane
is hidden when the repo has no gitlinks. All dimensions scale from
`--ui-font-size`.

**Commit details:** `commit_files.rs` classifies gitlink changes so a
pointer bump in history reads as a submodule change, not a modified file.

## Sub-project 3 - Tier 2: navigation + core operations

**Navigation:**

- Double-click a submodule row opens it as a peer repo tab
  (`openRepo(abs path)`; `register_open_repo` already dedupes by canonical
  toplevel - the DESIGN-v0.1 §7.2 peer-`RepoSession` model).
- In a repo that is itself a submodule, a parent chip (detected via
  `rev-parse --show-superproject-working-tree`) navigates back up.

**Operations** (each a `GitBackend` method: trait -> cli_impl -> Tauri
command -> `commands.ts` wrapper; addressed by name/path; cancellable via
`OperationId`):

- `submodule_init`, `submodule_update` (recorded SHA), `submodule_sync`,
  per-submodule fetch.
- Bulk `update --init` with a `--recursive` toggle (flat model - recursion
  is git's job).

**Staging:**

- Pointer changes stage/unstage per file (`git add <path>` /
  `git restore --staged`), which is already correct for gitlinks.
- Gitlink entries are excluded from hunk/line staging in both inline and
  split diff views via the shared helpers (action parity rule); `git apply`
  on `Subproject commit` pseudo-lines is not how gitlinks are staged.

**Watcher:** `.gitmodules` edits and `.git/modules/**` ref changes
invalidate the `submodules` domain (today everything folds into `Status`).

## Sub-project 4 - Tier 3: lifecycle

- **Add:** form in the Refs section (URL, path, optional branch); relative
  URLs resolve against the superproject origin.
- **Remove** (magit-grade staged sequence): refuse if dirty; run
  `absorbgitdirs` first for embedded gitdirs; `deinit -f` + `git rm`
  (which stages the `.gitmodules` edit and keeps `.git/modules/<name>`);
  gitdir deletion is a separate, explicitly confirmed step preceded by an
  unpushed-commits check. Confirmation goes through
  `useConfirmDestructive`; the menu section component is shared between row
  and chip menus so the confirm step cannot drift out of parity.
- **Set-url:** writes `.gitmodules`, then auto-runs `submodule sync` (URL
  changes do not propagate to `.git/config` / the submodule's origin
  otherwise).
- **Set-branch** (`submodule set-branch`).
- **Update `--remote`** with checkout/rebase/merge strategy, followed by
  `git add <path>` - `--remote` moves the worktree but not the index.

## Sub-project 5 - Tier 4: safety

**Checkout/pull auto-update** (the headline safety feature):

- After a superproject switch/pull, submodules whose recorded pointer
  changed update automatically. Per-repo off switch.
- Clean submodule: update to the recorded SHA.
- Dirty submodule: apply the global `SwitchDirtyBehavior`:
  - `TryDirectly`: attempt checkout; git carries non-conflicting changes
    over or fails with `WouldOverwriteLocalChanges` -> submodule left
    untouched, reported.
  - `AutoStash`: stash inside the submodule (verified via stash-tip
    comparison, never inferred from exit code), update, pop by SHA. On pop
    conflict: roll back - checkout the old SHA, pop on the original base
    (clean), report "submodule X has changes that could not be carried
    over".
  - `StashAndKeep`: stash, update, leave the stash parked; reported.
- Per-submodule atomicity: a failed submodule is restored to its previous
  state; the batch continues for the others. A skipped submodule then shows
  as a pointer-modified status entry, so the signal outlives the toast.
- Results cross IPC as a `SubmoduleUpdateOutcome` (partial success is an
  outcome, not an error). Local changes are never lost in any path: they
  end up carried over, in the worktree, or parked in that submodule's stash
  (which survives even a conflicted pop).

**Push guard:** `push --recurse-submodules=check` before superproject
pushes (setting: none / check / on-demand; check is cheap - git exits 128
with explicit advice when referenced submodule commits are unpushed).
Failure classified into a dedicated `GitError` variant with actionable
text. Works in detached HEAD - the exact SourceTree hole (SRCTREE-5276).

**Detached HEAD:** `(detached)` surfaced on submodule rows/chips plus a
one-click "create branch here".

**Drift repair:** `.gitmodules` vs `.git/config` vs gitdir mismatches are
detected during enumeration (`config_drift`) and get a Repair action
(re-sync registration; Tower's unique feature).

## Error handling

Existing house rules apply throughout: the user sees git's message, never a
JSON envelope; common failures classify into `GitError` variants; partial
success crosses IPC as an outcome type; a failed best-effort recovery step
is appended to the primary error via `append_error_note` (e.g. "update
failed AND the rollback pop failed - your changes are in stash X of
submodule Y").

## Testing

Every git-behavior assumption is encoded at both harness levels, per house
rule:

- **Parser unit tests** with captured fixtures for the v2 status format and
  the submodule enumeration parser.
- **`cli_impl/flow_tests.rs`** (`FakeExecutor`): exact command sequences,
  including what must NOT run - no bare `stash pop`, no gitdir deletion
  without the explicit step, the full rollback sequence on pop conflict,
  no `git submodule status` during bulk refresh.
- **`tests/git_flows.rs`** (real binary, tempdir repos): fixtures need
  `protocol.file.allow=always` passed on the invoking command (local config
  does not reach the internal clone; CVE-2022-39253 hardening). Key
  assumptions to encode: v2 `S<c><m><u>` semantics (pointer-moved vs dirty
  vs untracked, conflict `u` records), `git rm` staging the `.gitmodules`
  edit and keeping the gitdir, `update --remote` not touching the index,
  stash-in-submodule create/pop behavior, pop-conflict rollback landing
  cleanly on the original base.

## Git plumbing reference (verified against git 2.43)

- Enumerate: `ls-files --stage` (mode `160000`) +
  `config -f .gitmodules -z --get-regexp '^submodule\.'`; registration in
  `.git/config`. Gitlinks without a `.gitmodules` entry are orphans.
- State: one `status --porcelain=v2` call carries `S<c><m><u>` per gitlink;
  staged-only pointer moves read `XY=M.` with `S...`; unmerged gitlinks are
  `u` records with stage-1/2/3 SHAs; all mode fields `160000`.
- Diff: pin `--submodule=short` when parsing; `--submodule=log` output
  (or `git -C <sub> log old..new`) supplies the commit list for display;
  `-dirty` suffix marks a dirty worktree.
- Update: default checkout mode detaches HEAD at the recorded SHA;
  `--remote` fetches and moves to `submodule.<name>.branch` (config beats
  `.gitmodules`; default remote HEAD) but does not touch the index.
- Push: `--recurse-submodules=check` aborts with exit 128 + advice when
  referenced submodule commits are on no submodule remote.
- Removal: `git rm` removes worktree + index entry + stages the
  `.gitmodules` edit, but leaves `.git/config` registration and
  `.git/modules/<name>`; `deinit -f` clears config + worktree. The kept
  gitdir is deliberate (re-adding the same path errors without
  `--force`/`--name`).
- Key by name, not path: `git mv` updates the path and gitfile but not the
  name or gitdir location.

## Delivery order

1. Status porcelain v2 migration (parity, no visible change)
2. Tier 1: state model + display
3. Tier 2: navigation + core operations
4. Tier 3: lifecycle
5. Tier 4: safety

Each sub-project gets its own spec and implementation plan; later tiers may
refine details within this architecture without re-deciding the choices
recorded here.
