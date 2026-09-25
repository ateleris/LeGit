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

### Fixed

- Changing a repo setting no longer removes lane locks or the selected git profile set earlier in the session.
- Settings, themes, layouts and keybindings are saved atomically, so a crash mid-save can no longer leave a truncated file; a settings file that fails to load is kept as `*.corrupt-<time>` instead of being overwritten with defaults.
- Errors that also report a failed recovery step (e.g. "checked out in another worktree" plus a failed stash restore) keep their specific guidance instead of turning into a generic error.
- A merge rejected by a hook is reported as an error instead of as conflicts when a file name contains "conflict".
- A push declined by the server (branch policy or pre-receive hook, e.g. Azure DevOps "use a pull request") no longer shows the misleading "pull first or force-push" advice; the toast names the remote rejection and clicking it opens the Git Command Log with the server's message.
- Live updates stay off when turned off while a repository's watcher is still starting, and closed repositories no longer keep a stale watcher error.
- Credentials embedded in a remote URL are now masked in every git error message, not only in fetch/pull/push errors.
- A file name containing "conflict (" can no longer make a failed merge, rebase or cherry-pick look like a conflict.
- A branch checked out in another worktree is recognised in both git wordings when switching, not only when deleting.
- Checking out a branch from the Branches panel, or creating a branch from a stash, now offers the same clickable "open that worktree" toast as the Commits panel when the branch is checked out elsewhere.
- Pushing or deleting tags and deleting remote branches show the specific authentication / rejected-push guidance instead of raw git output.
- Tags' "pushed" indicators refresh after a background or external fetch.
- The Merge panel no longer drops an unsaved conflict resolution when it is asked to clear; it asks first, like the Diff panel.
- If git could not confirm an auto-stash before switching branches, the error now says your changes may be in the stash instead of only reporting the git failure.
- Line-ending indicators for files at a revision no longer read oversized blobs in full before skipping them.
- Repo Settings now shows the `.gitattributes` line-ending rules of WSL repositories (the file was looked up at a wrong path on Windows).

- Theme and layout names that Windows reserves (CON, NUL, COM1, ...) or that end with a dot are rejected on save instead of producing an unusable or silently renamed file.

### Changed

- Changing a repo's git binary override no longer restarts the repo session: the new binary is swapped in live, keeping panel state and selections.
- The Settings panels were redesigned: settings are grouped into finer categories (Branches, Remotes & sync, Submodules, Working tree, Application, ...), a search field filters them, and wide panels show a category nav that follows scrolling; Repo Settings mirrors the same layout. Category headers are full-width tinted bands that stay pinned while scrolling through their group (also in the Theme Editor).

## [1.3.3] - 2026-09-23

### Added

- New global setting to show author initials in the commit graph dots;
  with Gravatar avatars also enabled, initials appear only for authors
  without a Gravatar.
- Hovering a commit's subject shows the full message (including the body)
  when the cell can't show everything; hovering a commit dot shows the
  author.

### Changed

- The merge/rebase-in-progress and warning banners now use solid accent /
  warning colours in the built-in themes, so they clearly stand out when
  something needs attention.

### Fixed

- Gravatar dots in the commit graph no longer render slightly larger than
  plain dots (the lane-coloured ring overhung the dot radius).

## [1.3.2] - 2026-09-21

### Added

- Themes can give individual panels their own surface colours (Theme Editor →
  Panel overrides): e.g. a different background just for the Commits panel.
- macOS: a native menu bar (File / Edit / View / Window). View mirrors the
  in-app View menu (panels, saved layouts, maximize toggle), File opens
  repositories, the app menu's Settings… opens the Global Settings, and the
  Edit menu makes Cmd+C/V/X work in text fields.
- Panel border thickness setting (Appearance, under Panel corner radius):
  sets the panel-group border width; any value other than 1 switches to the
  spaced-chrome per-panel borders even without a gap or radius.
- While a merge is in progress, the commit message box is prefilled with
  git's standard merge message, so committing from the box concludes the
  merge with the same message the merge bar's Continue would use.

### Changed

