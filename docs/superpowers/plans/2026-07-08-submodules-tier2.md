# Submodules Tier 2 (Navigation + Core Operations) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Do NOT use subagent-driven-development (user rule). Do NOT commit at any point (user rule): leave all changes in the working tree for the user to review.

**Goal:** Make submodules operable: open one as a peer repo tab (and navigate back up from inside it), run init/update/sync/fetch (single + bulk, `--recursive` toggle), make "discard" on a submodule pointer actually reset the pointer, and give the watcher a real `submodules` domain. (Spec: `docs/superpowers/specs/2026-07-08-submodules-architecture-design.md`, sub-project 3; builds on the tier-1 working-tree changes.)

**Architecture:** Four new `GitBackend` methods (`submodule_init/update/sync/fetch`) plus `superproject_path()`, following the existing trait -> cli_impl -> Tauri command -> `commands.ts` wrapper chain; network-shaped ops (`update`, `fetch`) run through `run_remote` (progress + cancel + `classify_remote_error`). `discard()` grows a third partition: `SubmoduleChanged` paths reset via `git submodule update --checkout --no-fetch` (git itself refuses to overwrite dirty submodules - no data loss). The watcher gains `ChangeDomain::Submodules` classified from `.git/modules/**` gitdir writes. The UI wires ops into `SubmodulesSection` rows (double-click = open as tab) and a superproject back-button into `RepoTabBar`.

