# LeGit Backlog

Deferred features and extension ideas — things intentionally postponed, not
forgotten. When a feature is put off ("let it be for now", "later", "future"),
add it here with: what it is, why it's deferred, and a rough approach so it can
be picked up cleanly. Completed items are removed (git history keeps the
record); an item that is partially done keeps only its open remainder.

---

## Review findings deferred (2026-07-05 full-codebase review)

All findings from the review are now closed (second sweep 2026-07-05:
duplicate-OperationId guard in the runner, 3-way resolve CRLF preservation,
canonicalize-and-verify in `resolve_repo_relative`, credential-broker trust
docs + prompt attribution, File View binary classification) except one,
re-deferred with justification:

- **Runner: non-UTF-8 paths cannot be represented.** The whole `&[&str]` arg
  surface (and `<rev>:<path>` interpolation via `to_string_lossy`) assumes
  UTF-8 paths. Re-deferred after scoping: every path crossing IPC is JSON
  (UTF-8 by construction), so the frontend cannot even express a non-UTF-8
  path - a real fix means bytes end-to-end (runner + executor trait + every
  backend signature + an IPC encoding + frontend types), a cross-cutting
  rewrite. Today a repo with non-UTF-8 filenames fails cleanly (git reports
  "pathspec did not match" on the lossy-decoded name); nothing corrupts.
  Revisit only if such repos become a real support case.

---

## Other deferred ideas

- **Live-refresh the diff on external git changes.** The filesystem watcher's
  emitted domains (backend) don't include `diff`, so an external `git`
  stage/unstage while the app is open doesn't refresh an open diff (in-app
  actions do). Add `diff` to the watcher's domains in the Rust side.
- **Diff viewer: cross-hunk syntax highlighting.** Shipped 2026-07-05 (Lezer
  via `@codemirror/language-data`, opt-in global setting): each hunk's old/new
  side is reconstructed from the rows and parsed independently
  (`syntaxModel.ts`), so multi-line constructs highlight correctly *within* a
  hunk. Constructs opened before the hunk's context window still mis-parse;
  full fidelity would mean fetching both full blobs, parsing each once, and
  mapping by line number. Only worth it if the per-hunk approximation proves
  insufficient in practice.
- **Theme note: syntax palette vs heavy line tints.** Themes that tint
  changed-line text strongly (`diff.added.fg`/`diff.removed.fg`) may want
  their Syntax palette checked for contrast against the line tints - a
  theme-author concern, no code planned.
- **Diff viewer: inline editing of staged diffs.** Unstaged working-tree
  diffs are editable (2026-07-03); staged diffs (new side = index) remain
  read-only — extend if wanted.
- **Files panel follow-ups.** The Files panel (repo-wide tree, tracked/
  untracked/ignored, History/Blame/View + ignore/untrack + copy/reveal)
  shipped 2026-07-06. Deferred:
  - **Untrack a folder.** The folder context menu offers "Add folder to
    .gitignore" but not "stop tracking" — `rm_cached` would need `-r` for a
    directory. Add a recursive untrack if wanted.
  - **Persist view mode / show-ignored.** Both are ephemeral component state
    today (tree + hidden on each open); persist in settings if the reset is
    annoying (mirror `changed_files_view_mode`).
  - **Nested `.gitignore` / `.git/info/exclude` targets.** Ignore actions
    always append to the repo-root `.gitignore`; offer the nearest nested
    `.gitignore` or the private `info/exclude` as alternatives.
  - **Escape gitignore glob metacharacters in paths.** `gitignore_line`
    anchors with a leading `/` (neutralising a leading `#`/`!`) but does not
    escape `*`, `?`, `[` inside a filename — rare, but such a path would become
    a glob. Escape them for exactness.
- **Git Log panel follow-ups.** Filter/search the log, copy a command, jump
  a toast to its specific log entry (currently it just opens the panel).
- **Consolidate the file-inspection panels (Diff / Blame / File View).**
  Considered 2026-07-06, deferred (undecided). These three all view "one file"
  and currently scatter across the layout when summoned. A 3-way `swapSummon`
  (like Changed Files ⇄ Working Changes) was floated but is a poor fit: unlike
  that pair, these are **complementary, not mutually exclusive**, and **Diff is
  the high-frequency primary** (summoned on every file click from Changed
  Files / Working Changes / Compare / File History) while Blame/File View are
  occasional. A shared slot would let occasional actions evict the Diff
  mid-review and tear down in-progress state (scroll, split/inline, half-staged
  hunk). Preferred approach if picked up: **default all three into one dockview
  group as tabs** (consolidated location, switch by tab, nothing evicted,
  side-by-side still possible) rather than a swap. Heavier alternative: a
  single "Inspect" panel with a Diff/Blame/View mode toggle over the current
  `{path, rev, source}` — most "combined" but their inputs differ (Diff needs a
  `DiffSource`/hunk model) and you lose seeing two at once.
