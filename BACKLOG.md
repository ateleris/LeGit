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

(none currently)

---

## Known bugs

(none currently)

## Git features (missing vs a normal client)

Each follows the same vertical slice: `GitBackend` method -> `cli_impl` via
`GitRunner` (+ parser if it returns data) -> Tauri command (registered in
`lib.rs`) -> wrapper in `lib/commands.ts` + type in `lib/types.ts` -> UI.

- **Bisect.** The one whole-feature gap left vs a full-featured client
  (worktrees shipped 2026-09-10). Deferred to post v1.0.0 (decided
  2026-07-20).
- **Platform integrations, open remainders** (SSH key tools, PAT connect,
  and broker HTTPS auth shipped 2026-07-13; scope = GitHub/GitLab/ADO,
  SSH-first, per 2026-07-13 decision; code lives in
  `crates/legit-providers` + `commands/accounts.rs` / `ssh_keys.rs`):
  - **OAuth device flows, GitLab + ADO remainder** (GitHub shipped
    2026-10-08: `design/2026-10-08-github-oauth-device-flow.md`). GitLab
    needs a registered app plus refresh-token handling in the credential
    broker (its OAuth tokens expire after 2h); ADO needs an Entra app
    registration and the Microsoft device code flow. The seams:
    `Platform::device_flow_client_id` / `device_flow_config`
    (`legit-providers`), and the platform-agnostic commands already
    gate on them. Also pending: transfer of the GitHub OAuth app from
    the personal account to the company org (client ID survives).
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
- **Patches: create + apply** (from the 2026-08-20 competitive review;
  SourceTree, Fork, and Git Extensions all have both). "Create patch" from a
  commit or a selected range (multi-select shipped 2026-08-22) via
  `format-patch`, and
  "Apply patch file" via `git apply` / `git am` (am = keeps authorship +
  message; offer both). The workflow for moving changes without a shared
  remote. Standard vertical slice; file dialogs via the existing Tauri
  dialog plumbing.

## Smaller follow-ups

