# Submodule Branch Attach Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Do NOT use subagent-driven-development (user rule).

**Goal:** Opt-in global setting: after every LeGit-driven submodule update, attach a detached submodule HEAD to the branch already pointing at the checked-out commit (configured branch first, else a unique local match).

**Architecture:** A pure decision function (`choose_attach_branch`) plus a best-effort backend helper (`attach_submodule_branch`) called after successful moves in the three submodule-update flows of `GitCliBackend`. The flag travels via `SubmoduleUpdateOptions.attach_branch` and new `attach_branch: bool` params; the Tauri commands fill it from the new `GlobalSettings.submodule_attach_branch`. Spec: `design/2026-07-23-submodule-branch-attach.md`.

**Tech Stack:** Rust (legit-core + src-tauri), React/TypeScript (settings panel), FakeExecutor flow tests, real-git integration tests.

## Global Constraints

- **NEVER commit or push.** Leave all changes unstaged for Simon to review. This overrides the usual per-task commit steps: there are none in this plan.
- **No em-dashes (—) anywhere**: prose, comments, UI copy, docs. Use a hyphen, colon, or parentheses.
- Every new user-visible colour must come from a theme token; this plan adds none (reuse existing settings-panel markup patterns only).
- Rust verification runs from WSL: `cargo test -p legit-core`, `cargo check --workspace`. Frontend type-check: `npx tsc --noEmit` from `<repo>`. Do not run `npm install` from WSL.
- specta regenerates `src/lib/bindings.ts` only when the app runs; the frontend uses hand-written wrappers (`src/lib/commands.ts`) and hand-mirrored types (`src/lib/types.ts`). Add new commands/fields in both places by hand.
- Attach failures are logged with `tracing::warn!` and never turn a successful update into an error.

---

### Task 1: `choose_attach_branch` pure function

**Files:**
- Modify: `crates/legit-core/src/cli_impl/mod.rs` (function next to `find_created_stash`, ~line 3121; tests in the existing `#[cfg(test)]` module, next to the `find_created_stash_*` tests ~line 3561)

**Interfaces:**
- Produces: `fn choose_attach_branch(configured: Option<&str>, matching: &[String]) -> Option<String>` (private to `cli_impl`), used by Task 3.

- [ ] **Step 1: Write the failing tests**

Add to the `#[cfg(test)]` module in `crates/legit-core/src/cli_impl/mod.rs`, next to the `find_created_stash_*` tests:

```rust
#[test]
fn choose_attach_branch_configured_match_wins() {
    let matching = vec!["dev".to_string(), "main".to_string()];
    assert_eq!(
        choose_attach_branch(Some("main"), &matching),
        Some("main".to_string())
    );
}

#[test]
fn choose_attach_branch_unique_match_attaches() {
    let matching = vec!["feature".to_string()];
    assert_eq!(choose_attach_branch(None, &matching), Some("feature".to_string()));
    // Configured branch NOT at this commit: the unique rule still applies.
    assert_eq!(
        choose_attach_branch(Some("main"), &matching),
        Some("feature".to_string())
    );
}

#[test]
fn choose_attach_branch_ambiguous_stays_detached() {
    let matching = vec!["a".to_string(), "b".to_string()];
    assert_eq!(choose_attach_branch(None, &matching), None);
}

#[test]
fn choose_attach_branch_no_candidates_stays_detached() {
    assert_eq!(choose_attach_branch(Some("main"), &[]), None);
    assert_eq!(choose_attach_branch(None, &[]), None);
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p legit-core choose_attach_branch`
Expected: compile error, `cannot find function choose_attach_branch`

- [ ] **Step 3: Implement the function**

Add near `find_created_stash` (file scope, not inside the impl block):

```rust
/// Pick the branch to attach a submodule's detached HEAD to, given the
/// configured `.gitmodules` branch (if any) and the local branches whose
/// tips equal the checked-out commit (`for-each-ref --points-at HEAD`).
/// The configured branch wins when it matches; otherwise only an
/// unambiguous single candidate attaches - 2+ candidates stay detached.
fn choose_attach_branch(configured: Option<&str>, matching: &[String]) -> Option<String> {
    if let Some(c) = configured {
        if matching.iter().any(|b| b == c) {
            return Some(c.to_string());
        }
    }
    match matching {
        [only] => Some(only.clone()),
        _ => None,
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p legit-core choose_attach_branch`
Expected: 4 passed

---

### Task 2: Global setting + persistence command

**Files:**
- Modify: `src-tauri/src/state.rs` (`GlobalSettings` struct ~line 179, its `Default` impl ~line 318)
- Modify: `src-tauri/src/commands/persistence.rs` (new command next to `set_confirm_discard`, ~line 169)
- Modify: `src-tauri/src/lib.rs` (`collect_commands!` list, near `commands::set_confirm_discard` ~line 108)

