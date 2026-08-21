# LeGit Backlog

Deferred features and extension ideas - things intentionally postponed, not
forgotten. When a feature is put off ("let it be for now", "later", "future"),
add it here with: what it is, why it's deferred, and a rough approach so it can
be picked up cleanly. Completed items are removed (git history keeps the
record); an item that is partially done keeps only its open remainder.

Last full review: 2026-08-18 (dropped the shipped 2026-08 wave: LFS
detection/placeholders/track-management, binary image previews, the
interactive-rebase polish + manual passes, and the fixed known bugs).
Companion state-of-the-app review: `design/2026-07-11-state-of-the-app.md`.

---

## Release blockers (v0.9.x -> first public release)

(none - the blocker list emptied 2026-08-21: license landed, funding links
landed, first-run experience shipped. What remains before flipping the repo
public is a final read-through of the README and a smoke pass of the app.)

Decided and recorded, no action:
- **Release / distribution model: OPEN SOURCE + donations** - confirmed by
  Simon 2026-08-21 (option (a) of the 2026-08-19 trade-off: best
  adoption/trust for a git client and the strongest Ateleris marketing;
  donations are a tip jar, not a plan). Rejected: closed-source free
  download, fair source (FSL), free-personal + paid-commercial, open core.
- **License: GPL-3.0-or-later** - chosen by Simon 2026-08-21 (copyleft: no
  proprietary forks; "or later" per FSF convention). LICENSE file landed
  (verbatim gnu.org text), workspace Cargo.toml `license` set (all three
  crates inherit), package.json `license` field added, tauri.conf.json
  `bundle.licenseFile` points at ../LICENSE so installers embed the text
  (bundle license id itself defaults to the Cargo.toml value). Note the
  consequence recorded 2026-08-19: relicensing later needs a CLA once
  outside contributions land.
- **Funding links: Stripe donate link** - landed 2026-08-21.
  `.github/FUNDING.yml` uses a `custom:` entry with Simon's Stripe payment
  link (Sponsor button, zero platform signup); the README got a Donate
  badge in the header row plus a short "Want to say thanks?" section at the
  end. GitHub Sponsors / Ko-fi can be appended to FUNDING.yml later as
  one-liners if ever wanted.
- **Git is not bundled** (trade study
  `design/2026-07-07-bundled-git-trade-study.md`; revisit trigger +
  download-on-demand fallback design are in the study).
- **Code signing stays deferred**, SmartScreen/Gatekeeper warnings
  documented.
- **Standalone reword-a-commit action** (outside the interactive-rebase
  panel): dropped 2026-07-05; the rebase panel's reword step covers it.
- **git-flow helpers, archive export, git notes, sparse checkout**: decided
  against 2026-08-20 (competitive feature review vs SourceTree / GitKraken /
  Fork / Git Extensions / Sublime Merge / Tower). git-flow is ceremony in
  decline and LeGit's branch tooling doesn't need it; the other three are
  Git-Extensions-tier rarities the built-in Console covers when needed.
  Revisit only on real user demand.
- **LFS smudge-on-demand + "fetch LFS content" action**: dropped
  2026-08-17 - content is on disk / in `.git/lfs/objects`, and display
  value only materializes with rendered previews (now shipped for images).
  Stub recovery stays `git lfs pull` in the Console.
- **README screenshot branding spot check**: dropped 2026-08-18.
- **Summon into the last-active group**: dropped 2026-08-21 after checking.
  Placement memory persists in the layout envelope, so the default-placement
  split only happens on a panel's first-ever open; and the active group at
  summon time is usually the group the user just clicked in, so stacking
  there would cover the panel driving the interaction (dockview's implicit
  active-group add is already avoided in `openRepoPanel` because it can be
  the hidden console group). If first-open splits ever hurt, the viable
  variant is a descriptor-level `joinGroupOf` list generalizing the
  Diff/File View/Blame collocation (summon.ts Case 2c), not the active group.

---

## Known bugs

(none currently)

## Git features (missing vs a normal client)

Each follows the same vertical slice: `GitBackend` method -> `cli_impl` via
`GitRunner` (+ parser if it returns data) -> Tauri command (registered in
`lib.rs`) -> wrapper in `lib/commands.ts` + type in `lib/types.ts` -> UI.

