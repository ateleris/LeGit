# Worktrees as Repos Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Do NOT use subagent-driven-development. Do NOT commit or push at any point: leave all changes uncommitted for Simon's review (this overrides any skill default).

**Goal:** Git worktree support where each worktree opens as its own repo tab, managed from a new "Worktrees" pane in the Refs panel (list / add / remove / prune), with live updates and correct error guidance - built so mode B (worktrees in one shared commit graph) can be layered on without rework.

**Architecture:** Standard vertical slice: pure porcelain parser + `GitBackend` methods in a new `cli_impl/worktrees.rs` (the `case_drift.rs` module pattern), Tauri commands, hand-written frontend wrappers, and a paneview section. Two cross-cutting pieces: a new `Worktrees` watcher domain (with `.git/worktrees/**` classification), and common-git-dir watching so a linked-worktree session live-updates on ref moves. Mode-B forward compatibility is carried by data shape, not by code: `WorktreeInfo.path` is the future worktree identity, `WorktreeInfo.head` feeds future graph decorations, and the `worktrees` domain/query already exists for the graph to consume.

**Tech Stack:** Rust (tokio, serde, specta), React + TypeScript, TanStack Query, dockview paneview, vitest, cargo test.

**Spec:** `design/2026-09-10-worktrees-parallel-graph.md` (mode analysis; sections 1-2 define the shared/per-worktree model and the staging this plan implements as "mode A"). The chat estimate of 2026-09-10 is folded into this plan.

## Global Constraints

- NEVER commit or push. All work stays uncommitted.
- No em-dashes anywhere (prose, comments, code, docs). Use hyphens or colons.
- Comments only for constraints not derivable from the code; no historical or what-changed comments.
- TDD for every behavior: failing test first, watch it fail, minimal code, watch it pass.
- Every colour via `var(--token)`; no new tokens are expected in this plan (reuse `--subtle-fg`, `--panel-border`, badge conventions).
- All destructive confirmations go through `confirmDialog` (store/confirm) and are gated by `useConfirmDestructive()` / the discard setting as noted per task.
- Rust verification runs from WSL: `cargo test -p legit-core --lib`, `cargo test -p legit-core --test git_flows`, `cargo test --workspace`. Frontend: `npx tsc --noEmit` (WSL) and vitest via `powershell.exe -NoProfile -Command "npx vitest run <path>"` (never npm install from WSL).
- specta regenerates `src/lib/bindings.ts` only when the app runs; the frontend uses hand-written wrappers in `src/lib/commands.ts` with hand-mirrored types in `src/lib/types.ts`. Add new commands in both places.
- Every user-visible change gets a CHANGELOG bullet (Task 8).

---

### Task 1: `WorktreeInfo` type + porcelain parser

**Files:**
- Modify: `crates/legit-core/src/types.rs` (next to `CaseDriftEntry`, ~line 1125)
- Create: `crates/legit-core/src/cli_impl/parsers/worktrees.rs`
- Modify: `crates/legit-core/src/cli_impl/parsers/mod.rs` (add `pub mod worktrees;` to the module list)

**Interfaces:**
- Produces: `WorktreeInfo { path: String, head: Option<String>, branch: Option<String>, is_main: bool, detached: bool, bare: bool, locked: Option<String>, prunable: Option<String> }`; `parsers::worktrees::WORKTREE_LIST_ARGS: [&str; 4]`; `parse_worktree_list(&str) -> Vec<WorktreeInfo>`.

- [x] **Step 1: Add the type to `types.rs`**

```rust
/// One entry of `git worktree list --porcelain`. `path` is the worktree's
/// absolute path ON ITS HOST and doubles as the stable worktree identity
/// (the future mode-B WorktreeId - see
/// design/2026-09-10-worktrees-parallel-graph.md). `head` is carried so the
/// commit graph can decorate worktree HEADs later without a new query.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct WorktreeInfo {
    pub path: String,
    /// HEAD commit sha; None only for a bare main entry.
    pub head: Option<String>,
    /// Short branch name (refs/heads/ stripped); None when detached or bare.
    pub branch: Option<String>,
    /// The first listed entry is the main worktree.
    pub is_main: bool,
    pub detached: bool,
    pub bare: bool,
    /// Present when locked; the lock reason ("" when none was given).
    pub locked: Option<String>,
    /// Present when prunable; git's reason.
    pub prunable: Option<String>,
}
```

- [x] **Step 2: Write the failing parser tests**

Create `crates/legit-core/src/cli_impl/parsers/worktrees.rs` with the const, a `todo!()` body, and this test module. The `-z` framing (verified against git 2.43 and 2.52): every attribute line is NUL-terminated, and an EMPTY token (a second consecutive NUL) terminates each record.

```rust
//! Parser for `git worktree list --porcelain -z` backing `worktree_list()`.
//! The format flags live next to the parser so the contract is in one place.

use crate::types::WorktreeInfo;

/// `-z`: attribute lines are NUL-terminated and each record ends with an
/// empty token, so paths with spaces/unicode pass through unquoted.
pub const WORKTREE_LIST_ARGS: [&str; 4] = ["worktree", "list", "--porcelain", "-z"];

pub fn parse_worktree_list(output: &str) -> Vec<WorktreeInfo> {
    todo!("implemented after the tests fail for the right reason")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Join attribute lines into a `-z` stream: NUL after every line, plus
    /// the record-terminating empty token where `""` appears.
    fn stream(lines: &[&str]) -> String {
        let mut s = lines.join("\0");
        s.push('\0');
        s
    }

    #[test]
    fn parses_main_linked_and_detached() {
        let out = stream(&[
            "worktree /repo", "HEAD 1111111111111111111111111111111111111111", "branch refs/heads/main", "",
            "worktree /wt-feature", "HEAD 2222222222222222222222222222222222222222", "branch refs/heads/feature", "",
            "worktree /wt-detached", "HEAD 3333333333333333333333333333333333333333", "detached", "",
        ]);
        let list = parse_worktree_list(&out);
        assert_eq!(list.len(), 3);
        assert!(list[0].is_main && !list[1].is_main && !list[2].is_main);
        assert_eq!(list[0].branch.as_deref(), Some("main"));
        assert_eq!(list[1].path, "/wt-feature");
        assert_eq!(list[1].head.as_deref(), Some("2222222222222222222222222222222222222222"));
        assert!(list[2].detached);
        assert_eq!(list[2].branch, None);
    }

    #[test]
    fn parses_locked_with_and_without_reason_and_prunable() {
        let out = stream(&[
            "worktree /repo", "HEAD 1111111111111111111111111111111111111111", "branch refs/heads/main", "",
            "worktree /wt-a", "HEAD 2222222222222222222222222222222222222222", "branch refs/heads/a", "locked", "",
            "worktree /wt-b", "HEAD 3333333333333333333333333333333333333333", "branch refs/heads/b", "locked usb drive", "",
            "worktree /wt-c", "HEAD 4444444444444444444444444444444444444444", "detached", "prunable gitdir file points to non-existent location", "",
        ]);
        let list = parse_worktree_list(&out);
        assert_eq!(list[1].locked.as_deref(), Some(""));
        assert_eq!(list[2].locked.as_deref(), Some("usb drive"));
        assert!(list[3].prunable.as_deref().unwrap_or("").contains("non-existent"));
        assert_eq!(list[0].locked, None);
    }

    #[test]
    fn parses_a_bare_main_entry() {
        let out = stream(&["worktree /repo.git", "bare", ""]);
        let list = parse_worktree_list(&out);
        assert_eq!(list.len(), 1);
        assert!(list[0].bare && list[0].is_main);
        assert_eq!(list[0].head, None);
    }

    #[test]
    fn empty_output_parses_to_empty() {
        assert_eq!(parse_worktree_list(""), Vec::new());
    }
}
```