**Interfaces:**
- Produces: `GlobalSettings.submodule_attach_branch: bool` (read by Tasks 3 and 4) and Tauri command `set_submodule_attach_branch(enabled: bool)` (called by Task 6).

- [ ] **Step 1: Add the settings field**

In `GlobalSettings` (after `push_recurse_submodules`):

```rust
/// After LeGit-driven submodule updates, attach a detached submodule HEAD
/// to a branch pointing at the same commit (configured branch first, else
/// a unique local match). Opt-in; see
/// design/2026-07-23-submodule-branch-attach.md.
#[serde(default)]
pub submodule_attach_branch: bool,
```

In `impl Default for GlobalSettings`, add in the same relative position:

```rust
submodule_attach_branch: false,
```

- [ ] **Step 2: Add the persistence command**

In `src-tauri/src/commands/persistence.rs`, after `set_confirm_discard`:

```rust
#[tauri::command]
#[specta::specta]
pub async fn set_submodule_attach_branch(
    state: tauri::State<'_, AppState>,
    enabled: bool,
) -> Result<(), AppError> {
    state.mutate_global(|s| {
        s.submodule_attach_branch = enabled;
    })
    .await
}
```

- [ ] **Step 3: Register the command**

In `src-tauri/src/lib.rs`, add to `collect_commands!` next to the other settings setters:

```rust
commands::set_submodule_attach_branch,
```

- [ ] **Step 4: Verify it compiles**

Run: `cargo check --workspace`
Expected: no errors (the new field/command are not consumed yet; that is fine)

---

### Task 3: Attach helper + wiring for `submodule_auto_update` and `submodule_update_remote`

**Files:**
- Modify: `crates/legit-core/src/types.rs` (`SubmoduleUpdateOptions`, ~line 897)
- Modify: `crates/legit-core/src/backend.rs` (trait signatures ~lines 231, 266)
- Modify: `crates/legit-core/src/cli_impl/mod.rs` (new helper near `move_submodule` ~line 478; `submodule_update_remote` ~line 1732; `submodule_auto_update` ~line 1847)
- Modify: `crates/legit-core/src/cli_impl/flow_tests.rs` (update 2 existing tests; add 3 new)
- Modify: `src-tauri/src/commands/submodules.rs` (`repo_submodule_update_remote` ~line 179, `repo_submodule_auto_update` ~line 246)

**Interfaces:**
- Consumes: `choose_attach_branch` (Task 1), `GlobalSettings.submodule_attach_branch` (Task 2).
- Produces:
  - `SubmoduleUpdateOptions.attach_branch: bool` field (`#[serde(default)]`) - consumed by Task 4.
  - `async fn attach_submodule_branch(&self, p: &str, configured: Option<&str>)` (private helper on `GitCliBackend`, returns `()`) - consumed by Task 4.
  - Trait: `submodule_update_remote(&self, paths, strategy, behavior, attach_branch: bool, op_id)` and `submodule_auto_update(&self, behavior, attach_branch: bool)`.

- [ ] **Step 1: Write the failing flow tests**

In `crates/legit-core/src/cli_impl/flow_tests.rs`, after `submodule_auto_update_pop_conflict_rolls_back_and_reapplies` (~line 1786):