**Tech Stack:** Rust (crates/legit-core, src-tauri), React + TypeScript + react-query, FakeExecutor flow tests, real-git harness (reuses tier 1's `repo_with_submodule()` fixture).

## Global Constraints

- **No commits, no pushes.** All changes stay in the working tree for user review.
- Operations address submodules by path pathspec (`-- <path>`), cancellable via `OperationId` where network is involved (spec: tier-2 operations).
- Never a bare destructive git call: discard of a pointer must go through `submodule update --checkout --no-fetch` so git's own overwrite protection guards dirty submodules.
- Hunk/line staging exclusion for gitlinks is structural since tier 1 (submodule diffs render `SubmoduleDiffView`, which has no hunk UI) - this plan only VERIFIES it, no code needed.
- UI: existing theme tokens only; sizes from `--fz-*`/em; busy indicators delayed ~150ms with re-entry guard (the `run()` pattern from `TagsSection`).
- Real-git submodule fixtures: `-c protocol.file.allow=always` on the invoking command.
- Verification from WSL: `cargo test -p legit-core`, `cargo check -p legit-app`, `npx tsc --noEmit`. vitest + live app are PowerShell steps for the user.
- No em-dashes in comments or docs.

---

### Task 1: Backend operations (`submodule_init/update/sync/fetch`, `superproject_path`)

**Files:**
- Modify: `crates/legit-core/src/types.rs` (add `SubmoduleUpdateOptions` next to `SubmoduleLog`)
- Modify: `crates/legit-core/src/backend.rs` (five trait methods after `submodule_log`)
- Modify: `crates/legit-core/src/cli_impl/mod.rs` (implementations after `submodule_log`)
- Modify: `crates/legit-core/src/cli_impl/flow_tests.rs` (new tests at the end)

**Interfaces:**
- Consumes: `run_remote(&runner, &args, op_id)` (existing, `cli_impl/mod.rs:379`), `run_pathspec` (existing), tier-1 types.
- Produces (trait methods Tasks 3-5 rely on):
  - `SubmoduleUpdateOptions { init: bool, recursive: bool, paths: Vec<PathBuf> }` (`Default`; empty `paths` = all submodules)
  - `async fn submodule_init(&self, paths: &[PathBuf]) -> Result<(), GitError>`
  - `async fn submodule_update(&self, opts: SubmoduleUpdateOptions, op_id: OperationId) -> Result<(), GitError>`
  - `async fn submodule_sync(&self, paths: &[PathBuf], recursive: bool) -> Result<(), GitError>`
  - `async fn submodule_fetch(&self, path: &Path, op_id: OperationId) -> Result<(), GitError>`
  - `async fn superproject_path(&self) -> Result<Option<PathBuf>, GitError>`

- [x] **Step 1: Add the options type**

In `types.rs`, after `SubmoduleLog`:

```rust
/// Options for `submodule update`. Empty `paths` = all submodules.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type, Default)]
pub struct SubmoduleUpdateOptions {
    /// Also register new submodules (`--init`).
    pub init: bool,
    /// Recurse into nested submodules (`--recursive`).
    pub recursive: bool,
    pub paths: Vec<PathBuf>,
}
```

- [x] **Step 2: Write the failing flow tests**

Append to `flow_tests.rs`:

```rust
// ---------------------------------------------------------------------------
// submodule operations
// ---------------------------------------------------------------------------

#[tokio::test]
async fn submodule_update_builds_flags_and_pathspec() {
    let fake = FakeExecutor::default();
    fake.expect(
        &["submodule", "update", "--init", "--recursive", "--", "lib"],
        ok(""),
    );
    // No flags, no paths: bare bulk update.
    fake.expect(&["submodule", "update"], ok(""));
    let (b, exec) = backend(fake);

    b.submodule_update(
        SubmoduleUpdateOptions {
            init: true,
            recursive: true,
            paths: vec![PathBuf::from("lib")],
        },
        OperationId("op1".into()),
    )
    .await
    .unwrap();
    b.submodule_update(SubmoduleUpdateOptions::default(), OperationId("op2".into()))
        .await
        .unwrap();
    exec.assert_done();
}

#[tokio::test]
async fn submodule_init_sync_fetch_build_expected_argv() {
    let fake = FakeExecutor::default();
    fake.expect(&["submodule", "init", "--", "lib"], ok(""));
    fake.expect(&["submodule", "sync", "--recursive", "--", "lib"], ok(""));
    fake.expect(&["-C", "lib", "fetch"], ok(""));
    let (b, exec) = backend(fake);

    b.submodule_init(&[PathBuf::from("lib")]).await.unwrap();
    b.submodule_sync(&[PathBuf::from("lib")], true).await.unwrap();
    b.submodule_fetch(Path::new("lib"), OperationId("op".into())).await.unwrap();
    exec.assert_done();
}

#[tokio::test]
async fn superproject_path_maps_empty_output_to_none() {
    let fake = FakeExecutor::default();
    fake.expect(&["rev-parse", "--show-superproject-working-tree"], ok("/home/u/super\n"));
    fake.expect(&["rev-parse", "--show-superproject-working-tree"], ok("\n"));
    let (b, exec) = backend(fake);

    assert_eq!(
        b.superproject_path().await.unwrap(),
        Some(PathBuf::from("/home/u/super"))
    );
    assert_eq!(b.superproject_path().await.unwrap(), None);
    exec.assert_done();
}
```

- [x] **Step 3: Run to verify failure**

Run: `cargo test -p legit-core --lib submodule_update_builds 2>&1 | tail -3`
Expected: COMPILE ERROR (methods not on the trait).

- [x] **Step 4: Add the trait methods**

In `backend.rs`, after `submodule_log` (add `SubmoduleUpdateOptions` to the `crate::types` import):

```rust
    /// Register submodules in `.git/config` (`git submodule init`). Empty
    /// `paths` = all.
    async fn submodule_init(&self, paths: &[PathBuf]) -> Result<(), GitError>;

    /// Check out the recorded SHA (`git submodule update`), optionally
    /// registering (`--init`) and recursing. May fetch - cancellable.
    async fn submodule_update(
        &self,
        opts: SubmoduleUpdateOptions,
        op_id: OperationId,
    ) -> Result<(), GitError>;

    /// Copy `.gitmodules` URLs into `.git/config` and the submodules' origin
    /// remotes (`git submodule sync`). Empty `paths` = all.
    async fn submodule_sync(&self, paths: &[PathBuf], recursive: bool) -> Result<(), GitError>;

    /// Fetch inside one submodule (`git -C <path> fetch`). Cancellable.
    async fn submodule_fetch(&self, path: &Path, op_id: OperationId) -> Result<(), GitError>;

    /// The superproject working tree containing this repo, or `None` when the
    /// repo is not checked out as a submodule
    /// (`git rev-parse --show-superproject-working-tree`).
    async fn superproject_path(&self) -> Result<Option<PathBuf>, GitError>;
```

- [x] **Step 5: Implement in `cli_impl/mod.rs`**

After the `submodule_log` implementation (add `SubmoduleUpdateOptions` to the types import):

```rust
    async fn submodule_init(&self, paths: &[PathBuf]) -> Result<(), GitError> {
        if paths.is_empty() {
            return self.run_simple(&["submodule", "init"]).await;
        }
        self.run_pathspec(&["submodule", "init", "--"], paths).await
    }

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
        self.run_remote(&runner, &args, op_id).await
    }

    async fn submodule_sync(&self, paths: &[PathBuf], recursive: bool) -> Result<(), GitError> {
        let base: &[&str] = if recursive {
            &["submodule", "sync", "--recursive"]
        } else {
            &["submodule", "sync"]
        };
        if paths.is_empty() {
            return self.run_simple(base).await;
        }
        let mut with_sep: Vec<&str> = base.to_vec();
        with_sep.push("--");
        self.run_pathspec(&with_sep, paths).await
    }

    async fn submodule_fetch(&self, path: &Path, op_id: OperationId) -> Result<(), GitError> {
        let runner = self.runner().await;
        let args: Vec<String> = vec![
            "-C".into(),
            path.to_string_lossy().into_owned(),
            "fetch".into(),
        ];
        self.run_remote(&runner, &args, op_id).await
    }

    async fn superproject_path(&self) -> Result<Option<PathBuf>, GitError> {
        let runner = self.runner().await;
        let out = runner
            .run(&["rev-parse", "--show-superproject-working-tree"])
            .await
            .map_err(|e| GitError::Internal(e.to_string()))?;
        if !out.success {
            return Err(GitError::CommandFailed {
                exit_code: out.exit_code.unwrap_or(-1),
                stderr: out.stderr,
            });
        }
        let path = out.stdout.trim();
        Ok(if path.is_empty() { None } else { Some(PathBuf::from(path)) })
    }
```

Helper signatures verified against the code: `run_pathspec(&self, prefix: &[&str], paths: &[PathBuf])` (`cli_impl/mod.rs:92`), `run_simple(&self, args: &[&str])` (`cli_impl/mod.rs:430`), `run_remote(&self, runner, &args, op_id)` (per `fetch()`).

- [x] **Step 6: Run the flow tests**

Run: `cargo test -p legit-core --lib flow_tests 2>&1 | tail -3`
Expected: PASS (all, including the three new ones).

- [x] **Step 7: Real-git operations test**

Append to `tests/git_flows.rs` (reuses `repo_with_submodule`; `SubmoduleUpdateOptions` needs adding to the `use legit_core::{...}` list):

```rust
#[tokio::test]
async fn submodule_ops_roundtrip_deinit_init_update() {
    let (sup, _lib) = repo_with_submodule().await;

    // Make it uninitialized+unpopulated the way a fresh clone would be.
    sup.git(&["submodule", "deinit", "-f", "--", "lib"]).await;
    let subs = sup.backend.submodules().await.unwrap();
    assert!(!subs[0].state.initialized && !subs[0].state.populated);

    // init registers, update populates at the recorded SHA.
    sup.backend.submodule_init(&[PathBuf::from("lib")]).await.unwrap();
    let subs = sup.backend.submodules().await.unwrap();
    assert!(subs[0].state.initialized && !subs[0].state.populated);

    sup.backend
        .submodule_update(
            SubmoduleUpdateOptions { paths: vec![PathBuf::from("lib")], ..Default::default() },
            OperationId("t".into()),
        )
        .await
        .unwrap();
    let subs = sup.backend.submodules().await.unwrap();
    assert!(subs[0].state.populated && !subs[0].state.pointer_moved);

    // sync succeeds (URL copy is a no-op here but must not error).
    sup.backend.submodule_sync(&[PathBuf::from("lib")], false).await.unwrap();
}

#[tokio::test]
async fn superproject_path_resolves_from_inside_a_submodule() {
    let (sup, _lib) = repo_with_submodule().await;

    // Not a submodule: the superproject itself reports None.
    assert_eq!(sup.backend.superproject_path().await.unwrap(), None);

    // A backend opened on the submodule directory reports the superproject.
    let sub_path = sup.path.join("lib");
    let runner = GitRunner::for_repo("git", &sub_path);
    let sub_backend = GitCliBackend::new(Arc::new(RwLock::new(Arc::new(runner))));
    let sp = sub_backend.superproject_path().await.unwrap().expect("superproject");
    // Compare canonicalized: git may print a resolved (symlink-free) path.
    assert_eq!(
        std::fs::canonicalize(&sp).unwrap(),
        std::fs::canonicalize(&sup.path).unwrap()
    );
}
```

- [x] **Step 8: Run them**

Run: `cargo test -p legit-core --test git_flows submodule_ops -- --nocapture 2>&1 | tail -3` and `cargo test -p legit-core --test git_flows superproject_path 2>&1 | tail -3`
Expected: PASS both.

---

### Task 2: Discard resets submodule pointers

**Files:**
- Modify: `crates/legit-core/src/cli_impl/mod.rs` (the `discard` implementation)
- Modify: `crates/legit-core/src/cli_impl/flow_tests.rs` (extend the discard test section)
- Modify: `crates/legit-core/tests/git_flows.rs` (one real-git test)

**Interfaces:**
- Consumes: `FileState::SubmoduleChanged` status entries (tier 1), `run_pathspec`.
- Produces: `discard(paths)` routes `SubmoduleChanged` paths through `git submodule update --checkout --no-fetch -- <paths>`; tracked/untracked behavior unchanged.

- [x] **Step 1: Failing flow test**

Append to the discard section of `flow_tests.rs` (after `discard_restores_tracked_and_cleans_untracked`):

```rust
#[tokio::test]
async fn discard_resets_submodule_pointers_via_submodule_update() {
    let fake = FakeExecutor::default();
    // status: a moved submodule pointer, a modified file, an untracked file.
    fake.expect(
        &["status", "--porcelain=v2", "-z", "--untracked-files=all"],
        ok("1 .M SC.. 160000 160000 160000 aaaaaaa bbbbbbb lib\0\
            1 .M N... 100644 100644 100644 aaaaaaa bbbbbbb tracked.txt\0\
            ? untracked.txt\0"),
    );
    fake.expect(&["restore", "--worktree", "--", "tracked.txt"], ok(""));
    fake.expect(&["clean", "-f", "--", "untracked.txt"], ok(""));
    // The gitlink is NOT restore-able: it goes through submodule update.
    // --no-fetch: discarding must never touch the network; --checkout is the
    // explicit non-integrating mode.
    fake.expect(
        &["submodule", "update", "--checkout", "--no-fetch", "--", "lib"],
        ok(""),
    );
    let (b, exec) = backend(fake);

    b.discard(&[
        PathBuf::from("lib"),
        PathBuf::from("tracked.txt"),
        PathBuf::from("untracked.txt"),
    ])
    .await
    .unwrap();
    exec.assert_done();
}
```

- [x] **Step 2: Run to verify failure**

Run: `cargo test -p legit-core --lib discard_resets_submodule 2>&1 | tail -3`
Expected: FAIL - the current partition sends `lib` through `restore --worktree` (argv mismatch).

- [x] **Step 3: Implement the third partition**

Replace the body of `discard` in `cli_impl/mod.rs`:

```rust
    async fn discard(&self, paths: &[PathBuf]) -> Result<(), GitError> {
        if paths.is_empty() {
            return Ok(());
        }
        // Classify paths: untracked ones must be removed with `clean`, moved
        // submodule pointers reset via `submodule update` (restore does not
        // touch gitlink worktrees), the rest reverted with `restore
        // --worktree`. Raw entries suffice — no need to pay for the numstat
        // enrichment here.
        let status = self.status_entries().await?;
        let untracked: std::collections::HashSet<&std::path::Path> = status
            .iter()
            .filter(|f| f.state == FileState::Untracked)
            .map(|f| f.path.as_path())
            .collect();
        let submodules: std::collections::HashSet<&std::path::Path> = status
            .iter()
            .filter(|f| f.state == FileState::SubmoduleChanged && !f.staged)
            .map(|f| f.path.as_path())
            .collect();

        let mut untracked_paths = Vec::new();
        let mut submodule_paths = Vec::new();
        let mut tracked_paths = Vec::new();
        for p in paths {
            if untracked.contains(p.as_path()) {
                untracked_paths.push(p.clone());
            } else if submodules.contains(p.as_path()) {
                submodule_paths.push(p.clone());
            } else {
                tracked_paths.push(p.clone());
            }
        }

        if !tracked_paths.is_empty() {
            self.run_pathspec(&["restore", "--worktree", "--"], &tracked_paths)
                .await?;
        }
        if !untracked_paths.is_empty() {
            self.run_pathspec(&["clean", "-f", "--"], &untracked_paths)
                .await?;
        }
        if !submodule_paths.is_empty() {
            // --checkout resets to the recorded SHA; --no-fetch keeps discard
            // strictly local; git itself refuses to overwrite a dirty
            // submodule worktree, so this cannot destroy uncommitted work.
            self.run_pathspec(
                &["submodule", "update", "--checkout", "--no-fetch", "--"],
                &submodule_paths,
            )
            .await?;
        }
        Ok(())
    }