Also add `pub mod worktrees;` to `crates/legit-core/src/cli_impl/parsers/mod.rs`.

- [x] **Step 3: Run tests, verify RED**

Run: `cargo test -p legit-core --lib parsers::worktrees`
Expected: FAIL, panicking on the `todo!` (not a compile error).

- [x] **Step 4: Implement the parser**

```rust
pub fn parse_worktree_list(output: &str) -> Vec<WorktreeInfo> {
    let mut out: Vec<WorktreeInfo> = Vec::new();
    let mut cur: Option<WorktreeInfo> = None;
    for token in output.split('\0') {
        if token.is_empty() {
            // Record terminator (and the stream's trailing NUL).
            if let Some(w) = cur.take() {
                out.push(w);
            }
            continue;
        }
        if let Some(path) = token.strip_prefix("worktree ") {
            if let Some(w) = cur.take() {
                out.push(w);
            }
            cur = Some(WorktreeInfo {
                path: path.to_string(),
                head: None,
                branch: None,
                is_main: out.is_empty(),
                detached: false,
                bare: false,
                locked: None,
                prunable: None,
            });
            continue;
        }
        let Some(w) = cur.as_mut() else { continue };
        if let Some(h) = token.strip_prefix("HEAD ") {
            w.head = Some(h.to_string());
        } else if let Some(b) = token.strip_prefix("branch ") {
            w.branch = Some(b.strip_prefix("refs/heads/").unwrap_or(b).to_string());
        } else if token == "detached" {
            w.detached = true;
        } else if token == "bare" {
            w.bare = true;
        } else if token == "locked" {
            w.locked = Some(String::new());
        } else if let Some(r) = token.strip_prefix("locked ") {
            w.locked = Some(r.to_string());
        } else if token == "prunable" {
            w.prunable = Some(String::new());
        } else if let Some(r) = token.strip_prefix("prunable ") {
            w.prunable = Some(r.to_string());
        }
    }
    if let Some(w) = cur.take() {
        out.push(w);
    }
    out
}
```

- [x] **Step 5: Run tests, verify GREEN**

Run: `cargo test -p legit-core --lib parsers::worktrees`
Expected: 4 passed.

---

### Task 2: Backend methods + checked-out-elsewhere classification + flow tests

**Files:**
- Create: `crates/legit-core/src/cli_impl/worktrees.rs`
- Modify: `crates/legit-core/src/cli_impl/mod.rs` (module decl next to `mod case_drift;`; trait delegation next to the `case_drift` delegations; `classify_switch_error` ~line 3134; `classify_branch_delete_error` just below it)
- Modify: `crates/legit-core/src/error.rs` (new variant near `BranchNotFullyMerged`)
- Modify: `crates/legit-core/src/types.rs` (add `WorktreeAddMode`)
- Modify: `crates/legit-core/src/backend.rs` (trait methods + `WorktreeAddMode`/`WorktreeInfo` in the `types::` import list)
- Test: `crates/legit-core/src/cli_impl/flow_tests.rs` (append), `crates/legit-core/src/cli_impl/worktrees.rs` (unit tests for the message extractor)

**Interfaces:**
- Consumes: `parsers::worktrees::{WORKTREE_LIST_ARGS, parse_worktree_list}`, `WorktreeInfo` (Task 1); existing `run_simple`, `ensure_success`, `safe_ref`.
- Produces: `GitBackend::worktree_list() -> Result<Vec<WorktreeInfo>, GitError>`, `GitBackend::worktree_add(path: &str, mode: &WorktreeAddMode)`, `GitBackend::worktree_remove(path: &str, force: bool)`, `GitBackend::worktree_prune()`; `GitError::CheckedOutInWorktree { branch: Option<String>, path: Option<String>, stderr: String }`; `WorktreeAddMode`.

- [x] **Step 1: Add `WorktreeAddMode` to `types.rs`**

```rust
/// How `worktree add` populates the new worktree. Detached checkouts are a
/// deliberate non-goal for v1 (add on demand).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WorktreeAddMode {
    /// Check out an existing local branch (git refuses one that is already
    /// checked out in another worktree).
    Checkout { branch: String },
    /// Create a new branch at `start_point` (HEAD when None) and check it out.
    NewBranch { name: String, start_point: Option<String> },
}
```

- [x] **Step 2: Add the error variant to `error.rs`**

Next to `BranchNotFullyMerged`:

```rust
/// A branch operation was refused because the branch is checked out in
/// another worktree (git allows a branch in only one worktree at a time).
/// `branch`/`path` are best-effort extractions from git's message so the
/// UI can name (and offer to open) that worktree.
#[error("branch is checked out in another worktree: {stderr}")]
CheckedOutInWorktree {
    branch: Option<String>,
    path: Option<String>,
    stderr: String,
},
```

- [x] **Step 3: Write the failing extractor tests**

Create `crates/legit-core/src/cli_impl/worktrees.rs`:

```rust
//! Worktree management for `GitCliBackend` (list/add/remove/prune) and the
//! checked-out-elsewhere message extractor.
//!
//! The `GitBackend` trait impl in `mod.rs` delegates to the same-named
//! inherent methods here (a trait impl cannot span files).

use crate::error::GitError;
use crate::executor::GitExecutor;
use crate::types::{WorktreeAddMode, WorktreeInfo};

use super::{parsers, safe_ref, GitCliBackend};

/// Best-effort (branch, worktree path) from git's two refusal messages:
/// switch/checkout: `fatal: '<branch>' is already checked out at '<path>'`;
/// branch delete (wording varies by git version):
/// `error: Cannot delete branch '<b>' checked out at '<path>'` or
/// `error: cannot delete branch '<b>' used by worktree at '<path>'`.
pub(super) fn parse_checked_out_elsewhere(stderr: &str) -> (Option<String>, Option<String>) {
    todo!("implemented after the tests fail for the right reason")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_branch_and_path_from_the_switch_refusal() {
        let (b, p) = parse_checked_out_elsewhere(
            "fatal: 'feature' is already checked out at '/home/u/wt-feature'",
        );
        assert_eq!(b.as_deref(), Some("feature"));
        assert_eq!(p.as_deref(), Some("/home/u/wt-feature"));
    }

    #[test]
    fn extracts_from_the_branch_delete_refusals() {
        let (b, p) = parse_checked_out_elsewhere(
            "error: Cannot delete branch 'feature' checked out at '/home/u/wt-feature'",
        );
        assert_eq!(b.as_deref(), Some("feature"));
        assert_eq!(p.as_deref(), Some("/home/u/wt-feature"));
        let (b2, p2) = parse_checked_out_elsewhere(
            "error: cannot delete branch 'f' used by worktree at '/w'",
        );
        assert_eq!(b2.as_deref(), Some("f"));
        assert_eq!(p2.as_deref(), Some("/w"));
    }

    #[test]
    fn unrecognized_message_yields_nones() {
        assert_eq!(parse_checked_out_elsewhere("fatal: something else"), (None, None));
    }
}
```

Register the module in `cli_impl/mod.rs` next to the existing decls:

```rust
mod case_drift;
mod line_endings;
mod worktrees;
```

- [x] **Step 4: Run, verify RED**

Run: `cargo test -p legit-core --lib worktrees::tests`
Expected: FAIL on the `todo!`.

- [x] **Step 5: Implement the extractor**

```rust
pub(super) fn parse_checked_out_elsewhere(stderr: &str) -> (Option<String>, Option<String>) {
    // Both messages quote the branch first and the path last.
    let quoted: Vec<&str> = stderr
        .split('\'')
        .skip(1)
        .step_by(2)
        .collect();
    match quoted.as_slice() {
        [branch, .., path] => (Some(branch.to_string()), Some(path.to_string())),
        _ => (None, None),
    }
}
```

- [x] **Step 6: Run, verify GREEN**

