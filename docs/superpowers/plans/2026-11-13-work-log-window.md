# Work Log Window Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. (subagent-driven-development is excluded by the user's instructions.) Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A always-popout "Work Log" window that shows, per calendar day, the user's commits, stashes and uncommitted changes across all open repos, with read-only diffs.

**Architecture:** One new composed backend flow in legit-core (`work_log`: rev-parse common dir + log across local branches since a cutoff), a batched mtime-capable `stat_many` through the Host seam, one new read-only `DiffSource::WorkingTree`, two thin IPC commands, and a new `wl-main` window cloned from the File History window shell with three Splitview panes (day list, day detail, diff). All day bucketing, identity filtering and worktree dedup is pure TypeScript with unit tests.

**Tech Stack:** Rust (tokio, async_trait, serde, specta), Tauri 2.x, React + TypeScript, dockview-react SplitviewReact, React Query, vitest.

**Spec:** docs/superpowers/specs/2026-11-13-work-log-window-design.md

## Global Constraints

- Never commit or push; leave all changes for Simon's review. No commit steps exist in this plan.
- No em-dashes and no center dots in any produced file.
- No `%G?` in any log format string.
- Every colour via `var(--token)`; a new token goes in the 4 places plus a `CONTRAST_PAIRS` entry if it carries text (enforced by `src/theme/contract.test.ts`, `noLiteralColors.test.ts`).
- Every dimension derives from `--ui-font-size` / `--fz-*`; fixed px only for hairlines.
- Toolbar controls share the compact height (`.legit-panel__toolbar` normalization; `toolbarControls.test.ts`).
- IPC output types must not carry field-level `#[serde(default)]` (wire-only types like `FsStat` are exempt).
- `src/lib/bindings.ts` is committed; regenerate with `LEGIT_UPDATE_BINDINGS=1 cargo test -p legit-app bindings` after any command/type change.
- Busy indicators delayed ~150ms (`PanelLoadingBar`); errors as toasts or content states, never panel-embedded banners.
- CHANGELOG.md gets one `## [Unreleased]` Added bullet (Task 9).
- Verification: `cargo test -p legit-core` and `cargo test -p legit-app` from WSL; vitest and tsc also run from WSL (vitest through PowerShell interop per project convention, see memory "WSL verification split").

## Review Focus

Failure modes the spec implies that no existing test exercises; each line's test is added to the owning task:

1. An open repo with no commits at all (fresh init, unborn HEAD) must yield an empty work log, not an error (real-git test, Task 2).
2. A commit subject containing tab characters must survive parsing intact (subject is the last `splitn` field; unit test, Task 1).
3. A commit authored 23:30 at UTC+2 must book to the author-local day, not the UTC day (unit test, Task 7).
4. An empty identity set (no profiles, unset user.email) must disable filtering and show all commits rather than none (unit test, Task 7).
5. A stale WSL agent sending `FsStat` without the new mtime field must not break deserialization, and such files land in the "Older" bucket as unknown-date rather than vanishing (serde unit test, Task 3; bucket unit test, Task 7).

---

### Task 1: WorkLogCommit type and parser

**Files:**
- Modify: `crates/legit-core/src/types.rs`
- Create: `crates/legit-core/src/cli_impl/parsers/worklog.rs`
- Modify: `crates/legit-core/src/cli_impl/parsers/mod.rs` (add `pub mod worklog;`)

**Interfaces:**
- Produces:
  - `types.rs`: `pub struct WorkLogCommit { pub id: CommitId, pub author: Signature, pub subject: String, pub source_ref: Option<String> }` and `pub struct WorkLogRepoData { pub common_dir: String, pub commits: Vec<WorkLogCommit> }`, both deriving `Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type` like `Commit`.
  - `parsers/worklog.rs`: `pub const WORK_LOG_FORMAT: &str = "%H%x09%an%x09%ae%x09%aI%x09%S%x09%s";` and `pub fn parse_work_log(output: &str) -> Result<Vec<WorkLogCommit>, ParseError>`.

- [ ] **Step 1: Write failing unit tests in `parsers/worklog.rs`** (`#[cfg(test)] mod tests`):
  - `parses_record`: one line `"<sha>\tAlice\ta@b.com\t2026-11-12T09:12:00+01:00\trefs/heads/dev\tfix stash"` parses to a `WorkLogCommit` with `author.timestamp` and `author.tz_offset_minutes == 60`, `source_ref == Some("refs/heads/dev".into())`.
  - `subject_may_contain_tabs`: subject field `"a\tb\tc"` comes back whole (use `splitn(6, '\t')` with subject last).
  - `empty_source_ref_is_none`.
  - `skips_blank_lines`.
