# State of the app - 2026-07-11 (v0.9.2)

Written as part of the full backlog review (see BACKLOG.md, same date).
Snapshot of what works, what is rough, and what the next milestone should be.

## What works

The core daily-driver workflow is complete and hardened:

- **Working tree**: status, stage/unstage/discard at file, hunk, and line
  level (inline + split diff with action parity), per-file stash, resizable
  sections, commit composer with message memory.
- **History**: commit graph with injected stashes, commit details with
  on-demand signature verification, file history, blame (with reblame-parent
  guard), file view at any revision, compare, repo-wide search (virtualized,
  1000-result cap), reflog.
- **Branching and integration**: branches/tags/remotes panels, per-remote
  branch view, delete remote branch, merge / rebase (incl. interactive with
  reorder, squash/fixup/drop) / cherry-pick / revert with a shared op-state
  strip, and the 2026-07-10 conflict-resolution overhaul (mark-resolved
  guard, reopen conflict, marker badges, side-select checkboxes).
- **Repo lifecycle**: clone/init with options, multi-repo tabs with
  persistent sessions and user-controlled order, submodules (state model,
  navigation, lifecycle, safety), git profiles for identity/auth, in-app
  credential prompt (helper-shim broker + OS keychain).
- **Foundation**: everything through the hardened `GitRunner` (no library),
  pure parsers with unit tests, real-git integration harness
  (`tests/git_flows.rs`), filesystem watcher with fingerprint guards, full
  theme-token system with live editor, global UI scaling, e2e smoke suite
  (tauri-driver + wdio) on Linux CI, release packaging for Windows/macOS/
  Linux with a tag-push release workflow.

## What is rough

- **Two verification passes are pending**: the conflict-resolution overhaul
  (manual end-to-end from PowerShell) and the credential-manager chain
  (real remotes, Windows + WSL/Linux). Both are release blockers because
  they guard data-loss and auth paths.
- **Merge initiation UX**: merging fires immediately from four context-menu
  entries; there is no preview of incoming commits or ff prediction. An
  improved merge window is the one explicitly user-requested open feature.
- **Visibility gaps**: a background repo tab gives no hint that it is
  mid-merge/rebase; an externally staged change does not refresh an open
  diff (no `diff` watcher domain).
- **Content-view edges**: LFS files show pointer text in at-revision views;
  blame-parent breaks across renames; the Git Log panel has no
  filter/search.
- **Not implemented at all**: worktrees, bisect, SSH passphrase prompting
  (encrypted keys without an agent fail non-interactively).
- **Release hygiene**: no LICENSE, no README screenshots, builds unsigned
  (deferred by decision, documented), built bundles not yet smoke-tested
  per target.

## Next milestone

**First public release.** The gap is not features - the feature set already
matches a normal git client for daily work. The gap is trust: run the two
pending verification passes, add the LICENSE, smoke-test the real bundles on
each target, and put screenshots in the README. The merge window is the
first post-release feature, scoped with Simon before starting.