- "Color branch chips by graph lane" and "Color stashes by their base
  commit's lane" are now global settings (Global Settings → Commits graph)
  instead of per-theme toggles, so they survive theme switches. Themes keep
  the branch-chip shade tuning; a theme that previously enabled the toggles
  needs them re-enabled once in Global Settings.

- The Working Changes layout rows (Global Settings) and the Interactive
  Rebase plan rows are drag-only now, with a drag handle matching the Layouts
  panel; the arrow buttons (and the layout rows' numbering) are gone.
- Summoning a panel never splits the layout anymore: a panel without a
  remembered spot joins an existing group as a tab (a related panel's group,
  or the active group) instead of carving out a new slot.

### Fixed

- The Refs panel's sections no longer stay collapsed to zero height when the
  first launch is slow (all space went to the last section until a divider
  was dragged); the initial size distribution now waits for the panel's
  first real measurement instead of giving up after 5 seconds.
- Panels no longer lose what they were showing when a layout is applied or a
  panel is closed and reopened: selections (Working Changes, Log, Changed
  Files), the open diff/merge/file view, log search and filters, and the
  Compare range now survive - and each repo remembers its own across tab
  switches.
- Applying a layout keeps the slot-sharing panel you are currently using:
  with a commit selected, Changed Files stays in place of a layout's Working
  Changes (and vice versa), and an in-progress Merge stays where the layout
  has Diff.
- Saving a theme that uses the "Lighter (40%)" or "Darker (40%)" filters no
  longer fails validation.
- A theme's per-panel `panel.border` override now also colours the panel's
  outer border (the spaced-chrome group border), following the visible tab.
- With "Color stashes by their base commit's lane" on, the line connecting a
  stash to its base commit is drawn solid in the base's lane colour instead
  of fading into the stash row's lane.

## [1.3.1] - 2026-09-17

### Added

- Saved layouts are reorderable: drag the rows in the Layouts panel. The
  "Apply saved layout N" shortcuts follow that order.
- The Layouts panel and the View menu show which shortcut applies each
  saved layout.
- Panel spacing and panel corner radius settings (Appearance): put a gap
  between the panels and round their corners; 0/0 keeps the classic flush
  look. The gap shows the theme's window background.

### Fixed

- Renaming a saved layout no longer moves it in the list, so it keeps the
  shortcut that applied it.
- The window now appears as soon as the theme has painted instead of after
  a 4-second fallback delay (the startup reveal was blocked by missing
  window permissions), and if it opens behind the app you are working in,
  the taskbar button flashes instead of staying silent.
- The View menu's "Maximize panel" entry now shows the actual configured
  shortcut instead of always claiming Ctrl+Shift+M.

## [1.3.0] - 2026-09-16

### Added

- "Add folder to .gitignore" in the Working Changes tree view's folder
  context menu (shown when the folder holds only untracked files).
- "Add to .gitignore" on a nested file is now a submenu offering the file
  itself (also the click action) or any folder layer above it.
- Keyboard Shortcuts panel (View menu): rebind any command with
  press-a-key capture, conflict detection, per-command or full reset, and
  import/export. Commit, fetch, pull, push, the panel summons and
  apply-saved-layout ship unbound - bind them here.
- Default shortcuts: F5 refreshes, Ctrl+1..9 jump to a repository tab,
  Ctrl+Tab/Ctrl+Shift+Tab switch tabs in recently-used order like Firefox
  (hold Ctrl to cycle deeper).
- Keyboard staging in Working Changes: Up/Down move the selection (the
  diff follows, Shift extends), Space (rebindable) stages/unstages the
  file, selection, or highlighted folder and advances to the next file,
  Ctrl+A selects all in the focused list (#21), Del discards with
  confirmation, and Left/Right fold folders. Files in flight dim until git
  confirms the move.
- The Files panel gets the same list keyboard: Up/Down move the selection
  (the file view follows), Left/Right fold folders, and a folder under
  the cursor takes the highlight - one highlight at a time in every file
  list.
- The commit graph gets Up/Down keyboard navigation: the selection moves
  like a native list with the details panels following, and Shift+Up/Down
  grows or shrinks a multi-commit selection for the bulk actions.

### Changed

- Named layouts now capture and apply only the repository section; the
  global section (Repositories, Theme Editor, Settings) keeps its own
  arrangement. Existing layout files still work - their global part is
  ignored.
- "Add to .gitignore" no longer prefixes nested paths with `/` - a pattern
  containing a slash is root-anchored already; top-level names keep the
  prefix, where it prevents matching at any depth.

- LeGit no longer demands a locally installed git when the machine has a WSL
  distribution: the startup screen only blocks when nothing can run git. WSL
  repositories use their distribution's binary.
- File context menus now share one common section (view, history, blame,
  copy path, open in editor) with consistent wording and order across panels.
- More UI spacing (paddings, margins, gaps) now scales with the global UI
  font size.

### Fixed

- The split buttons' caret menus (commit mode, pull strategy, push
  options, stash mode) no longer render behind a neighboring panel.
- Opening, cloning or initializing a repository on a machine without git now
  explains that git is missing and how to install it, instead of showing a raw
  error.
- A WSL distribution whose git is missing or older than LeGit supports is now
  reported when connecting to it, rather than failing later without a reason.
- Repository tabs are no longer forgotten at startup when git cannot be run on
  the app machine; they are kept for the next launch, as they already were for
  an unavailable WSL distribution.
- Every dropdown menu and popover now closes with Escape and dismisses
  consistently on outside clicks.
- The uncommitted-changes row no longer draws on top of a locked branch's
  lane when HEAD is behind that branch on the same line (e.g. main locked,
  dev checked out); it now branches out of HEAD on its own lane.

## [1.2.2] - 2026-09-11

### Added

- Filter boxes for the Branches, Tags, and Stashes lists in the Refs panel
  (substring match, Esc clears).

### Changed

- The branches/tags sort order dropdown moved from Global Settings into the
  Branches and Tags sections, next to the filter box; the two sections now
  keep independent sort orders (tags inherit the branches order until
  changed).

- Long branch, tag, and stash names in the Refs panel now truncate the path
  prefix first, so the name itself stays visible (as file names already did
  in Working Changes).

## [1.2.1] - 2026-09-10

### Fixed

- Submodules opened as a repo tab no longer show their own checkout as a
  foreign worktree (bogus entry in the Worktrees section, worktree icon on
  their own branch chip in the graph).

## [1.2.0] - 2026-09-10

### Added

- Case-only renames (e.g. `test.c` -> `Test.c`), which git cannot see on
  Windows/macOS, are now detected and shown as rename rows in Working
  Changes - including renames made while LeGit was closed. The row offers
  "Stage rename" and "Discard rename" (back to the tracked spelling) plus
  the usual blame/history/editor actions. Opt out via the new "Detect
  case-only renames" setting.
- Multi-selecting unpushed commits in the graph now offers "Drop N
  commits" and "Squash N commits into one" (with an editable message,
  prefilled from the selected commits) in the context menu. Both run as an
  automatic rebase in the background; a conflict rolls the branch back
  unchanged. The entries only appear when every selected commit is on no
  remote.
