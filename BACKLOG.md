# LeGit Backlog

Deferred features and extension ideas - things intentionally postponed, not
forgotten. When a feature is put off ("let it be for now", "later", "future"),
add it here with: what it is, why it's deferred, and a rough approach so it can
be picked up cleanly. Completed items are removed (git history keeps the
record); an item that is partially done keeps only its open remainder.

Last full review: 2026-07-11 (audited every item against the code, dropped
shipped items, re-prioritised). Companion state-of-the-app review:
`design/2026-07-11-state-of-the-app.md`.

---

## Release blockers (v0.9.x -> first public release)

In rough order:

1. **LICENSE file.** The repo has no LICENSE yet - pick one and add it before
   the release is public (the Releases page implies redistribution).
2. **Conflict-resolution verification pass.** Pending since 2026-07-10:
   vitest suites + manual end-to-end run of the overhaul (mark-resolved
   guard -> marker badge -> reopen-conflict -> side-select header checkboxes
   incl. gutter alignment -> resolution-invisible toast -> abort
   hold-disabled-until-refresh; plus the toast line-clamp fix, the dev
   build's "LeGit DEV" title + ribbon icon (regenerable via
   `scripts/make-dev-icon.py`), and the draggable unstaged/staged split in
   Working Changes in every section order) from PowerShell; WSL-side
   cargo/tsc are green.
3. **Credential manager verification pass.** A check over the whole chain
   before release: helper-shim registration lands at the END of the helper
   list (GCM / profile helpers still win where configured), broker prompt
   appears when no other helper answers, keychain entries are written only
   after git confirms via `store`, cached credentials are scoped to the
   session. Exercise against real remotes (GitHub HTTPS with GCM installed,
   a remote with no helper configured) on Windows and in WSL/Linux, where
   the helper landscape differs (no GCM by default; keychain backend is
   Secret Service).
4. **Pre-release pass.** Smoke-test the built (non-dev) bundles on each
   target, since several code paths differ from `tauri dev` (e.g. the
   `CREATE_NO_WINDOW` git-spawn flag, `windows_subsystem = "windows"`,
   bindings generated only when the app runs).
5. **README screenshots.** Add one or two once the UI is deemed presentable,
   and check the README/release-page branding matches the new logo
   (swapped in 2026-07-09).

Decided and recorded, no action: **git is not bundled** (trade study
`design/2026-07-07-bundled-git-trade-study.md`; install-relative config,
size, and CVE ownership; revisit trigger + download-on-demand fallback
design are in the study). Code signing stays deferred with the
SmartScreen/Gatekeeper warnings documented.

---

## Next up (high value, post-release ok)

- **Improve the merge window.** (Requested 2026-07-09; exact scope to be
  defined with Simon before starting.) Merging is still a set of
  fire-immediately context-menu entries (merge ff-auto / no-ff / ff-only /
  squash -> `repoMerge` from BranchesPanel / RefsCell). Likely direction: a
  merge dialog that shows what is about to happen before running it -
  source/target, the commits that would come in (`git log target..source`),
  ff-or-merge-commit prediction, options (ff mode, squash, message) in one
  place, and a conflict heads-up where cheaply detectable. Follow the
  panel/summon patterns; keep the quick menu entries as shortcuts.
- **Live-refresh the diff on external git changes.** The watcher's emitted
  domains (`status|log|branches|stashes|tags`) don't include `diff`, so an
  external `git` stage/unstage while the app is open doesn't refresh an open
  diff (in-app actions do). Add a `diff` domain on the Rust side.
- **Op-state indicator for background repos.** (Deferred 2026-07-10.) The
  strip under the repo tab bar surfaces only the active repo's in-progress
  merge/rebase/cherry-pick/revert; a background tab can be mid-operation
  with no visible hint. Idea: a badge/dot on the repo tab when that repo's
  `op_state` is not `none` (needs a per-repo op-state subscription).
- **Conflict-flow open remainders** (from the 2026-07-10 overhaul):
  - *Working Changes "Mark resolved" menu entry is unguarded*: the
    conflict-row menu stages the file directly (`repoStage`) with no
    markers check - deliberate for now (the warning badge catches it right
    after); decide whether it should get the same confirm as the Merge
    panel, which would need a file-content read at menu-action time.
  - *Header checkbox alignment is measured once per view build*: a global
    font-size change while the merge view is open rebuilds the view, so it
    re-measures in practice, but a path where the gutter width changes
    without a rebuild would let the header box drift.

