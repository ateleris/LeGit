# Submodules Tier 4 (Safety) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Do NOT use subagent-driven-development (user rule). Do NOT commit at any point (user rule): leave all changes in the working tree for the user to review.

**Goal:** The tier-4 safety net: post-switch/pull submodule auto-update honoring the global `SwitchDirtyBehavior` with full rollback on a conflicted pop (changes are never lost, per-submodule atomicity, outcomes cross IPC as data), a `push --recurse-submodules` guard with a classified error, detached-HEAD "branch here", and config-drift Repair. (Spec: sub-project 5 + brainstorming decisions 2026-07-08.)

**Architecture:** `submodule_auto_update(behavior)` enumerates via the existing `submodules()`, then per pointer-moved submodule: clean -> `submodule update`; dirty + `TryDirectly` -> direct checkout (git carries or refuses); dirty + `AutoStash`/`StashAndKeep` -> stash inside the submodule (tip-compare verified), update, then pop by SHA - a conflicted pop triggers ROLLBACK (`reset --hard <old>` discards the marker-ridden application, git kept the stash; pop again on the original base lands clean). Every path records a `SubmoduleAutoUpdateResult`; failures never abort the batch. The Tauri command gates on a new per-repo setting and reads the global behavior from state, so the frontend just calls it after successful switch/pull. Push gains `--recurse-submodules=check|on-demand` from a new global setting, with the "unpushed submodule commits" stderr classified into `GitError::UnpushedSubmodules`.

**Tech Stack:** Rust (crates/legit-core, src-tauri), React + TypeScript, FakeExecutor flow tests, real-git harness.

## Global Constraints