- Worktree support: a new Worktrees section in the Refs panel lists all
  worktrees and can add (new or existing branch), open as a separate repo
  tab, remove (with a force offer for dirty trees), lock/unlock (with an
  optional reason), add detached at a revision, and prune. Switching
  to a branch that is checked out in another worktree now says which one,
  branch chips in the commit graph mark such branches with a worktree
  icon (tooltip names the worktree), detached worktree HEADs appear as
  their own chip in the graph (right-click opens that worktree), a dirty
  worktree shows a dot on its chip and a "dirty" badge in the Worktrees
  section, the checked-out-elsewhere refusal toast opens that worktree on
  click, and a worktree tab live-updates when refs change in the main
  checkout.
- Themes can color branch and remote chips by the graph lane their commit
  occupies, with per-part filters (foreground/border/background) applied
  to the lane color - new toggle and dropdowns under Refs in the Theme
  Editor, off by default. A companion toggle colors stash nodes by their
  BASE commit's lane instead of their own row's lane.
- SVG files now render as images in the diff viewer (old/new panes, like
  PNGs) and in the file preview, falling back to the text diff when the
  content is not actually SVG.
- A repo whose file watcher failed to start now shows a "live updates off"
  badge on its tab with the reason (previously the failure was only a log
  line and the repo silently stopped auto-refreshing).