```

- [x] **Step 4: Run flow tests**

Run: `cargo test -p legit-core --lib flow_tests 2>&1 | tail -3`
Expected: PASS.

- [x] **Step 5: Real-git discard test**

Append to `tests/git_flows.rs`:

```rust
#[tokio::test]
async fn discard_resets_a_moved_submodule_pointer() {
    let (sup, _lib) = repo_with_submodule().await;
    let sub_path = sup.path.join("lib").to_string_lossy().into_owned();
    let recorded = sup.git(&["-C", &sub_path, "rev-parse", "HEAD"]).await.trim().to_string();
    sup.git(&["-C", &sub_path, "commit", "--allow-empty", "-m", "bump"]).await;

    sup.backend.discard(&[PathBuf::from("lib")]).await.unwrap();

    let now = sup.git(&["-C", &sub_path, "rev-parse", "HEAD"]).await.trim().to_string();
    assert_eq!(now, recorded, "pointer must be back at the recorded SHA");
    let status = sup.backend.status().await.unwrap();
    assert!(
        !status.iter().any(|s| s.path == PathBuf::from("lib")),
        "no residual submodule entry: {status:?}"
    );
}
```

- [x] **Step 6: Run it**

Run: `cargo test -p legit-core --test git_flows discard_resets_a_moved -- --nocapture 2>&1 | tail -3`
Expected: PASS.

---

### Task 3: Watcher `submodules` domain

**Files:**
- Modify: `src-tauri/src/watcher.rs` (`ChangeDomain` enum, `classify_git`, tests)
- Modify: `src/lib/types.ts:106-112` (`ChangeDomain` union)

**Interfaces:**
- Consumes: existing `classify`/`classify_git` structure.
- Produces: `ChangeDomain::Submodules` serialized as `"submodules"` - matches the tier-1 query key `[repoId, "submodules"]`. The tier-1 `withDerivedDomains` stays (it covers superproject index/worktree changes; this task covers `.git/modules/**` gitdir writes, which today classify as NOTHING).

- [x] **Step 1: Failing watcher tests**

Append to the watcher `tests` module:

```rust
    #[test]
    fn submodule_gitdir_head_move_hits_submodules_domain() {
        // A commit inside a submodule moves `.git/modules/<name>/HEAD`;
        // today that classifies as nothing and the UI goes stale.
        let wt = Path::new("/repo");
        let gd = Path::new("/repo/.git");
        let mut out = BTreeSet::new();
        classify(Path::new("/repo/.git/modules/lib/HEAD"), wt, gd, &Gitignore::empty(), &mut out);
        assert!(out.contains(&ChangeDomain::Submodules), "got {out:?}");
        assert!(out.contains(&ChangeDomain::Status), "pointer move shows in status too");
    }

    #[test]
    fn submodule_gitdir_refs_hit_submodules_even_for_slashed_names() {
        // Submodule names default to their path and may contain slashes:
        // `.git/modules/vendor/lib/refs/heads/main`.
        let wt = Path::new("/repo");
        let gd = Path::new("/repo/.git");
        let mut out = BTreeSet::new();
        classify(
            Path::new("/repo/.git/modules/vendor/lib/refs/heads/main"),
            wt, gd, &Gitignore::empty(), &mut out,
        );
        assert!(out.contains(&ChangeDomain::Submodules), "got {out:?}");
    }

    #[test]
    fn submodule_gitdir_objects_and_locks_stay_quiet() {
        let wt = Path::new("/repo");
        let gd = Path::new("/repo/.git");
        for noisy in [
            "/repo/.git/modules/lib/objects/aa/bbcc",
            "/repo/.git/modules/lib/index.lock",
            "/repo/.git/modules/lib/logs/HEAD",
            "/repo/.git/modules/lib/FETCH_HEAD",
        ] {
            let mut out = BTreeSet::new();
            classify(Path::new(noisy), wt, gd, &Gitignore::empty(), &mut out);
            assert!(out.is_empty(), "{noisy} classified as {out:?}");
        }
    }
```

- [x] **Step 2: Run to verify failure**

Run: `cargo test -p legit-app --lib watcher 2>&1 | tail -5` (if the crate has no `--lib` test target for this module, `cargo test -p legit-app submodule_gitdir 2>&1 | tail -5`)
Expected: COMPILE ERROR (`ChangeDomain::Submodules` missing).

- [x] **Step 3: Implement**

Add the variant to `ChangeDomain`:

```rust
    /// A merge/rebase/cherry-pick/revert started, advanced, or ended
    /// (MERGE_HEAD, MERGE_MSG, rebase-merge/, rebase-apply/, *_HEAD).
    OpState,
    /// Submodule state changed: a write inside a submodule gitdir
    /// (`.git/modules/**` HEAD/refs/index). Superproject-side triggers
    /// (index, `.gitmodules`) already arrive via `Status`, which the frontend
    /// derives into the submodules query (`withDerivedDomains`).
    Submodules,
```

In `classify_git`, add a `"modules"` arm to the `match` (before the catch-all):

```rust
        // A submodule's gitdir lives at `.git/modules/<name>/...`; the name
        // defaults to the submodule path, so it may contain slashes - classify
        // by tail components instead of locating the module boundary.
        "modules" => {
            let comps: Vec<String> = rel
                .components()
                .skip(1)
                .filter_map(|c| match c {
                    Component::Normal(s) => Some(s.to_string_lossy().into_owned()),
                    _ => None,
                })
                .collect();
            // Same noise filter as the superproject gitdir: object database,
            // reflogs, and FETCH_HEAD churn without UI-visible state changes
            // (lock files are already filtered above).
            if comps.iter().any(|c| c == "objects" || c == "logs" || c == "FETCH_HEAD") {
                return;
            }
            if comps
                .iter()
                .any(|c| c == "HEAD" || c == "index" || c == "refs" || c == "packed-refs")
            {
                out.insert(ChangeDomain::Submodules);
                // A submodule HEAD move is a pointer move: visible in the
                // superproject's status as SubmoduleChanged.
                out.insert(ChangeDomain::Status);
            }
        }
```

Note the existing early return `if first == "objects" || first == "logs"` only matches the FIRST component, so `modules/...` reaches the `match` - do not restructure it.

- [x] **Step 4: Run watcher tests**

Run: `cargo test -p legit-app 2>&1 | tail -3`
Expected: PASS (all, including the three new).

- [x] **Step 5: Frontend union**

In `src/lib/types.ts`, extend `ChangeDomain`:

```ts
export type ChangeDomain =
  | "status"
  | "log"
  | "branches"
  | "stashes"
  | "tags"
  | "op_state"
  | "submodules";
```

Run: `npx tsc --noEmit` -> clean.

---

### Task 4: IPC commands + wrappers

**Files:**
- Modify: `src-tauri/src/commands/submodules.rs` (five new commands)
- Modify: `src-tauri/src/lib.rs` (`collect_commands![...]`)
- Modify: `src/lib/commands.ts` (wrappers under `// --- submodules ---`)
- Modify: `src/lib/types.ts` (`SubmoduleUpdateOptions` mirror)

**Interfaces:**
- Consumes: Task 1's backend methods.
- Produces (for Tasks 5-6): `repoSubmoduleInit(repoId, paths)`, `repoSubmoduleUpdate(repoId, opts, opId)`, `repoSubmoduleSync(repoId, paths, recursive)`, `repoSubmoduleFetch(repoId, path, opId)`, `repoSuperproject(repoId): Promise<string | null>`.

- [x] **Step 1: Commands**

Append to `src-tauri/src/commands/submodules.rs` (extend the `legit_core::types` import with `SubmoduleUpdateOptions`; add `use legit_core::OperationId;` matching `remote.rs`'s import style):

```rust
/// Register submodules (`git submodule init`).
#[tauri::command]
#[specta::specta]
pub async fn repo_submodule_init(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    paths: Vec<String>,
) -> Result<(), AppError> {
    let session = state.get_session(&repo_id).await?;
    let paths: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    session.backend.submodule_init(&paths).await.map_err(AppError::Git)
}

/// Check out recorded submodule SHAs (`git submodule update`). Cancellable.
#[tauri::command]
#[specta::specta]
pub async fn repo_submodule_update(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    opts: SubmoduleUpdateOptions,
    op_id: String,
) -> Result<(), AppError> {
    let session = state.get_session(&repo_id).await?;
    session
        .backend
        .submodule_update(opts, OperationId(op_id))
        .await
        .map_err(AppError::Git)
}

/// Re-sync submodule URLs (`git submodule sync`).
#[tauri::command]
#[specta::specta]
pub async fn repo_submodule_sync(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    paths: Vec<String>,
    recursive: bool,
) -> Result<(), AppError> {
    let session = state.get_session(&repo_id).await?;
    let paths: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    session
        .backend
        .submodule_sync(&paths, recursive)
        .await
        .map_err(AppError::Git)
}

/// Fetch inside one submodule. Cancellable.
#[tauri::command]
#[specta::specta]
pub async fn repo_submodule_fetch(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    path: String,
    op_id: String,
) -> Result<(), AppError> {
    let session = state.get_session(&repo_id).await?;
    session
        .backend
        .submodule_fetch(&PathBuf::from(path), OperationId(op_id))
        .await
        .map_err(AppError::Git)
}

/// The superproject working tree containing this repo, if any.
#[tauri::command]
#[specta::specta]
pub async fn repo_superproject(
    state: tauri::State<'_, AppState>,
    repo_id: String,
) -> Result<Option<String>, AppError> {
    let session = state.get_session(&repo_id).await?;
    let path = session.backend.superproject_path().await.map_err(AppError::Git)?;
    Ok(path.map(|p| p.to_string_lossy().into_owned()))
}
```

Register all five in `src-tauri/src/lib.rs` next to `commands::repo_submodules,`. Run: `cargo check -p legit-app 2>&1 | tail -3` -> clean.

- [x] **Step 2: TS mirrors + wrappers**

In `src/lib/types.ts` after `SubmoduleLog`:

```ts
/** Options for `git submodule update` (mirrors SubmoduleUpdateOptions). */
export interface SubmoduleUpdateOptions {
  init: boolean;
  recursive: boolean;
  paths: string[];
}
```

In `src/lib/commands.ts` under `// --- submodules ---` (extend the type import with `SubmoduleUpdateOptions`):

