# Submodules Tier 3 (Lifecycle) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Do NOT use subagent-driven-development (user rule). Do NOT commit at any point (user rule): leave all changes in the working tree for the user to review.

**Goal:** Full submodule lifecycle: add, the magit-grade remove sequence (refuse dirty, absorb gitdirs, deinit + rm, gitdir deletion as a separate confirmed step with an unpushed-commits check), set-url with auto-sync, set-branch, and `update --remote` with checkout/rebase/merge strategy plus pointer staging. (Spec: `docs/superpowers/specs/2026-07-08-submodules-architecture-design.md`, sub-project 4.)

**Architecture:** Seven new `GitBackend` methods following the established chain. Remove refuses dirty submodules with `GitError::WouldOverwriteLocalChanges` (existing classified variant), then runs `absorbgitdirs -> deinit -f -> rm -f`; the kept `.git/modules/<name>` is inspected (`submodule_gitdir_info`: exists + unpushed commits via `git --git-dir <gd> log --branches --not --remotes`) and deleted only by an explicit second call (`submodule_delete_gitdir`, path-validated `fs::remove_dir_all`). `update --remote` integrates per the strategy flag and then stages the moved pointers (`git add`), because `--remote` moves the worktree but not the index. The UI splits `SubmoduleRow` into its own file and adds the add-form, strategy select, remove flow (two confirmations: remove, then optional gitdir deletion with unpushed warning), and in-place URL/branch editing via `InlineRenameInput`.