- **Interactive rebase polish.** The panel ships (reorder via up/down,
  pick/squash/fixup/drop, plan injected via the `printf`-redirect
  `GIT_SEQUENCE_EDITOR`, conflicts through the normal banner). Deferred:
  drag-to-reorder rows, reword as a plan step (needs per-commit message
  injection), and a warning when the plan rewrites pushed commits.
  (Reword beyond HEAD as a standalone feature was dropped 2026-07-05 by
  decision - not planned.)

---

## Git functionality — missing vs a normal client

Audited 2026-06-19; done items pruned since (large sweep 2026-07-04: per-remote
branch view, in-app credential prompt, inspection polish, clone/init options,
tag remote choice + annotated-from-graph, file restore/view at revision).
Each item follows the same vertical slice: add a `GitBackend` method →
implement in `cli_impl` via `GitRunner` (+ a parser if it returns data) →
Tauri command (registered in `lib.rs`) → wrapper in `lib/commands.ts` + type
in `lib/types.ts` → UI.

### Credential prompt follow-ups
The in-app credential prompt ships (2026-07-04): the app binary doubles as a
`git credential` helper (`--credential-helper` shim mode), injected via
`GIT_CONFIG_*` env config so it lands at the END of the helper list (GCM /
profile helpers keep winning where configured); a localhost token-guarded
broker answers from a session cache, the OS keychain (`keyring` crate,
written only after git confirms via `store`), or a UI prompt. Deferred:
- **SSH passphrase prompting** (`SSH_ASKPASS` shim mode): the helper covers
  HTTP(S) only; encrypted SSH keys without an agent still fail
  non-interactively.
- **Keychain management UI**: list/forget credentials LeGit remembered
  (today: delete the "LeGit Git Credentials" entries in the OS keychain).

### Inspection polish
- Search: virtualized results for huge repos (results are capped at 100
  today, so this only matters if the cap is raised).
- Rev pickers use a native `<input list>` datalist (Compare); a richer
  dropdown (grouped, fuzzy) could replace it if the native UX is not enough.
- Blame: the panel accepts a `{ path, rev }` summon payload and offers
  per-hunk "blame parent" time travel, but has no rev input of its own.

### Clone / init
- `--shallow-submodules` pairing when depth + submodules are both set
  (skipped: fails on servers without reachable-sha1 fetch support).

### Advanced
- **Submodules** (the `GitBackend::submodules()` method is a `NotYet` stub) —
  list/update/sync.
- **Worktrees** (add/list/remove), **bisect**.

---

## UX / polish

- **Repo Settings visual parity.** The Global Settings cleanup (2026-07-06)
  gave the global panel collapsible category groups + a shared `SettingsGroup`/
  `Section` template (`Settings/primitives.tsx`) and a "Git config" pill on
  git-writing settings. The **Repo Settings** panel still uses the older flat
  layout; bring it onto the same primitives for consistency if wanted.

---

## Release readiness (v0.x → first public release)

Not started. Prepare LeGit for a first tagged release:
- **Installers / bundles.** Wire up `tauri build` for the target platforms
  (Windows `.msi`/NSIS, macOS `.dmg`, Linux AppImage/`.deb`); confirm the
  bundle identifier, icons, product name, and version wiring in
  `tauri.conf.json` + `Cargo.toml`. Decide on code signing (Windows
  Authenticode, macOS notarization) or explicitly defer it with a note.
- **Automatic GitHub releases.** A CI workflow (GitHub Actions) that, on a
  version tag, builds the bundles on each OS runner and attaches them to a
  GitHub Release. Consider `tauri-action`. Include the auto-generated or
  curated changelog.
- **Repository cleanup.** Ensure `.gitignore` covers build output, add a
  README with screenshots + build instructions, a LICENSE, and prune any
  remaining dead files. (The tracked `crates/legit-core/src/XXYaRI8C` scratch
  file has been removed.)
- **Versioning + changelog.** Pick a versioning scheme, seed a CHANGELOG,
  and align the workspace version(s).
- **Pre-release pass.** Smoke-test a built (non-dev) bundle on each target,
  since several code paths differ from `tauri dev` (e.g. the
  `CREATE_NO_WINDOW` git-spawn flag, `windows_subsystem = "windows"`,
  bindings generated only when the app runs).