```ts
export const repoSubmoduleInit = (repoId: string, paths: string[]) =>
  invoke<void>("repo_submodule_init", { repoId, paths });

export const repoSubmoduleUpdate = (
  repoId: string,
  opts: SubmoduleUpdateOptions,
  opId: string,
) => invoke<void>("repo_submodule_update", { repoId, opts, opId });

export const repoSubmoduleSync = (repoId: string, paths: string[], recursive: boolean) =>
  invoke<void>("repo_submodule_sync", { repoId, paths, recursive });

export const repoSubmoduleFetch = (repoId: string, path: string, opId: string) =>
  invoke<void>("repo_submodule_fetch", { repoId, path, opId });

export const repoSuperproject = (repoId: string) =>
  invoke<string | null>("repo_superproject", { repoId });
```

Run: `npx tsc --noEmit` -> clean.

---

### Task 5: SubmodulesSection operations UI

**Files:**
- Modify: `src/panels/Submodules/SubmodulesSection.tsx` (ops + open-as-tab)

**Interfaces:**
- Consumes: Task 4 wrappers, `useRepoStore` (`openRepo(path)` at `src/store/repos.ts:132`), `submoduleBadge`, `invalidateRepoDomains`, `notify`, `ToolbarButton`, the `run()` busy pattern from `TagsSection` (`src/panels/Tags/TagsSection.tsx:83-101`).
- Produces: double-click row = open as peer tab; per-row Update / Init & Update / Sync / Fetch buttons; section-level "Update all" + recursive toggle.