**Tech Stack:** Rust (crates/legit-core, src-tauri), React + TypeScript + react-query, FakeExecutor flow tests, real-git harness (tier 1's `repo_with_submodule()` fixture).

## Global Constraints

- **No commits, no pushes.** All changes stay in the working tree for user review.
- Remove semantics (spec, magit-grade): refuse if dirty; `absorbgitdirs` first; `deinit -f` + `git rm -f` (stages the `.gitmodules` edit, keeps `.git/modules/<name>`); gitdir deletion is a separate, explicitly confirmed step preceded by an unpushed-commits check. Every destructive confirmation is gated by `useConfirmDestructive()`; when off, the action runs immediately (never hardcode a confirm).
- `set-url` writes `.gitmodules` and MUST auto-run `submodule sync` for the path (URL changes do not propagate otherwise).
- `update --remote` must be followed by staging the moved pointers (`git add`), per spec.
- Renames/edits happen in place: `InlineRenameInput` (`src/panels/Commits/cells/InlineRenameInput.tsx`; Enter approves, Esc discards) - never summon another panel.
- Gitdir deletion must path-validate: the target must be exactly `<git_dir>/modules/<name>` with no `..` traversal.
- UI: existing theme tokens; `--fz-*`/em sizing; delayed-busy `run()` pattern.
- Real-git fixtures: `-c protocol.file.allow=always` on invoking commands; for `update --remote`'s internal fetch, set `protocol.file.allow=always` in the SUBMODULE's local config (the fetch runs inside the existing submodule repo, so its own local config applies - unlike a fresh internal clone).
- `submodule add` gets no real-git test: its internal clone ignores repo-local config (CVE-2022-39253), so a file-path fixture cannot work without polluting global config. The flow test pins the argv; the clone behavior is git's own.
- Verification from WSL: `cargo test -p legit-core`, `cargo check -p legit-app`, `npx tsc --noEmit`. vitest + live app are PowerShell steps.
- No em-dashes in comments or docs.

---

### Task 1: Types + backend `submodule_add` / `set_url` / `set_branch`

**Files:**
- Modify: `crates/legit-core/src/types.rs` (two new types after `SubmoduleUpdateOptions`)
- Modify: `crates/legit-core/src/backend.rs` (trait methods after `superproject_path`)
- Modify: `crates/legit-core/src/cli_impl/mod.rs` (implementations)
- Modify: `crates/legit-core/src/cli_impl/flow_tests.rs` (tests)

**Interfaces:**
- Consumes: `run_remote`, `run_simple`, tier-2 helpers.
- Produces:
  - `SubmoduleUpdateStrategy` enum: `Checkout` (default) | `Rebase` | `Merge` (serde snake_case)
  - `SubmoduleGitdirInfo { path: PathBuf, unpushed: bool }`
  - `async fn submodule_add(&self, url: &str, path: &Path, branch: Option<&str>, op_id: OperationId) -> Result<(), GitError>`
  - `async fn submodule_set_url(&self, path: &Path, url: &str) -> Result<(), GitError>`
  - `async fn submodule_set_branch(&self, path: &Path, branch: Option<&str>) -> Result<(), GitError>`

- [x] **Step 1: Types**

In `types.rs`, after `SubmoduleUpdateOptions`:

```rust
/// Integration mode for `submodule update --remote`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "snake_case")]
pub enum SubmoduleUpdateStrategy {
    /// Detach at the fetched commit (git's default).
    #[default]
    Checkout,
    /// Rebase the current branch onto the fetched commit.
    Rebase,
    /// Merge the fetched commit into the current branch.
    Merge,
}

/// State of a removed submodule's retained gitdir (`.git/modules/<name>`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct SubmoduleGitdirInfo {
    pub path: PathBuf,
    /// Commits on local branches that are on no remote - deleting the gitdir
    /// would destroy them permanently.
    pub unpushed: bool,
}
```

- [x] **Step 2: Failing flow tests**

Append to `flow_tests.rs`:

```rust
// ---------------------------------------------------------------------------
// submodule lifecycle: add / set-url / set-branch
// ---------------------------------------------------------------------------

#[tokio::test]
async fn submodule_add_builds_branch_flag_and_operands() {
    let fake = FakeExecutor::default();
    fake.expect(
        &["submodule", "add", "-b", "main", "--", "https://x.invalid/lib.git", "vendor/lib"],
        ok(""),
    );
    fake.expect(
        &["submodule", "add", "--", "https://x.invalid/lib.git", "lib"],
        ok(""),
    );
    let (b, exec) = backend(fake);

    b.submodule_add("https://x.invalid/lib.git", Path::new("vendor/lib"), Some("main"), OperationId("a".into()))
        .await
        .unwrap();
    b.submodule_add("https://x.invalid/lib.git", Path::new("lib"), None, OperationId("b".into()))
        .await
        .unwrap();
    exec.assert_done();
}

#[tokio::test]
async fn submodule_set_url_syncs_afterwards() {
    let fake = FakeExecutor::default();
    fake.expect(&["submodule", "set-url", "--", "lib", "https://new.invalid/lib.git"], ok(""));
    // set-url edits .gitmodules only: without sync the local config and the
    // submodule's origin keep the old URL.
    fake.expect(&["submodule", "sync", "--", "lib"], ok(""));
    let (b, exec) = backend(fake);

    b.submodule_set_url(Path::new("lib"), "https://new.invalid/lib.git").await.unwrap();
    exec.assert_done();
}

#[tokio::test]
async fn submodule_set_branch_sets_and_clears() {
    let fake = FakeExecutor::default();
    fake.expect(&["submodule", "set-branch", "--branch", "dev", "--", "lib"], ok(""));
    fake.expect(&["submodule", "set-branch", "--default", "--", "lib"], ok(""));
    let (b, exec) = backend(fake);

    b.submodule_set_branch(Path::new("lib"), Some("dev")).await.unwrap();
    b.submodule_set_branch(Path::new("lib"), None).await.unwrap();
    exec.assert_done();
}
```

- [x] **Step 3: Run to verify failure**

Run: `cargo test -p legit-core --lib submodule_add_builds 2>&1 | tail -3`
Expected: COMPILE ERROR.

- [x] **Step 4: Trait methods**

In `backend.rs` after `superproject_path` (extend imports with `SubmoduleUpdateStrategy`, `SubmoduleGitdirInfo` - the latter is used in Task 3's methods, import both now):

```rust
    /// Add a submodule (`git submodule add [-b <branch>] -- <url> <path>`).
    /// Clones - cancellable. Relative URLs resolve against origin (git-native).
    async fn submodule_add(
        &self,
        url: &str,
        path: &Path,
        branch: Option<&str>,
        op_id: OperationId,
    ) -> Result<(), GitError>;

    /// Change a submodule's URL in `.gitmodules` and immediately `sync` it
    /// into the local config and the submodule's origin remote.
    async fn submodule_set_url(&self, path: &Path, url: &str) -> Result<(), GitError>;

    /// Set (`Some`) or clear (`None` = remote default) the `.gitmodules`
    /// branch used by `update --remote`.
    async fn submodule_set_branch(&self, path: &Path, branch: Option<&str>) -> Result<(), GitError>;
```

- [x] **Step 5: Implementations**

In `cli_impl/mod.rs` after `superproject_path` (extend the types import):

```rust
    async fn submodule_add(
        &self,
        url: &str,
        path: &Path,
        branch: Option<&str>,
        op_id: OperationId,
    ) -> Result<(), GitError> {
        let runner = self.runner().await;
        let mut args: Vec<String> = vec!["submodule".into(), "add".into()];
        if let Some(b) = branch {
            args.push("-b".into());
            args.push(b.to_string());
        }
        args.push("--".into());
        args.push(url.to_string());
        args.push(path.to_string_lossy().into_owned());
        // Clones the repository: run as a remote op (progress, cancel, auth).
        self.run_remote(&runner, &args, op_id).await
    }

    async fn submodule_set_url(&self, path: &Path, url: &str) -> Result<(), GitError> {
        let p = path.to_string_lossy().into_owned();
        self.run_simple(&["submodule", "set-url", "--", &p, url]).await?;
        // set-url edits .gitmodules only; sync propagates to .git/config and
        // the submodule's origin (spec: set-url auto-syncs).
        self.run_simple(&["submodule", "sync", "--", &p]).await
    }

    async fn submodule_set_branch(&self, path: &Path, branch: Option<&str>) -> Result<(), GitError> {
        let p = path.to_string_lossy().into_owned();
        match branch {
            Some(b) => {
                self.run_simple(&["submodule", "set-branch", "--branch", b, "--", &p])
                    .await
            }
            None => {
                self.run_simple(&["submodule", "set-branch", "--default", "--", &p])
                    .await
            }
        }
    }
```

- [x] **Step 6: Run flow tests + real-git set-url/set-branch test**

Run: `cargo test -p legit-core --lib flow_tests 2>&1 | tail -3` -> PASS.

Append to `tests/git_flows.rs`:

```rust
#[tokio::test]
async fn submodule_set_url_and_branch_write_gitmodules_and_sync() {
    let (sup, _lib) = repo_with_submodule().await;

    sup.backend
        .submodule_set_url(Path::new("lib"), "https://new.invalid/lib.git")
        .await
        .unwrap();
    let gm = sup.git(&["config", "-f", ".gitmodules", "submodule.lib.url"]).await;
    assert_eq!(gm.trim(), "https://new.invalid/lib.git");
    // sync propagated into the local config (registration).
    let lc = sup.git(&["config", "submodule.lib.url"]).await;
    assert_eq!(lc.trim(), "https://new.invalid/lib.git");

    sup.backend.submodule_set_branch(Path::new("lib"), Some("dev")).await.unwrap();
    let b = sup.git(&["config", "-f", ".gitmodules", "submodule.lib.branch"]).await;
    assert_eq!(b.trim(), "dev");
    sup.backend.submodule_set_branch(Path::new("lib"), None).await.unwrap();
    let subs = sup.backend.submodules().await.unwrap();
    assert_eq!(subs[0].branch, None);
}
```

Run: `cargo test -p legit-core --test git_flows submodule_set_url 2>&1 | tail -3` -> PASS.

---

### Task 2: Backend `update --remote` with strategy + pointer staging

**Files:**
- Modify: `crates/legit-core/src/backend.rs`, `crates/legit-core/src/cli_impl/mod.rs`, `flow_tests.rs`, `tests/git_flows.rs`

**Interfaces:**
- Consumes: `SubmoduleUpdateStrategy` (Task 1), `parse_gitlinks` + `LS_FILES_STAGE_ARGS` (tier 1), `run_remote`, `run_pathspec`.
- Produces: `async fn submodule_update_remote(&self, paths: &[PathBuf], strategy: SubmoduleUpdateStrategy, op_id: OperationId) -> Result<(), GitError>` - fetch + integrate, then stage the pointers.

- [x] **Step 1: Failing flow test**

```rust
#[tokio::test]
async fn submodule_update_remote_integrates_then_stages_pointers() {
    let sha_a = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let fake = FakeExecutor::default();
    // Explicit path: update, then stage exactly that pointer.
    fake.expect(&["submodule", "update", "--remote", "--rebase", "--", "lib"], ok(""));
    fake.expect(&["add", "--", "lib"], ok(""));
    // No paths: update all, then enumerate gitlinks and stage them.
    fake.expect(&["submodule", "update", "--remote", "--checkout"], ok(""));
    fake.expect(
        &["ls-files", "--stage", "-z"],
        ok(&format!("100644 {sha_a} 0\tREADME.md\0160000 {sha_a} 0\tlib\0")),
    );
    fake.expect(&["add", "--", "lib"], ok(""));
    let (b, exec) = backend(fake);

    b.submodule_update_remote(&[PathBuf::from("lib")], SubmoduleUpdateStrategy::Rebase, OperationId("a".into()))
        .await
        .unwrap();
    b.submodule_update_remote(&[], SubmoduleUpdateStrategy::Checkout, OperationId("b".into()))
        .await
        .unwrap();
    exec.assert_done();
}
```

Run: `cargo test -p legit-core --lib submodule_update_remote 2>&1 | tail -3` -> COMPILE ERROR.

- [x] **Step 2: Trait + implementation**

`backend.rs`:

```rust
    /// Fetch and integrate each submodule's tracked branch
    /// (`update --remote` + strategy), then STAGE the moved pointers -
    /// `--remote` moves the worktree but never the index. Empty `paths` =
    /// all submodules. Cancellable.
    async fn submodule_update_remote(
        &self,
        paths: &[PathBuf],
        strategy: SubmoduleUpdateStrategy,
        op_id: OperationId,
    ) -> Result<(), GitError>;
```

`cli_impl/mod.rs`:

```rust
    async fn submodule_update_remote(
        &self,
        paths: &[PathBuf],
        strategy: SubmoduleUpdateStrategy,
        op_id: OperationId,
    ) -> Result<(), GitError> {
        let runner = self.runner().await;
        let flag = match strategy {
            SubmoduleUpdateStrategy::Checkout => "--checkout",
            SubmoduleUpdateStrategy::Rebase => "--rebase",
            SubmoduleUpdateStrategy::Merge => "--merge",
        };
        let mut args: Vec<String> =
            vec!["submodule".into(), "update".into(), "--remote".into(), flag.into()];
        if !paths.is_empty() {
            args.push("--".into());
            for p in paths {
                args.push(p.to_string_lossy().into_owned());
            }
        }
        self.run_remote(&runner, &args, op_id).await?;

        // `--remote` moves worktrees but not the index: stage the pointers so
        // the operation reads as one atomic "pull latest and record it"
        // (spec sub-project 4). With no explicit paths, stage every gitlink.
        let to_stage: Vec<PathBuf> = if paths.is_empty() {
            let ls = runner
                .run(&parsers::submodules::LS_FILES_STAGE_ARGS)
                .await
                .map_err(|e| GitError::Internal(e.to_string()))?;
            if !ls.success {
                return Err(GitError::CommandFailed {
                    exit_code: ls.exit_code.unwrap_or(-1),
                    stderr: ls.stderr,
                });
            }
            parsers::submodules::parse_gitlinks(&ls.stdout)
                .into_iter()
                .map(|(p, _)| p)
                .collect()
        } else {
            paths.to_vec()
        };
        drop(runner);
        if to_stage.is_empty() {
            return Ok(());
        }
        self.run_pathspec(&["add", "--"], &to_stage).await
    }
```

(If `run_pathspec` acquires the runner itself and the borrow above conflicts, keep the explicit `drop(runner)` as shown; check `run_pathspec`'s body - it does `self.runner().await` internally.)

- [x] **Step 3: Run flow tests**

Run: `cargo test -p legit-core --lib flow_tests 2>&1 | tail -3` -> PASS.

- [x] **Step 4: Real-git test**

Append to `tests/git_flows.rs` (note the submodule-local `protocol.file.allow` - the `--remote` fetch runs inside the EXISTING submodule repo, whose own local config applies, unlike a fresh internal clone):

```rust
#[tokio::test]
async fn submodule_update_remote_moves_and_stages_the_pointer() {
    let (sup, lib) = repo_with_submodule().await;
    let sub_path = sup.path.join("lib").to_string_lossy().into_owned();
    // Allow the submodule's own fetch of its file-path origin.
    sup.git(&["-C", &sub_path, "config", "protocol.file.allow", "always"]).await;

    // New upstream commit in the submodule's origin.
    lib.write("lib.txt", "v2\n");
    lib.commit_all("lib v2").await;
    let upstream = lib.head().await;

    sup.backend
        .submodule_update_remote(
            &[PathBuf::from("lib")],
            SubmoduleUpdateStrategy::Checkout,
            OperationId("t".into()),
        )
        .await
        .unwrap();

    let now = sup.git(&["-C", &sub_path, "rev-parse", "HEAD"]).await.trim().to_string();
    assert_eq!(now, upstream, "submodule must be at the origin's new HEAD");
    // The pointer was staged: a staged SubmoduleChanged entry exists.
    let status = sup.backend.status().await.unwrap();
    let entry = status
        .iter()
        .find(|s| s.path == PathBuf::from("lib") && s.staged)
        .expect("staged pointer entry");
    assert_eq!(entry.state, FileState::SubmoduleChanged);
}
```

(Add `SubmoduleUpdateStrategy` to the `use legit_core::{...}` list.)

Run: `cargo test -p legit-core --test git_flows submodule_update_remote 2>&1 | tail -3` -> PASS. If the fetch is still refused despite the submodule-local config, adapt the fixture: set the config via `git -C <sub> config` BEFORE the update (as written) and read git's stderr for the exact knob it wants - do not weaken the assertion.

---

### Task 3: Backend remove + gitdir info/delete

**Files:**
- Modify: `crates/legit-core/src/backend.rs`, `crates/legit-core/src/cli_impl/mod.rs`, `flow_tests.rs`, `tests/git_flows.rs`

**Interfaces:**
- Consumes: `parse_status_submodule_flags` + `STATUS_ARGS` (tier 1), `run_simple`, `GitError::WouldOverwriteLocalChanges`, `SubmoduleGitdirInfo` (Task 1).
- Produces:
  - `async fn submodule_remove(&self, path: &Path) -> Result<(), GitError>` - refuse-dirty, absorb, deinit, rm.
  - `async fn submodule_gitdir_info(&self, name: &str) -> Result<Option<SubmoduleGitdirInfo>, GitError>`
  - `async fn submodule_delete_gitdir(&self, name: &str) -> Result<(), GitError>`

- [x] **Step 1: Failing flow tests**

```rust
// ---------------------------------------------------------------------------
// submodule remove - magit-grade staged sequence
// ---------------------------------------------------------------------------

#[tokio::test]
async fn submodule_remove_runs_absorb_deinit_rm_in_order() {
    let fake = FakeExecutor::default();
    // Clean submodule: the full sequence runs, gitdir deletion NEVER runs here.
    fake.expect(
        &["status", "--porcelain=v2", "-z", "--untracked-files=all"],
        ok("1 .M SC.. 160000 160000 160000 aaaaaaa bbbbbbb other\0"),
    );
    fake.expect(&["submodule", "absorbgitdirs", "--", "lib"], ok(""));
    fake.expect(&["submodule", "deinit", "-f", "--", "lib"], ok(""));
    fake.expect(&["rm", "-f", "--", "lib"], ok(""));
    let (b, exec) = backend(fake);

    b.submodule_remove(Path::new("lib")).await.unwrap();
    exec.assert_done();
}

#[tokio::test]
async fn submodule_remove_refuses_dirty_without_running_anything() {
    let fake = FakeExecutor::default();
    // Dirty (untracked content inside): refuse BEFORE any mutation.
    fake.expect(
        &["status", "--porcelain=v2", "-z", "--untracked-files=all"],
        ok("1 .M S..U 160000 160000 160000 aaaaaaa aaaaaaa lib\0"),
    );
    let (b, exec) = backend(fake);

    let err = b.submodule_remove(Path::new("lib")).await.unwrap_err();
    assert!(
        matches!(err, GitError::WouldOverwriteLocalChanges(_)),
        "{err:?}"
    );
    // assert_done proves absorb/deinit/rm never ran.
    exec.assert_done();
}
```

Run: `cargo test -p legit-core --lib submodule_remove 2>&1 | tail -3` -> COMPILE ERROR.

- [x] **Step 2: Trait methods**

```rust
    /// Remove a submodule the safe way (magit semantics): refuse if its
    /// worktree is dirty/conflicted, absorb an embedded gitdir, `deinit -f`,
    /// then `git rm -f` (stages the `.gitmodules` edit). The gitdir under
    /// `.git/modules/<name>` is deliberately KEPT - see
    /// `submodule_gitdir_info` / `submodule_delete_gitdir`.
    async fn submodule_remove(&self, path: &Path) -> Result<(), GitError>;

    /// Inspect a removed submodule's retained gitdir: `None` when it does
    /// not exist; `unpushed = true` when local branches hold commits on no
    /// remote (deletion would destroy them).
    async fn submodule_gitdir_info(&self, name: &str)
        -> Result<Option<SubmoduleGitdirInfo>, GitError>;

    /// Permanently delete `.git/modules/<name>`. The caller confirms first
    /// (destructive; unpushed commits are gone for good).
    async fn submodule_delete_gitdir(&self, name: &str) -> Result<(), GitError>;
```

- [x] **Step 3: Implementations**

```rust
    async fn submodule_remove(&self, path: &Path) -> Result<(), GitError> {
        // Refuse dirty/conflicted BEFORE any mutation: `git rm -f` would
        // happily discard uncommitted submodule work.
        let runner = self.runner().await;
        let status = runner
            .run(&parsers::status::STATUS_ARGS)
            .await
            .map_err(|e| GitError::Internal(e.to_string()))?;
        if !status.success {
            return Err(GitError::CommandFailed {
                exit_code: status.exit_code.unwrap_or(-1),
                stderr: status.stderr,
            });
        }
        let dirt = parsers::submodules::parse_status_submodule_flags(&status.stdout);
        if let Some(d) = dirt.get(path) {
            if d.dirty_tracked || d.dirty_untracked || d.conflicted {
                return Err(GitError::WouldOverwriteLocalChanges(format!(
                    "submodule '{}' has uncommitted changes - commit or discard them inside the submodule first",
                    path.display()
                )));
            }
        }
        drop(runner);

        let p = path.to_string_lossy().into_owned();
        // Embedded `.git` directories move into `.git/modules/<name>` so the
        // history survives `rm` (magit runs this too; no-op when absorbed).
        self.run_simple(&["submodule", "absorbgitdirs", "--", &p]).await?;
        self.run_simple(&["submodule", "deinit", "-f", "--", &p]).await?;
        // Removes worktree + index gitlink and STAGES the .gitmodules edit.
        self.run_simple(&["rm", "-f", "--", &p]).await
    }

    async fn submodule_gitdir_info(
        &self,
        name: &str,
    ) -> Result<Option<SubmoduleGitdirInfo>, GitError> {
        let Some(gitdir) = self.submodule_gitdir_path(name).await? else {
            return Ok(None);
        };
        // Any commit on a local branch that no remote ref reaches would be
        // destroyed by deleting the gitdir - surface that before the confirm.
        let runner = self.runner().await;
        let gd = gitdir.to_string_lossy().into_owned();
        let unpushed = match runner
            .run(&["--git-dir", &gd, "log", "--branches", "--not", "--remotes", "--oneline", "-n", "1"])
            .await
        {
            Ok(o) if o.success => !o.stdout.trim().is_empty(),
            // A broken/bare-ish leftover gitdir: treat as "unknown, warn".
            _ => true,
        };
        Ok(Some(SubmoduleGitdirInfo { path: gitdir, unpushed }))
    }

    async fn submodule_delete_gitdir(&self, name: &str) -> Result<(), GitError> {
        let Some(gitdir) = self.submodule_gitdir_path(name).await? else {
            return Err(GitError::Internal(format!(
                "no retained gitdir for submodule '{name}'"
            )));
        };
        std::fs::remove_dir_all(&gitdir)
            .map_err(|e| GitError::Internal(format!("could not delete {}: {e}", gitdir.display())))
    }
```

And the shared private helper on the impl block that hosts `run_simple` (NOT inside the `GitBackend` trait impl - place it in the inherent `impl<E: GitExecutor> GitCliBackend<E>` block next to `run_simple`):

```rust
    /// Resolve `.git/modules/<name>` for this repo, validated against path
    /// traversal; `None` when the directory does not exist.
    async fn submodule_gitdir_path(&self, name: &str) -> Result<Option<PathBuf>, GitError> {
        // Reject anything that could escape `<git_dir>/modules/`.
        let name_path = Path::new(name);
        if name_path.is_absolute()
            || name_path
                .components()
                .any(|c| !matches!(c, std::path::Component::Normal(_)))
        {
            return Err(GitError::Internal(format!("invalid submodule name '{name}'")));
        }
        let runner = self.runner().await;
        let out = runner
            .run(&["rev-parse", "--absolute-git-dir"])
            .await
            .map_err(|e| GitError::Internal(e.to_string()))?;
        if !out.success {
            return Err(GitError::CommandFailed {
                exit_code: out.exit_code.unwrap_or(-1),
                stderr: out.stderr,
            });
        }
        let gitdir = PathBuf::from(out.stdout.trim()).join("modules").join(name_path);
        Ok(gitdir.is_dir().then_some(gitdir))
    }
```

- [x] **Step 4: Run flow tests**

Run: `cargo test -p legit-core --lib flow_tests 2>&1 | tail -3` -> PASS.

- [x] **Step 5: Real-git remove roundtrip**

Append to `tests/git_flows.rs`:

```rust
#[tokio::test]
async fn submodule_remove_keeps_gitdir_and_delete_is_separate() {
    let (sup, _lib) = repo_with_submodule().await;
    let sub_path = sup.path.join("lib").to_string_lossy().into_owned();

    // Dirty submodule: remove must refuse and change nothing.
    sup.write("lib/wip.txt", "precious\n");
    let err = sup.backend.submodule_remove(Path::new("lib")).await.unwrap_err();
    assert!(matches!(err, legit_core::GitError::WouldOverwriteLocalChanges(_)), "{err:?}");
    assert!(sup.exists("lib/wip.txt"), "dirty submodule must be untouched");
    std::fs::remove_file(sup.path.join("lib/wip.txt")).unwrap();

    // Unpushed commit inside, clean tree: remove succeeds, gitdir survives.
    sup.git(&["-C", &sub_path, "switch", "-c", "wip"]).await;
    sup.git(&["-C", &sub_path, "commit", "--allow-empty", "-m", "unpushed"]).await;
    sup.backend.submodule_remove(Path::new("lib")).await.unwrap();

    // Gone from index + .gitmodules (rm stages the edit), dir removed.
    let subs = sup.backend.submodules().await.unwrap();
    assert!(subs.is_empty(), "no submodule left: {subs:?}");
    assert!(!sup.exists("lib"), "worktree dir removed");
    // The gitdir is deliberately retained and flags the unpushed commit.
    let info = sup.backend.submodule_gitdir_info("lib").await.unwrap().expect("gitdir kept");
    assert!(info.unpushed, "local-only branch commit must flag unpushed");
    assert!(info.path.ends_with("modules/lib"));

    // Explicit second step deletes it.
    sup.backend.submodule_delete_gitdir("lib").await.unwrap();
    assert!(sup.backend.submodule_gitdir_info("lib").await.unwrap().is_none());

    // Traversal names are rejected outright.
    let err = sup.backend.submodule_gitdir_info("../hooks").await.unwrap_err();
    assert!(matches!(err, legit_core::GitError::Internal(_)), "{err:?}");
}
```

(`GitError` may already be importable as `legit_core::GitError`; adjust to the crate's re-exports.)

Run: `cargo test -p legit-core --test git_flows submodule_remove_keeps 2>&1 | tail -3` -> PASS.

---

### Task 4: IPC commands + wrappers

**Files:**
- Modify: `src-tauri/src/commands/submodules.rs`, `src-tauri/src/lib.rs`, `src/lib/commands.ts`, `src/lib/types.ts`

**Interfaces:**
- Consumes: Tasks 1-3 backend methods.
- Produces: `repoSubmoduleAdd(repoId, url, path, branch, opId)`, `repoSubmoduleSetUrl(repoId, path, url)`, `repoSubmoduleSetBranch(repoId, path, branch)`, `repoSubmoduleUpdateRemote(repoId, paths, strategy, opId)`, `repoSubmoduleRemove(repoId, path)`, `repoSubmoduleGitdirInfo(repoId, name): Promise<SubmoduleGitdirInfo | null>`, `repoSubmoduleDeleteGitdir(repoId, name)`.

- [x] **Step 1: Commands**

Append to `src-tauri/src/commands/submodules.rs` (extend the types import with `SubmoduleGitdirInfo, SubmoduleUpdateStrategy`):

```rust
/// Add a submodule. Cancellable (clones).
#[tauri::command]
#[specta::specta]
pub async fn repo_submodule_add(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    url: String,
    path: String,
    branch: Option<String>,
    op_id: String,
) -> Result<(), AppError> {
    let session = state.get_session(&repo_id).await?;
    session
        .backend
        .submodule_add(&url, &PathBuf::from(path), branch.as_deref(), OperationId(op_id))
        .await
        .map_err(AppError::Git)
}

/// Change a submodule's URL (.gitmodules) and auto-sync it.
#[tauri::command]
#[specta::specta]
pub async fn repo_submodule_set_url(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    path: String,
    url: String,
) -> Result<(), AppError> {
    let session = state.get_session(&repo_id).await?;
    session
        .backend
        .submodule_set_url(&PathBuf::from(path), &url)
        .await
        .map_err(AppError::Git)
}

/// Set or clear (None) the tracked branch used by `update --remote`.
#[tauri::command]
#[specta::specta]
pub async fn repo_submodule_set_branch(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    path: String,
    branch: Option<String>,
) -> Result<(), AppError> {
    let session = state.get_session(&repo_id).await?;
    session
        .backend
        .submodule_set_branch(&PathBuf::from(path), branch.as_deref())
        .await
        .map_err(AppError::Git)
}

/// Pull each submodule's tracked branch and stage the moved pointers.
#[tauri::command]
#[specta::specta]
pub async fn repo_submodule_update_remote(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    paths: Vec<String>,
    strategy: SubmoduleUpdateStrategy,
    op_id: String,
) -> Result<(), AppError> {
    let session = state.get_session(&repo_id).await?;
    let paths: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    session
        .backend
        .submodule_update_remote(&paths, strategy, OperationId(op_id))
        .await
        .map_err(AppError::Git)
}

/// Remove a submodule (refuses dirty; keeps the gitdir).
#[tauri::command]
#[specta::specta]
pub async fn repo_submodule_remove(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    path: String,
) -> Result<(), AppError> {
    let session = state.get_session(&repo_id).await?;
    session
        .backend
        .submodule_remove(&PathBuf::from(path))
        .await
        .map_err(AppError::Git)
}

/// Inspect a removed submodule's retained gitdir.
#[tauri::command]
#[specta::specta]
pub async fn repo_submodule_gitdir_info(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    name: String,
) -> Result<Option<SubmoduleGitdirInfo>, AppError> {
    let session = state.get_session(&repo_id).await?;
    session.backend.submodule_gitdir_info(&name).await.map_err(AppError::Git)
}

/// Permanently delete `.git/modules/<name>` (caller confirms).
#[tauri::command]
#[specta::specta]
pub async fn repo_submodule_delete_gitdir(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    name: String,
) -> Result<(), AppError> {
    let session = state.get_session(&repo_id).await?;
    session.backend.submodule_delete_gitdir(&name).await.map_err(AppError::Git)
}
```

Register all seven in `collect_commands![...]` after `commands::repo_superproject,`. Run: `cargo check -p legit-app 2>&1 | tail -3` -> clean.

- [x] **Step 2: TS mirrors + wrappers**

`src/lib/types.ts` (after `SubmoduleUpdateOptions`):

```ts
/** Integration mode for `submodule update --remote`. */
export type SubmoduleUpdateStrategy = "checkout" | "rebase" | "merge";

/** Retained gitdir of a removed submodule. */
export interface SubmoduleGitdirInfo {
  path: string;
  /** Local commits on no remote - deleting the gitdir destroys them. */
  unpushed: boolean;
}
```

`src/lib/commands.ts` (extend type import; append under `// --- submodules ---`):

```ts
export const repoSubmoduleAdd = (
  repoId: string,
  url: string,
  path: string,
  branch: string | null,
  opId: string,
) => invoke<void>("repo_submodule_add", { repoId, url, path, branch, opId });

export const repoSubmoduleSetUrl = (repoId: string, path: string, url: string) =>
  invoke<void>("repo_submodule_set_url", { repoId, path, url });

export const repoSubmoduleSetBranch = (repoId: string, path: string, branch: string | null) =>
  invoke<void>("repo_submodule_set_branch", { repoId, path, branch });

export const repoSubmoduleUpdateRemote = (
  repoId: string,
  paths: string[],
  strategy: SubmoduleUpdateStrategy,
  opId: string,
) => invoke<void>("repo_submodule_update_remote", { repoId, paths, strategy, opId });

export const repoSubmoduleRemove = (repoId: string, path: string) =>
  invoke<void>("repo_submodule_remove", { repoId, path });

export const repoSubmoduleGitdirInfo = (repoId: string, name: string) =>
  invoke<SubmoduleGitdirInfo | null>("repo_submodule_gitdir_info", { repoId, name });

export const repoSubmoduleDeleteGitdir = (repoId: string, name: string) =>
  invoke<void>("repo_submodule_delete_gitdir", { repoId, name });
```

Run: `npx tsc --noEmit` -> clean.

---

### Task 5: SubmoduleRow extraction + lifecycle UI

**Files:**
- Create: `src/panels/Submodules/SubmoduleRow.tsx` (row moved out of the section + new ops)
- Modify: `src/panels/Submodules/SubmodulesSection.tsx` (add form, strategy select, remove/gitdir flow state)

**Interfaces:**
- Consumes: Task 4 wrappers, `useConfirmDestructive()` (`src/store/settings.ts:82` - runs actions immediately when the global setting is off), `InlineRenameInput` (`src/panels/Commits/cells/InlineRenameInput.tsx`: `{ initialValue, onSave(value), onCancel, disabled?, style?, title?, placeholder? }`), `Button` (`src/panels/shared/buttons`), the existing `run()` pattern.
- Produces: per-row Pull latest / Set URL / Set branch / Remove (+ the two-stage gitdir prompt); section-level Add form and strategy select.

The full component code is long; the structure is fixed here and the row's
existing display code (badge, sha, path) moves verbatim from the section
file. New behavior in `SubmoduleRow.tsx`:

```tsx
// Props added to the row (all wired by the section):
//   onPullLatest: () => void                      - update --remote + stage
//   onSetUrl: (url: string) => void               - set-url (auto-syncs)
//   onSetBranch: (branch: string | null) => void  - set-branch / --default
//   onRemove: () => void                          - starts the remove flow
//   removing: "confirm" | null                    - inline confirm state
//   onConfirmRemove / onCancelRemove: () => void
//
// Local state: `editing: "url" | "branch" | null`. The Set URL / Set branch
// buttons flip it; the row then renders an InlineRenameInput in place of the
// URL/branch text (Enter saves via onSetUrl/onSetBranch, Esc cancels):
{editing === "url" ? (
  <InlineRenameInput
    initialValue={info.url ?? info.gitmodules_url ?? ""}
    placeholder="submodule URL"
    onSave={(v) => { setEditing(null); if (v.trim()) onSetUrl(v.trim()); }}
    onCancel={() => setEditing(null)}
    style={{ fontSize: "var(--fz-sm)", flex: 1 }}
  />
) : null}
{editing === "branch" ? (
  <InlineRenameInput
    initialValue={info.branch ?? ""}
    placeholder="tracked branch (empty = remote default)"
    onSave={(v) => { setEditing(null); onSetBranch(v.trim() === "" ? null : v.trim()); }}
    onCancel={() => setEditing(null)}
    style={{ fontSize: "var(--fz-sm)", flex: 1 }}
  />
) : null}
// The remove confirm renders inline (TagRow-style), gated by the section:
{removing === "confirm" && (
  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
    <span style={{ fontSize: "var(--fz-md)", flex: 1 }}>
      Remove this submodule? Its .gitmodules entry and working tree go away;
      the repository data under .git/modules is kept.
    </span>
    <Button variant="danger" disabled={busy} onClick={onConfirmRemove}>Remove</Button>
    <button disabled={busy} onClick={onCancelRemove}>Cancel</button>
  </div>
)}
```

New behavior in `SubmodulesSection.tsx`:

```tsx
// Section state additions:
const [strategy, setStrategy] = useState<SubmoduleUpdateStrategy>("checkout");
const [confirmRemove, setConfirmRemove] = useState<string | null>(null); // path
// Post-remove gitdir prompt: name + info (null info = no gitdir kept).
const [gitdirPrompt, setGitdirPrompt] = useState<
  { name: string; info: SubmoduleGitdirInfo } | null
>(null);
const confirmDestructive = useConfirmDestructive();

const doRemove = (s: SubmoduleInfo) =>
  run(async () => {
    await repoSubmoduleRemove(repo!.id, s.path);
    setConfirmRemove(null);
    // Second stage: offer gitdir deletion only if one was retained.
    const info = await repoSubmoduleGitdirInfo(repo!.id, s.name);
    if (info) setGitdirPrompt({ name: s.name, info });
  });

const requestRemove = (s: SubmoduleInfo) => {
  if (confirmDestructive) setConfirmRemove(s.path);
  else void doRemove(s);
};

// Strategy select next to "Update all" (drives Pull latest + a new bulk
// "Pull latest" button):
<select
  value={strategy}
  onChange={(e) => setStrategy(e.target.value as SubmoduleUpdateStrategy)}
  title="How update --remote integrates the fetched branch"
  style={{ fontSize: "var(--fz-sm)" }}
>
  <option value="checkout">checkout</option>
  <option value="rebase">rebase</option>
  <option value="merge">merge</option>
</select>

// The gitdir prompt renders above the rows; ALWAYS explicitly confirmed
// (even with confirmDestructive off - it destroys unpushed commits, and the
// spec demands a separate explicit step):
{gitdirPrompt && (
  <div style={{ padding: "8px 10px", border: "1px solid var(--panel-border)", borderRadius: 4 }}>
    <div style={{ marginBottom: 8, fontSize: "var(--fz-md)" }}>
      Submodule removed. Its repository data is kept at{" "}
      <span style={{ fontFamily: "monospace" }}>{gitdirPrompt.info.path}</span>
      {" "}(so it can be re-added later).
      {gitdirPrompt.info.unpushed && (
        <strong> It contains commits that are on no remote - deleting destroys them permanently.</strong>
      )}
    </div>
    <div style={{ display: "flex", gap: 6 }}>
      <Button
        variant="danger"
        disabled={busy}
        onClick={() =>
          run(async () => {
            await repoSubmoduleDeleteGitdir(repo!.id, gitdirPrompt.name);
            setGitdirPrompt(null);
          })
        }
      >
        Delete repository data
      </Button>
      <button disabled={busy} onClick={() => setGitdirPrompt(null)}>Keep</button>
    </div>
  </div>
)}

// Add form at the bottom (TagsSection "New tag" pattern):
const [addUrl, setAddUrl] = useState("");
const [addPath, setAddPath] = useState("");
const [addBranch, setAddBranch] = useState("");
const doAdd = () =>
  run(async () => {
    const url = addUrl.trim();
    const path = addPath.trim();
    if (!url || !path) return;
    await repoSubmoduleAdd(repo!.id, url, path, addBranch.trim() || null, crypto.randomUUID());
    setAddUrl(""); setAddPath(""); setAddBranch("");
  });
```

- [x] **Step 1: Create `SubmoduleRow.tsx`** - move the existing row component there verbatim, add the new props and the `editing`/confirm blocks above, wire the button rows: populated rows get `Pull latest` (disabled while busy; title "git submodule update --remote --<strategy>: fetch and integrate the tracked branch, then stage the pointer"), `Set URL`, `Set branch`, `Remove` alongside the existing Open/Update/Fetch/Sync.
- [x] **Step 2: Update `SubmodulesSection.tsx`** - import the row, add the state/handlers/JSX above, pass `strategy` into `onPullLatest` (`repoSubmoduleUpdateRemote(repo.id, [s.path], strategy, crypto.randomUUID())`), add the bulk "Pull latest" button next to "Update all" (`paths: []`), and the add form (three inputs: URL, path, branch-optional + Add button, Enter submits).
- [x] **Step 3: Verify**

Run: `npx tsc --noEmit` -> clean.

---

### Task 6: Full verification

- [x] **Step 1: Backend suites**

Run: `cargo test -p legit-core 2>&1 | grep "test result"` and `cargo check -p legit-app 2>&1 | tail -2`
Expected: all green.

- [x] **Step 2: Frontend type-check**

Run: `npx tsc --noEmit` -> clean.

- [x] **Step 3: Hand off PowerShell verification to the user**

1. `npm test`.
2. `npm run tauri dev`: add a submodule (URL + path), set its branch, Pull latest with each strategy, remove it (confirm), inspect the gitdir prompt (unpushed warning when applicable), delete or keep the gitdir, re-add the same path after deleting the gitdir.