- [ ] **Step 2: Run to verify failure**: `cargo test -p legit-core worklog` fails to compile (type/parser missing).
- [ ] **Step 3: Implement the types and `parse_work_log`.** One record per line; parse `%aI` with `chrono::DateTime::parse_from_rfc3339` into `Signature { name, email, timestamp, tz_offset_minutes }`, mirroring `parsers/log.rs`.
- [ ] **Step 4: Run to verify pass**: `cargo test -p legit-core worklog`.

### Task 2: Backend method `work_log`

**Files:**
- Modify: `crates/legit-core/src/backend.rs` (trait method + type import)
- Create: `crates/legit-core/src/cli_impl/worklog.rs` (inherent method)
- Modify: `crates/legit-core/src/cli_impl/mod.rs` (declare module, one-line delegation)
- Create: `crates/legit-core/src/cli_impl/flow_tests/worklog.rs` (+ register in `flow_tests/mod.rs`)
- Modify: `crates/legit-core/tests/suite/git_flows_suite.rs`

**Interfaces:**
- Consumes: Task 1 (`WorkLogRepoData`, `WORK_LOG_FORMAT`, `parse_work_log`).
- Produces: `async fn work_log(&self, since_unix: i64) -> Result<WorkLogRepoData, GitError>` on `GitBackend`.

- [ ] **Step 1: Write the flow test** in `flow_tests/worklog.rs` scripting `FakeExecutor` with exactly two invocations, in order:
  1. `["rev-parse", "--path-format=absolute", "--git-common-dir"]` returning `ok("/repo/.git\n")`
  2. `["log", &format!("--format={}", parsers::worklog::WORK_LOG_FORMAT), "--since=@1762902000", "--date-order", "--source", "--ignore-missing", "HEAD", "--branches"]` returning one fabricated record
  Assert the parsed result and `exec.assert_done()`. The format constant containing no `%G?` is pinned by the exact-args assertion.
- [ ] **Step 2: Run to verify failure**: `cargo test -p legit-core flow_tests::worklog` (method missing).
- [ ] **Step 3: Implement.** Inherent method in `cli_impl/worklog.rs` using `run_checked` for both invocations (options before revisions); trait method in `backend.rs`; one-line delegation in `mod.rs`.
- [ ] **Step 4: Run to verify pass.**
- [ ] **Step 5: Write real-git tests** in `tests/suite/git_flows_suite.rs` (they also run through the remote agent via `remote_git_flows.rs`):
  - `work_log_sees_unmerged_branch_and_source_ref`: commit on an unmerged branch `feature`; `work_log(0)` includes it with `source_ref` ending in `"feature"`, and `common_dir` is an absolute path.
  - `work_log_since_excludes_old_commits`: one commit with `--date "2020-01-01T12:00:00+00:00"`, one fresh; `work_log(<2021 epoch>)` returns only the fresh one.
  - `work_log_rebased_commit_keeps_author_day`: commit on a branch with `--date` of an old day, rebase it onto an advanced main; the entry's `author.timestamp` still matches the old day.
  - `work_log_empty_repo_is_empty`: fresh `TestRepo::init()` with zero commits; `work_log(0)` returns `Ok` with no commits (Review Focus 1).
- [ ] **Step 6: Run the full crate suite**: `cargo test -p legit-core`. All green.

### Task 3: FsStat mtime and batched stat

**Files:**
- Modify: `crates/legit-core/src/fs.rs` (FsStat field, `stat_of`, `RepoFs::stat_many` default impl, tests)
- Modify: `crates/legit-proto/src/lib.rs` (`Method::FsStatMany`, `PROTO_VERSION` 2 -> 3)
- Modify: `crates/legit-agent/src/main.rs` (dispatch arm)
- Modify: `crates/legit-host/src/remote.rs` (`stat_many` override)