- **Worktrees** (add/list/remove) and **bisect**. The two whole-feature gaps
  left vs a full-featured client. Deferred to post v1.0.0 (decided
  2026-07-20).
- **Platform integrations, open remainders** (SSH key tools, PAT connect,
  and broker HTTPS auth shipped 2026-07-13; scope = GitHub/GitLab/ADO,
  SSH-first, per 2026-07-13 decision; code lives in
  `crates/legit-providers` + `commands/accounts.rs` / `ssh_keys.rs`):
  - **OAuth device flows** (GitHub client-id-only, GitLab device grant,
    Entra device code for ADO) - blocked on registering app client IDs
    (Simon's account/org); the code seam is
    `legit_providers::validate_token`.
  - **Self-hosted GitLab hosts** (gitlab.com fixed for now).
  - `ssh -T` connection test could surface WHICH account authenticated
    (parse the "Hi <user>!" line).
  - Legacy `org.visualstudio.com` ADO remotes miss the `dev.azure.com`
    keychain entry (fix only if it hurts).
  - *(Separate product decision)* repo listing for the clone dialog,
    PR/issue surfaces.
- **SSH key generation: offer a passphrase** (the last remainder of the
  SSH passphrase item; prompting itself shipped 2026-08-20 via the
  `SSH_ASKPASS` shim on the credential broker - passphrase-protected keys
  now prompt in-app, incl. host-key confirmations and the `ssh -T` probe).
  Remaining: a passphrase field on the key-generation form
  (`ssh-keygen -N <pass>`), now that such keys are usable.
- **Keychain management UI**: list/forget credentials LeGit remembered
  (today: delete the "LeGit Git Credentials" entries in the OS keychain).
- **Line-ending normalization: skip-unstaged refinement.** `--renormalize`
  implies `-u`, so the shipped Normalize block (2026-07-29) also stages
  pending unstaged edits of tracked files - v1 warns with a count in the
  confirm step; the refinement restricts the pathspec to files without
  unstaged edits.
- **Git LFS, add only on demand** (detection/banner/icons, pointer
  placeholders, and root-`.gitattributes` track management all shipped
  2026-08-17/18): a Files-panel context-menu track/untrack entry, file
  locking (`git lfs locks`) - these matter mainly to asset-heavy teams,
  which LeGit does not currently target.
- **Binary preview remainder** (image previews in Diff + File View incl.
  local LFS objects shipped 2026-08-18, spec
  `docs/superpowers/specs/2026-08-18-binary-image-preview-design.md`):
  audio (MP3/WAV/OGG playable panes - the RIFF/WAV sniff case is already
  encoded), SVG (text to git, needs an extension-triggered path),
  zoom / 1:1 toggle, swipe/onion-skin comparison. Add on demand.
- **Patches: create + apply** (from the 2026-08-20 competitive review;
  SourceTree, Fork, and Git Extensions all have both). "Create patch" from a
  commit (later: a range, once multi-select exists) via `format-patch`, and
  "Apply patch file" via `git apply` / `git am` (am = keeps authorship +
  message; offer both). The workflow for moving changes without a shared
  remote. Standard vertical slice; file dialogs via the existing Tauri
  dialog plumbing.
- **Multi-commit selection in the Commits panel** (2026-08-20 review; every
  surveyed competitor has a form of it). Ctrl/Shift row selection unlocking
  the field-standard bulk actions: cherry-pick a set (sequencer handles
  multi-commit continue/abort already), revert a set, compare two selected
  commits (feed the Compare panel), create patch from range. Touches row
  selection state + context-menu plumbing; the backends are largely present.

## Smaller follow-ups

- **Auto-update: on-startup check behind a setting** (the open remainder of
  the in-app updater, which SHIPPED 2026-08-21: `tauri-plugin-updater` +
  `tauri-plugin-process`, signing keys in repo secrets, `latest.json` via
  `tauri-action`, "Check for updates" button in Global Settings → About -
  see RELEASING.md). Wanted later: an optional periodic/startup check
  (global setting, default off or on?) that surfaces "update available" as
  a toast or a subtle chip instead of requiring the manual button. Also
  worth considering then: a nicer changelog display (release notes from the
  GitHub release body) in the update prompt.
- **Settings sync via a user-configured URL** (2026-08-21). Let the user
  point LeGit at a location where its settings are stored, so one
  configuration can be shared across installations and across users (a
  team distributing a common setup). Today everything is local:
  `<app-data>/global-settings.json`, `repos/<hash>/settings.json`, themes,
  column preferences, and the dock layouts (localStorage). Open design
  questions before building: what the "URL" is (an HTTP(S) endpoint LeGit
  GETs/PUTs, a git repo it pulls, a WebDAV share, or just a file path on a
  network drive - a plain file/dir path covers the team case with zero
  server code and may be the right v1); which settings are shareable vs
  machine-bound (editor command template, UI font size, and repo settings
  keyed by local path hashes do not travel; themes and column prefs do);
  read-only "inherit from URL, override locally" vs true two-way sync
  (two-way needs conflict handling - last-write-wins with a timestamp is
  probably enough); and auth for a remote endpoint (LeGit stores no
  secrets, so anything beyond an unauthenticated GET needs the keychain
  broker). A layered read path (defaults -> synced -> local overrides)
  fits the existing `Option<T> + serde(default)` settings convention.

- **Files panel:** untrack a folder (`rm_cached` needs `-r` for a
  directory); persist view mode / show-ignored (ephemeral component state
  today; mirror `changed_files_view_mode`); escape `*`, `?`, `[` in
  `gitignore_line` (a filename containing them would become a glob).
- **Git Log panel:** filter/search the log, copy a command, jump a toast to
  its specific log entry (today it just opens the panel).
- **Temporarily maximize a panel to the whole window** (2026-08-21). A
  "focus mode" for one panel: expand it over the entire LeGit window
  (hiding the other groups) while working in it - e.g. resolving a merge in
  the Merge panel or reading a large diff - then restore the previous layout
  with one action. Check what dockview already gives us before building
  anything: it has group maximization (`api.maximizeGroup` /
  `hasMaximizedGroup` / `exitMaximizedGroup`) plus popout/full-width group
  concepts, so this may be a thin wrapper over its API rather than a layout
  of our own. Open questions: whether it maximizes the GROUP (tab strip
  included) or the single panel; how it interacts with the persisted layout
  (maximization must never be saved as the resting layout); the restore
  path when the maximized panel is closed while maximized; a keyboard
  shortcut plus a View-menu entry; and whether the repo/global dock strips
  stay visible.
- **Commits panel: incremental log appending** (decided 2026-07-30). Today
  every window growth (infinite scroll, and the jump-seek) refetches the
  WHOLE window from offset 0 and re-parses it - O(n^2) total work,
  mitigated for the seek by exponential window doubling (`growJumpWindow`).
  The clean fix: fetch only the next page (`repoLog` already takes an
  offset) and append - the lane algorithm was designed for this
  (`previousAssignments` keeps existing rows stable; incremental == full
  recompute is pinned by the "load-more … edge set" tests in
  `lanes.test.ts`). Likely React Query infinite-query style. Caveats:
  offset pages are only consistent while refs don't move (a watcher
  invalidation mid-walk must restart the walk), and the auto-seek needs a
  guardrail (~50k commits: stop and ask via toast). Keep-everything-loaded
  stays the model; windowed unloading was rejected 2026-07-30.