```rust
#[tokio::test]
async fn submodule_auto_update_attach_checks_out_configured_branch() {
    let rec = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let old = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    let fake = FakeExecutor::default();
    // -- submodules() enumeration: pointer moved, clean, tracked branch main --
    fake.expect(&["ls-files", "--stage", "-z"], ok(&format!("160000 {rec} 0\tlib\0")));
    fake.expect(
        &["config", "-f", ".gitmodules", "-z", "--get-regexp", "^submodule\\."],
        ok("submodule.lib.path\nlib\0submodule.lib.url\nu\0submodule.lib.branch\nmain\0"),
    );
    fake.expect(&["config", "-z", "--get-regexp", "^submodule\\."], ok("submodule.lib.url\nu\0"));
    fake.expect(
        &["status", "--porcelain=v2", "-z", "--untracked-files=all"],
        ok("1 .M SC.. 160000 160000 160000 aaaaaaa bbbbbbb lib\0"),
    );
    fake.expect(&["-C", "lib", "rev-parse", "--show-prefix", "HEAD"], ok(&format!("\n{old}\n")));
    fake.expect(&["-C", "lib", "rev-parse", "--abbrev-ref", "HEAD"], ok("HEAD\n"));
    // -- clean move to the recorded SHA --
    fake.expect(&["submodule", "update", "--", "lib"], ok(""));
    // -- attach: detached (symbolic-ref exits 1), main points at HEAD --
    fake.expect(&["-C", "lib", "symbolic-ref", "-q", "--short", "HEAD"], fail(1, ""));
    fake.expect(
        &["-C", "lib", "for-each-ref", "refs/heads", "--points-at", "HEAD", "--format=%(refname:short)"],
        ok("main\n"),
    );
    fake.expect(&["-C", "lib", "checkout", "main"], ok("Switched to branch 'main'"));
    let (b, exec) = backend(fake);

    let results = b
        .submodule_auto_update(SwitchDirtyBehavior::TryDirectly, true)
        .await
        .unwrap();
    assert_eq!(results.len(), 1);
    assert!(matches!(results[0].status, SubmoduleAutoUpdateStatus::Updated), "{results:?}");
    exec.assert_done();
}

#[tokio::test]
async fn submodule_auto_update_attach_ambiguous_match_stays_detached() {
    let rec = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let old = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    let fake = FakeExecutor::default();
    // No submodule.lib.branch: nothing configured, so 2 matches = ambiguous.
    fake.expect(&["ls-files", "--stage", "-z"], ok(&format!("160000 {rec} 0\tlib\0")));
    fake.expect(
        &["config", "-f", ".gitmodules", "-z", "--get-regexp", "^submodule\\."],
        ok("submodule.lib.path\nlib\0submodule.lib.url\nu\0"),
    );
    fake.expect(&["config", "-z", "--get-regexp", "^submodule\\."], ok("submodule.lib.url\nu\0"));
    fake.expect(
        &["status", "--porcelain=v2", "-z", "--untracked-files=all"],
        ok("1 .M SC.. 160000 160000 160000 aaaaaaa bbbbbbb lib\0"),
    );
    fake.expect(&["-C", "lib", "rev-parse", "--show-prefix", "HEAD"], ok(&format!("\n{old}\n")));
    fake.expect(&["-C", "lib", "rev-parse", "--abbrev-ref", "HEAD"], ok("HEAD\n"));
    fake.expect(&["submodule", "update", "--", "lib"], ok(""));
    fake.expect(&["-C", "lib", "symbolic-ref", "-q", "--short", "HEAD"], fail(1, ""));
    fake.expect(
        &["-C", "lib", "for-each-ref", "refs/heads", "--points-at", "HEAD", "--format=%(refname:short)"],
        ok("release\nhotfix\n"),
    );
    // assert_done proves NO checkout ran.
    let (b, exec) = backend(fake);

    let results = b
        .submodule_auto_update(SwitchDirtyBehavior::TryDirectly, true)
        .await
        .unwrap();
    assert!(matches!(results[0].status, SubmoduleAutoUpdateStatus::Updated), "{results:?}");
    exec.assert_done();
}

#[tokio::test]
async fn submodule_update_remote_attach_skips_attached_and_survives_checkout_failure() {
    let sha_a = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let fake = FakeExecutor::default();
    // Two submodules: `lib` stays on its branch after --rebase (attach probe
    // succeeds, nothing further); `vendor` is detached and its checkout FAILS
    // (the status must still be Updated - attach is best-effort).
    fake.expect(
        &["ls-files", "--stage", "-z"],
        ok(&format!("160000 {sha_a} 0\tlib\0160000 {sha_a} 0\tvendor\0")),
    );
    fake.expect(
        &["config", "-f", ".gitmodules", "-z", "--get-regexp", "^submodule\\."],
        ok("submodule.lib.path\nlib\0submodule.lib.url\nu\0submodule.vendor.path\nvendor\0submodule.vendor.url\nv\0"),
    );
    fake.expect(
        &["config", "-z", "--get-regexp", "^submodule\\."],
        ok("submodule.lib.url\nu\0submodule.vendor.url\nv\0"),
    );
    fake.expect(&["status", "--porcelain=v2", "-z", "--untracked-files=all"], ok(""));
    fake.expect(&["-C", "lib", "rev-parse", "--show-prefix", "HEAD"], ok(&format!("\n{sha_a}\n")));
    fake.expect(&["-C", "lib", "rev-parse", "--abbrev-ref", "HEAD"], ok("main\n"));
    fake.expect(&["-C", "vendor", "rev-parse", "--show-prefix", "HEAD"], ok(&format!("\n{sha_a}\n")));
    fake.expect(&["-C", "vendor", "rev-parse", "--abbrev-ref", "HEAD"], ok("HEAD\n"));
    // -- lib: rebase onto the tracked branch, still attached afterwards --
    fake.expect(&["submodule", "update", "--remote", "--rebase", "--", "lib"], ok(""));
    fake.expect(&["-C", "lib", "symbolic-ref", "-q", "--short", "HEAD"], ok("main\n"));
    // -- vendor: detached; unique match; checkout fails --
    fake.expect(&["submodule", "update", "--remote", "--rebase", "--", "vendor"], ok(""));
    fake.expect(&["-C", "vendor", "symbolic-ref", "-q", "--short", "HEAD"], fail(1, ""));
    fake.expect(
        &["-C", "vendor", "for-each-ref", "refs/heads", "--points-at", "HEAD", "--format=%(refname:short)"],
        ok("main\n"),
    );
    fake.expect(
        &["-C", "vendor", "checkout", "main"],
        fail(1, "fatal: 'main' is already used by worktree"),
    );
    // -- both moved: stage both pointers --
    fake.expect(&["add", "--", "lib", "vendor"], ok(""));
    let (b, exec) = backend(fake);

    let results = b
        .submodule_update_remote(
            &[],
            SubmoduleUpdateStrategy::Rebase,
            SwitchDirtyBehavior::AutoStash,
            true,
            OperationId("a".into()),
        )
        .await
        .unwrap();
    assert_eq!(results.len(), 2);
    assert!(matches!(results[0].status, SubmoduleAutoUpdateStatus::Updated), "{results:?}");
    assert!(matches!(results[1].status, SubmoduleAutoUpdateStatus::Updated), "{results:?}");
    exec.assert_done();
}
```

