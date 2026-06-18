# LeGit — project guide for Claude

LeGit is a desktop **git GUI**: a **Tauri 2.x** app with a **Rust** backend and a
**React + TypeScript** frontend. The canonical spec lives in `design/DESIGN-v0.*.md`
(plus dated design notes in `design/`); code comments reference its `§` sections.

## Layout

- `crates/legit-core/` — pure git logic, UI-agnostic.
  - `runner.rs` — `GitRunner`, the single chokepoint that invokes `git`.
  - `backend.rs` — `GitBackend` trait; `cli_impl/` — `GitCliBackend` + `parsers/`.
  - `types.rs` — domain types crossing the IPC boundary (serde + specta).
- `src-tauri/` — the Tauri app: `commands/` (IPC commands), `state.rs`
  (`AppState`, per-repo `RepoSession`), `watcher.rs` (filesystem watcher).
- `src/` — React frontend: `panels/` (UI), `store/` (zustand), `lib/`
  (command wrappers + types), `theme/`, `icons/`, `styles/`.

## Architecture & key decisions

**Git is run via the CLI, not a library.** Every git invocation goes through
`GitRunner` (hardened env: `GIT_EDITOR=false`, `GIT_TERMINAL_PROMPT=0`,
`LANG/LC_ALL=C.UTF-8`; cancellable via `OperationId`). `run` / `run_with_op` /
`run_with_stdin` / `stream`. Parsers are **pure** `text -> type` functions in
`cli_impl/parsers/`, and each command's format string is a constant next to its
parser so the contract lives in one place.

**Commands & bindings.** Backend commands are `#[tauri::command] #[specta::specta]`,
registered in `src-tauri/src/lib.rs` (`collect_commands!`). specta regenerates
`src/lib/bindings.ts` **when the app runs** (debug), not at `cargo build`. The
frontend actually calls **hand-written wrappers** in `src/lib/commands.ts`
(`invoke(...)`), with types **hand-mirrored** in `src/lib/types.ts` (bindings.ts
is the generated reference). Add new commands in both places.

**Panels are dockview-based.** `src/panels/registry.tsx` declares every panel
(`PanelDescriptor`: id, scope global/repo, `summons`, `defaultPlacement`).
Panels open/focus each other through the **summon** mechanism
(`src/store/summon.ts`): `summon(id, payload)` opens-or-focuses and delivers a
payload (queued until mount); `notifyIfOpen(id, payload)` updates a panel only if
it's already mounted (never opens it). `swapSummon` shares one slot between two
panels.

**Theme system (palette → token → CSS var).** A theme has a **palette** (named
colours; values may include alpha hex like `#4a9eff33`) and **tokens** (each
token maps to a palette entry). `applyTheme` writes CSS custom properties
(`--token-name: var(--palette-entry)`); `resolveTheme` merges over
`DEFAULT_THEME`. Components **never use literal colours — only `var(--token)`**.
A new token must be added in **4 places**: `src/theme/tokens.ts` (`TOKEN_CONTRACT`),
`src/theme/defaults.ts`, `src/styles/theme.css` (`:root` fallback), and **both**
`themes/Light.legit-theme.json` + `Dark.legit-theme.json`. `TOKEN_CONTRACT` /
`PALETTE_CONTRACT` are a user-facing contract: **adding is safe; renaming/removing
breaks user themes.** The **Theme Editor** (`ThemeEditorPanel`) edits palette +
token bindings live; rules: a palette entry can be **deleted only if no token
references it**, and **renaming a palette entry auto-updates** all token bindings.

**Everything scales with the global UI font size.** `--ui-font-size` (default
12px, user-adjustable, persisted) is the single base; the `--fz-xs/sm/md/lg/xl`
scale derives from it (`src/styles/global.css`). Row heights, icon sizes, tab
strip height, etc. all scale off it (see `useFileRowMetrics`). Icons
(`src/icons/index.tsx`, lucide-based) default to `size="1em"` and inherit
`currentColor` — no per-call-site colour/size.

**Data freshness (React Query + watcher).** Query keys are `[repoId, domain, …]`
(`"status" | "log" | "branches" | "diff" | …`). `invalidateRepoDomains` (with
leading-edge coalescing) is the manual refresh; the filesystem **watcher**
(`useRepoChangeListener`) is the primary live-update path (the backend event
carries the domains to invalidate). Repo data uses a short `staleTime`.

**Repos & sessions.** `src/store/repos.ts` owns `openRepos` + `activeRepoId`.
`RepoSession`s and watchers are **persistent per repo** (a `HashMap`), not rebuilt
on tab switch. Tab order is user-controlled: tabs are drag-reorderable, the order
persists (`currently_open` / `set_open_repos_order`), and `refresh()` preserves
the manual order rather than re-sorting.

**Signature verification is on-demand.** The bulk commit-list `git log` format
must **never** include `%G?` — it makes git verify every commit's signature during
the walk (spawning gpg/ssh per signed commit; ~18s on large/heavily-signed
repos). Signatures are verified lazily in `commit_details` (`git verify-commit`).

**Diff viewer (CodeMirror 6).** Inline + split share one rendering primitive
(`src/panels/Diff/`); split is two scroll-synced panes built from the same hunk
model (not `@codemirror/merge`). Hunk- and line-level stage/unstage/discard, with
**action parity** between inline and split enforced via shared helpers. See the
project memory for details.

## Conventions

- **Never commit or push without the user's explicit command.**
- New UI colours → theme tokens (4 places), never literals.
- Follow existing panel/store/parser patterns; keep files focused.
- The diff viewer's inline and split views must keep **action parity** (wire new
  per-hunk/per-line capabilities through the shared helpers, apply to both).

## Backlog

Deferred features and extension ideas live in [BACKLOG.md](BACKLOG.md). When a
feature is postponed during a session ("let it be for now", "later", "future"),
**add it to BACKLOG.md** — capture what it is, why it's deferred, and a rough
approach so it can be picked up cleanly later.