Run: `cargo test -p legit-core --lib worktrees::tests`
Expected: 3 passed.

- [x] **Step 7: Write the failing flow tests**

Append to `crates/legit-core/src/cli_impl/flow_tests.rs` (import `WorktreeAddMode, WorktreeInfo` in the existing `use crate::types::{...}` line):

```rust
// ---------------------------------------------------------------------------
// worktrees - list/add/remove sequences + checked-out-elsewhere classification
// ---------------------------------------------------------------------------

#[tokio::test]
async fn worktree_list_parses_the_porcelain_stream() {
    let fake = FakeExecutor::default();
    fake.expect(
        &["worktree", "list", "--porcelain", "-z"],
        ok("worktree /repo\0HEAD 1111111111111111111111111111111111111111\0branch refs/heads/main\0\0worktree /wt\0HEAD 2222222222222222222222222222222222222222\0branch refs/heads/feature\0\0"),
    );
    let (b, exec) = backend(fake);
    let list = b.worktree_list().await.unwrap();
    assert_eq!(list.len(), 2);
    assert!(list[0].is_main);
    assert_eq!(list[1].branch.as_deref(), Some("feature"));
    exec.assert_done();
}

#[tokio::test]
async fn worktree_add_variants_build_the_right_args() {
    let fake = FakeExecutor::default();
    fake.expect(&["worktree", "add", "--", "/wt", "feature"], ok(""));
    fake.expect(&["worktree", "add", "-b", "topic", "--", "/wt2"], ok(""));
    fake.expect(
        &["worktree", "add", "-b", "hotfix", "--", "/wt3", "v1.0"],
        ok(""),
    );
    let (b, exec) = backend(fake);
    b.worktree_add("/wt", &WorktreeAddMode::Checkout { branch: "feature".into() })
        .await
        .unwrap();
    b.worktree_add("/wt2", &WorktreeAddMode::NewBranch { name: "topic".into(), start_point: None })
        .await
        .unwrap();
    b.worktree_add(
        "/wt3",
        &WorktreeAddMode::NewBranch { name: "hotfix".into(), start_point: Some("v1.0".into()) },
    )
    .await
    .unwrap();
    exec.assert_done();
}

#[tokio::test]
async fn worktree_remove_passes_force_only_when_asked() {
    let fake = FakeExecutor::default();
    fake.expect(&["worktree", "remove", "--", "/wt"], ok(""));
    fake.expect(&["worktree", "remove", "--force", "--", "/wt"], ok(""));
    fake.expect(&["worktree", "prune"], ok(""));
    let (b, exec) = backend(fake);
    b.worktree_remove("/wt", false).await.unwrap();
    b.worktree_remove("/wt", true).await.unwrap();
    b.worktree_prune().await.unwrap();
    exec.assert_done();
}

#[tokio::test]
async fn switch_to_a_branch_checked_out_elsewhere_is_classified() {
    let fake = FakeExecutor::default();
    fake.expect(&["switch", "--end-of-options", "feature"], fail(128,
        "fatal: 'feature' is already checked out at '/home/u/wt-feature'"));
    let (b, exec) = backend(fake);
    let err = b
        .switch_branch("feature", SwitchDirtyBehavior::TryDirectly)
        .await
        .unwrap_err();
    match err {
        GitError::CheckedOutInWorktree { branch, path, .. } => {
            assert_eq!(branch.as_deref(), Some("feature"));
            assert_eq!(path.as_deref(), Some("/home/u/wt-feature"));
        }
        other => panic!("expected CheckedOutInWorktree, got {other:?}"),
    }
    exec.assert_done();
}
```

NOTE for the executor: `switch_branch` returns a `SwitchResult`; if the current signature wraps errors differently, mirror how the existing `switch_error_dirty_tree_is_classified` test in `cli_impl/tests` or flow tests obtains the classified error, and keep the assertion on the variant + fields unchanged.

- [x] **Step 8: Run, verify RED**

Run: `cargo test -p legit-core --lib flow_tests::worktree`
Expected: compile error (methods missing) first; add stubs (`todo!()` bodies, exact signatures from Step 9) so the failures become `todo!` panics, then re-run to see proper RED. Also run `cargo test -p legit-core --lib flow_tests::switch_to_a_branch` (RED: classified as `CommandFailed` today).

- [x] **Step 9: Implement the backend methods**

In `cli_impl/worktrees.rs`:

```rust
impl<E: GitExecutor + ?Sized> GitCliBackend<E> {
    pub(super) async fn worktree_list(&self) -> Result<Vec<WorktreeInfo>, GitError> {
        let runner = self.runner().await;
        let out = runner.run(&parsers::worktrees::WORKTREE_LIST_ARGS).await?;
        Self::ensure_success(&out)?;
        Ok(parsers::worktrees::parse_worktree_list(&out.stdout))
    }

    pub(super) async fn worktree_add(
        &self,
        path: &str,
        mode: &WorktreeAddMode,
    ) -> Result<(), GitError> {
        if path.trim().is_empty() {
            return Err(GitError::Internal("worktree path is empty".into()));
        }
        match mode {
            WorktreeAddMode::Checkout { branch } => {
                let b = safe_ref("branch", branch)?;
                self.run_simple(&["worktree", "add", "--", path, b]).await
            }
            WorktreeAddMode::NewBranch { name, start_point } => {
                let n = safe_ref("branch", name)?;
                match start_point.as_deref() {
                    Some(s) => {
                        let s = safe_ref("revision", s)?;
                        self.run_simple(&["worktree", "add", "-b", n, "--", path, s]).await
                    }
                    None => self.run_simple(&["worktree", "add", "-b", n, "--", path]).await,
                }
            }
        }
    }

    pub(super) async fn worktree_remove(&self, path: &str, force: bool) -> Result<(), GitError> {
        if force {
            self.run_simple(&["worktree", "remove", "--force", "--", path]).await
        } else {
            self.run_simple(&["worktree", "remove", "--", path]).await
        }
    }

    pub(super) async fn worktree_prune(&self) -> Result<(), GitError> {
        self.run_simple(&["worktree", "prune"]).await
    }
}
```

Trait methods in `backend.rs` (add `WorktreeAddMode, WorktreeInfo` to its `types::` import):

```rust
/// All worktrees of this repo (`git worktree list`), main first.
async fn worktree_list(&self) -> Result<Vec<WorktreeInfo>, GitError>;

/// Create a worktree at `path` (absolute, on the repo's host).
async fn worktree_add(&self, path: &str, mode: &WorktreeAddMode) -> Result<(), GitError>;

/// Remove a worktree checkout. Without `force` git refuses a dirty tree.
async fn worktree_remove(&self, path: &str, force: bool) -> Result<(), GitError>;

/// Drop stale bookkeeping of manually deleted worktrees.
async fn worktree_prune(&self) -> Result<(), GitError>;
```

Delegations in `cli_impl/mod.rs` (next to the `case_drift` delegations, same one-liner shape):

```rust
async fn worktree_list(&self) -> Result<Vec<WorktreeInfo>, GitError> {
    self.worktree_list().await
}

async fn worktree_add(&self, path: &str, mode: &WorktreeAddMode) -> Result<(), GitError> {
    self.worktree_add(path, mode).await
}

async fn worktree_remove(&self, path: &str, force: bool) -> Result<(), GitError> {
    self.worktree_remove(path, force).await
}

async fn worktree_prune(&self) -> Result<(), GitError> {
    self.worktree_prune().await
}
```

Add `WorktreeAddMode, WorktreeInfo` to the `use crate::types::{...}` list in `cli_impl/mod.rs`.

Classification in `classify_switch_error` (insert BEFORE the `invalid reference` check):

