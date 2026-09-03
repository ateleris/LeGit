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

## Release blockers

### v1.2.0

- **Frontend consolidation batch** (parked 2026-07-11, promoted to blocker
  2026-08-24; details in `design/2026-07-11-hardening-review.md` §D):
  shared `Popover`/`useDismissable` for the hand-rolled dropdowns, shared
  composite file-row menu section, `STALE` query-time constants, fixed-px
  padding sweep, theme.css value-equality test, `GlobalSettingsPanel`
  split. (The seventh review item, GitBackend naming normalization, stays
  a non-blocker - batch it with the next big backend feature.)
- **Keyboard shortcuts system** - full plan in
  `design/2026-08-24-keyboard-shortcuts-system.md` (command registry +
  keymap-as-data + one dispatcher with a context/dismissable stack + input
  guard; seed bindings incl. Mod+Enter commit, fetch/pull/push, F5, tab
  switching, Commits arrow-nav, and issue #21's Ctrl+A select-all in
  Working Changes; generated help overlay; phases 2/3 = focus management,
  then user keymap + palette). Phase 1 is roughly one focused session.
  Related deferred note: a shortcut to open the commits context menu
  (`design/2026-06-16-commits-context-menu-design.md`).

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
  commit or a selected range (multi-select shipped 2026-08-22) via
  `format-patch`, and
  "Apply patch file" via `git apply` / `git am` (am = keeps authorship +
  message; offer both). The workflow for moving changes without a shared
  remote. Standard vertical slice; file dialogs via the existing Tauri
  dialog plumbing.

## Smaller follow-ups

- **Classify an untracked nested git repo as a submodule candidate.** Git
  reports a nested repo as one trailing-slash `? dir/` entry; the parser now
  strips the slash so the row renders, but the entry is still a plain
  `Untracked` file. Staging it as-is creates a gitlink without a
  `.gitmodules` entry (the case `gitmodulesWarning` flags after the fact).
  Better: detect the trailing-slash form in `parsers/status.rs`, give it a
  dedicated state, and offer "add as submodule" / warn before a plain stage.

- **Remote repositories: v1 deferrals** (2026-08-31, with the WSL feature —
  architecture in `design/2026-08-31-remote-repositories-wsl.md`):
  - **SSH hosts.** The protocol/transport is already agnostic (an
    `AgentTransport` supplies byte pipes; the agent is a static musl
    binary). Needs: an `SshTransport` (spawn `ssh.exe <host> <agent>
    --stdio`), deploy over ssh/scp, an `ssh://user@host/path` locator
    variant + `HostId::Ssh`, and host management UX. No protocol changes
    expected.
  - **Remote clone/init.** v1 only OPENS existing WSL repos; `repo_init` /
    `repo_clone` still resolve their paths locally. Route them through a
    host + locator like `probe_and_open` (clone needs the transient-op
    cancel path, which is already `Arc<dyn GitExecutor>`).
  - **Per-host git overrides.** Remote repos use PATH `git` from the
    agent's login-shell env; the per-repo override is refused for remote
    sessions (`set_repo_git_path`). Plan: `<app-data>/hosts/wsl-<distro>.json`
    (Option-fields convention) + a "Remote hosts" settings section; the
    remote per-repo override then stops being refused (its picker must not
    browse the app machine).
  - **Dedicated AgentGone error variant.** A dead connection surfaces as a
    RunnerError::Io/FsError message ("agent connection lost") — correct but
    unclassified; a `GitError` variant would let panels render "host
    disconnected, reconnecting…" instead of a generic failure.
  - **Binary sidecar frames.** Blob reads/`cat-file --batch` stdout cross
    as base64 (capped, fine in practice); the handshake reserves
    `encodings` for a `json1+bin` upgrade if profiling ever cares.
  - **Agent-side askpass prompt polish.** SSH askpass relays through the
    same broker as local (passphrase cache included); confirmations show
    ssh's raw prompt text — fine, but the dialog could name the distro.