Update the two existing call sites in `flow_tests.rs` for the new signatures:
- `submodule_update_remote_integrates_then_stages_pointers` (~line 1680): add `false,` between `SwitchDirtyBehavior::AutoStash,` and `OperationId("a".into()),`.
- `submodule_auto_update_pop_conflict_rolls_back_and_reapplies` (~line 1777): `b.submodule_auto_update(SwitchDirtyBehavior::AutoStash, false)`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p legit-core --lib flow_tests`
Expected: compile errors (wrong arity for `submodule_auto_update` / `submodule_update_remote`)

- [ ] **Step 3: Add the options field**

In `crates/legit-core/src/types.rs`, extend `SubmoduleUpdateOptions`:

```rust
/// Options for `submodule update`. Empty `paths` = all submodules.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type, Default)]
pub struct SubmoduleUpdateOptions {
    /// Also register new submodules (`--init`).
    pub init: bool,
    /// Recurse into nested submodules (`--recursive`).
    pub recursive: bool,
    pub paths: Vec<PathBuf>,
    /// After the update, attach detached submodule HEADs to a branch pointing
    /// at the same commit (top-level submodules only). Filled backend-side
    /// from the global setting; the frontend never sets it.
    #[serde(default)]
    pub attach_branch: bool,
}
```

- [ ] **Step 4: Update the trait signatures**

In `crates/legit-core/src/backend.rs`:

`submodule_update_remote` (~line 231) gains `attach_branch: bool` before `op_id`:

```rust
    async fn submodule_update_remote(
        &self,
        paths: &[PathBuf],
        strategy: SubmoduleUpdateStrategy,
        behavior: SwitchDirtyBehavior,
        attach_branch: bool,
        op_id: OperationId,
    ) -> Result<Vec<SubmoduleAutoUpdateResult>, GitError>;
```

`submodule_auto_update` (~line 266):

```rust
    async fn submodule_auto_update(
        &self,
        behavior: SwitchDirtyBehavior,
        attach_branch: bool,
    ) -> Result<Vec<SubmoduleAutoUpdateResult>, GitError>;
```

Extend each method's doc comment with one line: `/// With attach_branch, detached HEADs re-attach to a branch at the same commit (best-effort).`

- [ ] **Step 5: Implement the attach helper**

In `crates/legit-core/src/cli_impl/mod.rs`, next to `move_submodule` (~line 478), inside the same impl block:

