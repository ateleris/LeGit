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
- **Git LFS-aware content views.** LeGit is already LFS-*compatible* for the
  core workflow: because everything runs through the real `git` CLI (which
  inherits the user's `git-lfs` install + `git lfs install` filters and PATH),
  clone/fetch/pull/push/checkout/commit smudge & clean transparently, and LFS
  HTTPS auth rides the existing credential helper. No LFS code exists and none
  is required to ship. **Gap:** content views that read committed blobs via
  `git show <rev>:<path>` / `git diff` do NOT run the smudge filter, so for an
  LFS-tracked file **File View / Blame / Diff at a revision show the ~3-line LFS
  pointer** (`version https://git-lfs… / oid … / size …`) instead of the real
  content (working-tree views are fine — already smudged). The new line-ending
  badge and binary detection also treat the pointer as ordinary text. Fix
  options: (a) minimal & safe — detect a pointer blob (starts with
  `version https://git-lfs.github.com/spec/`) and render a placeholder like
  "Git LFS object, 42 MB (oid …)", mirroring the existing binary-file handling;
  (b) later — smudge on demand (`git lfs smudge`, gated/lazy for size+network)
  to show real content. Also consider a one-line warning when a repo has
  `filter=lfs` in `.gitattributes` but `git-lfs` isn't installed.
- **Blame "blame parent" across renames.** The reblame-parent button hides
  when the file has no parent version (`BlameHunk.has_previous`, from git's
  porcelain `previous` header — fixes the "no such path in `<sha>^`" error on
  the file-adding commit). Remaining edge: when a hunk's commit **renamed** the
  file, `has_previous` is true but `reblameParent` blames `<sha>^:<current
  path>`, which fails because the file had a different name at the parent. The
  porcelain `previous <sha> <path>` header carries the old path — surface it on
  `BlameHunk` (e.g. `previous_path`) and reblame at that path instead of the
  current one.
- **Git Log panel follow-ups.** Filter/search the log, copy a command, jump
  a toast to its specific log entry (currently it just opens the panel).
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

### Clone / init
- `--shallow-submodules` pairing when depth + submodules are both set
  (skipped: fails on servers without reachable-sha1 fetch support).

### Advanced
- **Submodules** (the `GitBackend::submodules()` method is a `NotYet` stub) —
  list/update/sync.
- **Worktrees** (add/list/remove), **bisect**.

### Fetch
- **Auto-fetch follow-ups.** Background auto-fetch shipped 2026-07-07 (global
  setting, default off; fetch-only `fetch --all` of the **active repo**, quiet,
  guarded against hidden app / offline / in-progress ops, exponential backoff,
  session-disable on auth failure). Deferred remainder: optionally fetching
  the non-active open repos too, a prune toggle for auto-fetch (manual toolbar
  fetch prunes; auto-fetch deliberately doesn't), and metered-network
  detection (no good cross-platform signal today). Note: an auto-fetch on a
  repo whose credentials were never stored can pop the in-app credential
  prompt once; it is then disabled for the session on the resulting auth
  failure — a "never prompt from background fetch" broker flag would be
  cleaner.

---

## UX / polish

- **Open repository root in a configurable external editor.** Add a button
  (e.g. in the repo header / repo menu) that opens the repository root folder in
  the user's editor of choice. The editor command should be configurable in
  settings (a git-config-free app setting, e.g. an "External editor" field
  holding a command template like `code "$ROOT"` or `subl`, with a sensible
  per-platform default and a way to fall back to the OS "open folder" if
  unset). Backend spawns the configured command with the repo root; surface
  clear feedback if the command isn't found. Consider also offering "open file
  in editor" from file rows later, reusing the same setting.
- **Draft commit message: survive app restart?** The draft now lives in a
  per-repo in-memory store (shipped 2026-07-07), so it survives panel unload
  and repo tab switches but not an app restart. Persist it (e.g. into the
  per-repo settings doc) only if in-session turns out to be insufficient.
- **Repo Settings visual parity.** The Global Settings cleanup (2026-07-06)
  gave the global panel collapsible category groups + a shared `SettingsGroup`/
  `Section` template (`Settings/primitives.tsx`) and a "Git config" pill on
  git-writing settings. The **Repo Settings** panel still uses the older flat
  layout; bring it onto the same primitives for consistency if wanted.

---

## Release readiness (v0.x → first public release)

Mostly shipped (v0.9.0): `tauri build` bundling is wired for all targets
(Windows `.msi` + NSIS, macOS `.dmg` for Apple Silicon **and** Intel, Linux
`.deb` + `.AppImage`; identifier `dev.legit.app`, icons, product name);
versions are semver and aligned across the Cargo workspace,
`tauri.conf.json`, and `package.json` (bump checklist in `RELEASING.md`); a
tag push drafts a GitHub Release with all installers attached
(`.github/workflows/release.yml` via `tauri-action`, reviewed before
publishing) next to a CI workflow; the README covers features, install, and
building from source; code signing is explicitly deferred with a note (builds
are unsigned; the release notes and README document the SmartScreen/Gatekeeper
warnings). Open remainder:
- **LICENSE file.** The repo has no LICENSE yet — pick one and add it before
  the release is public (the Releases page implies redistribution).
- **README screenshots.** The README has no screenshots; add one or two once
  the UI is deemed presentable.
- **Changelog decision.** There is no CHANGELOG file; today the drafted
  GitHub Release body is the changelog (edited at review time). Decide
  whether that stays the scheme or a curated `CHANGELOG.md` should be seeded
  and referenced from the release notes.
- **Pre-release pass.** Smoke-test the built (non-dev) bundles on each
  target, since several code paths differ from `tauri dev` (e.g. the
  `CREATE_NO_WINDOW` git-spawn flag, `windows_subsystem = "windows"`,
  bindings generated only when the app runs).
- **Analyse bundling a git executable with LeGit.** Investigation, not a
  decision yet. LeGit currently relies on the user's system `git` (found on
  PATH) and deliberately inherits its install — this is why LFS, credential
  helpers, and SSH "just work" (see the runner-env and LFS backlog notes).
  Bundling our own `git` would remove the "git not installed / too old"
  failure mode and give a known, tested version, but it's a real trade study.
  Points to weigh: (a) **what breaks** — a bundled git wouldn't see the user's
  global config, credential helpers (GCM), `git-lfs` filters, or SSH setup
  unless we explicitly wire PATH/GIT_EXEC_PATH to still find the system's
  helpers; risks regressing the very integrations we get for free today.
  (b) **size / packaging** — a portable git (esp. MinGit on Windows) adds tens
  of MB per platform and its own update/security burden; on macOS/Linux git is
  usually already present, so the win is mostly Windows. (c) **fallback model**
  — prefer bundled but fall back to system, or system-first with bundled only
  when absent? (d) **version pinning + CVE patching** — we'd own tracking git
  security releases. (e) **licensing** (GPLv2 redistribution) and how it
  interacts with our bundle. Deliverable: a written recommendation (bundle /
  don't / bundle-Windows-only) with the config-inheritance strategy spelled out
  before any code.