- [x] **Step 1: Rewrite the section with operations**

Replace `src/panels/Submodules/SubmodulesSection.tsx` with:

```tsx
import { useCallback, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useActiveRepo, useRepoStore } from "../../store/repos";
import { usePanelFocusEffect } from "../PanelApiContext";
import {
  repoSubmoduleFetch,
  repoSubmoduleInit,
  repoSubmoduleSync,
  repoSubmoduleUpdate,
  repoSubmodules,
} from "../../lib/commands";
import { submoduleBadge } from "../../lib/submodules";
import { formatAppError, type SubmoduleInfo } from "../../lib/types";
import { invalidateRepoDomains } from "../../lib/repoInvalidation";
import { notify } from "../../store/notifications";
import { PanelLoadingBar } from "../shared/PanelLoadingBar";
import { ToolbarButton } from "../shared/ToolbarButton";

// Submodule ops touch the submodule list, the status view, and (after an
// update moves pointers) the log decorations.
const AFFECTED_DOMAINS = ["submodules", "status", "log"];

/**
 * Submodules section (spec 2026-07-08, tier 2): one row per submodule with
 * path, branch or "(detached)", state badge, and operations. Double-click
 * opens the submodule as a peer repo tab (sessions dedupe by toplevel).
 * Rendered as a pane inside the combined Refs panel, which supplies the
 * header.
 */
export function SubmodulesSection() {
  const repo = useActiveRepo();
  const queryClient = useQueryClient();
  const openRepo = useRepoStore((s) => s.openRepo);

  const { data: subs = [], isFetching, refetch } = useQuery<SubmoduleInfo[]>({
    queryKey: [repo?.id, "submodules"],
    queryFn: () => repoSubmodules(repo!.id),
    enabled: !!repo,
    staleTime: 5_000,
  });
  const reload = useCallback(() => { refetch(); }, [refetch]);
  usePanelFocusEffect(reload);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recursive, setRecursive] = useState(false);

  // Delayed busy + re-entry guard (see CLAUDE.md: fast ops must not flicker).
  const runningRef = useRef(false);
  const run = useCallback(
    async (fn: () => Promise<unknown>) => {
      if (!repo || runningRef.current) return;
      runningRef.current = true;
      const busyTimer = window.setTimeout(() => setBusy(true), 150);
      setError(null);
      try {
        await fn();
        invalidateRepoDomains(queryClient, repo.id, AFFECTED_DOMAINS);
      } catch (e) {
        setError(formatAppError(e));
      } finally {
        window.clearTimeout(busyTimer);
        runningRef.current = false;
        setBusy(false);
      }
    },
    [repo, queryClient],
  );

  // A submodule opens as its own peer repo tab; `register_open_repo` dedupes
  // by canonical toplevel, so re-opening focuses the existing tab.
  const openSubmodule = (info: SubmoduleInfo) => {
    if (!repo || !info.state.populated) return;
    openRepo(`${repo.path}/${info.path}`).catch((e) => notify.error(formatAppError(e)));
  };

  const updateAll = () =>
    run(() =>
      repoSubmoduleUpdate(
        repo!.id,
        { init: true, recursive, paths: [] },
        crypto.randomUUID(),
      ),
    );

  if (!repo) {
    return (
      <div className="legit-panel">
        <div className="legit-panel__body">
          <span className="legit-subtle">No repository open.</span>
        </div>
      </div>
    );
  }

  return (
    <div className="legit-panel" style={{ display: "flex", flexDirection: "column" }}>
      <PanelLoadingBar active={isFetching} />
      <div
        className="legit-panel__body"
        style={{ display: "flex", flexDirection: "column", gap: 6 }}
      >
        {error && (
          <pre className="legit-error" style={{ margin: 0, fontSize: "var(--fz-md)" }}>
            {error}
          </pre>
        )}

        {subs.length === 0 ? (
          <span className="legit-subtle" style={{ fontSize: "var(--fz-md)" }}>
            No submodules.
          </span>
        ) : (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <ToolbarButton
                label="Update all"
                title="git submodule update --init: check out the recorded commit of every submodule"
                disabled={busy}
                onClick={updateAll}
              />
              <label
                className="legit-subtle"
                style={{ display: "flex", alignItems: "center", gap: 4, fontSize: "var(--fz-sm)" }}
                title="Recurse into nested submodules (--recursive)"
              >
                <input
                  type="checkbox"
                  checked={recursive}
                  onChange={(e) => setRecursive(e.target.checked)}
                />
                recursive
              </label>
            </div>
            {subs.map((s) => (
              <SubmoduleRow
                key={s.name}
                info={s}
                busy={busy}
                onOpen={() => openSubmodule(s)}
                onInitUpdate={() =>
                  run(() =>
                    repoSubmoduleUpdate(
                      repo.id,
                      { init: true, recursive: false, paths: [s.path] },
                      crypto.randomUUID(),
                    ),
                  )
                }
                onUpdate={() =>
                  run(() =>
                    repoSubmoduleUpdate(
                      repo.id,
                      { init: false, recursive: false, paths: [s.path] },
                      crypto.randomUUID(),
                    ),
                  )
                }
                onSync={() =>
                  run(async () => {
                    await repoSubmoduleSync(repo.id, [s.path], false);
                    notify.success(`Synced URL for '${s.path}'`);
                  })
                }
                onFetch={() =>
                  run(() => repoSubmoduleFetch(repo.id, s.path, crypto.randomUUID()))
                }
              />
            ))}
          </>
        )}
      </div>
    </div>
  );
}

function SubmoduleRow({
  info,
  busy,
  onOpen,
  onInitUpdate,
  onUpdate,
  onSync,
  onFetch,
}: {
  info: SubmoduleInfo;
  busy: boolean;
  onOpen: () => void;
  onInitUpdate: () => void;
  onUpdate: () => void;
  onSync: () => void;
  onFetch: () => void;
}) {
  const badge = submoduleBadge(info);
  const sha = info.checked_out_sha ?? info.recorded_sha;
  const uninitialized = !info.state.initialized || !info.state.populated;
  return (
    <div
      style={{
        border: "1px solid var(--panel-border)",
        borderRadius: 4,
        padding: "6px 10px",
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
      title={info.url ?? info.gitmodules_url ?? undefined}
      onDoubleClick={onOpen}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          style={{
            fontSize: "var(--fz-md)",
            fontFamily: "monospace",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={`${info.path} — double-click to open as a repo tab`}
        >
          {info.path}
        </span>
        <span className="legit-subtle" style={{ fontSize: "var(--fz-sm)", flexShrink: 0 }}>
          {info.state.populated ? info.head_branch ?? "(detached)" : ""}
        </span>
        {badge && (
          <span
            style={{
              fontSize: "var(--fz-sm)",
              color: badge.color,
              border: "1px solid currentColor",
              borderRadius: "0.75em",
              padding: "0 0.5em",
              flexShrink: 0,
            }}
          >
            {badge.label}
          </span>
        )}
        {sha && (
          <span
            className="legit-subtle"
            style={{
              fontSize: "var(--fz-sm)",
              fontFamily: "monospace",
              marginLeft: "auto",
              flexShrink: 0,
            }}
            title={sha}
          >
            {sha.slice(0, 8)}
          </span>
        )}
      </div>
      <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
        {uninitialized ? (
          <ToolbarButton
            label="Init && update"
            title="git submodule update --init: register and check out this submodule"
            disabled={busy}
            onClick={onInitUpdate}
          />
        ) : (
          <>
            <ToolbarButton
              label="Open"
              title="Open as a repo tab"
              disabled={busy}
              onClick={onOpen}
            />
            <ToolbarButton
              label="Update"
              title="git submodule update: check out the recorded commit (detaches HEAD)"
              disabled={busy || !info.state.pointer_moved}
              onClick={onUpdate}
            />
            <ToolbarButton
              label="Fetch"
              title="git fetch inside this submodule"
              disabled={busy}
              onClick={onFetch}
            />
            <ToolbarButton
              label="Sync"
              title="git submodule sync: copy the .gitmodules URL into the local config and the submodule's origin"
              disabled={busy}
              onClick={onSync}
            />
          </>
        )}
      </div>
    </div>
  );
}
```

