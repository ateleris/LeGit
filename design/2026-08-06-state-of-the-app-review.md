# State of the app - 2026-08-06 (v0.9.11)

Full-codebase review: architecture adherence, dead code, robustness, and
improvement candidates. Successor to `2026-07-11-state-of-the-app.md`
(v0.9.2, nine minor versions ago). Method: three parallel review passes
(Rust backend, React frontend, cross-cutting IPC/type/config hygiene), every
dead-code and drift claim verified by project-wide grep; `cargo clippy` and
`cargo test -p legit-core` (115/115 real-git flows) and `tsc --noEmit` all
pass clean.

Scale: ~31k LOC Rust (legit-core 15.5k, git_flows harness 3.8k, src-tauri
11k), ~42k LOC TS/TSX production + 7.4k test, 214 IPC commands, 20 panels,
16 zustand stores, ~690 Rust tests + 566 frontend tests, 6 e2e specs.

## Verdict

The architecture documented in CLAUDE.md is real, not aspirational: every
contract checked (GitRunner chokepoint, run_with_env-only hardening
relaxations, pure colocated parsers, no %G? in bulk logs, stash-by-SHA,
outcome-vs-error split, append_error_note, theme token discipline,
[repoId, domain] query keys) held under mechanical verification. The
recurring failure mode is not missing infrastructure but **incomplete
migration onto infrastructure that exists**: useRepoSwitchClear,
usePanelRunner, segmented.ts, confirmDialog, summonGlobalPanel, and the
commands.ts seam each have hand-rolled stragglers, and one of those gaps is
a user-visible bug. Nothing structural is wrong.

## High-severity findings