## Git features (missing vs a normal client)

Each follows the same vertical slice: `GitBackend` method -> `cli_impl` via
`GitRunner` (+ parser if it returns data) -> Tauri command (registered in
`lib.rs`) -> wrapper in `lib/commands.ts` + type in `lib/types.ts` -> UI.

- **Worktrees** (add/list/remove) and **bisect**. The two whole-feature gaps
  left vs a full-featured client.
- **SSH passphrase prompting** (`SSH_ASKPASS` shim mode): the credential
  helper covers HTTP(S) only; encrypted SSH keys without an agent still
  fail non-interactively.
- **Keychain management UI**: list/forget credentials LeGit remembered
  (today: delete the "LeGit Git Credentials" entries in the OS keychain).
- **Git LFS-aware content views.** LeGit is already LFS-*compatible* for the
  core workflow (real git CLI inherits the user's `git-lfs` filters), but
  content views that read committed blobs (`git show <rev>:<path>` / diff at
  a revision) do NOT smudge, so File View / Blame / Diff at a revision show
  the ~3-line LFS pointer instead of the real content (working-tree views
  are fine). Fix options: (a) minimal - detect a pointer blob (starts with
  `version https://git-lfs.github.com/spec/`) and render a placeholder like
  the existing binary-file handling; (b) later - smudge on demand (gated for
  size/network). Also consider a warning when `.gitattributes` has
  `filter=lfs` but `git-lfs` isn't installed.
- **Blame "blame parent" across renames.** When a hunk's commit renamed the
  file, `has_previous` is true but `reblameParent` blames
  `<sha>^:<current path>`, which fails (different name at the parent). The
  porcelain `previous <sha> <path>` header carries the old path - surface it
  on `BlameHunk` (e.g. `previous_path`) and reblame at that path.

## Smaller follow-ups

- **Files panel:** untrack a folder (`rm_cached` needs `-r` for a
  directory); persist view mode / show-ignored (ephemeral component state
  today; mirror `changed_files_view_mode`); offer the nearest nested
  `.gitignore` or `.git/info/exclude` as ignore targets (always repo-root
  `.gitignore` today); escape `*`, `?`, `[` in `gitignore_line` (a filename
  containing them would become a glob).
- **Git Log panel:** filter/search the log, copy a command, jump a toast to
  its specific log entry (today it just opens the panel).
- **"Open in editor" on more file rows.** Shipped 2026-07-11 for Files /
  Working Changes / Changed Files (`repo_open_file_in_editor`, `$FILE`,
  shared `OpenInEditorMenuItem`); File History, Compare, and Search share
  `CopyPathMenuSection` and could get the same entry.
- **Interactive rebase polish:** drag-to-reorder rows, reword as a plan step
  (needs per-commit message injection), warning when the plan rewrites
  pushed commits. (Reword beyond HEAD as a standalone feature was dropped
  2026-07-05 by decision - not planned.)
- **E2E extensions.** Discard-with-confirm, branch create/switch, and stash
  create/pop specs added 2026-07-11 (awaiting their first CI runs). Still
  open: clone-via-"+"-menu flow, and push/pull against a local bare-remote
  fixture (`buildRemoteFixture`). Keep it a small smoke suite; Linux-only
  remains fine.
- **Frontend consolidation (from the 2026-07-11 hardening review, section
  D).** Deliberately parked: shared Popover/useDismissable for the 6
  hand-rolled dropdowns, shared composite file-row menu section, STALE
  query-time constants, summon-registry cross-check test, fixed-px padding
  sweep, theme.css value-equality test, GlobalSettingsPanel split (1309
  lines), GitBackend naming normalization (batch with the next backend
  feature). Also decide keep-or-delete for the unreferenced
  `crates/legit-providers` workspace member.
- **Submodules:** nested-tree overview (deliberately flat for now);
  hide-the-Refs-pane-when-no-gitlinks (paneview layouts persist panes);
  `--shallow-submodules` on clone when depth + submodules are both set
  (skipped: fails on servers without reachable-sha1 fetch support).

## Only if it hurts in practice

- **Diff viewer: cross-hunk syntax highlighting.** Per-hunk Lezer parsing
  shipped 2026-07-05; constructs opened before the hunk's context window
  still mis-parse. Full fidelity means fetching both full blobs, parsing
  each once, and mapping by line number - only worth it if the per-hunk
  approximation proves insufficient.
