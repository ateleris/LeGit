# Design: attach submodule HEAD to its branch after updates (opt-in)

**Date:** 2026-07-23
**Status:** Implemented (pending manual verification in the app).
**Origin:** `git submodule update` always checks out the recorded commit as a
detached HEAD, even when the configured (`.gitmodules` `branch`) or another
local branch points at exactly that commit. Detached submodule HEADs are
rarely what the user wants: commits made there are easy to lose (nothing
references them; eventually GC'd). Goal: when LeGit moves a submodule and a
branch already points at the resulting commit, put HEAD on that branch.

## Decisions (settled with Simon)

- **Attach rule:** prefer the configured `.gitmodules` branch when its tip is
  exactly the checked-out commit; otherwise attach when exactly ONE local
  branch points at that commit; ambiguous (2+ matches) or no match stays
  detached.
- **Scope:** all submodule moves LeGit performs - manual recorded update,
  post-switch/pull auto-update, and "pull latest" (`update --remote`, any
  strategy).
- **Setting:** global only, `submodule_attach_branch: bool`, default `false`
  (opt-in). Per-repo override deliberately deferred (YAGNI).

## Behavior

After every successful per-submodule move, when the setting is on:

1. If the submodule HEAD is not detached (`git -C <path> symbolic-ref -q
   --short HEAD` succeeds), do nothing - e.g. after `--remote --merge` /
   `--rebase` on an attached branch.
2. List local branches pointing at the new commit:
   `git -C <path> for-each-ref refs/heads --points-at HEAD
   --format=%(refname:short)`.
3. Decide via a pure function
   `choose_attach_branch(configured: Option<&str>, matching: &[String]) ->
   Option<String>`:
   - configured branch if present in the match list, else
   - the single entry if the list has exactly length 1, else
   - `None` (stay detached).
4. If a branch was chosen: `git -C <path> checkout <branch>`. Because the
   branch tip equals HEAD this is a content no-op: it only re-points HEAD.

**Attach failure never fails the update.** If the checkout fails (branch
checked out in another worktree, permissions, ...), the submodule stays
detached, the update still reports success, and the failure is logged via
`tracing::warn`. The attach is a courtesy on top of a complete update, not a
recovery step, so the append-error-note rule does not apply.

## Known limits (accepted)

- **Not a guarantee.** After a superproject switch to an older commit the
  gitlink usually matches no branch tip; staying detached is then correct.
  The setting means "attach when the refs align", nothing more.
- **Mixed tooling re-detaches.** A plain `git submodule update` outside LeGit
  detaches again; LeGit re-attaches on its next move.
- **Attached submodules drift visibly.** Once on a branch, pulling inside the
  submodule moves the branch and the superproject shows a modified gitlink.
  That is the desired workflow for people who develop in submodules, but the
  setting's help text should hint at it.

## Implementation

### Backend (`crates/legit-core`)

- `choose_attach_branch` + the post-move attach step live in `cli_impl`
  next to `update_one_submodule` (`mod.rs`). Both the recorded-update path
  (`submodule_update`) and the shared `update_one_submodule` call the step,
  covering all three entry points without duplication. In-submodule commands
  use the existing `["-C", <path>, ...]` pattern.
- The flag travels as a new field on the existing options/behavior structs
  (`SubmoduleUpdateOptions`, the auto-/remote-update behavior struct) so
  `legit-core` stays settings-agnostic.

### App (`src-tauri`)

- New global setting `submodule_attach_branch: bool`, default `false`, in the
  global settings struct (`state.rs`), `#[serde(default)]` so old settings
  files keep parsing.
- The three submodule-move commands (`repo_submodule_update`,
  `repo_submodule_update_remote`, `repo_submodule_auto_update`) read the
  setting from `AppState` and fill the options field. No new IPC command.

### Frontend

- Mirror the setting in the hand-written global-settings type
  (`src/lib/types.ts`).
- Toggle in `GlobalSettingsPanel` (submodules section): "Attach submodule
  HEAD to its branch after updates", help text noting it applies only when a
  branch already points at the updated commit, and that the submodule then
  tracks that branch (gitlink changes become visible when it moves).
- No call-site changes: the flag is resolved backend-side.

## Tests

- **Unit (`choose_attach_branch`):** configured match wins; unique fallback;
  ambiguous list stays detached; empty list stays detached; configured branch
  NOT in the match list falls through to the unique rule.
- **`cli_impl/flow_tests.rs` (FakeExecutor):** flag on: sequence contains
  `symbolic-ref` probe, `for-each-ref`, then `checkout` after a successful
  move; ambiguous `for-each-ref` output: NO checkout; flag off: NO probe at
  all; already-attached: probe succeeds, nothing further.
- **`tests/git_flows.rs` (real git):** encode the assumptions the feature is
  built on: `submodule update` detaches even when the configured branch
  points at the same commit (the premise); `for-each-ref --points-at HEAD`
  lists the branch; the follow-up `checkout` attaches while leaving
  `git status --porcelain` empty in both submodule and superproject.