1. **Two visible buttons are silent no-ops: `summon("global-settings")`.**
   `WorkingChangesPanel.tsx:1113` ("Set identity..." in the commit
   composer's missing-identity warning - shown exactly when the user cannot
   commit) and `Settings/EffectiveValuesSummary.tsx:38` ("Edit in Global
   Settings"). `summon()` resolves only `REPO_PANELS`
   (`store/summon.ts:117`) and returns silently for a global panel id; the
   correct call is `summonGlobalPanel` (`GlobalDock.tsx:149`, used by
   ViewMenu). Fix is one line each + a regression guard (a summon-registry
   cross-check test was already parked in BACKLOG "Frontend consolidation").

2. **`RepoSettings` hand mirror omits `laneLocks` while
   `update_repo_settings` replaces the whole struct.** Rust
   `state.rs:442` serializes `laneLocks`; `bindings.ts:3218` has it; the
   hand-written `RepoSettings` (`src/lib/types.ts:104`) does not.
   `update_repo_settings` does `*s = settings` and persists. It works today
   only because callers spread the runtime object (which carries the field
   invisibly). Failure modes: any future hand-built `RepoSettings` literal
   silently wipes all lane locks, and a stale `repoSettings` cache spread
   after `set_lane_lock` can overwrite newer locks. TS cannot catch either
   because the field is absent from the type. Add the field (and
   `connected_accounts` to `GlobalSettings`, same class, benign today).

## Medium-severity findings

**Backend**

- **Pathname "conflict" misfire in rebase/sequencer classifiers.**
  `classify_rebase_output` (`cli_impl/mod.rs:3683`) and
  `classify_sequence_output` (`:3767`) test `contains("conflict")` before
  the would-be-overwritten check, so a dirty-tree refusal whose stderr file
  list contains a path like `conflicts.md` classifies as Conflicts
  ("resolve, then continue" - there is nothing to continue) instead of
  WouldOverwriteLocalChanges. The identical misfire class was already fixed
  and pinned for stash apply (`stash_apply_left_conflicts`, `:3600`); these
  two siblings never got the fix, and the existing tests pass only because
  their fixture stderr omits the file list. Fix + pinning test per the
  house rule.
- **Submodule auto-stash can silently detour changes into the stash.**
  `update_one_submodule` (`cli_impl/mod.rs:608-643`) maps a failed
  `stash list` read to "empty list"; if the after-push read fails the flow
  reports plain `Updated` while the user's changes sit in the submodule's
  stash - exactly the silent best-effort failure the append_error_note
  convention exists to prevent. Rare trigger, cheap to make loud.
- **4 dead IPC commands** registered but never wrapped or invoked:
  `repo_signing_config`, `repo_write_signing` (superseded by the profile
  system), `repo_submodule_init` (UI uses update --init), and
  `repo_search_paths` (documented-deliberate in BACKLOG - keep). Decide
  keep-or-delete for the first three; transitively `GitBackend::search_paths`
  and `submodule_init` plus helpers are production-dead.

**Frontend**

- **~30 busy states bypass the 150ms-delay convention**, concentrated in
  the settings panels (`GlobalSettingsPanel.tsx` ~20 sites,
  `RepoSettingsPanel.tsx` 8, plus RepoIdentitySection,
  GlobalGitConfigSection, ConnectedAccountsSection, CustomConfigEditor,
  Repositories/forms init path). Neighboring files hand-roll the timer
  correctly (NormalizeLineEndingsBlock, SshKeyTools), so this is drift.
  An adopt-usePanelRunner (or shared delayed-flag) pass closes it.
- **4 `window.confirm`/`window.alert` sites bypass the central surfaces**:
  ThemeEditorPanel.tsx:186 (theme deletion; gating is correct, surface is
  not), ConfirmCloseTab.tsx:18, RepoDock.tsx:95+105 (theme-import errors
  should be `notify.error` toasts).
- **Six summon-target panels still hand-roll the pre-fix
  clear-on-repo-switch pattern** that caused the 2026-08-06 clobber bug:
  Blame, Compare, FileHistory, Files, FileView, InteractiveRebase. Latent
  (no cross-repo flow summons them yet), but any future one re-introduces
  the bug silently. Migrate to `useRepoSwitchClear` (Diff/Merge use a safe
  repoId-embedding variant and can stay).
- **FileTree focused-row styling only differs from selected before the
  theme loads**: both rows use `--graph-row-selected-bg` with different
  literal fallbacks (`FileTree.tsx:341,343`); once a theme applies they
  render identically. Needs a dedicated token (4-place addition).
- **Fixed-px inline styles are systemic** (~534 non-hairline numeric values,
  densest in the two settings panels) and nothing enforces the px-scaling
  convention, unlike colours. Mostly small gaps/margins; worth a sweep plus
  an enforcement test if the convention is to stay honest.
- **`saveRegionState` seam violation**: the only two raw `invoke()` calls
  in the frontend (`AppLayout.tsx:46` - a shadowing local function of the
  same name - and `store/settings.ts:145`) bypass the existing commands.ts
  wrapper, which is consequently dead.

**Cross-cutting**

- **CI never typechecks the frontend**: ci.yml runs vitest only;
  `tsc --noEmit` happens solely inside `npm run build` at release time, so
  type drift (finding 2 above is the archetype) can land on main unseen.
  Add a tsc step to ci.yml.
- **BACKLOG release blocker 2 is stale**: README screenshots exist
  (`docs/screenshots/hero_{light,dark}.png`, wired into README via a
  theme-aware picture element). Blockers 1 (LICENSE; workspace license is
  still "TBD") and 3 (vibecoding disclaimer) remain open and accurate.

## Low-severity / inventory

- Dead exports: `applyOverride`/`applyPaletteValue` (`theme/applier.ts:70,74`,
  doc comment claims a consumer that does not import them);
  `RunnerEvent` export (`types.ts:128`); `GitRunner::in_flight`
  (`runner.rs:656`); `AppError::OperationNotFound` (`error.rs:47`).
- `PanelDescriptor.summons` metadata (`registry.tsx:40`) is never read and
  already stale (working-changes summons 4 panels it does not declare) -
  delete or make a test read it.
- Dead CSS: `.legit-region-divider__mode` (`global.css:218+`). Unused prop:
  `ColumnHeader.order` (`ColumnHeader.tsx:21`).
- Removable dependencies: `@codemirror/merge`, `codemirror` meta-package
  (package.json), `serde_json` (legit-core Cargo.toml).
- `segStyle` duplicated in 4 panels despite `shared/segmented.ts`.
- Tag-remote choice divergence: `CommitsPanel.tsx:409` ignores the
  user-selected remote that `TagsSection.tsx:60` honors - with multiple
  remotes the "pushed" tag indicators can disagree between panels.
- Binary-sniff window inconsistency: `mixed_endings_in_bytes` probes 512
  bytes (`mod.rs:3095`) vs `BINARY_SNIFF_WINDOW = 8000` in its siblings.
- Settings-persist failures in session bookkeeping are `.ok()`-swallowed
  without even a log (`commands/repo.rs:155+`).
- Config nits: devUrl `localhost` vs vite `127.0.0.1`; stale "two-spec"
  comment in ci.yml (there are 6); redundant tsconfig include globs; stale
  TODO in `theme.css:8` (the promised lint rule exists as
  `noLiteralColors.test.ts`). This is the codebase's only TODO/FIXME.
- `release-notes` panel is reachable only via the View menu (never
  summoned, absent from default layouts) - confirm intentional.
- Structural debt: `CommitsPanel.tsx` (2423 lines, one 1720-line component)
  and `WorkingChangesPanel.tsx` (1346, one 1130-line function) are the two
  monoliths; natural splits are queries hook + row context menu +
  RemoteSyncToolbar, and CommitComposer + shared FileRowMenu respectively.
  `cli_impl/mod.rs` (4951 lines) would split cleanly at the submodule and
  line-ending blocks. GlobalSettingsPanel (1582) is large but
  well-sectioned.

## What did NOT turn up

No security-shaped findings, no panics-in-waiting (unwrap/expect audit
clean), no query-key violations, no literal colours outside the enforced
system, no watcher/state races, no IPC name mismatches, and only 2 mirror
fields of drift across 99 shared types. BACKLOG.md is accurate except the
one stale blocker. Docs match reality on every spot-checked claim.

## Suggested order of attack

1. The two one-line fixes with user-visible impact: `summonGlobalPanel` at
   both call sites; add `laneLocks` to the `RepoSettings` mirror.
2. The classifier misfire + pinning tests (data-guidance correctness).
3. Add `tsc --noEmit` to CI (prevents the drift class recurring).
4. One consolidated "adopt the helper" pass: usePanelRunner in settings,
   useRepoSwitchClear in the six panels, segStyle, saveRegionState wrapper,
   window.confirm/alert to confirmDialog/notify.
5. Dead-surface cleanup (3 IPC commands + deps + exports) and the BACKLOG
   blocker correction.
6. Structural splits only when next touching those files (per convention).
