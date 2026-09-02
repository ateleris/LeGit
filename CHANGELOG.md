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

- **Remote repositories (WSL).** LeGit on Windows can now open repositories
  that live inside a WSL distribution — use the regular "Open repository…"
  and pick the folder under Explorer's Linux node: a `\\wsl.localhost\…`
  path is recognized and opened natively inside the distro. A small
  `legit-agent` is installed into the distro automatically (and removed
  again when the app is uninstalled) and runs git, file access, and the live
  filesystem watcher natively (no more "dubious ownership" or slow
  `\\wsl.localhost\` access). The git binary used inside each distro is
  configurable (Settings → Git (WSL)). Remote repos mix with local ones in
  tabs/recents (a compact WSL indicator shows the distro
  on hover), survive `wsl --shutdown` with auto-reconnect, share the in-app
  credential/SSH prompts and keychain, and reveal/open-in-editor do the
  right host-aware thing (`code .` opens VS Code Remote). A `legit` command
  is installed in the distro so `legit .` opens the current repo in the app,
  like `code .`.
- **Git settings for WSL distributions.** Settings now has a separate
  "Git (WSL)" section that configures each WSL distribution's own Git setup —
  git binary, identity, commit signing, credential helper and line endings —
  written to that distribution's global Git config, never the Windows one.
  Pick the distribution once at the top of the section; nothing is read or
  written until you connect (a distribution that is already running loads
  straight away). The credential-helper list now shows the helpers actually
  installed inside the distribution instead of Windows'. Connected accounts
  and identity profiles stay under "Git" — they are LeGit's own and already
  apply to WSL repositories.

### Fixed

- "New repository" and "Clone repository" now work for folders inside a WSL
  distribution. Picking a `\\wsl.localhost\…` folder (or typing a `wsl://`
  path) ran Windows git over the share, which failed with "dubious ownership"
  after `init` had already created the repository; both now run the
  distribution's own git inside WSL, and a cancelled WSL clone is cleaned up
  there too.
- A running clone is no longer lost when its dialog is dismissed. Each clone
  now gets its own "Cloning" tab in the repo tab strip while it runs: the tab
  shows the progress percentage, selecting it shows the clone's details and a
  progress bar in place of the repo panels, and its close button cancels the
  clone (after confirmation, removing the partial files). Closing the "+"
  menu or the Repositories panel mid-clone therefore keeps the clone visible
  and cancellable. The clone's outcome is reported as a toast (previously a
  clone that failed after the dialog closed failed silently), and the "+"
  menu no longer pins itself open while cloning.
- Repositories with very large working trees (e.g. a home directory opened as
  a repo) no longer hold up startup: the filesystem watcher now attaches in
  the background instead of blocking the "restoring repositories…" splash,
  and the repo refreshes once it is live. Previously six restored repos could
  take a minute to appear.
- The filesystem watcher no longer follows symlinked directories. Following
  them made it walk shared trees (package stores, caches) repeatedly, which
  could exhaust the operating system's watch limit and leave a repo with no
  live updates at all.
- Repo Settings no longer offers a per-repository Git executable override for
  repositories inside WSL. It showed the Windows git as the default and opened
  a Windows file picker for a path that has to exist inside the distribution,
  while the override was rejected anyway; it now shows the distribution's git
  and links to Settings → Git (WSL).
- Unsaved changes in one Settings form no longer suppress the
  "unsaved changes" confirmation when another form on the same panel is clean,
  so closing the tab can no longer discard edits silently.
- A WSL distribution that LeGit connected to only for Settings is no longer
  restarted every 15 seconds in the background after `wsl --shutdown`.
  Auto-reconnect now applies to distributions with open repositories; a
  Settings-only connection reports the loss and waits for Reconnect.

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