Note: `"Init && update"` inside a JSX string literal renders as `Init && update` - use `{"Init & update"}` instead when writing the file.

- [x] **Step 2: Verify**

Run: `npx tsc --noEmit` -> clean.

---

### Task 6: Superproject backlink in the tab bar

**Files:**
- Modify: `src/icons/index.tsx` (add `SuperprojectIcon`)
- Modify: `src/panels/RepoTabBar.tsx:156-173` area (query + button next to the remote-page button)

**Interfaces:**
- Consumes: `repoSuperproject` (Task 4), `useRepoStore` `openRepo`.
- Produces: an "up to superproject" icon button, visible only when the active repo is a submodule checkout.

- [x] **Step 1: Icon**

In `src/icons/index.tsx`: add `CornerLeftUp` to the lucide import list and export (matching the `withDefaults` pattern used by the existing icons, e.g. `PushIcon`):

```ts
export const SuperprojectIcon = withDefaults(CornerLeftUp, "SuperprojectIcon");
```

- [x] **Step 2: Tab-bar button**

In `RepoTabBar.tsx`: import `SuperprojectIcon` (extend the `../icons` import) and `formatAppError` is already imported. Add below the `remoteWebUrl` query (line ~165):

```tsx
  // The superproject working tree when the active repo is a submodule
  // checkout (null otherwise). Keyed under the repo id; the value only
  // changes when the repo is re-parented on disk, so a long staleTime is fine.
  const openRepoFromStore = useRepoStore((s) => s.openRepo);
  const { data: superprojectPath = null } = useQuery<string | null>({
    queryKey: [activeRepoId, "superproject"],
    queryFn: () => repoSuperproject(activeRepoId!),
    enabled: !!activeRepoId,
    staleTime: 300_000,
  });
  const onOpenSuperproject = async () => {
    if (!superprojectPath) return;
    try {
      await openRepoFromStore(superprojectPath);
    } catch (e) {
      notify.error(formatAppError(e));
    }
  };
```