**Interfaces:**
- Produces:
  - `FsStat` gains `#[serde(default)] pub mtime_unix: Option<i64>` (wire-only type; the IPC serde(default) rule does not apply, and the default keeps a stale agent's answers parsing, Review Focus 5).
  - `RepoFs` gains `async fn stat_many(&self, paths: &[HostPath]) -> Result<Vec<Option<FsStat>>, FsError>` with a default body looping `self.stat` (so existing impls, including test fakes, keep compiling); `RemoteFs` overrides it with one `Method::FsStatMany { paths: Vec<HostPath> }` round trip returning `Vec<Option<FsStat>>`.

- [ ] **Step 1: Write failing tests in `fs.rs`**:
  - `stat_reports_mtime`: write a temp file, `LocalFs.stat` returns `mtime_unix: Some(_)` within 5 minutes of now.
  - `stat_many_preserves_order_and_absence`: `[existing, missing, existing]` yields `[Some, None, Some]`.
  - `fsstat_deserializes_without_mtime`: `serde_json::from_str::<FsStat>(r#"{"is_dir":false,"len":3}"#)` succeeds with `mtime_unix: None` (Review Focus 5).
- [ ] **Step 2: Run to verify failure**: `cargo test -p legit-core fs::`.
- [ ] **Step 3: Implement.** `stat_of` fills mtime from `meta.modified()` via `duration_since(UNIX_EPOCH)`; add the trait default method; add the proto variant mirroring `FsProbeMany`; agent arm `Method::FsStatMany { paths } => Ok(to_value(&fs.stat_many(&paths).await.map_err(we)?))`; remote override; bump `PROTO_VERSION` to 3 (version-locked deploy forces agent redeploy, per the proto module policy).
- [ ] **Step 4: Run to verify pass**, then the full workspace gate: `cargo test -p legit-core -p legit-proto -p legit-agent -p legit-host` (the remote_git_flows gate must stay green).

### Task 4: `DiffSource::WorkingTree`

**Files:**
- Modify: `crates/legit-core/src/types.rs` (variant)
- Modify: `crates/legit-core/src/cli_impl/changes.rs` (`run_diff_text` arm + untracked fallback)
- Modify: every `DiffSource` match site flagged by the compiler (`backend.rs`, remaining `changes.rs` sites, `source_for_op` untouched in behavior)
- Modify: `src/lib/diffSides.ts` and any TS exhaustive switch the compiler flags (`src/panels/Diff/diffActions.ts`, `DiffPanel.tsx`, `WorkingChanges/useDiffSync.ts`, `FileRowMenu.tsx`)
- Test: `crates/legit-core/src/cli_impl/flow_tests/changes.rs`, `tests/suite/git_flows_suite.rs`

**Interfaces:**
- Produces: `DiffSource::WorkingTree` (wire tag `"working_tree"`): HEAD vs working tree, staged + unstaged in one view. Read-only consumer only; staging/hunk ops never receive it (TS arms are benign no-ops, Rust arms return the existing invalid-op classification where one exists or are unreachable).

- [ ] **Step 1: Write the flow test** in `flow_tests/changes.rs`: `working_tree_diff_runs_against_head` scripts `["-c","diff.submodule=short","diff","--no-color","--no-ext-diff","-U3","--end-of-options","HEAD","--",<path>]` (exact args copied from the `WorkingUnstaged` test as baseline) and asserts the parsed entry.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.** New match arm pushes `"--end-of-options", "HEAD"`; extend the untracked fallback guard to `matches!(source, DiffSource::WorkingUnstaged | DiffSource::WorkingTree)`; fix every Rust and TS match site the compilers flag (`diffSides("working_tree")` mirrors `working_unstaged`). Unborn-HEAD repos surface the git error as-is (accepted in the spec's error-surfacing model; the window renders it as the diff pane's content state).
- [ ] **Step 4: Write the real-git test** in `git_flows_suite.rs`: `working_tree_diff_combines_staged_and_unstaged` (stage one edit, make a second unstaged edit, the diff contains both), plus `working_tree_diff_shows_untracked_file` (untracked file renders via the no-index fallback).
- [ ] **Step 5: Run** `cargo test -p legit-core` and `npx tsc --noEmit`. Green.

### Task 5: IPC commands and settings field

**Files:**
- Create: `src-tauri/src/commands/worklog.rs`
- Modify: `src-tauri/src/commands/mod.rs`, `src-tauri/src/lib.rs` (`collect_commands!`)
- Modify: `src-tauri/src/state.rs` (`work_log_window_size`), `src-tauri/src/sync/model.rs`
- Modify: `src/lib/bindings.ts` (regenerated)

**Interfaces:**
- Consumes: Tasks 1-3.
- Produces:
  - `#[tauri::command] #[specta::specta] pub async fn repo_work_log(state: tauri::State<'_, AppState>, repo_id: String, since_unix: i64) -> Result<WorkLogRepoData, AppError>`: resolve session, call `backend.work_log(since_unix)`.
  - `pub struct WorkLogUncommittedFile { pub path: String, pub state: FileState, pub staged: bool, pub mtime_unix: Option<i64> }` (Serialize + specta Type; no `serde(default)`, IPC output rule).
  - `#[tauri::command] #[specta::specta] pub async fn repo_work_log_uncommitted(state, repo_id: String) -> Result<Vec<WorkLogUncommittedFile>, AppError>`: one backend call (`backend.status()`), then host-side `fs.stat_many` over the status paths joined onto `session.root` (git-produced relative paths, no user input, so no per-file canonicalize; deleted files simply stat to `None`). This is the allowed command shape: one backend method plus host-side fs work.
  - `GlobalSettings.work_log_window_size: Option<WindowSize>` with `#[serde(default)]`, added to `GLOBAL_SETTINGS_COMMAND_OWNED` (15 -> 16) and `GLOBAL_SETTINGS_NEVER_SYNCED` in `sync/model.rs` (16 -> 17), updating both pinned tests (state.rs around line 1638; sync/model.rs around line 235).
  - Bindings: `api.repoWorkLog(repoId, sinceUnix)`, `api.repoWorkLogUncommitted(repoId)`. Stashes reuse the existing `api.repoStashes`.

- [ ] **Step 1: Add the settings field and update the two pinned list tests; run** `cargo test -p legit-app state` to see them pass.
- [ ] **Step 2: Implement both commands and register them in `collect_commands!`.**
- [ ] **Step 3: Regenerate bindings**: `LEGIT_UPDATE_BINDINGS=1 cargo test -p legit-app bindings`, then `cargo test -p legit-app` (stale-bindings gate green).
- [ ] **Step 4: Verify** `npx tsc --noEmit` (new generated types compile).

### Task 6: Window plumbing

**Files:**
- Modify: `src-tauri/src/commands/panel_window.rs`
- Modify: `src-tauri/capabilities/default.json` (`"windows": ["main", "fh-*", "wl-main"]`)
- Modify: `src-tauri/src/lib.rs` (`on_window_event`)
- Modify: `src/main.tsx`
- Create: `src/windows/WorkLogWindowShell.tsx` (stub)

**Interfaces:**
- Consumes: Task 5 (`work_log_window_size`).
- Produces:
  - `pub const WORK_LOG_LABEL: &str = "wl-main";`, `pub const WORK_LOG_DEFAULT_SIZE: (f64, f64) = (1100.0, 700.0);`
  - `#[tauri::command] #[specta::specta] pub async fn open_work_log_window(app: tauri::AppHandle, state: tauri::State<'_, AppState>) -> Result<(), AppError>`: focus-if-exists, else build like `open_file_history_window` (WebviewUrl::App("index.html"), title "Work Log", `.inner_size` from `work_log_window_size`, `.min_inner_size(600.0, 400.0)`, `.visible(false)`, debug icon, 4s reveal failsafe). No context map: the window discovers repos itself via `list_repos`.
  - `on_window_event`: the main-close cascade also closes labels starting with `"wl-"`; `wl-main` CloseRequested persists `work_log_window_size`; no `close_repo` cascade (the window is not repo-bound).
  - `src/main.tsx`: `isWorkLogWindow()` (label === "wl-main") renders `<WorkLogWindowShell />` ahead of the history check.

- [ ] **Step 1: Implement all of the above with the shell as a minimal placeholder** (renders "Work Log" text inside `ErrorBoundary`).
- [ ] **Step 2: Register the command, regenerate bindings** (`LEGIT_UPDATE_BINDINGS=1 cargo test -p legit-app bindings`).
- [ ] **Step 3: Verify**: `cargo test -p legit-app` and `npx tsc --noEmit` green. (Interactive window opening is Simon's manual pass; the Windows async-WebviewWindow watch item from the fh window applies here too.)

### Task 7: Pure work-log model (TypeScript)

**Files:**
- Create: `src/windows/workLog.ts`
- Test: `src/windows/workLog.test.ts`

**Interfaces:**
- Consumes: generated types `WorkLogCommit`, `WorkLogRepoData`, `WorkLogUncommittedFile`, `StashEntry` from `src/lib/bindings.ts`.
- Produces (consumed by Task 8):
  - `dayKeyFor(unixSecs: number, tzOffsetMinutes: number): string` ("YYYY-MM-DD" in the author's recorded offset)
  - `groupRepoTabs(tabs: { repoId: string; name: string; commonDir: string }[]): RepoGroup[]` (merge tabs sharing `commonDir`; group name = primary tab's name; `RepoGroup = { key: string; name: string; repoIds: string[]; primaryRepoId: string }`)
  - `buildWorkLog(input: { groups: RepoGroup[]; commitsByRepo: Record<string, WorkLogCommit[]>; stashesByRepo: Record<string, StashEntry[]>; uncommittedByRepo: Record<string, WorkLogUncommittedFile[]>; allowedEmails: string[]; identityFilter: string | null; rangeDays: number; nowUnix: number; localTzOffsetMinutes: number }): WorkLogView`
    where `WorkLogView = { days: WorkLogDay[]; older: OlderBucket; emails: string[] }`,
    `WorkLogDay = { key: string; label: string; counts: { commits: number; repos: number }; repoBlocks: RepoBlock[] }` (one entry per day in range, newest first, empty days included),
    `RepoBlock = { group: RepoGroup; span: { first: number; last: number } | null; commits: WorkLogCommit[] (newest first, deduped by sha within the group); stashes: StashEntry[]; uncommitted: UncommittedRow[] }`,
    `UncommittedRow = { path: string; state: FileState; staged: boolean; mtimeUnix: number | null }` (staged + unstaged pair merged to one row),
    `OlderBucket = { rows: (UncommittedRow & { groupKey: string })[] }` (mtime before range, mtime unknown, or deleted).
  - `shortRef(sourceRef: string | null): string | null` (`refs/heads/x` -> `x`)
  - Decided semantics baked into `buildWorkLog`: empty `allowedEmails` disables filtering entirely; `identityFilter` applies to commits only (stashes and uncommitted always shown); commit day = author-offset day; stash day = `StashEntry.timestamp` with its author offset; uncommitted day = mtime in the app's local offset; future mtimes clamp to the newest day; commit identity matching is case-insensitive email comparison.

- [ ] **Step 1: Write failing vitest cases** in `workLog.test.ts`, one per semantic:
  - `dayKeyFor_uses_author_offset`: 2026-11-12T23:30+02:00 (unix 1762986600) with tz +120 gives "2026-11-12"; the same instant with tz 0 gives "2026-11-13" (Review Focus 3).
  - `empty_allowed_emails_shows_everything` (Review Focus 4).
  - `identity_filter_hides_other_emails_but_keeps_uncommitted_and_stashes`.
  - `worktree_tabs_merge_and_commits_dedupe` (two tabs, same commonDir, same sha appears once; both tabs' uncommitted rows kept, labeled by their own tab).
  - `staged_and_unstaged_pair_merges_to_one_row`.
  - `old_unknown_and_deleted_mtimes_land_in_older` (mtime before range start; mtime null; state Deleted) (Review Focus 5).
  - `future_mtime_clamps_to_newest_day`.
  - `days_include_empty_and_stash_only_days_count`.
  - `commits_sorted_newest_first_and_span_is_min_max`.
- [ ] **Step 2: Run to verify failure** (vitest via PowerShell interop).
- [ ] **Step 3: Implement `workLog.ts`.** Pure functions, no imports from panels (layering test applies to `src/windows`? it applies to store/keys/lib/layout; keep `workLog.ts` free of panel imports anyway).
- [ ] **Step 4: Run to verify pass.**

### Task 8: Window shell UI

**Files:**
- Modify: `src/windows/WorkLogWindowShell.tsx` (replace stub)
- Create: `src/windows/WorkLogPanes.tsx` (DayListPane, DayDetailPane, DiffPane and their row components) if the shell grows past one focused file
- Test: `src/windows/workLogShell.test.tsx` (body-level render test, modeled on `historyWindowBody.test.tsx`)

**Interfaces:**
- Consumes: Task 7's `buildWorkLog` and friends; Task 5/6 commands via `api`; shared pieces exactly as `HistoryWindowShell` uses them: `bootUiPrefs`/`refreshUiPrefs`, `onGlobalSettingsChanged`, `revealAndSignal`, `useRepoChangeListener`, `ErrorBoundary`, `Toasts`, `DevRibbon`, `PanelLoadingBar`, `SplitviewReact` + `WindowStateContext` pattern, `DiffBody` (read-only, `editable={false}`, `actions={[]}`, modeled on `CommitFileDiff`).
- Produces: the complete three-pane window.

Decided wiring (builder fills in idiomatic React):

- Shell boot mirrors `HistoryWindowShell`: `bootUiPrefs()` then reveal, `onGlobalSettingsChanged -> refreshUiPrefs`, `useRepoChangeListener()` mounted (free live updates: the queries below reuse watched domains).
- Queries: repos `["global", "work-log-repos"]` -> `api.listRepos()` refetched on window focus; per repo in each group: `[repoId, "log", "work-log", sinceUnix]` -> `api.repoWorkLog`, `[repoId, "status", "work-log"]` -> `api.repoWorkLogUncommitted`, stashes via the existing stashes query key/command; identities: `["global", "profiles"]` -> `api.listGitProfiles` plus per-repo `api.repoResolvedIdentity`. `staleTime: STALE.live` for git data. A repo whose query fails renders an inline error row inside its block and never blanks the others.
- `sinceUnix` = start of the oldest requested day minus one day (timezone-skew guard, per spec); precise cutting happens in `buildWorkLog`.
- Splitview: three panes `days | detail | diff`, layout persisted under `localStorage["legit.workLogWindow.split"]`; sizes derived from `ui_font_size` like the history shell.
- Toolbar (compact `.legit-panel__toolbar` metrics): range select (7/14/30, persisted `localStorage["legit.workLogWindow.rangeDays"]`, default 14), identity select ("All identities" + `view.emails`), refresh button (invalidates the work-log queries).
- Day list rows: weekday + date, "N commits, M repos" subline; empty days dimmed; the "Older" row pinned at the bottom when non-empty; selection state local to the window.
- Detail pane: day header with totals; per `RepoBlock`: header (group name, commit count, first-to-last span), then the uncommitted block (marked, expandable, one row per file: status letter, path, mtime time-of-day, newest first), then stash rows (marked, message + branch + time), then commit rows newest-first (time, `shortRef(source_ref)` chip, subject, expandable file list via `api.repoCommitFiles` keyed `[repoId, "log", "commit-files", sha]`; stash file lists reuse the same command with the stash sha, which already appends the untracked parent).
- Diff pane: selection -> `DiffRequest`; commit and stash files use `source: { kind: "commit", commit_id }`, uncommitted files use `{ kind: "working_tree" }`; rendered read-only through `DiffBody` with the `CommitFileDiff` prop recipe; empty-selection placeholder text.
- Colours: existing tokens only; the uncommitted/stash markers use an existing attention-ish token if one reads correctly, otherwise add `work-log-uncommitted-marker` (and, only if needed, a stash marker token) in the 4 places plus `CONTRAST_PAIRS` entries for any text over washes.
- Empty states: no open repos ("Open a repository to see your work log"); a day with nothing ("No activity"); first-load skeleton via `PanelLoadingBar` only.

- [ ] **Step 1: Write the body-level render test** (`workLogShell.test.tsx`): given canned query data (mock `api`), the body renders a day list with counts, a selected day's repo block with a newest-first commit ordering assertion, and the uncommitted block above commits.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement the shell and panes.**
- [ ] **Step 4: Run to verify pass**, then the full frontend gates: `npx tsc --noEmit`, vitest whole suite (theme contract, noLiteralColors, toolbarControls, layering all stay green).

### Task 9: Menu entries and changelog

**Files:**
- Modify: `src/panels/ViewMenu.tsx`
- Modify: `src/menu/macMenuModel.ts`, `src/menu/macAppMenu.ts`, `src/App.tsx` (action switch if it lives there)
- Test: `src/menu/macMenuModel.test.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: `api.openWorkLogWindow()` (Task 6).
- Produces: a "Work Log" item in the in-app View menu (testId `view-menu-work-log`, placed after the Global panels section, before the repo panels separator) and in the macOS native View submenu (`MacMenuAction` union gains exact id `"work-log"`; `parseMacMenuAction` and `viewMenuEntries` updated; `handleMacMenuAction` case calls the command). Errors surface via `notify.error(formatAppError(e))`.

- [ ] **Step 1: Extend `macMenuModel.test.ts`**: `parseMacMenuAction("work-log")` yields the new action; `viewMenuEntries` contains the Work Log entry. Run to verify failure.
- [ ] **Step 2: Implement both menus.** Run to verify pass.
- [ ] **Step 3: Add the CHANGELOG bullet** under `## [Unreleased]` / Added: `- Work Log window: per-day overview of your commits, stashes and uncommitted changes across all open repos, with read-only diffs (View menu)`.
- [ ] **Step 4: Final whole-project verification**: `cargo test -p legit-core && cargo test -p legit-app`, `npx tsc --noEmit`, full vitest run. All green; leave everything uncommitted.