- **Commits panel search: touched-path query kind** (`git log -- <path>`) -
  the one search mode the shipped search bar (2026-07-30) lacks. NOTE: the
  Search panel was removed 2026-07-30 as redundant; with it went the UI
  for content search (pickaxe `-S` / `-G`) and path search. The backend
  (`search_commits` Content/ContentRegex kinds, `search_paths`) is kept
  and tested; re-adding is a small UI task if "when did this string
  change?" archaeology is missed.
- **Diff viewer: ignore-whitespace toggle** (2026-08-20 review; Fork,
  Sublime Merge, Git Extensions, Tower have it). A toolbar toggle mapping to
  `git diff -w` / `--ignore-space-change` on the diff fetch (both inline and
  split - action parity), persisted like the syntax-highlighting toggle.
  NOTE: hunk stage/discard operate on the UNfiltered diff; simplest correct
  v1 disables hunk/line actions while the toggle is on (view-only), like the
  full-file mode. Word-wrap + Ctrl+F stay folded into the keyboard-shortcuts
  item.
- **Commit `--no-verify` (bypass hooks)** (2026-08-20 review; SourceTree,
  Fork, Git Extensions have it). Hooks run today because every op is a real
  git invocation, so a stuck/broken hook blocks committing entirely with no
  escape short of the Console. A small "bypass commit hooks" caret/checkbox
  on the commit composer (per-invocation, never persisted - silently
  skipping hooks by default is a footgun) mapping to `commit --no-verify`.
