# LeGit — project guide for Claude

LeGit is a desktop **git GUI**: a **Tauri 2.x** app with a **Rust** backend and a
**React + TypeScript** frontend. The canonical spec lives in `design/DESIGN-v0.*.md`
(plus dated design notes in `design/`); code comments reference its `§` sections.

## Test repo

A scratch git repository for manual testing lives at `../LeGit-Test`
(`/mnt/c/NOT_WORK/LeGit-Test`). It is used to reproduce git states (merges,
rebases, conflicts) while developing. Inspect its state before mutating it -
it may hold a repro the user set up on purpose; never reset/abort/clean it
without asking.

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
`run_with_stdin` / `run_with_env` / `stream`. Parsers are **pure** `text -> type`
functions in `cli_impl/parsers/`, and each command's format string is a constant
next to its parser so the contract lives in one place.

**Env vars beat `-c` config - relax hardening via `run_with_env`.** Git gives
environment variables (`GIT_EDITOR`, ...) precedence over ALL config, so a
`-c core.editor=...` can never undo the runner's `GIT_EDITOR=false` (this
silently broke `merge --continue` / `rebase --continue` until the integration
harness caught it). When one command must relax a hardening default, pass a
per-invocation override through `run_with_env` (applied after the base env, so
it wins) - the continue/skip commands run with `GIT_EDITOR=true` to accept the
prepared message unchanged.

**Backend logic is testable without git (executor seam).** `GitCliBackend` is
generic over the `GitExecutor` trait (`executor.rs`; default `GitRunner`, so
production code never names it). Composed flows are tested at two levels, and a
new composed flow or output-classification assumption needs both:
`cli_impl/flow_tests.rs` scripts a `FakeExecutor` that asserts the exact git
command sequence (incl. what must NOT run, e.g. no `stash pop` after a
clean-tree auto-stash); `crates/legit-core/tests/git_flows.rs` validates the
encoded assumptions against the real binary in tempdir repos (pins local
config: identity, no signing, no autocrlf). Both run in
`cargo test -p legit-core`.

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

**Stash addressing & auto-stash correctness.** `git stash push` exits **0**
with "No local changes to save" (on *stdout*) for a clean tree — never infer
"something was stashed" from the exit code or stderr; compare the `refs/stash`
tip before/after (`stash_tip` / `stash_created` in `cli_impl`). Positional
`stash@{N}` selectors are **display-only**: they shift on every
create/drop/pop, including ones made outside the app, so every stash mutation
addresses the entry by its **commit SHA**, resolved to the current selector at
action time (`resolve_stash_selector`). Never run a bare `git stash pop` — pop
the specific entry. A conflicted pop means the changes **are** applied (with
markers; git keeps the stash): the guidance is "resolve, then drop", never
"pop again" — which is why pop conflicts and pop failures are distinct
outcomes. Stash nodes are injected into the log by **committer** date
(`inject_stashes`) — `git log`'s default order is commit-date, and rebased
commits keep old author dates.

**Error surfacing.** The user must see git's message, never a JSON envelope —
`formatAppError` unwraps nested `GitError`s (show `stderr` / the string
payload). Classify common failures into dedicated `GitError` variants
(`WouldOverwriteLocalChanges`, `AuthFailed`, `PushRejected`, …) so panels can
react with actionable text (`gitErrorKind` + `src/lib/switchFeedback.ts`).
Partial success is an **outcome, not an error** (`SwitchOutcome`,
`StashApplyOutcome`) so it crosses IPC as data. A best-effort recovery step
that fails must never be silent — append the fact to the primary error
(`append_error_note`) so the user learns both what failed and where their
data went.

**Diff viewer (CodeMirror 6).** Inline + split share one rendering primitive
(`src/panels/Diff/`); split is two scroll-synced panes built from the same hunk
model (not `@codemirror/merge`). Hunk- and line-level stage/unstage/discard, with
**action parity** between inline and split enforced via shared helpers. See the
project memory for details.

## Conventions