- **No commits, no pushes.** All changes stay in the working tree for user review.
- **Changes are never lost in any path** (approved brainstorming decision): they end up carried over, back in the worktree after rollback, or parked in that submodule's stash - and a stash survives a conflicted pop. Never a bare `stash pop`; stash addressed by SHA -> selector at action time; "something was stashed" verified by tip comparison, never exit codes.
- Pop-conflict semantics (approved): ROLL BACK the submodule (old SHA, changes reapplied cleanly on their original base) and report "changes could not be carried over" - never leave conflict markers from a side-effect operation.
- Per-submodule atomicity: a failed submodule is restored/skipped and reported; the batch continues (partial success is an outcome, not an error).
- Auto-update is ON by default with a per-repo off switch (`RepoSettings.submodule_auto_update: Option<bool>`, `None` = inherit default true).
- Push guard works in detached HEAD (git's own `--recurse-submodules=check` does; the SourceTree hole was their custom warning, which we do not replicate).
- The worst-case double-failure (rollback pop also fails) must tell the user where their data is (`ChangesInStash` outcome; append-note house rule).
- Verification from WSL: `cargo test -p legit-core`, `cargo test -p legit-app --lib`, `npx tsc --noEmit`. vitest + live app are PowerShell steps.
- No em-dashes in comments or docs.

---

### Task 1: Backend `submodule_auto_update` (types + algorithm + tests)

**Files:**
- Modify: `crates/legit-core/src/types.rs` (outcome types after `SubmoduleGitdirInfo`)
- Modify: `crates/legit-core/src/backend.rs` (trait method after `submodule_delete_gitdir`)
- Modify: `crates/legit-core/src/cli_impl/mod.rs` (implementation + private per-submodule helper)
- Modify: `crates/legit-core/src/cli_impl/flow_tests.rs` (rollback-ordering flow test)
- Modify: `crates/legit-core/tests/git_flows.rs` (four real-git behavior tests)

**Interfaces:**
- Consumes: `submodules()` (tier 1), `stash_created` / `find_stash_selector` pure helpers (`cli_impl/mod.rs:2502,2511`), `SwitchDirtyBehavior`.
- Produces:
  - `SubmoduleAutoUpdateStatus` (serde `tag="kind"`, snake_case): `Updated` | `ChangesCarried` | `ChangesStashed` | `RolledBack { message }` | `ChangesInStash { message }` | `Skipped { message }`
  - `SubmoduleAutoUpdateResult { path: PathBuf, status: SubmoduleAutoUpdateStatus }`
  - `async fn submodule_auto_update(&self, behavior: SwitchDirtyBehavior) -> Result<Vec<SubmoduleAutoUpdateResult>, GitError>`

- [x] **Step 1: Types**

In `types.rs`, after `SubmoduleGitdirInfo`:

```rust
/// Per-submodule outcome of the post-switch/pull auto-update. Data, not an
/// error: partial success crosses IPC as outcomes (house rule).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SubmoduleAutoUpdateStatus {
    /// Clean submodule checked out at the recorded SHA.
    Updated,
    /// Dirty submodule updated with the local changes carried over
    /// (TryDirectly carry, or a clean auto-stash pop).
    ChangesCarried,
    /// Updated; the changes were deliberately left parked in the
    /// submodule's stash (StashAndKeep).
    ChangesStashed,
    /// The auto-stash pop conflicted: the submodule was rolled back to its
    /// previous commit and the changes reapplied cleanly there. Nothing was
    /// lost; the pointer remains un-updated.
    RolledBack { message: String },
    /// Worst case: rollback's own pop failed too. The changes are SAFE in
    /// the submodule's stash; the submodule sits at its previous commit.
    ChangesInStash { message: String },
    /// The update could not run (conflicted submodule, checkout refused,
    /// fetch failure, ...). The submodule was left untouched.
    Skipped { message: String },
}

/// One submodule's auto-update outcome.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct SubmoduleAutoUpdateResult {
    pub path: PathBuf,
    pub status: SubmoduleAutoUpdateStatus,
}
```

- [x] **Step 2: Trait method**

`backend.rs` (extend imports with the two new types + `SwitchDirtyBehavior` is already imported):

```rust
    /// After a superproject switch/pull moved submodule pointers, bring the
    /// populated submodules to their recorded SHAs. Dirty submodules follow
    /// `behavior` (the global switch strategy); a conflicted auto-stash pop
    /// ROLLS the submodule BACK (changes reapplied on their original base).
    /// Per-submodule atomicity: failures are reported per entry, the batch
    /// continues. Local changes are never lost in any path.
    async fn submodule_auto_update(
        &self,
        behavior: SwitchDirtyBehavior,
    ) -> Result<Vec<SubmoduleAutoUpdateResult>, GitError>;
```

- [x] **Step 3: Implementation**

In `cli_impl/mod.rs` (extend the types import; the public method plus a
private helper in the inherent impl next to `submodule_gitdir_path`):

Public method (in the `GitBackend` impl, after `submodule_delete_gitdir`):

```rust
    async fn submodule_auto_update(
        &self,
        behavior: SwitchDirtyBehavior,
    ) -> Result<Vec<SubmoduleAutoUpdateResult>, GitError> {
        let subs = self.submodules().await?;
        let mut results = Vec::new();
        for s in subs {
            if !s.state.populated || !s.state.pointer_moved {
                continue;
            }
            let (Some(recorded), Some(old)) = (s.recorded_sha.clone(), s.checked_out_sha.clone())
            else {
                continue;
            };
            let status = self
                .auto_update_one(&s, recorded.as_str(), old.as_str(), behavior)
                .await;
            results.push(SubmoduleAutoUpdateResult { path: s.path, status });
        }
        Ok(results)
    }
```

Private helper (inherent impl). NOTE the invariants encoded here: stash
verified by tip comparison; pop by SHA-resolved selector; rollback =
`reset --hard <old>` (clears the conflicted application AND unmerged index -
git kept the stash on the conflicted pop) then a clean pop on the original
base:

```rust
    /// Update ONE pointer-moved submodule to `recorded`, handling dirtiness
    /// per `behavior`. Never returns Err: every failure becomes a status so
    /// the caller's batch continues (per-submodule atomicity).
    async fn auto_update_one(
        &self,
        s: &SubmoduleInfo,
        recorded: &str,
        old: &str,
        behavior: SwitchDirtyBehavior,
    ) -> SubmoduleAutoUpdateStatus {
        let p = s.path.to_string_lossy().into_owned();
        let skip = |msg: String| SubmoduleAutoUpdateStatus::Skipped { message: msg };

        if s.state.conflicted {
            return skip("the submodule is in a merge conflict".into());
        }
        let dirty = s.state.dirty_tracked || s.state.dirty_untracked;

        // Clean: plain `submodule update` (fetches the recorded SHA on
        // demand, unlike a raw checkout).
        if !dirty {
            return match self.run_simple(&["submodule", "update", "--", &p]).await {
                Ok(()) => SubmoduleAutoUpdateStatus::Updated,
                Err(e) => skip(e.to_string()),
            };
        }

        match behavior {
            // Let git decide: a non-conflicting dirty tree carries over, a
            // conflicting one refuses and the submodule stays untouched.
            SwitchDirtyBehavior::TryDirectly => {
                match self.run_simple(&["-C", &p, "checkout", recorded]).await {
                    Ok(()) => SubmoduleAutoUpdateStatus::ChangesCarried,
                    Err(e) => skip(format!("local changes could not be carried over: {e}")),
                }
            }
            SwitchDirtyBehavior::AutoStash | SwitchDirtyBehavior::StashAndKeep => {
                let runner = self.runner().await;
                // Stash inside the submodule, verified by tip comparison
                // (never by exit code: `stash push` exits 0 on a clean tree).
                let tip = |o: Result<crate::runner::RunOutput, crate::runner::RunnerError>| match o
                {
                    Ok(out) if out.success => Some(out.stdout.trim().to_string()),
                    _ => None,
                };
                let before = tip(runner.run(&["-C", &p, "rev-parse", "-q", "--verify", "refs/stash"]).await);
                if let Err(e) = self
                    .run_simple(&[
                        "-C", &p, "stash", "push", "--include-untracked", "-m",
                        "legit: auto-stash before submodule update",
                    ])
                    .await
                {
                    return skip(format!("could not stash local changes: {e}"));
                }
                let after = tip(runner.run(&["-C", &p, "rev-parse", "-q", "--verify", "refs/stash"]).await);
                let Some(stash_sha) = stash_created(before.as_deref(), after.as_deref()) else {
                    // Race: tree turned out clean - just update.
                    return match self.run_simple(&["submodule", "update", "--", &p]).await {
                        Ok(()) => SubmoduleAutoUpdateStatus::Updated,
                        Err(e) => skip(e.to_string()),
                    };
                };

                // Move to the recorded SHA (tree is clean now).
                if let Err(e) = self.run_simple(&["submodule", "update", "--", &p]).await {
                    // Restore: pop the stash we just made, back on `old`.
                    let msg = match self.pop_submodule_stash(&p, &stash_sha).await {
                        Ok(()) => format!("update failed; local changes restored: {e}"),
                        Err(pop_e) => {
                            return SubmoduleAutoUpdateStatus::ChangesInStash {
                                message: format!(
                                    "update failed ({e}) AND restoring failed ({pop_e}) - your changes are in the submodule's stash"
                                ),
                            }
                        }
                    };
                    return skip(msg);
                }

                if matches!(behavior, SwitchDirtyBehavior::StashAndKeep) {
                    return SubmoduleAutoUpdateStatus::ChangesStashed;
                }

                // AutoStash: pop onto the NEW commit.
                match self.pop_submodule_stash(&p, &stash_sha).await {
                    Ok(()) => SubmoduleAutoUpdateStatus::ChangesCarried,
                    Err(pop_err) => {
                        // Conflicted/failed pop: ROLL BACK. `reset --hard`
                        // discards the marker-ridden application and clears
                        // unmerged index entries - the stash itself survived
                        // (git keeps it when a pop conflicts).
                        if let Err(e) = self.run_simple(&["-C", &p, "reset", "--hard", old]).await {
                            return SubmoduleAutoUpdateStatus::ChangesInStash {
                                message: format!(
                                    "pop conflicted ({pop_err}) AND rollback failed ({e}) - your changes are in the submodule's stash"
                                ),
                            };
                        }
                        match self.pop_submodule_stash(&p, &stash_sha).await {
                            Ok(()) => SubmoduleAutoUpdateStatus::RolledBack {
                                message: format!(
                                    "local changes conflict with the new submodule commit; the submodule was left at its previous commit with your changes intact ({pop_err})"
                                ),
                            },
                            Err(e) => SubmoduleAutoUpdateStatus::ChangesInStash {
                                message: format!(
                                    "pop conflicted ({pop_err}) AND reapplying on the original commit failed ({e}) - your changes are in the submodule's stash"
                                ),
                            },
                        }
                    }
                }
            }
        }
    }

    /// Pop the given stash SHA inside submodule `p`, resolving the SHA to its
    /// CURRENT selector first (positional selectors shift; house rule).
    async fn pop_submodule_stash(&self, p: &str, stash_sha: &str) -> Result<(), GitError> {
        let runner = self.runner().await;
        let list = runner
            .run(&["-C", p, "stash", "list", "--format=%H %gd"])
            .await
            .map_err(|e| GitError::Internal(e.to_string()))?;
        if !list.success {
            return Err(GitError::CommandFailed {
                exit_code: list.exit_code.unwrap_or(-1),
                stderr: list.stderr,
            });
        }
        let Some(selector) = find_stash_selector(&list.stdout, stash_sha) else {
            return Err(GitError::Internal(format!(
                "auto-stash {stash_sha} vanished from the submodule stash list"
            )));
        };
        drop(runner);
        self.run_simple(&["-C", p, "stash", "pop", &selector]).await
    }
```

(`stash_created` and `find_stash_selector` are free functions in this same
module - call them unqualified. Check their exact signatures at
`cli_impl/mod.rs:2502,2511` and adjust the `Option<&str>` call shapes.)

- [x] **Step 4: Rollback-ordering flow test**

Append to `flow_tests.rs` - this is THE data-safety sequence test (what runs,
in order, and what never runs). The enumeration prefix scripts `submodules()`
(ls-files, two configs, status, probe pair):

```rust
// ---------------------------------------------------------------------------
// submodule auto-update - rollback sequencing (the tier-4 data-safety core)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn submodule_auto_update_pop_conflict_rolls_back_and_reapplies() {
    let rec = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; // recorded (new)
    let old = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"; // checked out (old)
    let stash = "cccccccccccccccccccccccccccccccccccccccc";
    let fake = FakeExecutor::default();
    // -- submodules() enumeration --
    fake.expect(&["ls-files", "--stage", "-z"], ok(&format!("160000 {rec} 0\tlib\0")));
    fake.expect(
        &["config", "-f", ".gitmodules", "-z", "--get-regexp", "^submodule\\."],
        ok("submodule.lib.path\nlib\0submodule.lib.url\nu\0"),
    );
    fake.expect(&["config", "-z", "--get-regexp", "^submodule\\."], ok("submodule.lib.url\nu\0"));
    fake.expect(
        &["status", "--porcelain=v2", "-z", "--untracked-files=all"],
        // Pointer moved AND tracked modifications inside.
        ok("1 .M SCM. 160000 160000 160000 aaaaaaa bbbbbbb lib\0"),
    );
    fake.expect(&["-C", "lib", "rev-parse", "--show-prefix", "HEAD"], ok(&format!("\n{old}\n")));
    fake.expect(&["-C", "lib", "rev-parse", "--abbrev-ref", "HEAD"], ok("HEAD\n"));
    // -- auto-stash (tip-compare verified) --
    fake.expect(&["-C", "lib", "rev-parse", "-q", "--verify", "refs/stash"], fail(1, ""));
    fake.expect(
        &["-C", "lib", "stash", "push", "--include-untracked", "-m", "legit: auto-stash before submodule update"],
        ok("Saved"),
    );
    fake.expect(&["-C", "lib", "rev-parse", "-q", "--verify", "refs/stash"], ok(&format!("{stash}\n")));
    // -- update to recorded, pop by SHA-resolved selector: CONFLICT --
    fake.expect(&["submodule", "update", "--", "lib"], ok(""));
    fake.expect(&["-C", "lib", "stash", "list", "--format=%H %gd"], ok(&format!("{stash} stash@{{0}}\n")));
    fake.expect(&["-C", "lib", "stash", "pop", "stash@{0}"], fail(1, "CONFLICT (content): merge conflict"));
    // -- ROLLBACK: hard-reset to old (stash survived the pop), pop cleanly --
    fake.expect(&["-C", "lib", "reset", "--hard", old], ok(""));
    fake.expect(&["-C", "lib", "stash", "list", "--format=%H %gd"], ok(&format!("{stash} stash@{{0}}\n")));
    fake.expect(&["-C", "lib", "stash", "pop", "stash@{0}"], ok("Dropped"));
    let (b, exec) = backend(fake);

    let results = b.submodule_auto_update(SwitchDirtyBehavior::AutoStash).await.unwrap();
    assert_eq!(results.len(), 1);
    assert!(
        matches!(results[0].status, SubmoduleAutoUpdateStatus::RolledBack { .. }),
        "{results:?}"
    );
    // assert_done: no bare `stash pop`, no second update, nothing after the
    // clean reapply.
    exec.assert_done();
}
```

(Add `SubmoduleAutoUpdateStatus` to the flow tests' reachable imports via
`use super::*` - it is re-exported through `crate::types` in `mod.rs`'s
import; extend that import if the compiler asks.)

- [x] **Step 5: Run to verify failure, implement, run to green**

Run: `cargo test -p legit-core --lib submodule_auto_update_pop 2>&1 | tail -3` -> COMPILE ERROR first, then PASS after Steps 1-3 are in.

- [x] **Step 6: Real-git behavior tests**

Append to `tests/git_flows.rs` (add `SubmoduleAutoUpdateStatus` to the `use legit_core::{...}` list). Shared setup helper + four tests:

```rust
/// Fixture: superproject records a NEW submodule commit (touching lib.txt)
/// while the submodule is checked out at the OLD one. Returns (sup, old, new).
async fn submodule_pointer_ahead() -> (TestRepo, String, String) {
    let (sup, _lib) = repo_with_submodule().await;
    let sub_path = sup.path.join("lib").to_string_lossy().into_owned();
    let old = sup.git(&["-C", &sub_path, "rev-parse", "HEAD"]).await.trim().to_string();
    // New submodule commit that CHANGES lib.txt (so a conflicting local edit
    // is possible), recorded in the superproject.
    sup.write("lib/lib.txt", "upstream v2\n");
    sup.git(&["-C", &sub_path, "commit", "-am", "v2"]).await;
    let new = sup.git(&["-C", &sub_path, "rev-parse", "HEAD"]).await.trim().to_string();
    sup.git(&["add", "lib"]).await;
    sup.git(&["commit", "-m", "bump lib"]).await;
    // Submodule back at the old commit: pointer_moved, like right after a
    // superproject pull/switch.
    sup.git(&["-C", &sub_path, "checkout", &old]).await;
    (sup, old, new)
}

#[tokio::test]
async fn auto_update_moves_clean_submodules() {
    let (sup, _old, new) = submodule_pointer_ahead().await;
    let results = sup.backend.submodule_auto_update(SwitchDirtyBehavior::AutoStash).await.unwrap();
    assert_eq!(results.len(), 1);
    assert!(matches!(results[0].status, SubmoduleAutoUpdateStatus::Updated), "{results:?}");
    let sub_path = sup.path.join("lib").to_string_lossy().into_owned();
    let head = sup.git(&["-C", &sub_path, "rev-parse", "HEAD"]).await.trim().to_string();
    assert_eq!(head, new);
}

#[tokio::test]
async fn auto_update_carries_nonconflicting_changes_with_autostash() {
    let (sup, _old, new) = submodule_pointer_ahead().await;
    // Untracked file: never conflicts with the pointer move.
    sup.write("lib/notes.txt", "wip\n");
    let results = sup.backend.submodule_auto_update(SwitchDirtyBehavior::AutoStash).await.unwrap();
    assert!(matches!(results[0].status, SubmoduleAutoUpdateStatus::ChangesCarried), "{results:?}");
    let sub_path = sup.path.join("lib").to_string_lossy().into_owned();
    let head = sup.git(&["-C", &sub_path, "rev-parse", "HEAD"]).await.trim().to_string();
    assert_eq!(head, new);
    assert_eq!(sup.read("lib/notes.txt"), "wip\n", "changes carried to the new commit");
    let stashes = sup.git(&["-C", &sub_path, "stash", "list"]).await;
    assert!(stashes.trim().is_empty(), "clean pop must drop the auto-stash: {stashes}");
}

#[tokio::test]
async fn auto_update_pop_conflict_rolls_back_with_changes_intact() {
    let (sup, old, _new) = submodule_pointer_ahead().await;
    // Local edit to the SAME file the new commit changes: the pop conflicts.
    sup.write("lib/lib.txt", "local work\n");
    let results = sup.backend.submodule_auto_update(SwitchDirtyBehavior::AutoStash).await.unwrap();
    assert!(matches!(results[0].status, SubmoduleAutoUpdateStatus::RolledBack { .. }), "{results:?}");
    let sub_path = sup.path.join("lib").to_string_lossy().into_owned();
    let head = sup.git(&["-C", &sub_path, "rev-parse", "HEAD"]).await.trim().to_string();
    assert_eq!(head, old, "rolled back to the previous commit");
    assert_eq!(sup.read("lib/lib.txt"), "local work\n", "changes intact, no conflict markers");
    let stashes = sup.git(&["-C", &sub_path, "stash", "list"]).await;
    assert!(stashes.trim().is_empty(), "reapply on the original base must pop cleanly: {stashes}");
}

#[tokio::test]
async fn auto_update_stash_and_keep_parks_changes() {
    let (sup, _old, new) = submodule_pointer_ahead().await;
    sup.write("lib/lib.txt", "local work\n");
    let results = sup.backend.submodule_auto_update(SwitchDirtyBehavior::StashAndKeep).await.unwrap();
    assert!(matches!(results[0].status, SubmoduleAutoUpdateStatus::ChangesStashed), "{results:?}");
    let sub_path = sup.path.join("lib").to_string_lossy().into_owned();
    let head = sup.git(&["-C", &sub_path, "rev-parse", "HEAD"]).await.trim().to_string();
    assert_eq!(head, new);
    let stashes = sup.git(&["-C", &sub_path, "stash", "list"]).await;
    assert!(!stashes.trim().is_empty(), "changes parked in the submodule stash");
}
```

- [x] **Step 7: Run them**

Run: `cargo test -p legit-core --test git_flows auto_update 2>&1 | tail -3`
Expected: PASS (4 tests). The pop-conflict test is the spec's headline guarantee - if it fails, STOP and fix the algorithm, never the assertion.

---

### Task 2: Auto-update IPC + per-repo setting + frontend hook-in

**Files:**
- Modify: `src-tauri/src/state.rs:344-361` (`RepoSettings` field)
- Modify: `src-tauri/src/commands/submodules.rs` (+ `src-tauri/src/lib.rs` registration)
- Modify: `src/lib/types.ts` (RepoSettings mirror + outcome types)
- Modify: `src/lib/commands.ts` (wrapper)
- Modify: `src/lib/submodules.ts` (result -> notifications helper)
- Modify: `src/panels/Branches/BranchesPanel.tsx:183` area, `src/panels/Commits/CommitsPanel.tsx:379,1721` areas (post-switch/pull hook)
- Modify: the Repo Settings panel (find it: `grep -rln "warn_on_mixed_endings" src/panels` - add the checkbox next to that override)

- [x] **Step 1: RepoSettings field**

In `state.rs` `RepoSettings`:

```rust
    /// Auto-update submodule pointers after switch/pull (None = default ON).
    #[serde(default)]
    pub submodule_auto_update: Option<bool>,
```

- [x] **Step 2: Command**

In `commands/submodules.rs` (import `SubmoduleAutoUpdateResult` and `legit_core::SwitchDirtyBehavior`):

```rust
/// Post-switch/pull submodule auto-update. Gated on the per-repo setting
/// (default ON); dirty submodules follow the GLOBAL switch strategy. Returns
/// per-submodule outcomes (partial success is data, not an error).
#[tauri::command]
#[specta::specta]
pub async fn repo_submodule_auto_update(
    state: tauri::State<'_, AppState>,
    repo_id: String,
) -> Result<Vec<SubmoduleAutoUpdateResult>, AppError> {
    let session = state.get_session(&repo_id).await?;
    let enabled = session.settings.read().await.submodule_auto_update.unwrap_or(true);
    if !enabled {
        return Ok(Vec::new());
    }
    let behavior = state
        .global_settings
        .read()
        .await
        .switch_dirty_behavior
        .unwrap_or_default();
    session
        .backend
        .submodule_auto_update(behavior)
        .await
        .map_err(AppError::Git)
}
```

Register `commands::repo_submodule_auto_update,` in `lib.rs`. Run `cargo check -p legit-app` -> clean.

- [x] **Step 3: TS mirrors + wrapper + notifier**

`types.ts`: add `submodule_auto_update?: boolean | null;` to the `RepoSettings` interface, plus:

```ts
export type SubmoduleAutoUpdateStatus =
  | { kind: "updated" }
  | { kind: "changes_carried" }
  | { kind: "changes_stashed" }
  | { kind: "rolled_back"; message: string }
  | { kind: "changes_in_stash"; message: string }
  | { kind: "skipped"; message: string };

export interface SubmoduleAutoUpdateResult {
  path: string;
  status: SubmoduleAutoUpdateStatus;
}
```

`commands.ts`:

```ts
export const repoSubmoduleAutoUpdate = (repoId: string) =>
  invoke<SubmoduleAutoUpdateResult[]>("repo_submodule_auto_update", { repoId });
```

`src/lib/submodules.ts` - the shared post-switch/pull hook (import `notify`, `repoSubmoduleAutoUpdate`, `invalidateRepoDomains`, `QueryClient` type):

```ts
/** Run the post-switch/pull submodule auto-update and surface the outcomes.
 * Fire-and-forget: failures here must never break the primary operation. */
export async function autoUpdateSubmodules(qc: QueryClient, repoId: string) {
  try {
    const results = await repoSubmoduleAutoUpdate(repoId);
    if (results.length > 0) {
      invalidateRepoDomains(qc, repoId, ["submodules", "status", "log"]);
    }
    for (const r of results) {
      const s = r.status;
      if (s.kind === "rolled_back") {
        notify.error(`Submodule ${r.path}: ${s.message}`);
      } else if (s.kind === "changes_in_stash") {
        notify.error(`Submodule ${r.path}: ${s.message}`);
      } else if (s.kind === "skipped") {
        notify.error(`Submodule ${r.path} not updated: ${s.message}`);
      } else if (s.kind === "changes_stashed") {
        notify.success(`Submodule ${r.path} updated - changes parked in its stash`);
      }
      // updated / changes_carried: silent success (no toast spam).
    }
  } catch (e) {
    console.warn("submodule auto-update failed", e);
  }
}
```

- [x] **Step 4: Hook the call sites**

After each successful superproject switch/pull, fire-and-forget the helper.
`BranchesPanel.tsx` (~line 183) and `CommitsPanel.tsx` (~line 379): after the
`repoSwitchBranch` outcome is obtained (and NOT on throw), add
`void autoUpdateSubmodules(queryClient, repo.id);` (both components already
have a `queryClient` from `useQueryClient()` - verify and reuse; import the
helper). `CommitsPanel.tsx` pull (~line 1721): `runSync`'s success path -
chain it: `runSync("pull", (opId) => repoPull(repoId, { strategy: pullStrategy }, opId).then((r) => { void autoUpdateSubmodules(queryClient, repoId); return r; }), "Pulled")`.
(Adapt to `runSync`'s actual contract - the requirement is: auto-update runs
only after a successful pull, without delaying the "Pulled" toast.)

- [x] **Step 5: Repo Settings checkbox**

Locate the repo settings panel (`grep -rln "warn_on_mixed_endings" src/panels`). Add next to the existing per-repo overrides, following that panel's exact update pattern (it calls `update_repo_settings` with the whole `RepoSettings` object via the settings store):

```tsx
<label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "var(--fz-md)" }}>
  <input
    type="checkbox"
    checked={repoSettings?.submodule_auto_update ?? true}
    onChange={(e) => saveRepoSettings({ ...repoSettings!, submodule_auto_update: e.target.checked })}
  />
  Auto-update submodules after switch/pull
</label>
```

(Match the panel's real state/handler names; the semantic requirement is: default checked, persists via `update_repo_settings`.)

- [x] **Step 6: Verify**

Run: `npx tsc --noEmit` -> clean. `cargo check -p legit-app` -> clean.

---

### Task 3: Push guard backend (`--recurse-submodules` + classified error)

**Files:**
- Modify: `crates/legit-core/src/types.rs` (`PushRecurseMode` + `PushOptions` field)
- Modify: `crates/legit-core/src/error.rs` (`UnpushedSubmodules` variant)
- Modify: `crates/legit-core/src/cli_impl/mod.rs` (`build_push_args`, `classify_remote_error`, unit tests in the module's `tests`)
- Modify: `crates/legit-core/tests/git_flows.rs` (real-git guard test)

**Interfaces:**
- Produces: `PushRecurseMode` = `Check` | `OnDemand` (serde snake_case); `PushOptions.recurse_submodules: Option<PushRecurseMode>` (`#[serde(default)]`, `None` = no flag); `GitError::UnpushedSubmodules { stderr: String }` (frontend sees `kind: "UnpushedSubmodules"` via `gitErrorKind`).

- [x] **Step 1: Failing unit tests**

In `cli_impl/mod.rs`'s `#[cfg(test)] mod tests` (where `stash_created_*` live):

```rust
    #[test]
    fn push_args_carry_recurse_submodules_mode() {
        let mut opts = PushOptions {
            remote: "origin".into(),
            branch: "main".into(),
            set_upstream: false,
            force_with_lease: false,
            recurse_submodules: Some(PushRecurseMode::Check),
        };
        assert!(build_push_args(&opts).contains(&"--recurse-submodules=check".to_string()));
        opts.recurse_submodules = Some(PushRecurseMode::OnDemand);
        assert!(build_push_args(&opts).contains(&"--recurse-submodules=on-demand".to_string()));
        opts.recurse_submodules = None;
        assert!(!build_push_args(&opts).iter().any(|a| a.starts_with("--recurse-submodules")));
    }

    #[test]
    fn classify_detects_unpushed_submodules() {
        // git's advice text for --recurse-submodules=check (exit 128).
        let stderr = "The following submodule paths contain changes that can\nnot be found on any remote:\n  lib\n";
        assert!(matches!(
            classify_remote_error(128, stderr),
            GitError::UnpushedSubmodules { .. }
        ));
    }
```

- [x] **Step 2: Implement**

`types.rs` (next to `PushOptions`):

```rust
/// `git push --recurse-submodules` mode - the pre-push guard against
/// publishing a superproject that references unpushed submodule commits.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum PushRecurseMode {
    /// Abort the push when referenced submodule commits are on no remote.
    Check,
    /// Push the needed submodule branches first, then the superproject.
    OnDemand,
}
```

Add to `PushOptions`:

```rust
    /// Submodule guard (`--recurse-submodules=check|on-demand`); `None` = no
    /// flag (git default / user config).
    #[serde(default)]
    pub recurse_submodules: Option<PushRecurseMode>,
```

`error.rs` (next to `PushRejected`):

```rust
    #[error("push blocked: the superproject references submodule commits that exist on no remote:\n{stderr}")]
    UnpushedSubmodules { stderr: String },
```

`build_push_args` (after `--progress`):

```rust
    if let Some(mode) = opts.recurse_submodules {
        args.push(match mode {
            PushRecurseMode::Check => "--recurse-submodules=check".into(),
            PushRecurseMode::OnDemand => "--recurse-submodules=on-demand".into(),
        });
    }
```

`classify_remote_error` (BEFORE the `REJECTED` check - the same stderr can
contain overlapping phrases):

```rust
    // `push --recurse-submodules=check|on-demand` refusing to publish a
    // superproject whose gitlinks reference commits on no submodule remote.
    if lc.contains("submodule paths contain changes") || lc.contains("process for submodule") {
        return GitError::UnpushedSubmodules { stderr: stderr.trim().to_string() };
    }
```

Fix every existing `PushOptions { ... }` construction site (tests, flow tests, git_flows) by adding `recurse_submodules: None,` - `cargo test -p legit-core 2>&1 | grep error` lists them.

- [x] **Step 3: Real-git guard test**

Append to `tests/git_flows.rs` (uses the existing `bare_remote()` helper - check its exact return shape at ~line 1330; add `PushRecurseMode` to imports):

```rust
#[tokio::test]
async fn push_recurse_check_blocks_unpushed_submodule_commits() {
    let (sup, _lib) = repo_with_submodule().await;
    let sub_path = sup.path.join("lib").to_string_lossy().into_owned();
    let (_dir, _remote_path, url) = bare_remote().await;
    sup.git(&["remote", "add", "origin", &url]).await;

    // Bump the submodule locally (NOT pushed to the lib origin) and record it.
    sup.git(&["-C", &sub_path, "commit", "--allow-empty", "-m", "unpushed bump"]).await;
    sup.git(&["add", "lib"]).await;
    sup.git(&["commit", "-m", "bump lib"]).await;

    let opts = PushOptions {
        remote: "origin".into(),
        branch: "main".into(),
        set_upstream: true,
        force_with_lease: false,
        recurse_submodules: Some(PushRecurseMode::Check),
    };
    let err = sup
        .backend
        .push(opts.clone(), OperationId("t1".into()))
        .await
        .unwrap_err();
    assert!(
        matches!(err, legit_core::GitError::UnpushedSubmodules { .. }),
        "{err:?}"
    );

    // Publish the submodule commit (to a non-checked-out ref on its origin),
    // then the guarded push passes.
    sup.git(&["-C", &sub_path, "push", "origin", "HEAD:refs/heads/published"]).await;
    sup.backend.push(opts, OperationId("t2".into())).await.unwrap();
}
```

- [x] **Step 4: Run**

Run: `cargo test -p legit-core 2>&1 | grep "test result"` -> all green (unit + flow + real-git).

---

### Task 4: Push guard setting + UI wiring

**Files:**
- Modify: `src-tauri/src/state.rs` (`GlobalSettings.push_recurse_submodules`), `src-tauri/src/commands/persistence.rs` (save command, `save_pull_strategy` pattern at :309), `src-tauri/src/lib.rs` (register)
- Modify: `src/lib/types.ts` (`GlobalSettings` mirror + `PushOptions` mirror + `PushRecurseMode`), `src/lib/commands.ts` (save wrapper), `src/store/settings.ts` (setter, `save_pull_strategy` pattern at :237)
- Modify: `src/panels/Settings/GlobalSettingsPanel.tsx` (select next to the pull-strategy control)
- Modify: `src/panels/Commits/CommitsPanel.tsx:1727-1732` (pass the mode into `PushOptions`; special-case the error kind)

- [x] **Step 1: Backend setting**

`state.rs` `GlobalSettings`: `#[serde(default)] pub push_recurse_submodules: Option<legit_core::PushRecurseMode>,` (+ `None` in the `Default` impl if one is hand-written - check ~line 297). `persistence.rs`:

```rust
#[tauri::command]
#[specta::specta]
pub async fn save_push_recurse_submodules(
    state: tauri::State<'_, AppState>,
    mode: Option<legit_core::PushRecurseMode>,
) -> Result<(), AppError> {
    {
        let mut s = state.global_settings.write().await;
        s.push_recurse_submodules = mode;
    }
    state.persist_global_settings().await
}
```

Register in `lib.rs` next to `commands::save_pull_strategy,`. `cargo check -p legit-app` -> clean.

- [x] **Step 2: Frontend plumbing**

`types.ts`: `export type PushRecurseMode = "check" | "on_demand";` (the TS union mirrors serde's snake_case of `OnDemand`; the CLI flag spelling `on-demand` is mapped backend-side). Add `push_recurse_submodules?: PushRecurseMode | null;` to `GlobalSettings` and `recurse_submodules?: PushRecurseMode | null;` to the `PushOptions` interface. `commands.ts`: `export const savePushRecurseSubmodules = (mode: PushRecurseMode | null) => invoke<void>("save_push_recurse_submodules", { mode });` `store/settings.ts`: a `setPushRecurseSubmodules` action following `save_pull_strategy`'s optimistic-update pattern (:231-238).

`GlobalSettingsPanel.tsx` - next to the pull-strategy select, same markup style:

```tsx
<select
  value={settings?.push_recurse_submodules ?? ""}
  onChange={(e) => setPushRecurseSubmodules((e.target.value || null) as PushRecurseMode | null)}
>
  <option value="">off</option>
  <option value="check">check - block pushes referencing unpushed submodule commits</option>
  <option value="on_demand">on-demand - push needed submodule branches first</option>
</select>
```

`CommitsPanel.tsx` push opts (~1727): add `recurse_submodules: settingsPushRecurse ?? null,` (read from the settings store like `pullStrategy` is). In the push error path (wherever `runSync` surfaces the error - follow how `PushRejected` is displayed), special-case `gitErrorKind(e) === "UnpushedSubmodules"` to a clear message: "Push blocked: a submodule has commits that exist on no remote - push inside the submodule first (or use the on-demand mode)." with the git stderr below.

- [x] **Step 3: Verify**

Run: `npx tsc --noEmit` + `cargo check -p legit-app` -> clean.

---

### Task 5: Branch-here + drift Repair

**Files:**
- Modify: `crates/legit-core/src/backend.rs` + `cli_impl/mod.rs` + `flow_tests.rs` (`submodule_create_branch`)
- Modify: `src-tauri/src/commands/submodules.rs` + `src-tauri/src/lib.rs` (command)
- Modify: `src/lib/commands.ts` (wrapper)
- Modify: `src/panels/Submodules/SubmoduleRow.tsx` (Branch-here inline input when detached; Repair button when drifted)
- Modify: `src/panels/Submodules/SubmodulesSection.tsx` (wire the handler)

- [x] **Step 1: Backend method (flow test first)**

Flow test:

```rust
#[tokio::test]
async fn submodule_create_branch_switches_with_c() {
    let fake = FakeExecutor::default();
    fake.expect(&["-C", "lib", "switch", "-c", "fix/detached"], ok(""));
    let (b, exec) = backend(fake);
    b.submodule_create_branch(Path::new("lib"), "fix/detached").await.unwrap();
    exec.assert_done();
}
```

Trait + impl:

```rust
    /// Create and switch to a branch at the submodule's current (typically
    /// detached) HEAD - the one-click escape from detached-HEAD work loss.
    async fn submodule_create_branch(&self, path: &Path, name: &str) -> Result<(), GitError>;
```

```rust
    async fn submodule_create_branch(&self, path: &Path, name: &str) -> Result<(), GitError> {
        let p = path.to_string_lossy().into_owned();
        self.run_simple(&["-C", &p, "switch", "-c", name]).await
    }
```

Command `repo_submodule_create_branch(repo_id, path, name)` (same shape as `repo_submodule_set_branch`), register, wrapper `repoSubmoduleCreateBranch(repoId, path, name)`.

- [x] **Step 2: Row UI**

`SubmoduleRow.tsx`: new prop `onCreateBranch: (name: string) => void`; extend `editing` union with `"new-branch"`; a "Branch here" `ToolbarButton` shown when `info.state.populated && info.head_branch === null` toggles it; the inline input:

```tsx
{editing === "new-branch" && (
  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
    <span className="legit-subtle" style={{ fontSize: "var(--fz-sm)", flexShrink: 0 }}>
      New branch
    </span>
    <InlineRenameInput
      initialValue=""
      placeholder="branch name at the current commit"
      disabled={busy}
      onSave={(v) => { setEditing(null); if (v.trim()) onCreateBranch(v.trim()); }}
      onCancel={() => setEditing(null)}
      style={{ fontSize: "var(--fz-sm)", flex: 1 }}
      title="Create a branch at the submodule's detached HEAD so commits cannot be lost"
    />
  </div>
)}
```

Repair: shown when `info.state.config_drift`:

```tsx
{info.state.config_drift && (
  <ToolbarButton
    label="Repair"
    title="URL in .gitmodules and local config disagree - re-sync the registration (git submodule sync)"
    disabled={busy}
    onClick={onSync}
  />
)}
```

`SubmodulesSection.tsx`: pass `onCreateBranch={(name) => run(() => repoSubmoduleCreateBranch(repo.id, s.path, name))}`.

- [x] **Step 3: Verify**

Run: `cargo test -p legit-core --lib submodule_create_branch` -> PASS; `npx tsc --noEmit` -> clean.

---

### Task 6: Full verification

- [x] **Step 1:** `cargo test -p legit-core 2>&1 | grep "test result"` + `cargo test -p legit-app --lib 2>&1 | grep "test result"` -> all green.
- [x] **Step 2:** `npx tsc --noEmit` -> clean.
- [x] **Step 3: PowerShell handoff**: `npm test`; `npm run tauri dev` - switch a superproject branch with (a) clean, (b) dirty-nonconflicting, (c) dirty-conflicting submodule changes and watch the three outcomes (silent update / silent carry / rollback toast); flip the per-repo setting off and confirm nothing moves; enable push guard "check" and push a superproject with an unpushed submodule bump (clear blocked message), then "on-demand" (submodule pushed first); "Branch here" on a detached submodule; Repair on a drifted URL.