```rust
if lc.contains("already checked out at") || lc.contains("used by worktree at") {
    let (branch, path) = worktrees::parse_checked_out_elsewhere(stderr);
    return GitError::CheckedOutInWorktree {
        branch,
        path,
        stderr: stderr.trim().to_string(),
    };
}
```

And the same arm at the TOP of `classify_branch_delete_error` (delete refusals use the "used by worktree at" wording on current git). Make `parse_checked_out_elsewhere` reachable: it is `pub(super)` in `worktrees.rs`, referenced as `worktrees::parse_checked_out_elsewhere` from `mod.rs` (adjust the module decl to keep it private outside `cli_impl`).

- [x] **Step 10: Run, verify GREEN**

Run: `cargo test -p legit-core --lib`
Expected: all pass (including the four new flow tests and the extractor tests).

---

### Task 3: Real-git suite coverage

**Files:**
- Modify: `crates/legit-core/tests/suite/git_flows_suite.rs` (append; also add `WorktreeAddMode` to its `use legit_core::{...}` import)

**Interfaces:**
- Consumes: Task 2's backend methods and error variant; the suite's `TestRepo` helpers (`init`, `git`, `write`, `commit_all`).

- [x] **Step 1: Write the tests (they must pass immediately against real git - they validate the encoded assumptions, mirroring the suite's purpose)**

```rust
// ---------------------------------------------------------------------------
// Worktrees
// ---------------------------------------------------------------------------

#[tokio::test]
async fn worktree_add_list_remove_round_trip() {
    let repo = TestRepo::init().await;
    repo.write("f.txt", "x\n");
    repo.commit_all("init").await;
    repo.git(&["branch", "feature"]).await;

    let wt = repo.path.join("..").join(format!(
        "wt-{}",
        repo.path.file_name().unwrap().to_string_lossy()
    ));
    let wt_str = wt.to_string_lossy().into_owned();
    repo.backend
        .worktree_add(&wt_str, &WorktreeAddMode::Checkout { branch: "feature".into() })
        .await
        .expect("worktree_add");

    let list = repo.backend.worktree_list().await.expect("worktree_list");
    assert_eq!(list.len(), 2, "{list:?}");
    assert!(list[0].is_main);
    assert_eq!(list[1].branch.as_deref(), Some("feature"));
    assert!(list[1].head.is_some());

    // A dirty worktree refuses a plain remove; force removes it.
    std::fs::write(wt.join("dirty.txt"), "x").expect("write");
    assert!(repo.backend.worktree_remove(&wt_str, false).await.is_err());
    repo.backend.worktree_remove(&wt_str, true).await.expect("force remove");
    let list = repo.backend.worktree_list().await.expect("list after remove");
    assert_eq!(list.len(), 1);
}

#[tokio::test]
async fn switch_refusal_names_the_other_worktree() {
    // Pins the real message wording the classifier matches on.
    let repo = TestRepo::init().await;
    repo.write("f.txt", "x\n");
    repo.commit_all("init").await;
    repo.git(&["branch", "feature"]).await;
    let wt = repo.path.join("..").join(format!(
        "wtc-{}",
        repo.path.file_name().unwrap().to_string_lossy()
    ));
    let wt_str = wt.to_string_lossy().into_owned();
    repo.backend
        .worktree_add(&wt_str, &WorktreeAddMode::Checkout { branch: "feature".into() })
        .await
        .expect("worktree_add");

    let err = repo
        .backend
        .switch_branch("feature", SwitchDirtyBehavior::TryDirectly)
        .await
        .expect_err("switch to a branch checked out elsewhere must refuse");
    match err {
        GitError::CheckedOutInWorktree { branch, path, .. } => {
            assert_eq!(branch.as_deref(), Some("feature"));
            assert!(path.is_some(), "the refusal names the worktree path");
        }
        other => panic!("expected CheckedOutInWorktree, got {other:?}"),
    }
    repo.backend.worktree_remove(&wt_str, true).await.expect("cleanup");
}
```

NOTE for the executor: the suite's tempdirs nest, so `repo.path.join("..")` lands inside the same `TempDir` root and is cleaned up with it. If `switch_branch`'s error type differs (outcome vs error), mirror how the suite's existing switch tests obtain a refusal and keep the variant assertion.

- [x] **Step 2: Run, verify GREEN**

Run: `cargo test -p legit-core --test git_flows -- worktree switch_refusal`
Expected: both pass. If the branch-delete wording assertion path is ever exercised, git's actual message keeps the classifier honest here.

---

### Task 4: Tauri commands + frontend wrappers/types

**Files:**
- Create: `src-tauri/src/commands/worktrees.rs`
- Modify: `src-tauri/src/commands/mod.rs` (`pub mod worktrees;` in the alphabetical list; it uses `pub mod` + `pub use working::*;` style - mirror the `pub use` if other modules re-export, otherwise reference as `commands::worktrees::...`)
- Modify: `src-tauri/src/lib.rs` (`collect_commands![...]` next to `commands::repo_case_drift`)
- Modify: `src/lib/types.ts` (WorktreeInfo + WorktreeAddMode mirrors, near `CaseDriftEntry` ~line 952)
- Modify: `src/lib/commands.ts` (wrappers near `repoCaseDrift` ~line 910; add `WorktreeAddMode, WorktreeInfo` to the type import list)

**Interfaces:**
- Consumes: `GitBackend::worktree_*` (Task 2).
- Produces: commands `repo_worktree_list`, `repo_worktree_add`, `repo_worktree_remove`, `repo_worktree_prune`; wrappers `repoWorktreeList(repoId): Promise<WorktreeInfo[]>`, `repoWorktreeAdd(repoId, path, mode: WorktreeAddMode)`, `repoWorktreeRemove(repoId, path, force)`, `repoWorktreePrune(repoId)`; TS `WorktreeInfo`, `WorktreeAddMode`.

- [x] **Step 1: Write the command handlers**

`src-tauri/src/commands/worktrees.rs`:

```rust
//! Worktree management commands. Backs the Refs panel's Worktrees pane.

use crate::error::AppError;
use crate::state::AppState;
use legit_core::types::WorktreeAddMode;

/// All worktrees of the repo, main first.
#[tauri::command]
#[specta::specta]
pub async fn repo_worktree_list(
    state: tauri::State<'_, AppState>,
    repo_id: String,
) -> Result<Vec<legit_core::WorktreeInfo>, AppError> {
    let session = state.get_session(&repo_id).await?;
    session.backend.worktree_list().await.map_err(AppError::Git)
}

/// Create a worktree at `path` (absolute, on the repo's host).
#[tauri::command]
#[specta::specta]
pub async fn repo_worktree_add(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    path: String,
    mode: WorktreeAddMode,
) -> Result<(), AppError> {
    let session = state.get_session(&repo_id).await?;
    session
        .backend
        .worktree_add(&path, &mode)
        .await
        .map_err(AppError::Git)
}

/// Remove a worktree checkout; `force` also drops a dirty tree.
#[tauri::command]
#[specta::specta]
pub async fn repo_worktree_remove(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    path: String,
    force: bool,
) -> Result<(), AppError> {
    let session = state.get_session(&repo_id).await?;
    session
        .backend
        .worktree_remove(&path, force)
        .await
        .map_err(AppError::Git)
}

/// Drop stale bookkeeping of manually deleted worktrees.
#[tauri::command]
#[specta::specta]
pub async fn repo_worktree_prune(
    state: tauri::State<'_, AppState>,
    repo_id: String,
) -> Result<(), AppError> {
    let session = state.get_session(&repo_id).await?;
    session.backend.worktree_prune().await.map_err(AppError::Git)
}
```

Register the module in `commands/mod.rs` and the four commands in `lib.rs`'s `collect_commands![]` right after `commands::repo_discard_case_rename` (namespace-qualify as the file's existing entries do).

- [x] **Step 2: Build to verify**