```rust
    /// Best-effort: attach submodule `p`'s detached HEAD to a branch whose
    /// tip is exactly the current commit (configured branch first, else a
    /// unique local match - `choose_attach_branch`). The checkout is a
    /// content no-op (tip == HEAD), so this can never touch the worktree.
    /// Never fails the surrounding update: the update is already complete
    /// and a failed attach only leaves the correct detached state, so every
    /// error path is a warn + return.
    async fn attach_submodule_branch(&self, p: &str, configured: Option<&str>) {
        let runner = self.runner().await;
        // Attached already (e.g. `--remote --merge` on a branch): done.
        // Detached HEAD makes symbolic-ref exit 1 - expected, not a failure.
        match runner
            .run_expecting(&["-C", p, "symbolic-ref", "-q", "--short", "HEAD"], &[1])
            .await
        {
            Ok(o) if !o.success => {}
            Ok(_) => return,
            Err(e) => {
                tracing::warn!(path = p, error = %e, "branch-attach detach probe failed");
                return;
            }
        }
        let matching: Vec<String> = match runner
            .run(&["-C", p, "for-each-ref", "refs/heads", "--points-at", "HEAD", "--format=%(refname:short)"])
            .await
        {
            Ok(o) if o.success => o
                .stdout
                .lines()
                .map(|l| l.trim().to_string())
                .filter(|l| !l.is_empty())
                .collect(),
            Ok(o) => {
                tracing::warn!(path = p, stderr = %o.stderr, "branch-attach for-each-ref failed");
                return;
            }
            Err(e) => {
                tracing::warn!(path = p, error = %e, "branch-attach for-each-ref failed");
                return;
            }
        };
        drop(runner);
        let Some(branch) = choose_attach_branch(configured, &matching) else {
            return;
        };
        if let Err(e) = self.run_simple(&["-C", p, "checkout", &branch]).await {
            tracing::warn!(
                path = p, branch = %branch, error = %e,
                "branch attach failed; the submodule stays detached"
            );
        }
    }
```

- [ ] **Step 6: Wire the two flows**

In `submodule_update_remote` (~line 1732): add `attach_branch: bool` to the signature (before `op_id`, matching the trait). Replace the post-move staging block inside the loop:

```rust
            // `--remote` moves worktrees but not the index: stage the pointer
            // of every submodule that actually moved, so the operation reads
            // as one atomic "pull latest and record it" (spec sub-project 4).
            let moved = matches!(
                status,
                SubmoduleAutoUpdateStatus::Updated
                    | SubmoduleAutoUpdateStatus::ChangesCarried
                    | SubmoduleAutoUpdateStatus::ChangesStashed
            );
            if moved {
                if attach_branch {
                    let p = s.path.to_string_lossy().into_owned();
                    self.attach_submodule_branch(&p, s.branch.as_deref()).await;
                }
                to_stage.push(s.path.clone());
            }
            results.push(SubmoduleAutoUpdateResult { path: s.path, status });
```

In `submodule_auto_update` (~line 1847): add `attach_branch: bool` to the signature. After the `update_one_submodule` call, before `results.push`:

```rust
            let status = self
                .update_one_submodule(&s, old.as_str(), behavior, SubmoduleMove::Recorded, None)
                .await;
            if attach_branch
                && matches!(
                    status,
                    SubmoduleAutoUpdateStatus::Updated
                        | SubmoduleAutoUpdateStatus::ChangesCarried
                        | SubmoduleAutoUpdateStatus::ChangesStashed
                )
            {
                let p = s.path.to_string_lossy().into_owned();
                self.attach_submodule_branch(&p, s.branch.as_deref()).await;
            }
            results.push(SubmoduleAutoUpdateResult { path: s.path, status });
```

- [ ] **Step 7: Run the legit-core tests**

Run: `cargo test -p legit-core`
Expected: all pass, including the 3 new flow tests

- [ ] **Step 8: Update the two Tauri commands**

In `src-tauri/src/commands/submodules.rs`, `repo_submodule_update_remote` (~line 179) and `repo_submodule_auto_update` (~line 246): replace the `behavior` read with one lock that reads both values, and pass the flag through.

```rust
    let (behavior, attach_branch) = {
        let gs = state.global_settings.read().await;
        (gs.switch_dirty_behavior.unwrap_or_default(), gs.submodule_attach_branch)
    };
    session
        .backend
        .submodule_update_remote(&paths, strategy, behavior, attach_branch, OperationId(op_id))
        .await
        .map_err(AppError::Git)
```

and

```rust
    let (behavior, attach_branch) = {
        let gs = state.global_settings.read().await;
        (gs.switch_dirty_behavior.unwrap_or_default(), gs.submodule_attach_branch)
    };
    session
        .backend
        .submodule_auto_update(behavior, attach_branch)
        .await
        .map_err(AppError::Git)
```

- [ ] **Step 9: Verify the workspace compiles**

Run: `cargo check --workspace`
Expected: no errors

---

### Task 4: Manual `submodule_update` path

**Files:**
- Modify: `crates/legit-core/src/cli_impl/mod.rs` (`submodule_update`, ~line 1632)
- Modify: `crates/legit-core/src/cli_impl/flow_tests.rs` (extend `submodule_update_builds_flags_and_pathspec` struct literal; add 1 new test)
- Modify: `src-tauri/src/commands/submodules.rs` (`repo_submodule_update`, ~line 41)

**Interfaces:**
- Consumes: `SubmoduleUpdateOptions.attach_branch`, `attach_submodule_branch` (Task 3).
- Produces: nothing new; behavior only.

