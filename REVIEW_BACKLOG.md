# Review Backlog

Findings of the architecture / streamlining review of 2026-09-23 (core crate,
Tauri backend + host crates, frontend data layer, panels). Each item lists the
evidence, the problem, and the proposed change. Line numbers reflect the tree at
commit `0df3af2` and will drift.

Effort: **S** = hours, **M** = a day or two, **L** = multi-day.

---

## 1. Bugs (fix first, each with a regression test)

- [ ] **BUG-1 Stale repo-settings cache wipes lane locks / selected profile** (M)
  - `update_repo_settings` replaces the whole struct
    (`src-tauri/src/commands/repo.rs:1231`, `*s = settings`).
  - Lane locks live inside `RepoSettings` (`state.rs:591`) but are mutated via
    `useLaneLocksStore` (`src/store/laneLocks.ts:38-46`), which never updates
    `useRepoStore.repoSettings`.
  - `updateRepoSetting` (`src/store/repos.ts:236-244`) and the six direct
    writers in `RepoSettingsPanel.tsx` (258, 317, 386, 437, 487, 558) spread the
    cached settings, as does `CommitComposer.tsx:284`.
  - Backend-side writes of `git_profile_id` (`profiles.rs:458`) and
    `commit_button_mode` (`state.rs:1158`) do not refresh the frontend cache
    either.
  - Repro: open repo, lock a lane, toggle "show remote branches" -> lock gone.
  - Fix: backend `patch_repo_settings(repoId, partial)` that merges only sent
    fields; move RepoSettings into React Query (`[repoId, "repo-settings"]`),
    invalidated by lane-lock and profile mutations; derive `useLaneLocks` from
    the same query; drop the `repoSettings` cache in `useRepoStore`. Update the
    CLAUDE.md "Per-repo settings" paragraph, which documents the spread pattern.

- [ ] **BUG-2 Settings persistence is not crash-safe; malformed file resets to defaults** (S-M)
  - Plain `tokio::fs::write` for `persist_global_settings`
    (`state.rs:882-890`), `persist_repo_settings` (`state.rs:1006-1021`),
    `set_host_settings` (`state.rs:967-969`), `save_theme`
    (`persistence.rs:607`), layouts, keybindings.
  - Loaders silently fall back to defaults on parse error
    (`lib.rs:497-512` `load_global_settings_sync`, `state.rs:987-1002`
    `load_repo_settings_sync`); the next mutation overwrites the file with
    defaults (profiles, recent repos, accounts, open-repo list lost).
  - Fix: `write_json_atomic` helper (unique temp file, fsync, rename) plus one
    persist mutex; on parse failure rename the bad file to `*.corrupt-<ts>`
    before falling back. Test both.

- [ ] **BUG-3 `append_error_note` loses the error kind** (S)
  - `crates/legit-core/src/cli_impl/mod.rs:3690-3702`: only `CommandFailed`,
    `WouldOverwriteLocalChanges` and `RefNotFound` survive; everything else
    (`AuthFailed`, `PushRejected`, `CheckedOutInWorktree`,
    `LfsDownloadFailed`, ...) becomes `Internal`.
  - Scenario: switch fails with `CheckedOutInWorktree` and the auto-stash pop
    also fails (`mod.rs:733-745`) -> the panel loses the "open worktree"
    guidance.
  - Fix: make it total over every variant (append to the message payload,
    keep the variant). Test per variant.

- [ ] **BUG-4 Watcher lifecycle races / duplicated teardown** (M, see B2)
  - `AppState.repos`, `watchers`, `watch_errors` (`state.rs:736-751`) are
    separate locks on the same key.
  - Err branch in `repo.rs:295-305` records a watch error for a possibly
    closed repo; `set_watcher_enabled(false)` can race a starting watch that is
    inserted after the `clear()`.
  - Teardown is duplicated in `close_repo` (`repo.rs:778-787`) and
    `set_repo_git_path` (`git_setup.rs:126-128`); the latter skips the
    bookkeeping persist and the WSL release.

- [ ] **BUG-5 Submodule stash pop reports conflicts as a plain error** (S, see A5)
  - `pop_submodule_stash` (`cli_impl/submodules.rs:329`) re-implements
    selector resolution and returns an error on a conflicted pop instead of
    `StashApplyOutcome::Conflicts`, contradicting the "resolve, then drop" rule.