Run: `cargo build -p legit-app`
Expected: compiles cleanly.

- [x] **Step 3: Add the TS mirrors**

`src/lib/types.ts`, next to `CaseDriftEntry`:

```ts
/** One entry of `git worktree list` (matches legit-core `WorktreeInfo`).
 * `path` is absolute ON THE REPO'S HOST and is the worktree's identity. */
export interface WorktreeInfo {
  path: string;
  /** HEAD commit sha; null only for a bare main entry. */
  head: string | null;
  /** Short branch name; null when detached or bare. */
  branch: string | null;
  /** The first listed entry is the main worktree. */
  is_main: boolean;
  detached: boolean;
  bare: boolean;
  /** Present when locked; the lock reason ("" when none was given). */
  locked: string | null;
  /** Present when prunable; git's reason. */
  prunable: string | null;
}

/** How `worktree add` populates the new worktree (matches `WorktreeAddMode`). */
export type WorktreeAddMode =
  | { kind: "checkout"; branch: string }
  | { kind: "new_branch"; name: string; start_point: string | null };
```

`src/lib/commands.ts`, next to `repoCaseDrift`:

```ts
/** All worktrees of the repo, main first. */
export const repoWorktreeList = (repoId: string) =>
  invoke<WorktreeInfo[]>("repo_worktree_list", { repoId });

export const repoWorktreeAdd = (repoId: string, path: string, mode: WorktreeAddMode) =>
  invoke<null>("repo_worktree_add", { repoId, path, mode });

export const repoWorktreeRemove = (repoId: string, path: string, force: boolean) =>
  invoke<null>("repo_worktree_remove", { repoId, path, force });

export const repoWorktreePrune = (repoId: string) =>
  invoke<null>("repo_worktree_prune", { repoId });
```

- [x] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean.

---

### Task 5: Watcher - `Worktrees` domain + common-git-dir watching

**Files:**
- Modify: `crates/legit-watch/src/lib.rs` (`ChangeDomain` enum ~line 76; `classify` / `classify_git`; `WatcherCore::start`; `path_contribution`; `display_path`; tests module)
- Modify: `src-tauri/src/watcher.rs` (`all_domains()` ~line 59)
- Modify: `src/lib/types.ts` (`ChangeDomain` union ~line 230)

**Interfaces:**
- Produces: `ChangeDomain::Worktrees` (wire string `"worktrees"`); linked-worktree sessions receive ref/object events from the shared git dir; `.git/worktrees/**` events classify to `Worktrees`.
- Mode-B note: this is exactly the watch topology mode B needs per worktree; nothing here is throwaway.

- [x] **Step 1: Write the failing classification + shape tests**

Append to the tests module in `crates/legit-watch/src/lib.rs`:

```rust
#[test]
fn worktree_metadata_classifies_to_the_worktrees_domain_only() {
    // Add/remove/lock of linked worktrees, and OTHER worktrees' HEAD moves,
    // live under .git/worktrees/** - they drive the Worktrees pane, not
    // this session's status/log.
    let wt = Path::new("/repo");
    let gd = Path::new("/repo/.git");
    for p in [
        "/repo/.git/worktrees/wt-a/HEAD",
        "/repo/.git/worktrees/wt-a/locked",
        "/repo/.git/worktrees/wt-a/gitdir",
    ] {
        let mut out = BTreeSet::new();
        classify(Path::new(p), wt, gd, None, &Gitignore::empty(), &mut out);
        assert_eq!(
            out.into_iter().collect::<Vec<_>>(),
            vec![ChangeDomain::Worktrees],
            "{p}"
        );
    }
}

#[test]
fn common_dir_of_detects_the_linked_gitdir_shape() {
    assert_eq!(
        common_dir_of(Path::new("/repo/.git/worktrees/wt-a")),
        Some(PathBuf::from("/repo/.git"))
    );
    assert_eq!(common_dir_of(Path::new("/repo/.git")), None);
    assert_eq!(common_dir_of(Path::new("/repo")), None);
}

#[test]
fn common_dir_events_classify_like_git_dir_events() {
    // A LINKED worktree's session: git_dir is the private
    // .git/worktrees/<name>; ref moves land in the COMMON dir and must
    // still drive log/branches.
    let wt = Path::new("/wt-a");
    let gd = Path::new("/repo/.git/worktrees/wt-a");
    let common = Path::new("/repo/.git");
    let mut out = BTreeSet::new();
    classify(
        Path::new("/repo/.git/refs/heads/main"),
        wt,
        gd,
        Some(common),
        &Gitignore::empty(),
        &mut out,
    );
    let got: Vec<_> = out.into_iter().collect();
    assert!(got.contains(&ChangeDomain::Log) && got.contains(&ChangeDomain::Branches), "{got:?}");
    // The session's OWN private gitdir still classifies via the git_dir
    // prefix (checked before the common one).
    let mut own = BTreeSet::new();
    classify(
        Path::new("/repo/.git/worktrees/wt-a/HEAD"),
        wt,
        gd,
        Some(common),
        &Gitignore::empty(),
        &mut own,
    );
    assert!(own.contains(&ChangeDomain::Log), "own HEAD is a HEAD move: {own:?}");
}
```

Existing `classify(...)` calls in the tests take no `common` argument; this task changes the signature, so every existing call site in the tests gets `None` inserted (mechanical; the `domains` helper in the tests wraps it).

- [x] **Step 2: Run, verify RED**

Run: `cargo test -p legit-watch`
Expected: compile errors (no `Worktrees` variant, no `common_dir_of`, `classify` arity), then after stubbing (`Worktrees` variant added, `common_dir_of` with `todo!()`, `classify` accepting `Option<&Path>` but ignoring it) the three new tests FAIL.

- [x] **Step 3: Implement**

1. Enum: add `Worktrees,` to `ChangeDomain` (serde snake_case renames it to `"worktrees"` on the wire).
2. `common_dir_of`:

```rust
/// The shared git dir behind a LINKED worktree's private gitdir
/// (`<common>/worktrees/<name>` -> `<common>`); None for a main gitdir.
/// Path-shape based: that layout is git's on-disk contract for linked
/// worktrees, so no filesystem access is needed.
fn common_dir_of(git_dir: &Path) -> Option<PathBuf> {
    let parent = git_dir.parent()?;
    if parent.file_name()?.to_str()? != "worktrees" {
        return None;
    }
    parent.parent().map(Path::to_path_buf)
}
```

3. `classify` gains `common: Option<&Path>`: after the existing `strip_prefix(git_dir)` branch, add:

```rust
if let Some(common) = common {
    if let Ok(rel) = path.strip_prefix(common) {
        classify_git(rel, out);
        return;
    }
}
```

4. `classify_git` gains the arm (in the `match first.as_str()` block):

```rust
// Linked-worktree metadata (`.git/worktrees/<name>/...`): worktree
// add/remove/lock and other worktrees' HEAD moves. Drives the
// Worktrees pane only - another worktree's private state is not this
// session's status/log.
"worktrees" => {
    out.insert(ChangeDomain::Worktrees);
}
```

5. `WatcherCore::start`: compute `let common = common_dir_of(&git_dir);` before the debouncer closure; clone it into the closure and pass `common.as_deref()` through `path_contribution` -> `classify`. Register the watch after the git-dir watch, in BOTH modes (the common dir is bounded like a git dir, so recursive is fine even on Linux):

```rust
if let Some(c) = &common {
    debouncer.watch(c, RecursiveMode::Recursive)?;
}
```

(non-pruned mode: only when `!c.starts_with(&worktree)`, mirroring the git-dir condition.)
6. `path_contribution` gains the same `common: Option<&Path>` parameter, forwards it to `classify`, and the fingerprint gate condition becomes `path.starts_with(git_dir) || common.is_some_and(|c| path.starts_with(c))` (ref files in the common dir need the same dedupe). Update its unit-test call sites with `None`.
7. `display_path` tries the common dir after the git dir, rendering as `".git/<rel>"` as well.