- [ ] **Step 1: Fix the existing flow test and write the failing new one**

In `submodule_update_builds_flags_and_pathspec` (~line 1536), the struct literal gains the new field:

```rust
        SubmoduleUpdateOptions {
            init: true,
            recursive: true,
            paths: vec![PathBuf::from("lib")],
            attach_branch: false,
        },
```

New test after it:

```rust
#[tokio::test]
async fn submodule_update_attach_enumerates_then_checks_out() {
    let rec = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let fake = FakeExecutor::default();
    // -- the update itself --
    fake.expect(&["submodule", "update", "--", "lib"], ok(""));
    // -- attach pass: enumerate, then probe only the detached submodule --
    fake.expect(&["ls-files", "--stage", "-z"], ok(&format!("160000 {rec} 0\tlib\0")));
    fake.expect(
        &["config", "-f", ".gitmodules", "-z", "--get-regexp", "^submodule\\."],
        ok("submodule.lib.path\nlib\0submodule.lib.url\nu\0submodule.lib.branch\nmain\0"),
    );
    fake.expect(&["config", "-z", "--get-regexp", "^submodule\\."], ok("submodule.lib.url\nu\0"));
    fake.expect(&["status", "--porcelain=v2", "-z", "--untracked-files=all"], ok(""));
    fake.expect(&["-C", "lib", "rev-parse", "--show-prefix", "HEAD"], ok(&format!("\n{rec}\n")));
    fake.expect(&["-C", "lib", "rev-parse", "--abbrev-ref", "HEAD"], ok("HEAD\n"));
    fake.expect(&["-C", "lib", "symbolic-ref", "-q", "--short", "HEAD"], fail(1, ""));
    fake.expect(
        &["-C", "lib", "for-each-ref", "refs/heads", "--points-at", "HEAD", "--format=%(refname:short)"],
        ok("main\n"),
    );
    fake.expect(&["-C", "lib", "checkout", "main"], ok("Switched to branch 'main'"));
    let (b, exec) = backend(fake);

    b.submodule_update(
        SubmoduleUpdateOptions {
            init: false,
            recursive: false,
            paths: vec![PathBuf::from("lib")],
            attach_branch: true,
        },
        OperationId("op".into()),
    )
    .await
    .unwrap();
    exec.assert_done();
}
```

- [ ] **Step 2: Run tests to verify the new one fails**

Run: `cargo test -p legit-core --lib flow_tests::submodule_update`
Expected: `submodule_update_attach_enumerates_then_checks_out` FAILS ("expected more git invocation(s)"); `submodule_update_builds_flags_and_pathspec` passes

- [ ] **Step 3: Implement the attach pass**

Rewrite `submodule_update` in `cli_impl/mod.rs`:

```rust
    async fn submodule_update(
        &self,
        opts: SubmoduleUpdateOptions,
        op_id: OperationId,
    ) -> Result<(), GitError> {
        let runner = self.runner().await;
        let mut args: Vec<String> = vec!["submodule".into(), "update".into()];
        if opts.init {
            args.push("--init".into());
        }
        if opts.recursive {
            args.push("--recursive".into());
        }
        if !opts.paths.is_empty() {
            args.push("--".into());
            for p in &opts.paths {
                args.push(p.to_string_lossy().into_owned());
            }
        }
        // May clone/fetch missing commits: run as a remote op (progress,
        // cancel, auth-aware error classification).
        self.run_remote(&runner, &args, op_id).await?;
        drop(runner);

        if opts.attach_branch {
            // Best-effort attach pass over the updated (top-level) submodules;
            // an enumeration failure must not turn the successful update into
            // an error. `head_branch.is_some()` skips already-attached ones.
            match self.submodules().await {
                Ok(subs) => {
                    for s in subs {
                        if !s.state.populated || !s.state.initialized {
                            continue;
                        }
                        if !opts.paths.is_empty() && !opts.paths.contains(&s.path) {
                            continue;
                        }
                        if s.head_branch.is_some() {
                            continue;
                        }
                        let p = s.path.to_string_lossy().into_owned();
                        self.attach_submodule_branch(&p, s.branch.as_deref()).await;
                    }
                }
                Err(e) => tracing::warn!(error = %e, "branch-attach enumeration failed"),
            }
        }
        Ok(())
    }
```

Note: `head_branch.is_some()` already filters attached submodules here, so the helper's `symbolic-ref` probe is redundant on this path - but it is one cheap command, and keeping the probe inside the helper keeps it self-contained for its other two callers.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p legit-core`
Expected: all pass

- [ ] **Step 5: Fill the flag in the command**

