# Hardening review - 2026-07-11

Full-codebase review (backend core, Tauri layer, frontend infrastructure,
panels, test coverage) done with five parallel review passes; every finding
listed here was spot-verified against the code before inclusion. Companion to
`2026-07-11-state-of-the-app.md`.

Legend: [core] crates/legit-core, [tauri] src-tauri, [fe] frontend.

---

## A. Correctness findings (fix first)

A1. **[core] Runner errors are flattened to `Internal` at 57 call sites.**
`cli_impl/mod.rs` maps every runner error with
`.map_err(|e| GitError::Internal(e.to_string()))`; there is no
`From<RunnerError> for GitError`. `RunnerError::GitNotFound` therefore
surfaces as an opaque internal error instead of `GitError::GitUnavailable`,
so the UI cannot react to "git is missing" on any per-operation failure.
Fix: `impl From<RunnerError> for GitError` (GitNotFound -> GitUnavailable,
else Internal) and use `?`. Collapses naturally with B1.

A2. **[tauri] Watcher fingerprint map grows unbounded.** `watcher.rs:147-151`
fingerprints every non-noise git-dir path BEFORE `classify` filters it, so
each distinct loose object / lockfile ever seen inserts an entry into `seen`
(plus a stat per path per batch). The bounding comment ("roughly the ref
count") is wrong. Slow memory leak in the long-lived per-repo watcher.
Fix: classify first (or short-circuit objects/logs/.lock) and only
fingerprint paths that resolve to a domain.

A3. **[tauri] Duplicate-open race.** `repo.rs` `register_open_repo` checks
existing sessions under `repos.read()` and inserts under a later
`repos.write()`; two concurrent opens of the same path can create two
sessions + two watchers. Fix: find-or-insert under a single write guard.

A4. **[tauri] Credential broker can wedge after a panic.** `credentials.rs:384`
and `:400` use `.lock().unwrap()` on `session_cache` / `pending`, bypassing
the file's own poison-proof `lock()` helper (line 115) that exists exactly
to keep credential prompting alive after a panicked handler.

A5. **[core] `is_untracked` treats a failed `ls-files` as "untracked".**
`cli_impl/mod.rs:214-220` returns `stdout.is_empty()` without checking
`out.success`. Untested exit-code assumption of the class that caused two
past bugs. Fix: propagate the failure.

A6. **[core] Stash-conflict detection is a substring match.**
`run_stash_apply` classifies any failing apply/pop containing "conflict"
anywhere in combined output (even a pathname) as `Conflicts`. Siblings key
off specific git phrases. Fix: match git's actual phrases like
`classify_merge_output` does.

A7. **[core] Auto-stash "did we stash?" can mis-address under concurrency.**
`run_with_auto_stash` / `create_stash` decide by comparing `refs/stash`
tips; a stash created concurrently (another client/CLI) between push and
tip-read gets adopted and later popped/dropped. Low likelihood, real
data-move hazard. Fix: diff the full stash-list SHA set before/after
instead of tip-compare.

A8. **[fe] Compare and Search panels bypass `formatAppError`.**
`ComparePanel.tsx:196`, `SearchPanel.tsx:180` render
`String((error as Error)?.message ?? error)`; an `AppError` object shows as
`[object Object]` instead of the git message.

A9. **[fe] `tracking` is a query domain but not a watcher domain.** External
fetches (or any watcher-detected ref move) refresh `branches`/`log` but the
ahead/behind counter stays stale until an in-app action. Fix: derive
`tracking` in `withDerivedDomains` when `branches` is present (same pattern
as the `submodules` derivation).

A10. **[fe] `GitSetupGate.tsx:173` uses `navigator.clipboard` directly,**
skipping `copyText()`'s webview fallback - copy fails silently where the
async API is blocked. One-line fix.

## B. Architecture / duplication (structural improvements)

B1. **[core] One `run_checked` helper.** The "run, map runner error, map
non-zero exit to CommandFailed(stderr)" block is copy-pasted 57 times in
`cli_impl/mod.rs`. A single `async fn run_checked(&self, args) ->
Result<String, GitError>` collapses ~two dozen methods. Also: shared
`diff_tree(from, to)` helper (three inline copies), and `commit_files`
runs `rev-list --parents -n 1` twice on the same SHA.

B2. **[fe] Extract `usePanelRunner` and fix three convention violators.**
The delayed-busy + re-entry-guard runner is duplicated ~6x (WorkingChanges,
Branches, OpStateStrip, Tags, Submodules, InteractiveRebase) and
Stashes / Reflog / Remotes violate it outright (instant `setBusy(true)`,
no 150ms delay, no double-click guard - Stashes has >=6 hand-rolled
copies in one file). Extract `usePanelRunner` into `panels/shared/`,
migrate all sites.

B3. **[fe] Shared `PanelError` component.** The
`<pre className="legit-error">{formatAppError(error)}</pre>` block is
duplicated ~20x with already-diverged margins. Also fixes A8 for free.

B4. **[fe] Split `CommitsPanel.tsx` (1997 lines).** Extract (a) the ~30
uniform async mutation handlers into a `useCommitActions` hook (also
removes ~18 `eslint-disable react-hooks/exhaustive-deps`), (b) the pure
transforms (`refsAt`, `upstreamMap`, `stashSelectorById`) into a tested
`commitRows.ts` next to `graph/`. Sheds 700-900 lines and makes the graph
decision logic unit-testable. (`GlobalSettingsPanel.tsx` at 1309 lines is
the second candidate, lower priority.)

B5. **[tauri] Settings persist helpers.** `{ write().await; mutate }` +
persist is repeated ~25x for global settings and 5x for repo settings
(four args that can drift). Add `state.mutate_global(|s| ...)` and
`session.persist_settings(state)`.

B6. **[tauri] Move line-endings classification into legit-core.**
`line_endings.rs` runs `git ls-files` and scans bytes inline in the
command layer while sibling `classify_line_endings` correctly lives in
core; `LineEndingsView` assembly is also copy-pasted 4x in the file.
Move `detect/is_mixed_endings` next to `classify_line_endings`, add the
missing unit tests there (currently zero).

B7. **[tauri] `set_git_path` holds `repos.read()` across awaits**
(`git_setup.rs:59-66`). Snapshot sessions into a Vec, drop the guard.

## C. Dead code / stale docs (quick wins, zero risk)

- [fe] `Settings/SettingsPanel.tsx` (140 lines, no importers) - delete.
- [fe] `PanelHost.tsx` (an `export {}` stub), icons `LockIcon` /
  `DiscardIcon` / `TrashIcon`, wrappers `saveGlobalLayout` /
  `saveRepoLayout` / `repoSubmoduleInit` - all unreferenced.
- [core] `GitError` variants never constructed anywhere: `Cancelled`,
  `TimedOut`, `NotARepo`, `MergeConflict`, `NotYet`; likewise
  `RunnerError::Cancelled`. Either wire up (produce `Cancelled` on the
  cancel path) or delete. They currently generate unreachable TS bindings.
- [fe] Dead theme tokens `branch.current.fg` and `commit.signed.indicator`
  (superseded by `ref.branch.current.*` / another token; zero readers).
  IMPORTANT: remove BEFORE the first public release - afterwards removal
  breaks user themes per the contract. Add a reverse "every token is
  consumed" assertion to `contract.test.ts`.
- [tauri] Unused deps in src-tauri/Cargo.toml: `async-trait`, `chrono`,
  `legit-providers`.
- Stale comments contradicting code: `cli_impl/mod.rs:3-5` + `backend.rs:3-7`
  ("NotYet stubs" - ~90 methods are implemented), `run_classified` doc
  leader, mis-attached `stash_tip` doc, `state.rs:65` auto-fetch default
  doc, `state.rs:383` "flushed on close" (settings persist eagerly),
  `types.ts:117` vs `repoInvalidation.ts:38` `submodules`-domain
  contradiction.
- [fe] `types.ts` optionality drift vs `bindings.ts` in `GlobalSettings`
  (fields with opposite `?`) - align field-by-field.

## D. Deliberately NOT recommended now

- GitBackend trait naming/typing normalization (`&str` vs `&CommitId`,
  `list_` prefixes): real inconsistency, but a wide mechanical churn with
  no behavior change - batch it with the next big backend feature instead.
- Shared `Popover`/`useDismissable` (6 hand-rolled dropdowns), shared
  composite file-row menu section, `STALE` query-time constants, summon
  registry cross-check test, fixed-px padding sweep, theme.css
  value-equality test, `GlobalSettingsPanel` split: all worthwhile, none
  urgent - park as a "frontend consolidation" backlog entry.
- DevRibbon literal colours: dev-only, document as exception.

## E. Unit-test gaps (from the coverage audit)

Existing coverage is strong: every parser has tests; ~85 FakeExecutor flow
tests; ~90 real-git harness tests; watcher, profiles, editor, credentials
IO all tested. Gaps, risk-ordered:

P0 (data-loss adjacent, all Small):
- `delete_branch` / `create_branch` / `rename_branch`: no coverage at all.
- `create_tag` / `delete_tag` / `push_tag` / `delete_remote_tag`: only
  arg-builder units.
- `checkout_commit` (detached HEAD): no coverage.
- Remote management (`add/remove/rename_remote`, `set_remote_url`): only
  `set_url_args` unit.
  For all of the above: FakeExecutor sequence tests + real-git harness
  tests per the "both levels" rule.
- [fe] `useConfirmDestructive` default-on assertion + settings clamp math.

P1 (git-output assumptions):
- `classify_sequence_output`: pure unit test (siblings have them).
- `line_endings` `is_mixed_endings`/`detect_mixed_endings`: zero tests
  (do together with B6).
- `resolve_git_path` (git_resolve.rs): zero tests.
- `pull` / `fetch` / `merge`: FakeExecutor sequence tests (only
  arg-builders + real-git today).
- `build_rebase_todo`: direct unit test for its validation.

P2 (frontend mirrors of tested Rust logic, all Small vitest):
- `lib/switchFeedback.ts`, `lib/mergeFeedback.ts` (outcome -> message maps),
  `lib/signature.ts` (security-facing badge mapping),
  `theme/validate.ts` (mirror of tested Rust theme validation).

P3 (UI logic, pick opportunistically):
- `shared/FileTree/buildTree.ts` (high blast radius), `lib/time.ts`,
  `Commits/menu/ordinal.ts`, `theme/contrast.ts`, `store/commitDraft.ts`,
  `store/remoteProgress.ts`, `store/laneLocks.ts`, `Diff/hunkExpanders.ts`.

Note: new vitest suites must be run from PowerShell (WSL runs cargo + tsc
only); the B4/B2 extractions create their own new test targets
(`commitRows.ts`, `usePanelRunner`).

## F. E2E additions (proposed order)

Covered today: stage->commit->log (smoke), merge-conflict banner (conflict).
The backlog gates extensions on the suite proving stable in CI - keep that
gate. When it opens, in value order:

1. **Discard with confirmation** (data-loss path + confirm gate). M
2. **Branch create -> switch** incl. dirty-switch auto-stash. M
3. **Stash create -> pop** through the UI. M
4. **Push/pull against a local bare-remote fixture** (new
   `buildRemoteFixture` in e2e/fixtures.ts). L
5. **Clone flow** (pairs with the missing real-git clone test). L

Keep it a small smoke suite: 1-3 now, 4-5 only if the suite stays quiet.

## G. Suggested execution order

1. Correctness fixes A1-A10 (each small; test-first where pure).
2. Dead code + stale docs sweep (C) - includes the pre-release-critical
   dead-token removal.
3. Structural: B1 (run_checked), B2 (usePanelRunner), B3 (PanelError),
   B5 (settings helpers), B7 (lock scope).
4. B6 (line-endings to core) and B4 (CommitsPanel split) - the two bigger
   refactors, tests first.
5. Test-gap fill (E) - P0 and P1 at minimum.
6. E2E additions (F) once CI stability gate is met.