- [x] **Step 4: Run, verify GREEN**

Run: `cargo test -p legit-watch`
Expected: all pass, including the pre-existing suite with `None` threaded through.

- [x] **Step 5: Write the failing real-fs watcher test (linked layout, ref write in common dir)**

Append to the same tests module:

```rust
#[test]
fn linked_worktree_watch_sees_common_dir_ref_moves() {
    use std::sync::mpsc;

    let tmp = tempfile::tempdir().unwrap();
    let main_git = tmp.path().join("repo/.git");
    let private = main_git.join("worktrees/wt-a");
    let wt = tmp.path().join("wt-a");
    std::fs::create_dir_all(main_git.join("refs/heads")).unwrap();
    std::fs::create_dir_all(&private).unwrap();
    std::fs::create_dir_all(&wt).unwrap();

    let (tx, rx) = mpsc::channel();
    let _core = WatcherCore::start(
        wt,
        private,
        Box::new(move |batch| {
            let _ = tx.send(batch);
        }),
    )
    .unwrap();

    std::fs::write(main_git.join("refs/heads/main"), "1111\n").unwrap();
    let batch = rx
        .recv_timeout(Duration::from_secs(5))
        .expect("a common-dir ref write must reach a linked worktree's watch");
    assert!(batch.domains.contains(&ChangeDomain::Branches), "{batch:?}");
}
```

- [x] **Step 6: Run, verify GREEN (RED first if Step 3's watch registration was incomplete)**

Run: `cargo test -p legit-watch linked_worktree_watch`
Expected: PASS.

- [x] **Step 7: Wire the domain through the app**

1. `src-tauri/src/watcher.rs` `all_domains()`: append `ChangeDomain::Worktrees`.
2. `src/lib/types.ts` `ChangeDomain` union: append `| "worktrees"`.
3. Run `cargo test --workspace` (the agent crate embeds legit-watch; its suite must stay green) and `npx tsc --noEmit`.
Expected: green. The frontend needs no mapping change: `useRepoChangeListener` invalidates `[repoId, <domain>]` generically, which is exactly the Task 6 query key.

---

### Task 6: Refs "Worktrees" pane

**Files:**
- Create: `src/panels/Worktrees/WorktreesSection.tsx`
- Create: `src/panels/Worktrees/worktreeRows.ts` (pure row/label helpers)
- Test: `src/panels/Worktrees/worktreeRows.test.ts`
- Modify: `src/lib/locator.ts` (add `worktreeLocator`), Test: `src/lib/locator.test.ts`
- Modify: `src/panels/Refs/RefsPanel.tsx` (`DEFAULT_PANES` ~line 36, `PANE_COMPONENTS` ~line 45, import list)
- Possibly modify: `src/panels/Refs/refsLayout.test.ts` / `refsPaneview.test.tsx` (pane-set expectations)

**Interfaces:**
- Consumes: `repoWorktreeList/Add/Remove/Prune`, `WorktreeInfo`, `WorktreeAddMode` (Task 4); `useRepoStore().openRepo(locator)`; `usePanelRunner`; `confirmDialog`; `useConfirmDestructive`; `invalidateRepoDomains`.
- Produces: pane id `"worktrees"`; `worktreeLocator(parentLocator: string, absPath: string): string`; `worktreeLabel(w: WorktreeInfo): string`; `worktreeBadges(w: WorktreeInfo, currentPath: string | null): string[]`.

- [x] **Step 1: Write the failing pure-helper tests**

`src/lib/locator.test.ts`, append:

```ts
describe("worktreeLocator", () => {
  it("keeps a local worktree path as a bare locator", () => {
    expect(worktreeLocator("C:/repos/app", "C:/repos/app-wt")).toBe("C:/repos/app-wt");
  });
  it("keeps the wsl scheme and distro for a WSL parent", () => {
    expect(worktreeLocator("wsl://Ubuntu/home/u/app", "/home/u/app-wt")).toBe(
      "wsl://Ubuntu/home/u/app-wt",
    );
  });
});
```

(add `worktreeLocator` to the existing import from `./locator`.)

`src/panels/Worktrees/worktreeRows.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { worktreeBadges, worktreeLabel } from "./worktreeRows";
import type { WorktreeInfo } from "../../lib/types";

const wt = (over: Partial<WorktreeInfo>): WorktreeInfo => ({
  path: "/home/u/app-wt",
  head: "1111111111111111111111111111111111111111",
  branch: "feature",
  is_main: false,
  detached: false,
  bare: false,
  locked: null,
  prunable: null,
  ...over,
});

describe("worktreeLabel", () => {
  it("uses the last path segment", () => {
    expect(worktreeLabel(wt({ path: "/home/u/app-wt" }))).toBe("app-wt");
    expect(worktreeLabel(wt({ path: "C:/repos/app-wt" }))).toBe("app-wt");
    expect(worktreeLabel(wt({ path: "C:\\repos\\app-wt" }))).toBe("app-wt");
  });
});

describe("worktreeBadges", () => {
  it("orders main/current/detached/locked/prunable", () => {
    expect(worktreeBadges(wt({ is_main: true }), null)).toEqual(["main"]);
    expect(worktreeBadges(wt({}), "/home/u/app-wt")).toEqual(["current"]);
    expect(worktreeBadges(wt({ detached: true, branch: null }), null)).toEqual(["detached"]);
    expect(worktreeBadges(wt({ locked: "usb" }), null)).toEqual(["locked"]);
    expect(worktreeBadges(wt({ prunable: "gone" }), null)).toEqual(["prunable"]);
    expect(worktreeBadges(wt({ is_main: true, locked: "" }), "/home/u/app-wt")).toEqual([
      "main",
      "current",
      "locked",
    ]);
  });
});
```

- [x] **Step 2: Run, verify RED**

Run: `powershell.exe -NoProfile -Command "npx vitest run src/panels/Worktrees src/lib/locator.test.ts"`
Expected: FAIL (helpers missing).

- [x] **Step 3: Implement the helpers**

`src/lib/locator.ts`:

```ts
/** Locator for a worktree at `absPath` - absolute ON THE REPO'S HOST, as
 * `git worktree list` reports it - on the same host as `parentLocator`.
 * Local repos: the path IS the locator; WSL repos keep scheme + distro. */
export function worktreeLocator(parentLocator: string, absPath: string): string {
  const m = /^wsl:\/\/([^/]+)\//.exec(parentLocator);
  return m ? `wsl://${m[1]}${absPath}` : absPath;
}
```

`src/panels/Worktrees/worktreeRows.ts`:

```ts
import type { WorktreeInfo } from "../../lib/types";

/** Row label: the worktree folder's name (paths may be posix or Windows). */
export function worktreeLabel(w: WorktreeInfo): string {
  const parts = w.path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? w.path;
}

/** Badge strings for a row, in display order. `currentPath` is the open
 * session's own worktree path (its row gets "current" instead of an Open
 * action). */