In `src-tauri/src/commands/submodules.rs`, `repo_submodule_update`:

```rust
pub async fn repo_submodule_update(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    opts: SubmoduleUpdateOptions,
    op_id: String,
) -> Result<(), AppError> {
    let session = state.get_session(&repo_id).await?;
    let mut opts = opts;
    // The frontend never sets this; it mirrors the global setting.
    opts.attach_branch = state.global_settings.read().await.submodule_attach_branch;
    session
        .backend
        .submodule_update(opts, OperationId(op_id))
        .await
        .map_err(AppError::Git)
}
```

- [ ] **Step 6: Verify the workspace compiles**

Run: `cargo check --workspace`
Expected: no errors

---

### Task 5: Real-git validation (`git_flows.rs`)

**Files:**
- Modify: `crates/legit-core/tests/git_flows.rs` (new test near the other submodule tests, after `submodules_reports_a_real_submodule` ~line 1570)

**Interfaces:**
- Consumes: `repo_with_submodule()` fixture, `SubmoduleUpdateOptions.attach_branch`, backend `submodule_update` / `submodule_set_branch` / `submodules`.

- [ ] **Step 1: Write the test**

Encodes the assumptions the feature is built on, against real git: (1) `submodule update` checks out the recorded SHA detached even when the configured branch points at that exact commit; (2) `for-each-ref --points-at HEAD --format=%(refname:short)` lists that branch; (3) the follow-up `checkout` attaches and leaves both worktrees clean. Note `git submodule update` skips a submodule already at the recorded SHA, so the setup moves the submodule's HEAD away first (a detached commit inside the submodule) while `main` stays at the recorded commit.

```rust
#[tokio::test]
async fn submodule_update_attach_branch_reattaches_the_configured_branch() {
    let (sup, _lib) = repo_with_submodule().await;
    // Track `main` in .gitmodules (read back by submodules()).
    sup.backend
        .submodule_set_branch(Path::new("lib"), Some("main"))
        .await
        .unwrap();

    // Move the submodule's HEAD off the recorded SHA: a detached commit
    // inside the submodule. `main` keeps pointing at the recorded commit.
    sup.git(&["-C", "lib", "checkout", "--detach"]).await;
    sup.write("lib/lib.txt", "detached work\n");
    sup.git(&["-C", "lib", "add", "-A"]).await;
    sup.git(&["-C", "lib", "commit", "-m", "detached work"]).await;

    // PREMISE (attach off): the update returns to the recorded SHA but
    // leaves the submodule detached, even though `main` points exactly there.
    let mut opts = SubmoduleUpdateOptions {
        paths: vec![PathBuf::from("lib")],
        ..Default::default()
    };
    sup.backend
        .submodule_update(opts.clone(), OperationId("t1".into()))
        .await
        .unwrap();
    let subs = sup.backend.submodules().await.unwrap();
    assert_eq!(subs.len(), 1);
    assert_eq!(subs[0].head_branch, None, "plain update must stay detached");
    assert_eq!(
        subs[0].checked_out_sha, subs[0].recorded_sha,
        "update must have checked out the recorded SHA"
    );

    // FEATURE (attach on): the same update now ends attached to `main`.
    opts.attach_branch = true;
    sup.backend
        .submodule_update(opts, OperationId("t2".into()))
        .await
        .unwrap();
    let subs = sup.backend.submodules().await.unwrap();
    assert_eq!(
        subs[0].head_branch.as_deref(),
        Some("main"),
        "attach must have checked out the configured branch"
    );
    assert_eq!(subs[0].checked_out_sha, subs[0].recorded_sha);
    // The attach is a content no-op: both worktrees stay clean.
    assert_eq!(sup.git(&["-C", "lib", "status", "--porcelain"]).await.trim(), "");
    assert_eq!(sup.git(&["status", "--porcelain"]).await.trim(), "");
}
```

- [ ] **Step 2: Run the test**

Run: `cargo test -p legit-core --test git_flows submodule_update_attach_branch`
Expected: PASS. If the premise assertion (`head_branch == None`) fails, STOP: git's behavior differs from the design's assumption; report instead of adapting the assertion.

- [ ] **Step 3: Run the full legit-core suite**

Run: `cargo test -p legit-core`
Expected: all pass

---

### Task 6: Frontend setting toggle

**Files:**
- Modify: `src/lib/types.ts` (`GlobalSettings` ~line 70, `SubmoduleUpdateOptions` mirror if present)
- Modify: `src/lib/commands.ts` (next to `setConfirmDiscard`, ~line 215)
- Modify: `src/store/settings.ts` (store interface + setter next to `setCommitAvatars`, ~line 216)
- Modify: `src/panels/Settings/GlobalSettingsPanel.tsx` (new section component next to `PushGuardSection` ~line 1002; render it after `<PushGuardSection />` ~line 96)

