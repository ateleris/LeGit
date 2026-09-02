# Changelog

All notable changes to LeGit are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
semver.

**Rule: every release from v1.0.0 on must have a section here.** The release
workflow refuses to build a `>= 1.0.0` tag whose version has no
`## [X.Y.Z]` heading in this file (`verify-version` job in `release.yml`).
Sections for pre-1.0 releases are welcome but optional - that early history
lives in the git log and the GitHub release notes.

## [Unreleased]

### Added

- Dev and PR builds show the commit they were built from next to the version
  (`1.0.3+abc1234`) in About and the log file's session banner, so artifacts
  and bug reports identify their exact build - with a `.wip` suffix when the
  build carried uncommitted changes. Releases keep the clean version.

### Changed

- Failed git-lfs downloads (e.g. objects never uploaded to the server) now
  surface an actionable message naming the affected files and the fix
  (`git lfs push` by whoever pushed them) instead of raw LFS noise - and
  any pull, branch switch, checkout, clone, or submodule update that
  "succeeds" while leaving LFS pointer stubs on disk now warns that those
  files hold no real content instead of reporting plain success.

- Deleting a branch that git refuses as "not fully merged" now explains why
  and offers a force delete in place: after a merge it names the branch that
  already contains the work, after a squash/rebase PR merge it reports the
  changes as merged despite differing commit IDs, and only genuinely
  unmerged work gets a data-loss warning.

## [1.0.3] - 2026-08-24

### Fixed

- Long filenames in the file lists (Working Changes, Changed Files) now
  truncate with an ellipsis instead of overlapping the +/- change counts.

## [1.0.2] - 2026-08-24

### Added

- Multi-commit selection in the Commits panel: Ctrl+click toggles rows,
  Shift+click selects a range. Right-clicking the selection offers bulk
  cherry-pick (oldest first), bulk revert (newest first), and, for exactly
  two commits, comparing them.
- Temporarily maximize a panel: Ctrl+Shift+M or View menu expands the active
  panel's group over the whole dock area; the same action, Esc, or navigating
  to another panel restores the previous layout. Maximization is never saved
  as the resting layout.
- Automatic update check on startup (Global Settings, on by default;
  check-only): an available update shows a toast, and clicking it opens the
  install prompt. Nothing downloads without confirmation.
- The update prompt now shows the release's changelog.
- Copy actions in the context menus: a commit's SHA and full message (and
  the SHAs of a multi-selection) in the Commits panel, and branch/tag names
  from ref chips and the Branches panel.

### Changed

- GitHub release notes now carry the version's changelog section instead of
  a generic body (assembled automatically by the release workflow).
- Error toasts now disappear on their own after 30 seconds instead of
  staying until dismissed (the details remain in the Git Command Log).

### Fixed

- Error ("fatal: ambiguous argument 'HEAD'") when initializing or opening a
  repository that has no commits yet; the commit graph now shows empty
  instead.
- The commit graph briefly showed the previously selected repository's
  commits after switching repos (or on window focus) while the new
  repository's history was still loading.

## [1.0.1] - 2026-08-21

### Changed

- Crash log stack traces now show real component/function names instead of
  minified ones.
- New default commit-graph metrics: row height and lane width 22, dot radius
  8, line width 2 (denser graph out of the box).
- The global dock now defaults to the left of the repo area instead of above
  it (existing installs keep their saved placement).

### Fixed

- Crash ("Something went wrong", React errors 300/310) when closing the last
  repository or opening one afterwards while panels are open.

## [1.0.0] - 2026-08-21

First public release. LeGit is a free, cross-platform Git GUI (Tauri 2:
Rust backend, React frontend) that wraps your installed `git` executable -
every operation is an ordinary git invocation, so behaviour and config match
the command line exactly.

Highlights of what 1.0 ships:

- **Commit graph** with lane locking, ref chips, type-to-jump, full-history
  search (message / author / SHA / rev), configurable columns, and
  content-fitted column widths.
- **Working changes & staging**: hunk- and line-level stage/unstage/discard,
  inline and split diff views (CodeMirror 6) with action parity and opt-in
  syntax highlighting, commit composer with amend and split commit-&-push.
- **Full daily-driver feature set**: branches/remotes/tags/stashes,
  interactive rebase, merge with conflict editor, cherry-pick/revert with
  mainline selection, submodules, file history, blame, compare, reflog,
  LFS detection with image previews, line-ending guardrails.
- **Panel system** (dockview): arrange, persist, and reset every panel;
  first-run layout designed for the click-through workflow.
- **Theme system**: every colour in the app resolves from a user-editable
  theme token; bundled themes meet WCAG AA contrast floors; live theme
  editor. The whole UI scales with one font-size setting.
- **Auth via git profiles**: SSH keys and credential-helper managed HTTPS,
  in-app passphrase/credential prompting; LeGit stores no secrets itself.
- **Auto-update**: in-app "Check for updates" against GitHub Releases
  (signed update artifacts).
- **Crash logging**: rotating log files with panic backtraces and frontend
  error capture ("Open log folder" in Global Settings → About).
