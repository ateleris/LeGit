# LeGit Backlog

Deferred features and extension ideas — things intentionally postponed, not
forgotten. When a feature is put off ("let it be for now", "later", "future"),
add it here with: what it is, why it's deferred, and a rough approach so it can
be picked up cleanly. Completed items are removed (git history keeps the
record); an item that is partially done keeps only its open remainder.

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
- **Lane locks: let uncommitted changes and stashes sit on the locked lane.**
  The lane algorithm reserves locked lanes for the locked ref's first-parent
  ancestry and keeps everything else off them (`lockedLaneSet` in
  `src/panels/Commits/graph/lanes.ts`), which pushes the synthetic
  working-dir row and injected stash nodes onto a free lane even when they
  belong to the checked-out branch that owns the locked lane. They should be
  allowed on it: they are part of that branch's line. Approach: extend the
  ownership pass so the working-dir row (child of HEAD) and stash nodes
  whose parent commit lies on a locked ref's first-parent line inherit that
  locked lane instead of being treated as squatters.
- **Git Log panel follow-ups.** Filter/search the log, copy a command, jump
  a toast to its specific log entry (currently it just opens the panel).
- **E2E UI tests (tauri-driver) against a dummy repo.** The backend is covered
  by real-git integration tests in ephemeral tempdir repos (incl. bare
  `file://` remotes for push/pull/fetch/prune flows, added 2026-07-07); the
  *UI* has no automated coverage. Idea: drive the built app with
  `tauri-driver` (WebDriver) on a Linux CI runner against a generated fixture
  repo — smoke flows like open repo → stage a file → type a message → commit →
  see it in the log; later clone-via-"+"-menu and conflict-banner flows.
  Deliberately a separate CI job (heavier: needs a built binary +
  webkit2gtk-driver); keep it a small smoke suite, not a second test pyramid.
  Note Windows/macOS WebDriver support in Tauri is spottier — Linux-only is
  fine for smoke value.
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
- **Recheck the credential manager integration.** A verification pass over
  the whole chain before release: helper-shim registration lands at the end
  of the helper list (GCM / profile helpers still win where configured),
  broker prompt appears when no other helper answers, keychain entries are
  written only after git confirms, and cached credentials are scoped to the
  session. Exercise against real remotes (GitHub HTTPS with GCM installed,
  a remote with no helper configured) on Windows and in WSL/Linux, where the
  helper landscape differs (no GCM by default; keychain backend is Secret
  Service).
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


---

## UX / polish

- **Open a single file in the external editor.** "Open in editor" for the repo
  root shipped 2026-07-07 (Global Settings "External editor" command template;
  `$ROOT` substitution, PATH/PATHEXT resolution, file-manager fallback —
  `commands/editor.rs`). Extend it to file rows (Files / Working Changes /
  Changed Files context menus): a `repo_open_file_in_editor` command reusing
  the same template with the reserved `$FILE` placeholder (substitute when
  present, else append the file path).

---

## Release readiness (v0.x → first public release)

Mostly shipped (v0.9.0): `tauri build` bundling is wired for all targets
(Windows `.msi` + NSIS, macOS `.dmg` for Apple Silicon **and** Intel, Linux
`.deb` + `.AppImage`; identifier `ch.ateleris.legit`, icons, product name);
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
- **Replace the logo.** New logo drafts exist (SVG iterations, 2026-07-08);
  once one is final, regenerate the full bundled icon set from it
  (`npm run tauri icon` from a 1024px source replaces `src-tauri/icons/` —
  Windows/macOS/Linux sizes + store tiles) and swap the in-app splash asset
  (`src/assets/legit-logo.png`, used in `App.tsx`). Check the README/release
  page once screenshots land, so the branding is consistent.
- **Check the log level in release builds.** `init_tracing` (`lib.rs`)
  defaults the `EnvFilter` to `info,legit_core=debug,legit_app_lib=debug`
  whenever `RUST_LOG` is unset — i.e. release builds run with debug-level
  tracing for our crates. Decide the intended release default (likely plain
  `info`, or `warn`): verify what the output costs (every git invocation is
  traced) and where it even goes in a bundled app (`windows_subsystem =
  "windows"` has no console — is anything writing to a file?). Gate the
  default on `cfg!(debug_assertions)` so dev keeps the verbose filter and
  release gets the quiet one; keep `RUST_LOG` as the override for
  field debugging.
- **Bundled git: decided — don't bundle.** Trade study written 2026-07-07
  (`design/2026-07-07-bundled-git-trade-study.md`): bundling breaks the
  install-relative config LeGit gets for free (GCM in Git-for-Windows'
  system gitconfig, LFS filters, EOL defaults), adds ~37 MB/arch, and makes
  LeGit own git CVE patching (actively exploited, e.g. CVE-2025-48384)
  before an auto-update story exists. The recommended follow-up (polished
  no-git first-run onboarding in `GitSetupGate`) shipped 2026-07-07. The
  revisit trigger and the download-on-demand fallback design (Windows-only,
  system-first, pinned + hash-verified MinGit) are spelled out in the study.