- [ ] **BUG-6 `classify_merge_output` misclassifies on pathnames** (S, see A4)
  - Bare `out_lc.contains("conflict")` (`mod.rs` ~3406); the rebase/sequence
    classifiers (`mod.rs:3482, 3654`) explicitly warn this pattern misfires on
    paths containing "conflict".

---

## 2. Rust core (`crates/legit-core`)

- [ ] **A2 Split `cli_impl/mod.rs` (~5000 lines) by domain** (M)
  - Keep the `GitBackend` trait as the contract; use the delegation pattern
    `submodules.rs`, `worktrees.rs` and `case_drift.rs` already follow:
    domain logic in inherent `impl<E: GitExecutor + ?Sized> GitCliBackend<E>`
    blocks per file, the trait impl in `mod.rs` reduced to one-line
    delegations (`self.x(..).await`).
  - Target modules:
    - `exec_helpers.rs` (run_checked/simple/classified/remote, 448-560)
    - `stash.rs` (2189-2356 + stash_tip, resolve_stash_selector, find_*,
      inject_stashes)
    - `branch.rs` (1916-2105 + classify_switch/branch_delete_error,
      filter_containing_refs)
    - `sequencer.rs` (2357-2621 + validate_rebase_plan, build_rebase_todo)
    - `remote.rs` (1805-1915 + build_fetch/pull/push_args)
    - `tags.rs`, `history.rs` (log, search, blame, reflog), `diff.rs`
      (run_diff_text, apply_*), `conflicts.rs` (2633-2819), `lfs.rs`
  - Move the 1150-line unit-test block (`mod.rs:3826-4981`, already sectioned
    by `// ---` headers) with its code.
  - Goal: `mod.rs` holds only the struct, constructor, shared helpers and the
    delegating trait impl.
  - Do one domain per step so each move stays reviewable and
    `cargo test -p legit-core` stays green between steps; avoid running it in
    parallel with feature branches that touch `mod.rs`.

- [ ] **A3 Collapse executor call shapes into one request struct** (M)
  - `GitExecutor` has 8 methods (`executor.rs:27-150`): run, run_expecting,
    run_with_op, run_with_stdin, run_with_stdin_bytes, run_with_env,
    run_with_op_progress, stream.
  - `runner.rs` copy-pastes the spawn/select/kill/log/RunOutput body 4x
    (`run_inner` 275, `run_with_op_progress` 358, `run_with_stdin` 452,
    `run_with_stdin_bytes` 498); the pipe-EOF orphan comment appears twice.
  - Matrix holes: progress runs cannot take env/ok_codes; stdin runs are not
    cancellable (never `try_insert_running`).
  - Default trait methods drop information (run_expecting ignores codes,
    progress == run_with_op), so FakeExecutor cannot assert cancellable/progress
    use.
  - `RemoteExecutor` (`legit-host/src/remote.rs:436-520`) remaps all 8 onto
    `GitRunParams` (`legit-proto/src/lib.rs:227`), which already is the right
    shape.
  - Fix: `GitRequest { args, env, stdin: Option<Vec<u8>>, op_id,
    ok_exit_codes, progress, stdout: Text|Bytes }` + builder, one
    `execute(req)` plus `stream`/`cancel`, one runner core. Removes the
    `Vec<String>` -> `Vec<&str>` shuffling (8x in mod.rs, `run_pathspec` 122).
  - While rewriting the runner core, split `runner.rs` (1700 lines) by
    concern: `proc_tree.rs` (ProcTree, terminate_tree, app_job, 782-975),
    `observers.rs` (process-wide statics, 100-148), and put redaction next to
    the command logging. All of it stays inside legit-core.