And in the actions block, before the editor button (inside the `activeRepoId && (...)` fragment):

```tsx
            {superprojectPath && (
              <button
                className="legit-tabs__icon"
                onClick={onOpenSuperproject}
                aria-label={`Open superproject ${superprojectPath}`}
                title={`This repo is a submodule — open its superproject (${superprojectPath})`}
              >
                <SuperprojectIcon />
              </button>
            )}
```

Add `repoSuperproject` to the `../lib/commands` import.

- [x] **Step 3: Verify**

Run: `npx tsc --noEmit` -> clean.

---

### Task 7: Full verification

- [x] **Step 1: Backend suites**

Run: `cargo test -p legit-core 2>&1 | grep "test result"` and `cargo test -p legit-app 2>&1 | tail -3`
Expected: all green (lib + git_flows + watcher tests).

- [x] **Step 2: Frontend type-check**

Run: `npx tsc --noEmit`
Expected: clean.

- [x] **Step 3: Hunk/line staging exclusion check (verify-by-design)**

Confirm (read, no change): submodule entries produce `DiffEntry::Submodule`, rendered by `SubmoduleDiffView` (no `DiffEditor`, no hunk/line actions) in both inline and split modes - the exclusion required by the spec is structural. If any code path still routes a gitlink diff into `DiffEditor`, stop and fix before closing out.

- [x] **Step 4: Hand off PowerShell verification to the user**

1. `npm test` - vitest suites (unchanged tests must stay green; no new vitest files in this tier).
2. `npm run tauri dev` - regenerate bindings; verify: double-click a submodule row opens it as a tab; the tab shows the superproject back-button when the submodule is active; Update all / per-row ops work; a commit inside a submodule (external terminal) live-refreshes the Submodules section via the new watcher domain; discarding a pointer move in Working Changes resets the submodule.