**Interfaces:**
- Consumes: Tauri command `set_submodule_attach_branch` (Task 2).
- Produces: `useSettingsStore` setter `setSubmoduleAttachBranch(enabled: boolean): Promise<void>`; settings field `submodule_attach_branch?: boolean`.

- [ ] **Step 1: Mirror the types**

In `src/lib/types.ts`, `GlobalSettings` gains (next to the other booleans):

```ts
  submodule_attach_branch?: boolean;
```

If `SubmoduleUpdateOptions` is mirrored in `types.ts`, add the optional field with a comment; do not set it anywhere in the frontend:

```ts
  /** Filled backend-side from the global setting; never set by the frontend. */
  attach_branch?: boolean;
```

- [ ] **Step 2: Add the command wrapper**

In `src/lib/commands.ts`, next to `setConfirmDiscard`:

```ts
export const setSubmoduleAttachBranch = (enabled: boolean) =>
  invoke<null>("set_submodule_attach_branch", { enabled });
```

- [ ] **Step 3: Add the store setter**

In `src/store/settings.ts`: import `setSubmoduleAttachBranch` from `../lib/commands` (alongside the existing setter imports), add to the store's TypeScript interface:

```ts
  setSubmoduleAttachBranch: (enabled: boolean) => Promise<void>;
```

and to the store implementation, next to `setCommitAvatars`:

```ts
  async setSubmoduleAttachBranch(enabled) {
    await setSubmoduleAttachBranch(enabled);
    const s = get().settings;
    if (s) set({ settings: { ...s, submodule_attach_branch: enabled } });
  },
```

Note: the store method and the imported command share a name; follow the file's existing convention for that (the other setters do the same, e.g. `setConfirmDiscard` - the method shorthand refers to the import without collision). If the file aliases imports instead, follow that pattern.

- [ ] **Step 4: Add the settings section**

In `src/panels/Settings/GlobalSettingsPanel.tsx`, after `PushGuardSection` (modeled on `ConfirmDiscardSection`; note the FieldNote copy avoids the em-dash used by older sections, per project writing rules):

```tsx
function SubmoduleAttachSection() {
  const enabled = useSettingsStore((s) => s.settings?.submodule_attach_branch ?? false);
  const setSubmoduleAttachBranch = useSettingsStore((s) => s.setSubmoduleAttachBranch);
  const [saving, setSaving] = useState(false);

  const toggle = async () => {
    setSaving(true);
    try {
      await setSubmoduleAttachBranch(!enabled);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Section title="Submodule branch attach">
      <FieldNote>writes to: global settings (applies to all repos)</FieldNote>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
        <input
          type="checkbox"
          id="global-submodule-attach"
          checked={enabled}
          onChange={toggle}
          disabled={saving}
        />
        <label htmlFor="global-submodule-attach" style={{ fontSize: "var(--fz-lg)", cursor: "pointer" }}>
          Attach submodule HEAD to its branch after updates
        </label>
      </div>
      <FieldNote>
        When a submodule update lands on a commit that a branch already points
        at (the tracked branch, or a single matching local branch), check out
        that branch instead of leaving a detached HEAD. The submodule then
        follows the branch, so its recorded pointer shows as changed when the
        branch moves.
      </FieldNote>
    </Section>
  );
}
```

Render it in the panel body directly after `<PushGuardSection />`:

```tsx
          <PushGuardSection />
          <SubmoduleAttachSection />
```

- [ ] **Step 5: Type-check and test**

Run from `<repo>`: `npx tsc --noEmit`
Expected: no errors
Run the frontend test suite via PowerShell interop (per project verification setup): `powershell.exe -Command "cd <repo>; npm test -- --run"`
Expected: all pass (no new frontend tests are required; the theme-contract and no-literal-colors suites must stay green)

---

### Task 7: Final verification

- [ ] **Step 1: Full Rust suite**

Run: `cargo test -p legit-core && cargo check --workspace`
Expected: all pass

- [ ] **Step 2: Frontend suite**

Run: `npx tsc --noEmit` and `powershell.exe -Command "cd <repo>; npm test -- --run"`
Expected: all pass

- [ ] **Step 3: Update the design doc status**

In `design/2026-07-23-submodule-branch-attach.md`, change `**Status:** Approved design, not yet implemented.` to `**Status:** Implemented (pending manual verification in the app).`

- [ ] **Step 4: Report**

Summarize the diff for Simon; remind that manual app verification (toggle the setting, update a submodule in `../LeGit-Test` or a repo with submodules) needs a human run from PowerShell. Do NOT commit anything.