- **Never commit or push without the user's explicit command.**
- **Every colour anywhere in the UI must resolve from a theme token — no
  exceptions.** The litmus test: a user theme must be able to turn the entire
  app fully white or fully black. Concretely:
  - No literal colours in CSS files, inline styles, SVG fills/strokes,
    gradients, borders, or box-shadows — always `var(--token)`. This includes
    "neutral" values like `rgba(0,0,0,0.4)` shadows and `#fff` text.
  - Inline fallbacks (`var(--token, #123456)`) are permitted only as
    pre-theme-load safety nets and must mirror the built-in Dark theme value —
    they must never be the primary source of a colour.
  - Icons inherit `currentColor` (never per-call-site colours); canvas/SVG
    code reads tokens via CSS custom properties.
  - Third-party chrome must be restyled through tokens too — dockview's
    `--dv-*` variables are mapped to LeGit tokens in `global.css` (the
    `abyss` class remains only as a structural fallback); extend that block
    when new dockview surfaces appear.
  - New tokens go in 4 places (`tokens.ts`, `defaults.ts`,
    `styles/theme.css`, both bundled themes) — enforced by
    `src/theme/contract.test.ts`; a token missing from any place fails the
    suite. Literal colours are enforced by
    `src/theme/noLiteralColors.test.ts`, which fails on any colour literal
    outside the theme system or a `var()` fallback.
- **Every UI dimension scales with the global UI font size — no fixed-px
  chrome.** `--ui-font-size` is the single base; changing it must resize the
  whole app coherently. Concretely:
  - Text uses the `--fz-*` scale (or the concrete `ui_font_size` value from
    the settings store when a px *number* is required, e.g. for measurement).
  - Heights, paddings, and icon boxes derive from the font size: `em` units,
    `calc(var(--ui-font-size) * X)` in CSS, or `Math.round(uiFontSize * X)`
    in JS. Fixed px is acceptable only for hairlines (1px borders) and true
    geometric constants.
  - Panels must NOT grow their own text-size settings — the Commits panel's
    was removed for exactly this reason; text follows the global size.
  - When a third-party component takes pixel sizes as JS numbers (dockview's
    paneview `headerSize`, tab heights), compute them from `ui_font_size`
    and re-initialise on change — see `RefsPanel` (keyed `PaneviewReact`,
    patches the persisted layout's `headerSize` on restore) and the
    `--dv-tabs-and-actions-container-height` mapping in `global.css`.
- Follow existing panel/store/parser patterns; keep files focused.
- The diff viewer's inline and split views must keep **action parity** (wire new
  per-hunk/per-line capabilities through the shared helpers, apply to both).
- **Destructive actions confirm inline in every menu that offers them** (drop
  stash, delete branch). Share the menu section component
  (e.g. `StashMenuSection`) between the row menu and the chip menu so the
  confirm step can't drift out of parity. Every such confirmation is gated by
  the global "Destructive action confirmation" setting — consult
  `useConfirmDestructive()` (store/settings) and run the action immediately
  when it is off; never hardcode a confirm step.
- **Renames edit in place**: an input appears where the text is (subject cell,
  ref chip), Enter approves, Esc discards (`InlineRenameInput`). Don't summon
  another panel for a rename.
- **Busy/loading feedback is delayed, never instant.** Indicators appear only
  after ~150ms so fast operations never flicker the UI: fetch signals go
  through the shared `PanelLoadingBar` (debounced internally); visual busy
  states around fast async actions use a 150ms timer cleared in `finally`,
  paired with a `useRef` re-entry guard so double-clicks are still blocked
  immediately (see `run()` in WorkingChangesPanel). Genuinely slow network
  ops (fetch/pull/push/clone) may show busy immediately.
- **Extract decision logic into pure functions and unit-test them** — parsers,
  error classification, and "did X actually happen" checks
  (`stash_created`, `classify_switch_error`, `find_stash_selector`,
  `pickHeadCommitId`, …). Assumptions about git's exit codes / output streams
  must be encoded in a test, not just in a comment: the auto-stash data-loss
  bug existed because "`stash push` fails on a clean tree" was assumed, wrong,
  and untested. Same lesson twice: "`-c core.editor=true` neutralizes the
  editor" was assumed, wrong (env outranks config), and broke
  merge/rebase continue until the real-git harness (`tests/git_flows.rs`)
  encoded the flow. Prefer validating such assumptions there, against the
  real binary.

## Backlog

Deferred features and extension ideas live in [BACKLOG.md](BACKLOG.md). When a
feature is postponed during a session ("let it be for now", "later", "future"),
**add it to BACKLOG.md** — capture what it is, why it's deferred, and a rough
approach so it can be picked up cleanly later.
