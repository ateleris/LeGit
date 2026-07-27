# Design: move a submodule to another path (wrap `git mv`)

**Date:** 2026-07-23
**Status:** Implemented (pending manual verification in the app).
**Origin:** Restructuring moved a submodule to another folder; done manually
(deinit/edit/re-add style) because it is not widely known that plain
`git mv <submodule> <new/path>` handles the whole move since git 1.8.5
(LeGit's floor is 2.34). The feature's value is discoverability plus
preflight/staging correctness, not new git mechanics.

## Decisions (settled with Simon)

- **Approach:** wrap `git mv` (rejected: reimplementing the move manually;
  docs-only hint).
- **UI:** the submodule row's path text edits in place (`InlineRenameInput`,
  Enter approves, Esc discards - app-wide rename convention). No dialog, no
  drag-and-drop.
- **Out of scope:** renaming the submodule NAME (config section +
  `.git/modules/<name>`; `git mv` keeps it stable on purpose and LeGit keys
  rows by name), cross-repo moves.

## Behavior

- Submitting a changed path moves the submodule; unchanged/empty input is a
  no-op.
- On success everything `git mv` did is left STAGED (`.gitmodules` edit +
  gitlink move) for the user's commit; LeGit never auto-commits.
- Errors surface git's message. Preflight refuses an occupied target before
  touching anything.

## Backend

`submodule_move(&self, from: &Path, to: &Path) -> Result<(), GitError>`
(trait + `cli_impl`):

1. Refuse an existing target path (clear `GitError`, no git command runs).
2. Create the target's missing parent directories (`git mv` refuses
   "destination directory does not exist"). If the move then fails,
   best-effort remove the directories just created; if that cleanup fails,
   append the fact to the primary error (`append_error_note`).
3. `git mv -- <from> <to>` via `run_simple`. Git moves the worktree,
   rewrites `.gitmodules`, moves the index gitlink, fixes the submodule's
   `.git` gitfile link, and stages all of it.

## Plumbing

- Tauri command `repo_submodule_move(repo_id, from, to)`, registered in
  `lib.rs`.
- Wrapper `submoduleMove(repoId, from, to)` in `src/lib/commands.ts` (no new
  types).
- `SubmodulesSection`: handler following the existing action pattern (busy
  guard, error toast, submodules-domain invalidation). `SubmoduleRow`:
  `editing` union gains `"path"`.

## Tests

- **`tests/git_flows.rs` (real git - the load-bearing level):**
  - move a populated submodule into a new nested folder: worktree at the new
    path, `.gitmodules` updated, change staged, `.git/modules/<name>`
    unchanged, `git -C <new> status` works (gitfile intact), follow-up
    commit succeeds;
  - dirty submodule: encode whatever real git does (content travels with
    dirt preserved, or refusal);
  - occupied target: refused, nothing changed;
  - uninitialized submodule: encode real git's behavior.
- **`cli_impl/flow_tests.rs`:** success path runs `rev-parse --show-toplevel`
  (root for the fs preflight) then exactly `mv -- <from> <to>`; occupied
  target never reaches `mv`; a path-escape (`..`) input runs no git command
  at all.