- **Cherry-pick: "record origin" option (`-x`)** (split out 2026-08-20 - a
  genuinely new, tiny feature, unlike the merge-commit support above).
  Appends "(cherry picked from commit <sha>)" to the message - the
  conventional breadcrumb when porting fixes across long-lived/release
  branches. Per-invocation choice (e.g. a second menu entry or a caret),
  not a persisted setting.
- **Branch list: filter box** (2026-08-20 review; table stakes in every
  surveyed tool). A small text filter above the Branches section narrowing
  local + remote lists (substring on the short name, keep folder groups),
  Esc clears. The grouped/folder view helps but doesn't replace typing
  "fix/".
- **E2E extensions.** Still open: clone-via-"+"-menu flow, and push/pull
  against a local bare-remote fixture (`buildRemoteFixture`). Keep it a
  small smoke suite; Linux-only remains fine.
- **Frontend consolidation (parked, from the 2026-07-11 hardening
  review):** shared Popover/useDismissable for the hand-rolled dropdowns,
  shared composite file-row menu section, STALE query-time constants,
  fixed-px padding sweep, theme.css value-equality test,
  GlobalSettingsPanel split, GitBackend naming normalization (batch with
  the next backend feature).
- **Structural splits, when next touched** (2026-08-06 review remainder):
  `CommitsPanel.tsx` (~1700-line component; queries hook + row context
  menu + RemoteSyncToolbar are natural splits), `WorkingChangesPanel.tsx`
  (~1100-line function; CommitComposer + shared FileRowMenu),
  `cli_impl/mod.rs` (~5000 lines; submodule + line-ending blocks).
- **Internationalization: decide want/need (2026-08-04).** Open product
  question, not a commitment: is a non-English UI worth it for LeGit's
  audience? Inputs: git terminology stays English in most clients, and
  git's own stderr surfaces untranslated regardless, so translated chrome
  around English git output may feel half-done. Sized 2026-08-18 (EN-only
  tokenization): ~600-800 distinct frontend strings across 97 tsx files.
  Approach when picked up: NO i18n library yet - a typed TS catalog
  (`src/i18n/en.ts`) + tiny `t(key, params)`, tests import the catalog,
  enforcement via ESLint `react/jsx-no-literals` scoped to `src/panels`
  (the noLiteralColors equivalent). Scope = frontend chrome only (backend
  messages + git stderr stay English; translating those means error-kind
  enums over IPC, a separate project). DECIDED 2026-08-18: NOT a 1.0
  blocker - decide want/need first; if yes, infra + pilot panel, then a
  chunked sweep (~2-4 sessions) in the first quiet post-release window.
  `PANEL_TITLES` in `registry.tsx` shows the catalog shape and would be
  its first consumer. If "not needed": record that here and drop the item.