### Changed

- On Linux/WSL the file watcher no longer registers watches inside
  gitignored directories, so repos with huge ignored trees (`node_modules`,
  `target`, package caches) start their watch in a fraction of the time and
  no longer risk the OS watch limit.

### Fixed

- Clicking a very large changed file (e.g. a multi-megabyte exported SVG)
  no longer crashes the app with an out-of-memory error: diffs above 20 MB
  now show a "too large to display" notice instead of rendering.
- Clicking a staged rename in Working Changes now shows it as a rename
  (with content hunks if the file was also edited) instead of a whole-file
  addition; the row also shows the old name.
- Unstaging a staged rename now unstages both sides; previously the old
  path's deletion silently stayed staged.

## [1.1.1] - 2026-09-08

### Added

- **Named layouts.** Save any number of panel arrangements under a name and
  switch between them from the View menu (click applies; each entry's
  submenu can override the layout with the current arrangement). The new
  Layouts panel manages them - save, apply, override, rename, delete,
  import/export as `.legit-layout.json` files - and offers "Reset to default
  layout". The whole layout set can be exported/imported as a single file
  (e.g. when setting up LeGit on a new machine); Import accepts both file
  kinds.

### Changed

- The View menu's "Save as default layout" / "Reset to default layout"
  entries were replaced by named layouts; an existing saved default is
  migrated to a layout called "My layout" automatically.

## [1.1.0] - 2026-09-03

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

- "Test SSH connection" now shows an unknown server's host key fingerprint
  for confirmation instead of trusting it silently, matching what a fetch or
  push over SSH already does.

### Fixed

- A submodule declared in `.gitmodules` but not yet staged (`git add` of the path still pending) now appears in the Refs panel's Submodules section instead of being hidden until the first gitlink is staged.
- Submodule rows in Working Changes now show the fork icon (staged and unstaged alike), so a to-be-added submodule no longer looks like a plain new file.
- Opening the diff of a not-yet-staged nested repository (e.g. a submodule before `git add`) no longer shows "no changes"; it shows the submodule view with the commit that staging would record.
- Closing the last tab of a WSL repository no longer shows a "Connection lost — reconnecting…" toast; "reconnecting…" now only appears while the app will actually reconnect. A distro connected only for Settings reports the loss plainly instead, and a standing "reconnecting…" toast is retired when the reconnect stops.
- The git executable path from Settings is trimmed before it is applied, so a stray trailing space no longer breaks resolution.
- Cancelling a clone on Windows sometimes failed with "The partial clone
  could not be removed … being used by another process": only git's top
  process was killed and an orphaned helper kept the pack file open. A cancel
  now terminates the whole git process tree.
- The "Cloning" tab's spinner no longer wobbles after clicking cancel (the
  row squeezed it into an ellipse).
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
- The WSL indicator on a repository tab now uses the same colour as the tab's
  name, so it brightens with the text on the active tab instead of staying
  dimmed.
- A credential the server rejects no longer deletes a different stored
  credential for the same host from the OS keychain.
- An untracked nested git repository (a submodule-to-be not yet added) showed
  up in Working Changes as a nameless row under its parent folder; it now
  renders under its own name.

### Security

- A token embedded in a remote URL (`https://<token>@github.com/...`) is no
  longer written to the log file when adding or editing a remote; only the
  redacted form is logged. Existing log files may still contain one - the
  log folder is reachable from Global Settings, About.

- Imported themes are checked more strictly: a palette entry must be a single
  colour, so a theme can no longer smuggle other CSS (such as a remote
  `url(...)` that would phone home) into the UI.

- Remote names that look like command-line options are now refused, as branch
  and tag names already were.

- The app ships with a Content Security Policy, and deleting a submodule's
  retained git directory refuses to follow a symlink out of the repository.

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