export function worktreeBadges(w: WorktreeInfo, currentPath: string | null): string[] {
  const out: string[] = [];
  if (w.is_main) out.push("main");
  if (currentPath !== null && w.path === currentPath) out.push("current");
  if (w.detached) out.push("detached");
  if (w.locked !== null) out.push("locked");
  if (w.prunable !== null) out.push("prunable");
  return out;
}
```

- [x] **Step 4: Run, verify GREEN**

Run: `powershell.exe -NoProfile -Command "npx vitest run src/panels/Worktrees src/lib/locator.test.ts"`
Expected: PASS.

- [x] **Step 5: Build the section component**

`src/panels/Worktrees/WorktreesSection.tsx` - mirror `SubmodulesSection`'s skeleton (query + `usePanelRunner` + rows + a header-adjacent action row). Full component:

```tsx
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useActiveRepo, useRepoStore } from "../../store/repos";
import { useConfirmDestructive } from "../../store/settings";
import {
  repoWorktreeAdd,
  repoWorktreeList,
  repoWorktreePrune,
  repoWorktreeRemove,
} from "../../lib/commands";
import type { Branch, WorktreeAddMode, WorktreeInfo } from "../../lib/types";
import { repoBranches } from "../../lib/commands";
import { formatAppError } from "../../lib/types";
import { worktreeLocator } from "../../lib/locator";
import { notify } from "../../store/notifications";
import { confirmDialog } from "../../store/confirm";
import { usePanelRunner } from "../shared/usePanelRunner";
import { invalidateRepoDomains } from "../../lib/repoInvalidation";
import { ToolbarButton } from "../shared/ToolbarButton";
import { worktreeBadges, worktreeLabel } from "./worktreeRows";

/** The Refs panel's Worktrees pane: list, open-as-tab, add, remove, prune. */
export function WorktreesSection() {
  const repo = useActiveRepo();
  const queryClient = useQueryClient();
  const openRepo = useRepoStore((s) => s.openRepo);
  const confirmDestructive = useConfirmDestructive();
  const [adding, setAdding] = useState(false);
  const [addPath, setAddPath] = useState("");
  const [addMode, setAddMode] = useState<"new_branch" | "checkout">("new_branch");
  const [addBranch, setAddBranch] = useState("");

  const { data: worktrees = [] } = useQuery<WorktreeInfo[]>({
    queryKey: [repo?.id, "worktrees"],
    queryFn: () => repoWorktreeList(repo!.id),
    enabled: !!repo,
    staleTime: 5_000,
  });
  // Existing local branches feed the checkout mode's picker; branches
  // checked out in some worktree are filtered out (git would refuse).
  const { data: branches = [] } = useQuery<Branch[]>({
    queryKey: [repo?.id, "branches"],
    queryFn: () => repoBranches(repo!.id),
    enabled: !!repo && adding,
    staleTime: 5_000,
  });

  const refresh = () => {
    if (!repo) return;
    invalidateRepoDomains(queryClient, repo.id, ["worktrees", "branches", "log"]);
  };
  const { busy, run } = usePanelRunner({
    enabled: !!repo,
    onSuccess: refresh,
    onError: (e) => notify.error(formatAppError(e)),
  });

  if (!repo) return null;
  const currentPath = worktrees.find((w) => repo.path.replaceAll("\\", "/").endsWith(worktreeLabel(w)) && w.path.replaceAll("\\", "/") === repo.path.replaceAll("\\", "/"))?.path ?? null;

  const checkedOut = new Set(worktrees.map((w) => w.branch).filter(Boolean));
  const addableBranches = branches.filter((b) => !b.is_remote && !checkedOut.has(b.name));

  const submitAdd = () =>
    run(async () => {
      const mode: WorktreeAddMode =
        addMode === "new_branch"
          ? { kind: "new_branch", name: addBranch, start_point: null }
          : { kind: "checkout", branch: addBranch };
      await repoWorktreeAdd(repo.id, addPath, mode);
      setAdding(false);
      setAddPath("");
      setAddBranch("");
    });

  const requestRemove = async (w: WorktreeInfo) => {
    if (confirmDestructive) {
      const ok = await confirmDialog({
        title: "Remove worktree",
        message: "Deletes the worktree checkout from disk. The branch and its commits are kept.",
        detail: w.path,
        confirmLabel: "Remove",
      });
      if (!ok) return;
    }
    void run(async () => {
      try {
        await repoWorktreeRemove(repo.id, w.path, false);
      } catch (e) {
        // Dirty worktree: git refuses without --force. Always confirm the
        // force (data loss), independent of the confirm setting - this is
        // a data-loss warning, not a routine destructive confirm.
        const msg = formatAppError(e);
        if (!msg.includes("--force")) throw e;
        const ok = await confirmDialog({
          title: "Worktree has local changes",
          message: "Force-removing deletes its uncommitted changes permanently.",
          detail: w.path,
          confirmLabel: "Force remove",
        });
        if (!ok) return;
        await repoWorktreeRemove(repo.id, w.path, true);
      }
    });
  };

  return (
    <div className="legit-panel__body" style={{ padding: "4px 0", overflowY: "auto" }}>
      <div style={{ display: "flex", gap: 6, padding: "2px 8px" }}>
        <ToolbarButton label="Add…" disabled={busy} onClick={() => setAdding((a) => !a)} />
        {worktrees.some((w) => w.prunable !== null) && (
          <ToolbarButton
            label="Prune"
            disabled={busy}
            onClick={() => void run(() => repoWorktreePrune(repo.id))}
          />
        )}
      </div>
      {adding && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "4px 8px" }}>
          <input
            placeholder="Absolute path for the new worktree"
            value={addPath}
            onChange={(e) => setAddPath(e.target.value)}
          />
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <select
              value={addMode}
              onChange={(e) => setAddMode(e.target.value as "new_branch" | "checkout")}
            >
              <option value="new_branch">New branch</option>
              <option value="checkout">Existing branch</option>
            </select>
            {addMode === "new_branch" ? (
              <input
                placeholder="Branch name"
                value={addBranch}
                onChange={(e) => setAddBranch(e.target.value)}
                style={{ flex: 1, minWidth: 0 }}
              />
            ) : (
              <select
                value={addBranch}
                onChange={(e) => setAddBranch(e.target.value)}
                style={{ flex: 1, minWidth: 0 }}
              >
                <option value="">Select branch…</option>
                {addableBranches.map((b) => (
                  <option key={b.name} value={b.name}>
                    {b.name}
                  </option>
                ))}
              </select>
            )}
            <button
              disabled={busy || addPath.trim() === "" || addBranch.trim() === ""}
              onClick={() => void submitAdd()}
            >
              Create
            </button>
          </div>
        </div>
      )}
      {worktrees.map((w) => {
        const badges = worktreeBadges(w, currentPath);
        const isCurrent = badges.includes("current");
        return (
          <div
            key={w.path}
            title={w.locked ? `Locked${w.locked ? `: ${w.locked}` : ""}` : w.path}
            style={{ display: "flex", alignItems: "center", gap: 6, padding: "2px 8px", fontSize: "var(--fz-md)" }}
          >
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {worktreeLabel(w)}
            </span>
            <span className="legit-subtle" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {w.branch ?? (w.detached ? w.head?.slice(0, 8) : "")}
            </span>
            {badges.map((b) => (
              <span
                key={b}
                className="legit-subtle"
                style={{ fontSize: "var(--fz-xs)", border: "1px solid var(--panel-border)", borderRadius: 3, padding: "0 0.35em" }}
              >
                {b}
              </span>
            ))}
            <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
              {!isCurrent && (
                <ToolbarButton
                  label="Open"
                  disabled={busy}
                  onClick={() =>
                    void openRepo(worktreeLocator(repo.locator ?? repo.path, w.path)).catch(
                      (e: unknown) => notify.error(formatAppError(e)),
                    )
                  }
                />
              )}
              {!w.is_main && !isCurrent && (
                <ToolbarButton label="Remove" disabled={busy} onClick={() => void requestRemove(w)} />
              )}
            </span>
          </div>
        );
      })}
      {worktrees.length <= 1 && !adding && (
        <div className="legit-subtle" style={{ padding: "2px 8px", fontSize: "var(--fz-sm)" }}>
          No linked worktrees.
        </div>
      )}
    </div>
  );
}
```

Executor notes for this step:
- `currentPath` matching: `repo.path` is the session toplevel as the app stores it; on Windows the worktree list may use forward or back slashes. Normalize both sides with `.replaceAll("\\", "/")` and compare for equality only (drop the `endsWith` clause if it reads confusingly; exact normalized equality is the requirement).
- For WSL repos the path input stays a plain text field (a Windows folder picker would produce app-machine paths; this mirrors the `supportsRepoGitOverride` decision). A native folder picker for LOCAL repos is a nice-to-have: if added, use `open({ directory: true, multiple: false })` from `@tauri-apps/plugin-dialog` as `RepoAddMenu.tsx:80` does, gated on `!repo.locator?.startsWith("wsl://")`.
- Row layout uses the pane-body idiom (plain rows), not `.legit-panel__toolbar`; controls inside one row share one size (ToolbarButton throughout).

- [x] **Step 6: Register the pane**

`src/panels/Refs/RefsPanel.tsx`:
- import: `import { WorktreesSection } from "../Worktrees/WorktreesSection";`
- `DEFAULT_PANES`: add `{ id: "worktrees", title: "Worktrees", isExpanded: false },` after the `submodules` entry.
- `PANE_COMPONENTS`: add `worktrees: WorktreesSection,` (wrap like the neighbors if they adapt `IPaneviewPanelProps`; mirror exactly how `submodules` is declared).
The restore path already appends missing default panes to persisted layouts (`RefsPanel.tsx` ~line 220) and drops unknown ones (~line 156), so no migration is needed.

- [x] **Step 7: Typecheck + run the Refs layout tests**

Run: `npx tsc --noEmit` and `powershell.exe -NoProfile -Command "npx vitest run src/panels/Refs"`
Expected: tsc clean. If `refsLayout.test.ts` / `refsPaneview.test.tsx` enumerate the default pane ids, extend their expected sets with `"worktrees"`; the tests' own failure output names the spot.

- [x] **Step 8: Full frontend suite**

Run: `powershell.exe -NoProfile -Command "npm test"`
Expected: all pass.

---

### Task 7: Checked-out-elsewhere guidance in switch feedback

**Files:**
- Modify: `src/lib/switchFeedback.ts` (`formatSwitchError`, ~line 76)
- Test: `src/lib/switchFeedback.test.ts`

**Interfaces:**
- Consumes: `gitErrorKind(e)` (returns the `GitError` kind tag string) and the error's `details` payload `{ branch: string | null, path: string | null, stderr: string }` (Task 2's variant; serialized as `{ kind, details }` like `BranchNotFullyMerged` - see `src/lib/bindings.ts` for the wire shape once regenerated).

- [x] **Step 1: Write the failing test**

Append to `src/lib/switchFeedback.test.ts` (mirror how existing cases construct a GitError-shaped object; the app error envelope wraps it as the existing tests show):

```ts
it("names the other worktree for a checked-out-elsewhere refusal", () => {
  const e = {
    Git: {
      kind: "CheckedOutInWorktree",
      details: {
        branch: "feature",
        path: "/home/u/wt-feature",
        stderr: "fatal: 'feature' is already checked out at '/home/u/wt-feature'",
      },
    },
  };
  const msg = formatSwitchError(e);
  expect(msg).toContain("feature");
  expect(msg).toContain("/home/u/wt-feature");
  expect(msg.toLowerCase()).toContain("worktree");
});
```

Executor note: match the EXACT error-envelope shape the file's existing tests use (e.g. how the `WouldOverwriteLocalChanges` case builds its input); the shape above is indicative.

- [x] **Step 2: Run, verify RED**

Run: `powershell.exe -NoProfile -Command "npx vitest run src/lib/switchFeedback.test.ts"`
Expected: the new test FAILS (falls through to the generic message).

- [x] **Step 3: Implement**

In `formatSwitchError`, before the generic fallback:

```ts
if (gitErrorKind(e) === "CheckedOutInWorktree") {
  const d = gitErrorDetails<{ branch: string | null; path: string | null }>(e);
  const branch = d?.branch ? `"${d.branch}"` : "This branch";
  const where = d?.path ? ` (${d.path})` : "";
  return `${branch} is already checked out in another worktree${where}. Open that worktree to work on it, or create a new branch here.`;
}
```

If no `gitErrorDetails` helper exists next to `gitErrorKind` in `src/lib/types.ts`, add one:

```ts
/** The `details` payload of a GitError, when the error is one. */
export function gitErrorDetails<T>(e: unknown): T | null {
  const kind = gitErrorKind(e);
  if (kind === null) return null;
  const git = (e as { Git?: { details?: T } }).Git;
  return git?.details ?? null;
}
```

Executor note: `gitErrorKind` (types.ts ~line 358) shows the real envelope traversal; implement `gitErrorDetails` with the same traversal, whatever it is, and adjust the snippet accordingly.

- [x] **Step 4: Run, verify GREEN**

Run: `powershell.exe -NoProfile -Command "npx vitest run src/lib/switchFeedback.test.ts"`
Expected: PASS.

---

### Task 8: Bookkeeping + full verification

**Files:**
- Modify: `CHANGELOG.md` (Unreleased > Added)
- Modify: `BACKLOG.md` (Git features list; Smaller follow-ups)

**Interfaces:** none.

- [x] **Step 1: CHANGELOG bullet**

Under `## [Unreleased]` / `### Added`:

```markdown
- Worktree support: a new Worktrees section in the Refs panel lists all
  worktrees and can add (new or existing branch), open as a separate repo
  tab, remove (with a force offer for dirty trees), and prune. Switching
  to a branch that is checked out in another worktree now says which one.
```

- [x] **Step 2: BACKLOG updates**

- In "Git features (missing vs a normal client)", change the worktrees/bisect bullet to bisect only:

```markdown
- **Bisect.** The one whole-feature gap left vs a full-featured client
  (worktrees shipped 2026-09-10). Deferred to post v1.0.0 (decided
  2026-07-20).
```

- In "Smaller follow-ups", add:

```markdown
- **Worktrees, deferred slices** (2026-09-10; mode analysis in
  `design/2026-09-10-worktrees-parallel-graph.md`): stage B1 = show OTHER
  worktrees' HEADs as read-only decorations in the commit graph (the
  `worktree_list` query already carries the HEAD shas); detached-checkout
  mode for `worktree add`; lock/unlock actions; a native folder picker for
  the add form on local repos; a guided "open that worktree" action on the
  CheckedOutInWorktree refusal (today: message only).
```

- [x] **Step 3: Full verification**

Run, in order:
1. `cargo test --workspace` - expected: all green (includes the remote-agent gate).
2. `npx tsc --noEmit` - expected: clean.
3. `powershell.exe -NoProfile -Command "npm test"` - expected: all green.

- [x] **Step 4: Manual pass handoff**

Leave everything uncommitted. Tell Simon: dev-server restart required (workspace crates changed); suggested manual script in LeGit-Test: add a worktree on a new branch, open it as a tab, commit there, watch the main tab's log update live (the common-dir watch), switch main to that branch (expect the named refusal), remove the worktree with local changes (expect the force offer).

---

## Self-review notes

- Spec coverage: mode A scope from the design note's staging section is fully tasked (list/add/remove/prune, open-as-tab, live updates, refusal guidance); mode-B forward-compat carried via `WorktreeInfo.head`, path-as-identity, and the `worktrees` domain (design note sections 2 and 6, stage B1 pointer recorded in BACKLOG).
- Types consistent across tasks: `WorktreeInfo`/`WorktreeAddMode` (Tasks 1/2/4/6), `CheckedOutInWorktree { branch, path, stderr }` (Tasks 2/3/7), pane id `"worktrees"` = query domain `"worktrees"` (Tasks 5/6).
- Known soft spots called out inline as executor notes rather than left implicit: the switch-error acquisition shape in flow/suite tests, the GitError envelope traversal in TS, `PANE_COMPONENTS` adapter shape, and path normalization for the "current" badge.