- **Keyboard shortcuts system** (possible future idea, surveyed
  2026-08-19; no commitment). Today the app has NO global shortcuts, no
  native menu/accelerators, no command palette, no configurable keymap -
  every key handler is local, focus-scoped, and hard-coded inline
  (~25 sites). What exists: Enter-submit in forms, Enter/Esc inline
  renames, Esc-dismiss in six overlays (two menus lack it), Commits
  type-to-jump (+ Alt+arrows through matches), full arrow-nav in the
  shared FileTree, Console history/Ctrl+C/pager keys, Ctrl+S in editable
  CodeMirror panes. Notable gaps if picked up: no app-wide actions
  (commit, fetch/pull/push, refresh, panel/repo-tab switch), Commits list
  has no plain arrow row-navigation, Working Changes and Interactive
  Rebase are mouse-only, no Ctrl+F in diff/merge/file view (CodeMirror
  `searchKeymap` unregistered), most panels' rows are not focusable, no
  focus trap in dialogs, zero keyboard tests. Approach when picked up:
  a small central keymap registry (single arbitration point, e.g. for
  the overloaded Escape; testable; user-remappable later) seeded with a
  few high-value bindings (Ctrl+Enter commit, refresh, commits-list
  arrows), NOT more inline handlers. Related deferred note: a shortcut
  to open the commits context menu
  (`design/2026-06-16-commits-context-menu-design.md`).
- **Commit graph: user-swappable shape tilesets** (designed 2026-08-19,
  stopped after approach approval; no spec yet). Let users restyle the
  graph's connectors and nodes with their own SVG fragments: a "texture
  pack" for the graph, eventually editable in a dedicated panel and
  loadable from a JSON file (analogous to `.legit-theme.json`). Decided
  architecture ("approach A"): split `GraphCell` into a pure part
  decomposition (`run-vertical`, `run-horizontal`, `corner-{ne,nw,se,sw}`,
  `crossing`, `node-{commit,merge,stash,workdir,avatar}`) plus two
  renderers behind that seam: the parametric renderer (today's
  lines/arcs/gradients, kept pixel-identical for the default look) and a
  tile renderer stamping tileset SVG via shared `<symbol>`/`<use>`. Tile
  contract: unit `0 0 100 100` viewBox, line anchors at edge midpoints,
  `currentColor` tinting (plus `var(--panel-bg)`), straight runs repeat
  stamps (never stretch), cross-lane colour fades step per stamp via
  `color-mix()`. Every part is optional and falls back to the parametric
  renderer (`node-merge` -> `node-commit` -> built-in dot), so partial
  tilesets work. Tilesets are JSON-serializable
  (`{ name, parts: { [partId]: { svg } } }`); at least one built-in
  alternate tileset should ship to prove the engine. Rejected: rendering
  the default look through the tile engine (smooth gradients cannot
  survive tiling and the byte-identical default test would be lost).
- **Submodules:** nested-tree overview (deliberately flat for now);
  hide-the-Refs-pane-when-no-gitlinks (paneview layouts persist panes);
  `--shallow-submodules` on clone when depth + submodules are both set
  (skipped: fails on servers without reachable-sha1 fetch support).

## Only if it hurts in practice

- **Native crash dumps (minidump/crashpad).** The crash logging shipped
  2026-08-21 (`src-tauri/src/logging.rs`: rotating file log, panic hook with
  message + file:line + backtrace, frontend error forwarding, session
  banner) covers Rust panics and JS errors - the bulk of real crashes. What
  it cannot catch: a segfault inside the webview (WebView2 / WebKitGTK), GPU
  process death, or an OOM kill - the process dies without reaching any
  in-process hook. If such reports actually appear, the fix is a
  minidump-writer (e.g. the `crash-handler`/`minidumper` crates) plus a
  "found a crash dump from last run" prompt; not worth the machinery before
  there is demand.

- **Diff viewer: cross-hunk syntax highlighting.** Per-hunk Lezer parsing
  shipped 2026-07-05; constructs opened before the hunk's context window
  still mis-parse. Full fidelity means fetching both full blobs, parsing
  each once, and mapping by line number - only worth it if the per-hunk
  approximation proves insufficient.
- **Commit-graph file for large repos.** The bulk log's `--date-order`
  (added 2026-08-19 for the equal-timestamp parent-order fix) makes git's
  walk "limited": measured on a synthetic 100k-commit repo (git 2.43), the
  first page costs ~0.5s without a commit-graph file and ~13ms with one
  (deep `--skip` pages converge either way; default order was ~instant).
  Repos that have been gc'd usually have one (`gc.writeCommitGraph`
  defaults on). If first-page latency ever hurts on a huge fresh clone,
  run `git commit-graph write --reachable` on repo open (or as a
  maintenance action).