- [ ] **A4 Centralise stderr classification in `classify.rs`** (S-M)
  - Seven classifiers repeat the same tail (WouldOverwrite -> RefNotFound ->
    CommandFailed): `mod.rs:3188, 3223, 3389, 3461, 3643, 3764`, ad-hoc copy
    at `submodules.rs:727`.
  - Drift: only switch matches "commit your changes or stash them" (3198);
    BUG-6; stderr trimmed in 20 places but not in `ensure_success` (530) and
    `run_stash_apply` (570); only the remote path redacts credentials.
  - Fix: shared `common_failure(exit, out, err)` tail, phrase constants,
    total `append_error_note` (BUG-3).
  - Cosmetic: `classify_remote_error`'s doc comment is detached and now sits
    above `LfsDownloadFailure` (~3704).

- [ ] **A5 Unify auto-stash choreography and stash-creation detection** (M)
  - Two detection methods: tip compare (`create_stash` 2222,
    `create_stash_paths` 2246) vs list-diff against a marker
    (`run_with_auto_stash` 714, `submodules.rs:254`); the list-diff is more
    robust.
  - Stash -> act -> pop exists twice with different rollback policies:
    `mod.rs:702-778` and `submodules.rs` ~220-310 (does `reset --hard`).
  - Fix: one `with_auto_stash(scope, behavior, action)` combinator; a scoped
    view (`self.at(path)`) replacing the 15 hand-written `"-C", p` prefixes in
    `submodules.rs`. Fixes BUG-5.

- [ ] **A7 Restore the format-constant contract** (S)
  - Inline format strings: `mod.rs:390, 415, 585, 2019, 2455`,
    `submodules.rs:332`; four different stash-list formats (`%H`, `%H %gd`,
    `%H %s`, `STASH_FORMAT`).
  - Pure parsers outside `parsers/`: `classify_repo_files`,
    `parse_ls_tree_files`, `filter_paths` (3045-3130), `find_stash_selector`,
    `filter_containing_refs`, `parse_author_fields`,
    `parse_lfs_download_failure` (3726), and in `line_endings.rs`
    `parse_check_attr_z`, `parse_cat_file_batch`, `parse_autocrlf`.
  - `format!("--format={}", X)` repeated 7x: export ready-made arg constants.

- [ ] **A8 Test-infrastructure consolidation** (S)
  - Three hand-written fakes: `FakeExecutor` (`flow_tests.rs:31`),
    `CannedExecutor` (`executor.rs:231`), `RecordingExecutor`
    (`src-tauri/.../config_util.rs:208`). Ship one behind a `test-support`
    feature (trivial after A3).
  - `flow_tests.rs:108` "legacy" steps do not assert stdin; make it the
    default.
  - Extract `pin_config(dir)` in `tests/suite/git_flows_suite.rs`
    (identity/no-sign setup repeated at 44-55, 126, 2344).
  - `flow_tests.rs` tests move into per-domain files together with A2.

---

## 3. Tauri backend (`src-tauri`, `legit-host`, `legit-proto`, `legit-agent`, `legit-watch`)