- **Stash-all button in Working Changes?** (open question, 2026-09-16) The
  sections have "Stage all" / "Unstage all" / "Discard all"; a "Stash all"
  alongside them would complete the set. The action already exists (the
  Commits toolbar's Stash split button, incl. the include-untracked mode) -
  this is only a second surface for it. Decide placement (Unstaged header
  vs the panel toolbar) and whether it reuses the persisted stash-mode
  caret.

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
  - **Remote per-repo git overrides.** Per-HOST overrides landed
    (`hosts/wsl-<distro>.json`, Settings → Git (WSL)), but the per-repo
    override is still refused for remote sessions (`set_repo_git_path`).
    Repo Settings now hides the field for WSL repos instead of showing a
    Windows file picker (2026-09-01, `supportsRepoGitOverride`). To lift it:
    probe the candidate through the session's host and make the picker not
    browse the app machine.
  - **Distro-side SSH keys**: shipped 2026-10-09 (WSL key section, matrix
    rows, apply-time resolution of auth + ssh-signing paths with copy /
    replace offers and allowed-signers sync; the `HostRun` captured spawn
    op carries it).
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

- **Settings sync: open remainders** (the git-repo writable mode shipped
  2026-10-02 - `design/2026-10-02-settings-sync-git.md`; a designated git
  repo mirrors shareable settings + themes, imports at startup, commits
  and pushes on change):
  - **Read-only "inherit from a plain folder" team variant** (the
    original 2026-08-21 design): a network share / Dropbox folder as a
    read-only settings layer with LOCAL WINS (`Option<T>` +
    `#[serde(default)]` migration). Rejected then and still rejected:
    HTTP(S)/WebDAV endpoints and two-way sync via a plain folder.
    Build when a team asks; the sync-doc format is already shared.
  - **Phase 2 candidates**: named layouts (files under
    `<app-data>/layouts/`, so syncing mirrors the themes approach; LIVE
    dock state stays localStorage), an export/import bundle file.
  - **Encrypted SSH-key sync** (requested 2026-10-08; deferred: needs
    its own design note and threat model before building; profile sync
    itself shipped 2026-10-09 as the "Sync git profiles" opt-in, keys
    referenced by `~/.ssh/<file>` name - build this only if the
    per-machine create-and-upload flow proves insufficient). A second
    opt-in ON TOP of the sync opt-in and of profile sync: store
    `keys/<id>.age` in the sync repo, passphrase-based age encryption
    (`age` crate), decrypt on import into a LeGit-managed key dir
    (0600 on Unix; Windows OpenSSH checks ACLs, needs per-OS
    handling), never write plaintext into the repo or the synced
    JSON. Must present the trade-offs explicitly in the opt-in UI:
    encrypted private keys live forever in the remote's git history
    guarded only by the passphrase's strength, and the passphrase
    itself still moves between machines out of band. This reverses
    the "LeGit stores no secrets" principle, which is why it is a
    separate, loudly-labelled opt-in rather than part of profile
    sync.

- **Git Log panel:** filter/search the log, copy a command, jump a toast to
  its specific log entry (today it just opens the panel).
- **Worktrees, stages B2/B3** (2026-09-10; mode analysis in
  `design/2026-09-10-worktrees-parallel-graph.md`). Everything else
  shipped 2026-09-10 (pane with add/detach/lock/remove/prune, B1 graph
  decorations, dirty indicators, guided open on chips AND the refusal
  toast). B2 = active-worktree switcher scoping Working Changes/composer
  inside one tab (per-worktree executors + worktree-scoped query keys);
  B3 = full parallel interaction incl. one workdir row per dirty
  worktree. Gated on demand: tab switching may well be enough.
- **Commits panel search: touched-path query kind** (`git log -- <path>`) -
  the one search mode the shipped search bar (2026-07-30) lacks. NOTE: the
  Search panel was removed 2026-07-30 as redundant; with it went the UI
  for content search (pickaxe `-S` / `-G`) and path search. The backend
  (`search_commits` Content/ContentRegex kinds, `search_paths`) is kept
  and tested; re-adding is a small UI task if "when did this string
  change?" archaeology is missed.
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
- **One Explorer invocation for local and WSL reveal** (from the 2026-09-23
  review's E0; blocked on a Windows check). `reveal_in_file_manager` (now
  `os_open`, Windows arm) passes `/select,<path>` through `Command::arg`,
  which quotes the WHOLE argument when the path has a space;
  `reveal_remote_in_explorer` uses `raw_arg` with quotes around the UNC path
  only, the form Explorer documents. Check on Windows whether the local form
  reveals a file whose path contains a space; if not, switch both to the
  quoted-path `raw_arg` form and route them through one function taking the
  app-visible path (local path, or the `\\wsl.localhost\` UNC).
- **Show unstaged moves as renames: decide want/need.** Open product
  question. A moved file that is not staged shows in Working Changes as a
  deletion plus an untracked file: `git status` only pairs a rename when
  the new path is in the index (`git add -N` turns it into `.R`), and
  LeGit reports git's status as-is. Once both sides are staged it shows as
  a rename. Check first: how GitKraken renders an unstaged move (it is
  libgit2-based, and libgit2 can pair index-to-workdir renames with
  `GIT_STATUS_OPT_RENAMES_INDEX_TO_WORKDIR`, which the git CLI's status
  cannot). If wanted, approach: pair `.D` entries with untracked entries
  by content similarity in legit-core (same shape as case-drift
  detection: display-only, never touches the index), render the pair as
  one "moved" row, and map stage/unstage/discard on it to both paths.
  Other option: running `git add -N` on untracked files (cheap, but it
  silently changes the user's index).

## Only if it hurts in practice

- **Multiple main windows (one per Windows virtual desktop)** (deferred
  2026-09-29: nice-to-have, not important enough yet; workaround exists -
  Task View > right-click the LeGit window > "Show this window on all
  desktops"). Wanted shape when picked up: full peer windows in ONE
  process (a second VS Code-style window with its own repo tabs, active
  repo and dock layout), NOT a second OS process (shared app-data would
  race) and NOT a pinned single-repo window. The fh-* history windows are
  the precedent: same bundle, label check in `src/main.tsx` picks the
  shell, each webview is its own JS realm so zustand/query state is
  per-window for free; backend `RepoSession`s are shared and `open_repo`
  is already idempotent. Known one-window assumptions to untangle
  (surveyed 2026-09-29): `currently_open`/`active_open_repo` are single
  global values and `repos.ts refresh()` adopts every backend session;
  `close_repo` has no refcount (window A closing a repo breaks window B);
  dock layouts persist to shared localStorage keys (last writer wins);
  capabilities allow only `main`/`fh-*` labels; closing "main" closes all
  fh-* windows; credential/askpass prompts broadcast to every window and
  the losing dialog lingers; startup update check + auto-fetch run per
  AppLayout mount; the macOS app menu binds to the realm that built it.
  Open design question: restore all windows on relaunch (needs per-window
  persisted tab sets) vs primary-only.

- **Lane-colored branch chips: editor ContrastSection rows** (the one
  remainder; feature + AA enforcement shipped 2026-09-10). The armed
  contract check (3:1 AA-Large floor, `contract.test.ts`) covers the
  built-ins; the Theme Editor's ContrastSection could additionally show
  live lane-wash rows so USERS see their own theme's lane-chip ratios
  while picking `laneChipFilters`. Add if theme authors ask.

- **Named layouts: deferred apply for an unmounted dock** (decided
  2026-09-07: fine as-is, layouts are mostly for the repo side). Applying a
  layout never changes the global region's expanded/collapsed state; while
  the global dock is collapsed (or no repo is open, for the repo dock) that
  dock's part of the layout is SKIPPED, so expanding later shows the
  pre-apply arrangement even though the checkmark says the layout is
  active. Fix if it ever confuses: when the dock's API is null, write that
  part into its live-persistence key (`legit.global-dock-layout` /
  `legit.repo-dock-layout`) so the next mount restores it - expansion state
  itself stays untouched.

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