- **Settings sync via a user-configured directory path** (2026-08-21,
  scope sharpened 2026-08-21 after design review; demand-driven - do not
  build before someone asks). A read-only "inherit from path" layer so one
  configuration (prefs + themes) can be shared across installations or a
  team. V1 design:
  - One optional global setting `settings_sync_path` - a plain directory
    (network share / Dropbox / a checked-out git repo). REJECTED for v1:
    HTTP(S)/WebDAV endpoints (auth needs the keychain broker for little
    gain over a synced folder) and two-way sync (conflict handling swamp;
    last-write-wins would corrupt a team setup). Read at startup + a
    manual "Reload synced settings" button; no file watching.
  - The directory holds `legit-sync.json` (shareable prefs subset) and
    optionally `themes/*.legit-theme.json`.
  - Layered resolution: built-in default -> synced -> local, LOCAL WINS.
    Requires moving the shareable prefs to `Option<T> +
    #[serde(default)]` in the local file (None = inherit), the existing
    RepoSettings convention; existing installs' concrete values then
    parse as explicit local overrides - the correct migration for free.
  - Shareable: theme choice + font size + graph metrics + date format +
    pull strategy + confirm toggle + column prefs + region placement.
    Never synced: open-repo state, last-dirs, `git_path_override`, git
    profiles (identities + machine-bound key paths), repo settings
    (local-path-hash keyed).
  - Themes ARE included - the most shareable artifact (portable JSON,
    stable TOKEN_CONTRACT, resolveTheme falls back over DEFAULT_THEME).
    Implementation seam exists: a third `ThemeSource::Synced` next to
    Builtin/User in `read_theme_dir`, read-only in the Theme Editor like
    builtins (duplicate-to-edit) - sidesteps name-collision and
    upstream-deletion semantics. `active_theme` syncs as a normal pref.
  - Phase 2 candidates: dock layouts (needs them out of localStorage
    into the exportable surface first), an export/import bundle file.

- **Files panel:** untrack a folder (`rm_cached` needs `-r` for a
  directory); persist view mode / show-ignored (ephemeral component state
  today; mirror `changed_files_view_mode`); escape `*`, `?`, `[` in
  `gitignore_line` (a filename containing them would become a glob).
- **Git Log panel:** filter/search the log, copy a command, jump a toast to
  its specific log entry (today it just opens the panel).
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
- **Issue / PR templates** - deferred 2026-08-21 ("we'll do them if
  needed"): add GitHub issue forms + a PR template once real issue traffic
  shows the need. The bug form should ask for version, OS, git version, and
  the log file (Global Settings → About → "Open log folder", newest
  `legit.log.*`, skim for repo paths first).
- **E2E extensions.** Still open: clone-via-"+"-menu flow, and push/pull
  against a local bare-remote fixture (`buildRemoteFixture`). Keep it a
  small smoke suite; Linux-only remains fine.
- **GitBackend naming normalization** (`&str` vs `&CommitId` params,
  inconsistent `list_` prefixes): wide mechanical churn with no behavior
  change - batch it with the next big backend feature. (The rest of the
  2026-07-11 frontend consolidation batch moved to the v1.1.0 release
  blockers 2026-08-24.)
- **Structural splits, when next touched** (2026-08-06 review remainder;
  CommitsPanel.tsx split done 2026-08-24 - queries hook, row context menu,
  RemoteSyncToolbar; `cli_impl/mod.rs` submodule + line-ending blocks
  extracted 2026-09-01 into `submodules.rs` / `line_endings.rs`):
  `WorkingChangesPanel.tsx` (~1100-line function; CommitComposer + shared
  FileRowMenu).
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

- **LFS stub reporting for stash/discard/restore paths** (the last
  remainder of the LFS missing-objects feedback; everything else shipped
  2026-09-01: classification + per-flow wording, exit-0 stub detection for
  pull / switch / checkout / clone / submodule updates via `LfsStubs` on
  each outcome, friendly `formatAppError` case via the import-free
  `lfsMessages.ts`). Stash apply/pop, discard, and restore-file-at-revision
  also run checkouts that can smudge; wire the same `lfs_stubs_from_stderr`
  pattern through their outcomes.

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