- [ ] **B1 Move git logic from `commands/` into legit-core** (L)
  - ~30 direct `runner.run*` calls in `commands/` (11 `repo.rs`, 7
    `config_util.rs`, 5 `line_endings.rs`, 4 `credential_helper.rs`, plus
    `profiles.rs`, `preview.rs`, `lfs.rs`) and 20
    `session.runner.read().await.clone()` sites bypass the backend, so neither
    `flow_tests.rs` nor `remote_git_flows.rs` covers them.
  - `repo_line_ending_status` (`line_endings.rs:326-420`): composed flow
    (status, `config --get`, `check-attr --stdin`, `cat-file --batch`, fs
    read) that swallows every error into defaults; parsers already live in
    core.
  - Git-config subsystem in src-tauri: `config_util.rs`
    (`read_config_all_scopes`, `write_config_local/global`) and
    `profiles.rs:140-260` (managed keys, reset-then-add `credential.helper`).
  - LFS pointer parsing (`preview.rs:73-122`) and `.gitattributes` editing
    (`lfs.rs:58-155`).
  - Fix: a core `config` module (scopes, read/write, multi-value writes),
    line-ending status, LFS pattern editing and pointer parsing, all behind the
    backend with fake + real-git tests.
  - The 9 hand-built `GitError::CommandFailed { exit_code:
    out.exit_code.unwrap_or(-1), ... }` in `commands/` go away with the move
    (use core's `ensure_success`, `cli_impl/mod.rs:524`).

- [ ] **B2 One owner for the per-repo lifecycle** (M, fixes BUG-4)
  - `watch: Mutex<WatchState>` (`Off | Starting | Live(WatchHandle) |
    Failed(String)`) on `RepoSession`; single `AppState::remove_session(id)`.
    Removes two maps, the races and `attach_watch_error`.
  - `set_repo_git_path` (`git_setup.rs:125-135`): swap the runner behind the
    existing `Arc<RwLock<Arc<dyn GitExecutor>>>` (`state.rs:631-636`) instead of
    rebuilding the session; keeps the repo id stable for the frontend.

- [ ] **B3 Finish the Host seam** (M)
  - 33 `RepoLocator::Wsl/Local` matches in `commands/` (25 in `repo.rs`).
  - `repo_open_in_editor` / `repo_open_file_in_editor` (`editor.rs:325-396`)
    use `std::process` locally but `host.spawn_detached` for WSL, although
    `LocalHost::spawn_detached` exists (`legit-host/src/lib.rs:143`).
  - Reveal builds UNC paths by hand (`files.rs:225-247`).
  - `restore_open_repos` (`repo.rs:980-1178`), `open_session`,
    `resolve_git_for` repeat "host for locator, probe toplevel" per variant.
  - Fix: `host_for_locator(...)`, `probe_toplevel(host, git, path)` helpers;
    a Host method returning the app-visible path (`Option<PathBuf>`, UNC for
    WSL).
  - Raw `std::fs` on repo paths currently only occurs in Local branches
    (`repo.rs:31, 325, 419, 634, 1009, 1081`); fold into `RepoFs`.

- [ ] **B4 Make `HostPath` the only repo-path type** (M)
  - `RepoSession.path` stores a host posix path as `PathBuf`
    (`state.rs:659-662`); `resolve_repo_relative` takes `&Path` and returns
    `PathBuf` (`working.rs:196`), converted back via `HostPath::from_path`
    (`editor.rs:371-374`, `preview.rs:190`).
  - Fix: `session.root: HostPath`, `resolve_repo_relative -> HostPath`, so the
    "never `self.path.join`" rule (`state.rs:677`) is compiler-enforced.

- [ ] **B6 Replace ~40 single-field global-settings setters with a patch command** (M)
  - `persistence.rs:44-537`: three-line `mutate_global` commands, each also
    needing `collect_commands!`, `commands.ts`, `types.ts` and store entries
    (`store/settings.ts` imports 35 setters, near-identical bodies 269-330).
  - Fix: `patch_global_settings(partial)` with clamping in Rust + generic
    `setSetting(key, value)` in the store. Same mechanism as BUG-1.

- [ ] **B10 Remove dead `AppState.hosts`** (S)
  - Only read by `local_host()` (`state.rs:864-871`), never inserted into
    (WSL hosts live in `wsl_hosts`). Replace with a `local_host` field. Fix the
    stale `RepoSession.locator` doc ("Today always `Local`", `state.rs:625`).

- [ ] **B12 `watcher::all_domains()` hand-lists `ChangeDomain`** (S)
  - `watcher.rs:58-70`; make it `ChangeDomain::ALL` in `legit-watch` so a new
    domain cannot be missed.

---

## 4. Frontend data layer (`src/lib`, `src/store`, `src/keys`)

- [ ] **C1 Make the generated bindings the source of truth** (M)
  - `bindings.ts` is gitignored (`.gitignore:26`), imported by nothing, and
    only regenerated by a debug app run (`src-tauri/src/lib.rs:361-372`).
  - Of 122 types present in both, 10 drift:
    - `Commit.has_signature`, `TagInfo.created_at`, `Branch.created_at`:
      required in TS, optional in bindings
    - `FileStatus.old_path`, `KeybindingsFile.bindings`,
      `RepoFileEntry.submodule`, `CommitDetails`: differ
    - `RepoSettings.line_ending_chips_in_changes`,
      `warn_on_line_ending_commit`: optional in TS, required `|null` in
      bindings
    - `GlobalSettings.column_preferences`: `unknown` vs `JsonValue`
    - `AppError` `Git` details: `unknown` (`types.ts:337`) vs the fully typed
      `GitError` union
  - 15 types exist only in `types.ts`, mostly event payloads: events are not
    registered with tauri-specta (empty events section, `bindings.ts:2768`),
    and `lib/events.ts` hand-types 12 `listen<>` calls.
  - Fix: export bindings from a `cargo test` and commit the file; `types.ts`
    re-exports generated types, keeping only frontend-only types; register
    events via `collect_events!`. First fix Rust-side `#[serde(default)]` on
    output-only types (specta emits `?`) or use `specta(optional = false)`.
  - Cheap first step: a `tsc` type test asserting mutual assignability of each
    mirrored type and its binding (catches all 10 today).

- [ ] **C2 Replace `commands.ts` pass-through wrappers** (M, after C1)
  - 1283 lines; 246 `invoke` names vs 265 generated commands; header
    (`commands.ts:1-5`) already calls it the seam bindings will replace.
  - Fix: one `unwrap(p: Promise<Result<T, AppError>>)` adapter plus
    `export const api = wrap(commands)`. Keep hand-written functions only where
    they add value (arg defaults like `repoInit`, the
    `GLOBAL_/WSL_GIT_CONFIG_COMMANDS` maps at 131-153 pinned by the isolation
    test).
  - `repo_search_paths` is registered (`lib.rs:271`,
    `commands/inspect.rs:53`) but has no frontend caller: delete or wire.

- [ ] **C3 Query-key factory, shared query hooks, typed domains** (M)
  - Identical `useQuery` blocks: `[id, "remotes"]` 6x
    (`BranchesPanel.tsx:94`, `RemoteSyncToolbar.tsx:83`,
    `useCommitsQueries.ts:203`, `RemotesPanel.tsx:52`, `TagsSection.tsx:57`,
    `CommitComposer.tsx:163`); `branches` 6x (`MergePanel.tsx:144`,
    `RevPicker.tsx:72`, `WorktreesSection.tsx:48`, ...); `tags` 4x;
    `status` 3x (`OpStateStrip.tsx:62`, `WorkingChangesPanel.tsx:218`,
    `useCommitsQueries.ts:147`); `tracking` 3x; `lfs` 3x; `stashes`,
    `worktrees`, `submodules` 2x.
  - Domains are untyped strings (`invalidateRepoDomains(domains:
    Iterable<string>)`, `repoInvalidation.ts:22`), copied into 11 arrays:
    `BranchesPanel.tsx:57` AFFECTED_DOMAINS == `useCommitActions.ts:69`
    BRANCH_DOMAINS; Stashes:37 == STASH_DOMAINS; Tags:37 == TAG_DOMAINS;
    `PUSH_DOMAINS` imported from a Commits hook by `BranchesPanel.tsx:34` and
    `CommitComposer.tsx:34`. `remotes`, `identity`, `remote-tags`, `lfs` exist
    only as ad-hoc strings.
  - Fix: `lib/queries/` with `repoKeys.*(id)` and `useRemotes(id)`,
    `useBranches(id)`, ...; `QueryDomain` union extending `ChangeDomain` plus
    named domain sets. `useOpState.ts` shows the intended pattern.

- [ ] **C4 Typed git-error helpers** (S)
  - `gitErrorKind` returns `string` (`types.ts:387`), `gitErrorDetails<T>` is
    an unchecked cast (`types.ts:400`, used at `switchFeedback.ts:86, 116`);
    15 call sites compare literals.
  - Fix: `gitErrorKind(e): GitError["kind"] | null`,
    `gitErrorDetails<K>(e, kind: K): Extract<GitError, {kind: K}>["details"]`.
    Move `formatAppError`/`gitErrorKind` etc. from `types.ts` into
    `lib/errors.ts`.

- [ ] **C5 Fix layering inversions (store/keys/lib importing panels)** (S-M)
  - `store/layouts.ts:24-25` imports `buildDefaultGlobalLayout` /
    `buildDefaultRepoLayout` from `GlobalDock` / `RepoDock`.
  - `store/summon.ts:6` imports `panels/registry`.
  - `keys/registry.ts:1` imports `summonGlobalPanel` from `GlobalDock`.
  - `lib/remoteHostGit.ts:1` imports `formatVersionTriple` from
    `panels/Settings/GitStatusReadout`.
  - `store/git-status.ts:3` imports `panels/Setup/gateDecision`.
  - Fix: move pure builders/helpers into `lib/` or a `layout/` module.

---

## 5. Panels (`src/panels`)

- [ ] **D1 Single implementation of ref actions** (M)
  - Checkout, delete, set-upstream, push, delete-remote, merge, rebase exist in
    both `Commits/useCommitActions.ts:95-410` and
    `Branches/BranchesPanel.tsx:256-373`; tag push in
    `useCommitActions.ts:403` and `Tags/TagsSection.tsx:149`; stash-branch in
    `CommitsPanel.tsx` and `StashesPanel.tsx`.
  - Already diverged: Commits uses `notifySwitchError(e, {onOpenWorktree})`
    with a clickable worktree toast (`useCommitActions.ts:288`), Branches uses
    plain `formatSwitchError` (`BranchesPanel.tsx:126`). Commits has no
    re-entry guard (skips `usePanelRunner`, header 7-10); Branches has four
    runners.
  - Fix: `lib/refActions.ts` (takes `repoId`, `queryClient`) owning command,
    outcome notification and invalidation; panels only wrap in their runner.

- [ ] **D2 `confirmDestructive()` helper** (S)
  - 41 hand-rolled `if (confirmDestructive) { const ok = await
    confirmDialog(...); if (!ok) return; }`.
  - `WorkingChangesPanel.tsx:131` reads raw `confirm_discard` instead of
    `useConfirmDestructive`.
  - `useMenuConfirm` (`PanelContextMenu.tsx:140`) leaves gating to callers.
  - Fix: `confirmDestructive(req): Promise<boolean>` in `store/confirm.ts`
    (reads setting via `getState()`, resolves `true` when off) and a gated
    `useMenuConfirm` variant. Keep `confirmDialog` for ungated history warnings
    (e.g. `InteractiveRebasePanel.tsx:221`).

- [ ] **D3 Shared dirty-guarded summon-target hook** (M)
  - `Diff/DiffPanel.tsx:113-150` and `Merge/MergePanel.tsx:66-102` duplicate:
    dirty state, `dirtyRef`/`requestRef` mirrors, pending-switch request,
    `savingRef`, `rebuildKey`, reset effect on `activeRepoId`.
  - Fix: `useGuardedEditorRequest(panelId, sameTarget)` returning `{request,
    dirty, setDirty, pending, accept, reject, rebuildKey, bump}`; saving via
    `useDelayedBusy`.

- [ ] **D4 Break up `CommitsPanel.tsx`** (L)
  - One 1810-line function (123-1936). Inline row renderer (1488-1930) in the
    virtualizer map; bulk right-click business logic in `onContextMenu`
    (1502-1560); hooks placed above the no-repo early return with a crash
    warning comment (955-958); `RefsCell` gets ~40 props, 30 callbacks
    (`cells/RefsCell.tsx:104`).
  - Extract: guard component + `CommitsPanelBody({repo})` (removes hook-order
    hazard); memoized `CommitRow`; pure tested `bulkMenuPlan()` in
    `multiSelect.ts`; `useQuickJump` (959-1110); `useColumnLayout`
    (985-1054); `useGraphModel` (edge/span memos, 739-806); inline-edit state
    hook for rename/reword/create-branch/create-tag (386-698);
    `RefActionsContext` instead of callback props.

- [ ] **D5 Shared CodeMirror layer; split `MergeView` and `DiffEditor`** (L)
  - `Merge/MergeView.tsx:323-1100`: ~730-line `useEffect` with fold
    bookkeeping, chunk/gap expansion, alignment spacers, header checkboxes as
    closures; only `mergeExpander.test.tsx` covers it.
  - MergeView imports `baseTheme`, `readOnly`, `plusMinusIcon`,
    `NumberMarker` from the component file `Diff/DiffEditor.tsx:29`, and
    `conflictModel` from `Diff/`.
  - Fix: `panels/codemirror/` (theme, gutters, expanders, syntaxLanguages);
    split `DiffEditor.tsx` (1226 lines) into theme/extensions, `mountInline`,
    `mountSplit` (954-1168), thin component; move `conflictModel` and pure
    `mergeFolds`/`mergeAlign` into `Merge/` with tests.

- [ ] **D6 Settings panel primitives** (M)
  - `GlobalSettingsPanel.tsx` (1442 lines): 18 sections, 19 checkboxes;
    ConfirmDiscard / DetectCaseRenames / CheckoutRemoteFF (1112-1240) are the
    same ~30-line toggle block; 85 `style={{` (most of any file); 16
    wordings of the "writes to:" note; em-dashes in UI copy.
  - Fix: `<SettingToggle scope field label note>` and `<WritesTo scope/>` in
    `Settings/primitives.tsx`; split into per-group files
    (CommitsGraphSection alone is 371-660).

- [ ] **D7 `ThemeEditorPanel` draft logic into pure, tested ops** (M)
  - Main function (48-584) mixes palette mutation (rename auto-rebind
    123-157, delete guard 141-157, `resetToken`) with import/export/save IO.
  - Fix: `themeDraftOps.ts` with unit tests for the CLAUDE.md rules (rename
    rebinds tokens, delete blocked while referenced); own files for
    `ContrastSection`, `PanelOverridesSection`.

- [ ] **D8 `WorkingChangesPanel` data + diff-sync extraction** (M)
  - 6+ inline queries (211-360) -> `useWorkingChangesData`; extract
    `openDiff`/`syncOpenDiff` (389-500).
  - Hand-rolled pending-dim timer (547-555) is `useDelayedFlag(!pendingEmpty)`.

- [ ] **D10 Move app-wide menu primitives out of `Commits/`** (S)
  - `Commits/menu/primitives` has 17 importers, `Commits/menu/PanelContextMenu`
    9 (incl. `shared/*`, ViewMenu, RepoTabBar). Move to `shared/menu/`.
  - `SectionLabel` redefined in `Branches:605`, `Stashes:329`,
    `menu/primitives:103`; `Section` in `CommitDetails:155`,
    `Repositories:142`, `WorkingChanges:1203`. Dedupe.

---

## 6. Streamlining and cleanup (small, opportunistic)

- [ ] **E1 Duplicated OS helpers (Rust)**: three explorer/open/xdg-open spawners
  (`files.rs:277-310`, `editor.rs:263-290`, `browser.rs:77-104`) -> one
  `os_open(target, OpenMode)` or `tauri-plugin-opener`; two quote tokenizers
  (`editor.rs:23`, `profiles.rs:385`); identical `sanitize_theme_name`
  (`persistence.rs:743`) / `sanitize_layout_name` (`layouts.rs:299`), neither
  rejecting Windows reserved names (CON, NUL) or trailing dots.
- [ ] **E3 Dead / test-only exports**: `keys/registry.ts:185` `commandById`
  (unused); `lib/locator.ts:31` `formatWslLocator` and `:44` `hostLabel`
  (tests only); un-export file-local constants. Core re-exports unused
  outside legit-core (`lib.rs:17-23`): `checkin_normalizes`,
  `classify_line_endings_normalized`, `mixed_endings_in_bytes`,
  `ParseError`.
- [ ] **E6 Fixed-px chrome in shared styles**: `shared/segmented.ts:7`
  (`padding: "2px 8px"` + rgba fallback), `shared/fields.ts` (`"0 6px"`,
  `borderRadius: 3`). Convert to em; check why the no-fixed-px test does not
  catch these.
- [ ] **E8 Stale documentation references**: 8 references to a non-existent
  `DESIGN.md`, 12 to `DESIGN-v0.2`; `legit-core/src/lib.rs:4` and
  `types.rs:4` still say "v0.1".

---

## Suggested order

1. BUG-1, BUG-2, BUG-3 (small, data-loss / lost guidance, each with a test).
2. A4 + BUG-5/BUG-6, B2 (fixes BUG-4).
3. C1 type-drift test, then committed bindings; C3 typed query keys/domains.
4. D1, D2 (remove the sources of behaviour drift).
5. A3; A2 (one domain at a time); A5; A8.
6. B1, B3, B4 (git logic into core, finish the Host seam); B6 with C2.
7. Component splits D4-D8, one at a time behind existing tests.
8. Section 6 opportunistically.
