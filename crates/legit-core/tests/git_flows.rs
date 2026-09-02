//! Integration tests: `GitCliBackend` against the real `git` binary in
//! throwaway tempdir repositories.
//!
//! The unit tests in `cli_impl` encode our *assumptions* about git's exit
//! codes and output text; these validate those assumptions against the real
//! binary (the auto-stash data-loss bug existed because "`stash push` fails
//! on a clean tree" was assumed, wrong, and untested). Focus: the
//! merge/rebase/conflict state machine, take-side resolution, and the
//! stash-tip detection - flows whose correctness depends on real git
//! behavior, not just on our own sequencing.
//!
//! Each repo pins the config the flows depend on (identity, no signing, no
//! autocrlf) locally, so a developer's global config cannot skew outcomes.

use legit_core::{
    BlobBytes, CommitId, GitError, ConflictKind, ConflictSide, DiffEntry, DiffSource, FastForwardResult,
    FetchOptions, FileState, GitmodulesFinding,
    GitBackend, GitCliBackend, GitRunner, LogOptions, MergeOptions, MergeOutcome, OperationId,
    PullOptions, PullStrategy, PushOptions, PushRecurseMode, RebaseOutcome, RefDecoration,
    RefSelector, RemoteProgress, RepoFileEntry, RepoFileKind, RepoOpState, ResetMode,
    SequenceOutcome, SignatureStatus, StashApplyOutcome, StashOutcome, SubmoduleAutoUpdateStatus,
    SubmoduleLog, SubmoduleUpdateOptions, SubmoduleUpdateStrategy, SwitchDirtyBehavior,
    SwitchOutcome,
};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use tempfile::TempDir;
use tokio::sync::RwLock;

struct TestRepo {
    _dir: TempDir,
    path: PathBuf,
    backend: GitCliBackend,
}

impl TestRepo {
    async fn init() -> Self {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().to_path_buf();
        let runner = GitRunner::for_repo("git", &path);
        for args in [
            ["init", "-b", "main"].as_slice(),
            &["config", "user.name", "LeGit Test"],
            &["config", "user.email", "test@example.invalid"],
            &["config", "commit.gpgsign", "false"],
            &["config", "tag.gpgsign", "false"],
            &["config", "core.autocrlf", "false"],
        ] {
            let out = runner.run(args).await.expect("spawn git");
            assert!(out.success, "setup `git {args:?}` failed: {}", out.stderr);
        }
        let backend = GitCliBackend::new(Arc::new(RwLock::new(Arc::new(runner))));
        Self { _dir: dir, path, backend }
    }

    /// Raw git for test setup/verification, asserting success.
    async fn git(&self, args: &[&str]) -> String {
        let runner = GitRunner::for_repo("git", &self.path);
        let out = runner.run(args).await.expect("spawn git");
        assert!(out.success, "`git {args:?}` failed: {}", out.stderr);
        out.stdout
    }

    /// Raw git where a non-zero exit is expected (e.g. a conflicting
    /// cherry-pick used as setup).
    async fn git_any(&self, args: &[&str]) {
        let runner = GitRunner::for_repo("git", &self.path);
        runner.run(args).await.expect("spawn git");
    }

    fn write(&self, rel: &str, content: &str) {
        std::fs::write(self.path.join(rel), content).expect("write file");
    }

    fn read(&self, rel: &str) -> String {
        std::fs::read_to_string(self.path.join(rel)).expect("read file")
    }

    fn exists(&self, rel: &str) -> bool {
        self.path.join(rel).exists()
    }

    async fn commit_all(&self, msg: &str) {
        self.git(&["add", "-A"]).await;
        self.git(&["commit", "-m", msg]).await;
    }

    async fn head(&self) -> String {
        self.git(&["rev-parse", "HEAD"]).await.trim().to_string()
    }
}

/// Superproject with one submodule `lib` (its upstream repo returned too).
/// `protocol.file.allow=always` must ride the invoking command: local config
/// does not reach git's internal clone (CVE-2022-39253 hardening).
async fn repo_with_submodule() -> (TestRepo, TestRepo) {
    let lib = TestRepo::init().await;
    lib.write("lib.txt", "v1\n");
    lib.commit_all("lib v1").await;

    let sup = TestRepo::init().await;
    sup.write("README.md", "super\n");
    sup.commit_all("base").await;
    let lib_path = lib.path.to_string_lossy().into_owned();
    // `-c core.autocrlf=false` must ride the add itself (like
    // protocol.file.allow): the internal clone checks files out, and under a
    // Windows-global autocrlf=true they would land as CRLF, breaking every
    // content assertion in the submodule flows.
    sup.git(&[
        "-c", "protocol.file.allow=always",
        "-c", "core.autocrlf=false",
        "submodule", "add", &lib_path, "lib",
    ])
    .await;
    // The clone is a fresh repo reading the OS-global config for everything
    // after the add — pin the same local settings TestRepo::init pins
    // (identity, no signing, no autocrlf) so later checkouts/stashes/commits
    // inside the submodule behave like every other test repo.
    for args in [
        ["-C", "lib", "config", "user.name", "LeGit Test"].as_slice(),
        &["-C", "lib", "config", "user.email", "test@example.invalid"],
        &["-C", "lib", "config", "commit.gpgsign", "false"],
        &["-C", "lib", "config", "tag.gpgsign", "false"],
        &["-C", "lib", "config", "core.autocrlf", "false"],
    ] {
        sup.git(args).await;
    }
    sup.git(&["commit", "-m", "add submodule"]).await;
    (sup, lib)
}

/// base -> `feature` edits a.txt one way, `main` the other. HEAD ends on main.
async fn conflicting_branches(repo: &TestRepo) {
    repo.write("a.txt", "base\n");
    repo.commit_all("base").await;
    repo.git(&["branch", "feature"]).await;
    repo.git(&["switch", "feature"]).await;
    repo.write("a.txt", "feature\n");
    repo.commit_all("feature change").await;
    repo.git(&["switch", "main"]).await;
    repo.write("a.txt", "main\n");
    repo.commit_all("main change").await;
}

// ---------------------------------------------------------------------------
// merge: conflict -> resolve -> continue / abort
// ---------------------------------------------------------------------------

#[tokio::test]
async fn merge_conflict_resolve_continue() {
    let repo = TestRepo::init().await;
    conflicting_branches(&repo).await;

    let outcome = repo.backend.merge("feature", MergeOptions::default()).await.unwrap();
    assert!(matches!(outcome, MergeOutcome::Conflicts { .. }), "{outcome:?}");

    // Real MERGE_HEAD / MERGE_MSG drive the op-state detection.
    match repo.backend.op_state().await.unwrap() {
        RepoOpState::Merge { branch, message } => {
            assert_eq!(branch.as_deref(), Some("feature"));
            assert!(message.unwrap().contains("feature"));
        }
        other => panic!("expected Merge op state, got {other:?}"),
    }

    let entries = repo.backend.conflict_entries().await.unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].path, "a.txt");
    assert_eq!(entries[0].kind, ConflictKind::BothModified);

    // Resolve, stage, continue.
    repo.write("a.txt", "resolved\n");
    repo.backend.stage(&[PathBuf::from("a.txt")]).await.unwrap();
    let outcome = repo.backend.merge_continue().await.unwrap();
    assert_eq!(outcome, MergeOutcome::Merged);
    assert_eq!(repo.backend.op_state().await.unwrap(), RepoOpState::None);
    assert!(repo.backend.conflict_entries().await.unwrap().is_empty());
}

#[tokio::test]
async fn merge_abort_restores_pre_merge_state() {
    let repo = TestRepo::init().await;
    conflicting_branches(&repo).await;
    let tip = repo.head().await;

    let outcome = repo.backend.merge("feature", MergeOptions::default()).await.unwrap();
    assert!(matches!(outcome, MergeOutcome::Conflicts { .. }));

    repo.backend.merge_abort().await.unwrap();
    assert_eq!(repo.backend.op_state().await.unwrap(), RepoOpState::None);
    assert_eq!(repo.head().await, tip);
    assert_eq!(repo.read("a.txt"), "main\n");
    assert!(repo.backend.conflict_entries().await.unwrap().is_empty());
}

#[tokio::test]
async fn staged_resolution_reopen_restores_the_conflict() {
    // Encodes the reopen-flow assumptions against real git: staging a
    // resolution records resolve-undo (REUC) info that persists until the
    // merge commit, `update-index --unresolve` restores the unmerged stages
    // from it, and `checkout -m` regenerates the markers in the worktree.
    let repo = TestRepo::init().await;
    conflicting_branches(&repo).await;
    repo.backend.merge("feature", MergeOptions::default()).await.unwrap();

    // Resolve + stage: no longer conflicted, but recorded as resolve-undo.
    repo.write("a.txt", "resolved\n");
    repo.backend.stage(&[PathBuf::from("a.txt")]).await.unwrap();
    assert!(repo.backend.conflict_entries().await.unwrap().is_empty());
    assert_eq!(repo.backend.resolve_undo_paths().await.unwrap(), vec!["a.txt"]);

    repo.backend.conflict_reopen(Path::new("a.txt")).await.unwrap();

    // Conflicted again, markers regenerated, previous resolution gone.
    let entries = repo.backend.conflict_entries().await.unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].path, "a.txt");
    let content = repo.read("a.txt");
    assert!(content.contains("<<<<<<<"), "{content}");
    assert!(!content.contains("resolved"), "{content}");
}

#[tokio::test]
async fn unstaged_resolution_keeps_the_warning_and_reopens() {
    // Encodes the assumptions behind warning/reopening on the UNSTAGED side:
    // the resolve-undo record survives `restore --staged` (LeGit's unstage),
    // and `diff --check` (worktree side) flags the markers once the staged
    // resolution moves back to unstaged.
    let repo = TestRepo::init().await;
    conflicting_branches(&repo).await;
    repo.backend.merge("feature", MergeOptions::default()).await.unwrap();

    // Stage as-is (markers included), then unstage again.
    repo.backend.stage(&[PathBuf::from("a.txt")]).await.unwrap();
    repo.backend.unstage(&[PathBuf::from("a.txt")]).await.unwrap();

    // Markers now sit on the worktree side only; still reopenable.
    assert!(repo.backend.staged_marker_paths().await.unwrap().is_empty());
    assert_eq!(repo.backend.unstaged_marker_paths().await.unwrap(), vec!["a.txt"]);
    assert_eq!(repo.backend.resolve_undo_paths().await.unwrap(), vec!["a.txt"]);

    repo.backend.conflict_reopen(Path::new("a.txt")).await.unwrap();
    let entries = repo.backend.conflict_entries().await.unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].path, "a.txt");
    assert!(repo.read("a.txt").contains("<<<<<<<"));
}

#[tokio::test]
async fn staged_conflict_markers_are_detected() {
    // Encodes the `diff --cached --check` assumptions: exit 2 with
    // `<path>:<line>: leftover conflict marker` lines when staged content
    // still holds markers; clean once properly resolved.
    let repo = TestRepo::init().await;
    conflicting_branches(&repo).await;
    repo.backend.merge("feature", MergeOptions::default()).await.unwrap();

    // Stage the file as-is - markers and all (the accidental "Mark resolved").
    repo.backend.stage(&[PathBuf::from("a.txt")]).await.unwrap();
    assert_eq!(repo.backend.staged_marker_paths().await.unwrap(), vec!["a.txt"]);

    // A real resolution clears the flag.
    repo.write("a.txt", "resolved\n");
    repo.backend.stage(&[PathBuf::from("a.txt")]).await.unwrap();
    assert!(repo.backend.staged_marker_paths().await.unwrap().is_empty());
}

#[tokio::test]
async fn merge_fast_forward_then_already_up_to_date() {
    let repo = TestRepo::init().await;
    repo.write("a.txt", "base\n");
    repo.commit_all("base").await;
    repo.git(&["switch", "-c", "feature"]).await;
    repo.write("b.txt", "b\n");
    repo.commit_all("feature adds b").await;
    repo.git(&["switch", "main"]).await;

    // Validates the "Fast-forward" stdout-line detection against real git.
    let outcome = repo.backend.merge("feature", MergeOptions::default()).await.unwrap();
    assert_eq!(outcome, MergeOutcome::FastForwarded);

    let outcome = repo.backend.merge("feature", MergeOptions::default()).await.unwrap();
    assert_eq!(outcome, MergeOutcome::AlreadyUpToDate);
}

#[tokio::test]
async fn squash_merge_stages_without_committing() {
    let repo = TestRepo::init().await;
    repo.write("a.txt", "base\n");
    repo.commit_all("base").await;
    let tip = repo.head().await;
    repo.git(&["switch", "-c", "feature"]).await;
    repo.write("b.txt", "b\n");
    repo.commit_all("feature adds b").await;
    repo.git(&["switch", "main"]).await;

    let outcome = repo
        .backend
        .merge("feature", MergeOptions { squash: true, ..Default::default() })
        .await
        .unwrap();
    assert_eq!(outcome, MergeOutcome::Squashed);
    // Changes staged, no commit created.
    assert_eq!(repo.head().await, tip);
    let staged = repo.git(&["diff", "--cached", "--name-only"]).await;
    assert!(staged.contains("b.txt"), "{staged}");
}

#[tokio::test]
async fn conflicted_squash_merge_has_no_merge_op_state() {
    // Documents real git behavior the UI must live with: `merge --squash`
    // writes no MERGE_HEAD, so a conflicted squash merge reports
    // `RepoOpState::None` (no Continue/Abort banner) while the conflicted
    // paths still show up in conflict_entries / status. Resolution is
    // resolve + ordinary commit, not `merge --continue`.
    let repo = TestRepo::init().await;
    conflicting_branches(&repo).await;

    let outcome = repo
        .backend
        .merge("feature", MergeOptions { squash: true, ..Default::default() })
        .await
        .unwrap();
    assert!(matches!(outcome, MergeOutcome::Conflicts { .. }), "{outcome:?}");
    assert_eq!(repo.backend.op_state().await.unwrap(), RepoOpState::None);
    assert!(!repo.backend.conflict_entries().await.unwrap().is_empty());
}

// ---------------------------------------------------------------------------
// rebase: conflict -> skip / abort; autostash pop-conflict
// ---------------------------------------------------------------------------

#[tokio::test]
async fn rebase_conflict_then_skip_drops_the_commit() {
    let repo = TestRepo::init().await;
    conflicting_branches(&repo).await;
    let main_tip = repo.head().await;
    repo.git(&["switch", "feature"]).await;

    let outcome = repo.backend.rebase("main").await.unwrap();
    assert!(matches!(outcome, RebaseOutcome::Conflicts { .. }), "{outcome:?}");

    // Real rebase-merge state files drive the detection.
    match repo.backend.op_state().await.unwrap() {
        RepoOpState::Rebase { head_name, current_step, total_steps, .. } => {
            assert_eq!(head_name.as_deref(), Some("feature"));
            assert_eq!(current_step, Some(1));
            assert_eq!(total_steps, Some(1));
        }
        other => panic!("expected Rebase op state, got {other:?}"),
    }

    // Skipping the only commit completes the rebase; feature ends at main.
    let outcome = repo.backend.rebase_skip().await.unwrap();
    assert_eq!(outcome, RebaseOutcome::Completed);
    assert_eq!(repo.backend.op_state().await.unwrap(), RepoOpState::None);
    assert_eq!(repo.head().await, main_tip);
}

#[tokio::test]
async fn rebase_conflict_resolve_continue() {
    // Caught a real bug on first run: `rebase --continue` commits the resolved
    // pick via the editor, and the runner's GIT_EDITOR=false failed it (env
    // beats `-c core.editor=…`). Now runs with GIT_EDITOR=true overridden.
    let repo = TestRepo::init().await;
    conflicting_branches(&repo).await;
    repo.git(&["switch", "feature"]).await;

    let outcome = repo.backend.rebase("main").await.unwrap();
    assert!(matches!(outcome, RebaseOutcome::Conflicts { .. }));

    repo.write("a.txt", "resolved\n");
    repo.backend.stage(&[PathBuf::from("a.txt")]).await.unwrap();
    let outcome = repo.backend.rebase_continue().await.unwrap();
    assert_eq!(outcome, RebaseOutcome::Completed);
    assert_eq!(repo.backend.op_state().await.unwrap(), RepoOpState::None);
    assert_eq!(repo.read("a.txt"), "resolved\n");
}

#[tokio::test]
async fn rebase_conflict_then_abort_restores_the_branch() {
    let repo = TestRepo::init().await;
    conflicting_branches(&repo).await;
    repo.git(&["switch", "feature"]).await;
    let feature_tip = repo.head().await;

    let outcome = repo.backend.rebase("main").await.unwrap();
    assert!(matches!(outcome, RebaseOutcome::Conflicts { .. }));

    repo.backend.rebase_abort().await.unwrap();
    assert_eq!(repo.backend.op_state().await.unwrap(), RepoOpState::None);
    assert_eq!(repo.head().await, feature_tip);
    assert_eq!(repo.read("a.txt"), "feature\n");
}

#[tokio::test]
async fn rebase_autostash_pop_conflict_is_a_distinct_outcome() {
    // The rebase itself succeeds; reapplying the autostash conflicts. Encodes
    // the assumption that git exits 0 and announces the stash conflict in its
    // output ("Applying autostash resulted in conflicts").
    let repo = TestRepo::init().await;
    repo.write("a.txt", "1\n");
    repo.commit_all("base").await;
    repo.git(&["switch", "-c", "feature"]).await;
    repo.write("b.txt", "b\n");
    repo.commit_all("feature adds b").await;
    repo.git(&["switch", "main"]).await;
    repo.write("a.txt", "2\n");
    repo.commit_all("main edits a").await;
    repo.git(&["switch", "feature"]).await;

    // Dirty, uncommitted edit that will conflict with main's a.txt.
    repo.write("a.txt", "dirty\n");
    let outcome = repo.backend.rebase("main").await.unwrap();
    assert!(
        matches!(outcome, RebaseOutcome::CompletedWithStashConflicts { .. }),
        "{outcome:?}"
    );
    // The rebase is over (no op state) and git kept the stash entry.
    assert_eq!(repo.backend.op_state().await.unwrap(), RepoOpState::None);
    assert_eq!(repo.backend.stashes().await.unwrap().len(), 1);
}

// ---------------------------------------------------------------------------
// take-side resolution on modify/delete conflicts
// ---------------------------------------------------------------------------

/// main modifies a.txt, feature deletes it, merge feature into main.
async fn modify_delete_conflict(repo: &TestRepo) {
    repo.write("a.txt", "base\n");
    repo.commit_all("base").await;
    repo.git(&["switch", "-c", "feature"]).await;
    repo.git(&["rm", "a.txt"]).await;
    repo.git(&["commit", "-m", "feature deletes a"]).await;
    repo.git(&["switch", "main"]).await;
    repo.write("a.txt", "main\n");
    repo.commit_all("main edits a").await;

    let outcome = repo.backend.merge("feature", MergeOptions::default()).await.unwrap();
    assert!(matches!(outcome, MergeOutcome::Conflicts { .. }), "{outcome:?}");
    let entries = repo.backend.conflict_entries().await.unwrap();
    assert_eq!(entries[0].kind, ConflictKind::DeletedByThem);
}

#[tokio::test]
async fn take_theirs_on_delete_conflict_removes_the_file() {
    let repo = TestRepo::init().await;
    modify_delete_conflict(&repo).await;

    // Theirs deleted the file: taking their side = git rm (checkout --theirs
    // has no stage to check out). Validates the stderr-based fallback.
    repo.backend
        .resolve_take_side(std::path::Path::new("a.txt"), ConflictSide::Theirs)
        .await
        .unwrap();
    assert!(!repo.exists("a.txt"));
    assert!(repo.backend.conflict_entries().await.unwrap().is_empty());

    let outcome = repo.backend.merge_continue().await.unwrap();
    assert_eq!(outcome, MergeOutcome::Merged);
    assert_eq!(repo.backend.op_state().await.unwrap(), RepoOpState::None);
}

#[tokio::test]
async fn take_ours_on_delete_conflict_keeps_the_file() {
    let repo = TestRepo::init().await;
    modify_delete_conflict(&repo).await;

    repo.backend
        .resolve_take_side(std::path::Path::new("a.txt"), ConflictSide::Ours)
        .await
        .unwrap();
    assert_eq!(repo.read("a.txt"), "main\n");
    assert!(repo.backend.conflict_entries().await.unwrap().is_empty());
}

// ---------------------------------------------------------------------------
// stash-tip detection and auto-stash switching against real git
// ---------------------------------------------------------------------------

#[tokio::test]
async fn stash_push_on_clean_tree_is_nothing_to_stash() {
    // Validates the discovery that motivated the tip comparison: on a clean
    // tree `git stash push` exits 0, so only the unmoved tip can tell.
    let repo = TestRepo::init().await;
    repo.write("a.txt", "base\n");
    repo.commit_all("base").await;

    let outcome = repo.backend.create_stash(Some("nothing"), true, false).await.unwrap();
    assert_eq!(outcome, StashOutcome::NothingToStash);
    assert!(repo.backend.stashes().await.unwrap().is_empty());

    repo.write("a.txt", "dirty\n");
    let outcome = repo.backend.create_stash(Some("wip"), true, false).await.unwrap();
    assert_eq!(outcome, StashOutcome::Created);
    assert_eq!(repo.backend.stashes().await.unwrap().len(), 1);
}

#[tokio::test]
async fn stash_keep_index_leaves_staged_changes_in_place() {
    // `--keep-index` stashes everything but re-applies the index afterwards:
    // staged changes stay staged (and in the worktree), unstaged-only changes
    // are stashed away.
    let repo = TestRepo::init().await;
    repo.write("a.txt", "base\n");
    repo.write("b.txt", "base\n");
    repo.commit_all("base").await;

    repo.write("a.txt", "staged change\n");
    repo.git(&["add", "a.txt"]).await;
    repo.write("b.txt", "unstaged change\n");

    let outcome = repo.backend.create_stash(Some("wip"), false, true).await.unwrap();
    assert_eq!(outcome, StashOutcome::Created);

    assert_eq!(repo.read("a.txt"), "staged change\n");
    let staged = repo.git(&["diff", "--cached", "--name-only"]).await;
    assert_eq!(staged.trim(), "a.txt");
    assert_eq!(repo.read("b.txt"), "base\n");
}

#[tokio::test]
async fn stash_branch_restores_changes_on_a_new_branch_and_drops_the_stash() {
    let repo = TestRepo::init().await;
    repo.write("a.txt", "base\n");
    repo.commit_all("base").await;

    repo.write("a.txt", "wip\n");
    let outcome = repo.backend.create_stash(Some("wip"), true, false).await.unwrap();
    assert_eq!(outcome, StashOutcome::Created);
    let stash_sha = repo.backend.stashes().await.unwrap()[0].stash_sha.clone();

    // Diverge main past the stash's base - the scenario `git stash branch`
    // exists for (a plain apply could conflict; the new branch cannot).
    repo.write("a.txt", "moved on\n");
    repo.commit_all("main moved on").await;

    repo.backend.stash_branch(stash_sha.as_str(), "from-stash").await.unwrap();

    assert_eq!(repo.git(&["branch", "--show-current"]).await.trim(), "from-stash");
    assert_eq!(repo.read("a.txt"), "wip\n");
    // A successful stash branch drops the entry.
    assert!(repo.backend.stashes().await.unwrap().is_empty());
}

#[tokio::test]
async fn switch_auto_stash_carries_changes_to_the_target_branch() {
    let repo = TestRepo::init().await;
    repo.write("a.txt", "base\n");
    repo.commit_all("base").await;
    repo.git(&["branch", "feature"]).await;

    repo.write("a.txt", "wip\n");
    let outcome = repo
        .backend
        .switch_branch("feature", SwitchDirtyBehavior::AutoStash)
        .await
        .unwrap();
    assert_eq!(outcome.outcome, SwitchOutcome::Clean);
    // The dirty edit travelled along; the transient stash entry is gone.
    assert_eq!(repo.read("a.txt"), "wip\n");
    assert!(repo.backend.stashes().await.unwrap().is_empty());
    assert_eq!(repo.git(&["branch", "--show-current"]).await.trim(), "feature");
}

#[tokio::test]
async fn switch_stash_and_keep_parks_the_changes() {
    let repo = TestRepo::init().await;
    repo.write("a.txt", "base\n");
    repo.commit_all("base").await;
    repo.git(&["branch", "feature"]).await;

    repo.write("a.txt", "wip\n");
    let outcome = repo
        .backend
        .switch_branch("feature", SwitchDirtyBehavior::StashAndKeep)
        .await
        .unwrap();
    assert_eq!(outcome.outcome, SwitchOutcome::ChangesStashed);
    // Target branch starts clean; the WIP is retrievable from the stash.
    assert_eq!(repo.read("a.txt"), "base\n");
    assert_eq!(repo.backend.stashes().await.unwrap().len(), 1);
}

// ---------------------------------------------------------------------------
// remote transfer progress (fetch --progress over file://)
// ---------------------------------------------------------------------------

/// Process-wide collector behind the runner's set-once progress observer;
/// tests filter by their own `OperationId`, so sharing it is safe.
fn progress_collector() -> &'static Mutex<Vec<(String, RemoteProgress)>> {
    static EVENTS: OnceLock<Mutex<Vec<(String, RemoteProgress)>>> = OnceLock::new();
    let events = EVENTS.get_or_init(|| Mutex::new(Vec::new()));
    legit_core::runner::set_progress_observer(Arc::new(|op_id, progress| {
        let _ = progress_collector()
            .lock()
            .map(|mut v| v.push((op_id.0.clone(), progress)));
    }));
    events
}

#[tokio::test]
async fn fetch_reports_transfer_progress_and_strips_the_meter() {
    let collector = progress_collector();

    // A file:// URL forces the real transport (a bare path would use the
    // hardlinking local optimization and skip the transfer meter).
    let origin = TestRepo::init().await;
    origin.write("a.txt", "base\n");
    origin.commit_all("base").await;
    let url = format!(
        "file:///{}",
        origin.path.to_string_lossy().replace('\\', "/").trim_start_matches('/')
    );

    let repo = TestRepo::init().await;
    repo.git(&["remote", "add", "origin", &url]).await;

    let op_id = OperationId::new();
    repo.backend
        .fetch(
            FetchOptions { all: false, prune: false, remote: Some("origin".into()) },
            op_id.clone(),
        )
        .await
        .unwrap();

    // The fetched ref exists, and the observer saw at least one parsed meter
    // update for this exact operation (validates --progress + the \r-split
    // streaming + the parser against real git output).
    let head = repo.git(&["rev-parse", "origin/main"]).await;
    assert!(!head.trim().is_empty());
    let events = collector.lock().unwrap();
    let ours: Vec<_> = events.iter().filter(|(id, _)| *id == op_id.0).collect();
    assert!(!ours.is_empty(), "no progress events observed: {events:?}");
}

// ---------------------------------------------------------------------------
// inspection: range diff, search, blame against real git
// ---------------------------------------------------------------------------

#[tokio::test]
async fn diff_files_and_file_diff_work_across_branches() {
    use legit_core::{CommitSearchKind, DiffEntry, DiffSource};
    let _ = CommitSearchKind::Message; // silence unused-import pedantry in older toolchains

    let repo = TestRepo::init().await;
    repo.write("base.txt", "base\n");
    repo.commit_all("base").await;
    repo.git(&["branch", "feature"]).await;
    repo.git(&["switch", "feature"]).await;
    repo.write("f.txt", "feature file\n");
    repo.commit_all("feature adds f").await;
    repo.git(&["switch", "main"]).await;
    repo.write("base.txt", "base v2\n");
    repo.commit_all("main edits base").await;

    let files = repo.backend.diff_files("main", "feature").await.unwrap();
    let paths: Vec<String> = files
        .iter()
        .map(|f| f.path.to_string_lossy().into_owned())
        .collect();
    assert!(paths.contains(&"f.txt".to_string()), "{paths:?}");
    assert!(paths.contains(&"base.txt".to_string()), "{paths:?}");

    let source = DiffSource::CommitRange {
        from: legit_core::CommitId::new("main"),
        to: legit_core::CommitId::new("feature"),
    };
    let entry = repo
        .backend
        .file_diff(&source, std::path::Path::new("base.txt"), None, 3)
        .await
        .unwrap();
    match entry {
        DiffEntry::Text(t) => assert!(!t.hunks.is_empty()),
        other => panic!("expected text diff, got {other:?}"),
    }
}

#[tokio::test]
async fn search_commits_and_paths_find_real_matches() {
    use legit_core::CommitSearchKind;

    let repo = TestRepo::init().await;
    std::fs::create_dir_all(repo.path.join("deep")).expect("mkdir");
    repo.write("deep/UniqueNeedleFile.txt", "hello SECRET42\n");
    repo.commit_all("add magic xyzzy feature").await;
    repo.write("other.txt", "plain\n");
    repo.commit_all("unrelated").await;

    let by_msg = repo
        .backend
        .search_commits("xyzzy", CommitSearchKind::Message, 50)
        .await
        .unwrap();
    assert_eq!(by_msg.len(), 1, "{by_msg:?}");

    let by_author = repo
        .backend
        .search_commits("legit test", CommitSearchKind::Author, 50)
        .await
        .unwrap();
    assert_eq!(by_author.len(), 2, "{by_author:?}");

    let by_content = repo
        .backend
        .search_commits("SECRET42", CommitSearchKind::Content, 50)
        .await
        .unwrap();
    assert_eq!(by_content.len(), 1, "{by_content:?}");

    let paths = repo.backend.search_paths("uniqueneedle", 10).await.unwrap();
    assert_eq!(paths, vec![std::path::PathBuf::from("deep/UniqueNeedleFile.txt")]);
}

#[tokio::test]
async fn blame_attributes_lines_to_the_right_commits() {
    let repo = TestRepo::init().await;
    repo.write("a.txt", "one\ntwo\n");
    repo.commit_all("first").await;
    let c1 = repo.head().await;
    repo.write("a.txt", "one\nTWO\n");
    repo.commit_all("second").await;
    let c2 = repo.head().await;

    let hunks = repo.backend.blame(std::path::Path::new("a.txt"), None).await.unwrap();
    assert_eq!(hunks.len(), 2, "{hunks:?}");
    assert_eq!(hunks[0].sha.as_str(), c1);
    assert_eq!(hunks[0].start_line, 1);
    assert_eq!(hunks[0].lines, vec!["one"]);
    assert_eq!(hunks[0].summary, "first");
    assert_eq!(hunks[1].sha.as_str(), c2);
    assert_eq!(hunks[1].lines, vec!["TWO"]);
    assert_eq!(hunks[1].author, "LeGit Test");

    // Blame at a revision sees the file as of that rev: every line from c1.
    let historic = repo
        .backend
        .blame(std::path::Path::new("a.txt"), Some(&c1))
        .await
        .unwrap();
    assert_eq!(historic.len(), 1, "{historic:?}");
    assert_eq!(historic[0].sha.as_str(), c1);
    assert_eq!(historic[0].lines, vec!["one", "two"]);
}

/// The porcelain `previous` header follows renames: it names the parent
/// commit AND the file's OLD path, and re-blaming must use both - after a
/// rename, `<parent>:<current name>` does not exist. Also pins the quoting
/// contract: core.quotePath (default true) C-quotes non-ASCII paths in the
/// header, which the parser must undo.
#[tokio::test]
async fn blame_previous_follows_renames_and_unquotes_paths() {
    let repo = TestRepo::init().await;
    // Enough unchanged lines that the rename stays comfortably above git's
    // ~50% content-similarity threshold (a small file with a big edit counts
    // as delete+add instead - see the below-threshold case at the end).
    repo.write("original.txt", "alpha\nbeta\ngamma\ndelta\nepsilon\nzeta\n");
    repo.commit_all("add original").await;
    let parent = repo.head().await;
    // Rename AND edit a line so the rename commit owns a blamed hunk.
    repo.git(&["mv", "original.txt", "renamed.txt"]).await;
    repo.write("renamed.txt", "alpha\nBETA\ngamma\ndelta\nepsilon\nzeta\n");
    repo.commit_all("rename + edit").await;
    let head = repo.head().await;

    let hunks = repo.backend.blame(Path::new("renamed.txt"), None).await.expect("blame");
    // Rename following at work: the unchanged lines still blame to the
    // ORIGINAL commit, only the edited line to the renaming commit.
    let hunk = hunks
        .iter()
        .find(|h| h.sha.as_str() == head)
        .expect("the rename commit owns the edited line");
    assert_eq!(hunk.lines, vec!["BETA"]);
    assert!(
        hunks.iter().any(|h| h.sha.as_str() == parent),
        "unchanged lines must still blame to the original commit: {hunks:?}"
    );
    assert_eq!(hunk.previous_sha.as_ref().map(|s| s.as_str()), Some(parent.as_str()));
    assert_eq!(hunk.previous_path.as_deref(), Some("original.txt"));

    // Re-blaming at (previous_sha, previous_path) succeeds - the point of
    // following the rename - while the current name at the parent fails,
    // which is exactly why the old `<sha>^:<current path>` approach broke.
    let at_parent = repo
        .backend
        .blame(Path::new("original.txt"), Some(&parent))
        .await
        .expect("blame parent at the old path");
    assert_eq!(at_parent[0].lines[..2], ["alpha", "beta"]);
    assert!(
        repo.backend.blame(Path::new("renamed.txt"), Some(&parent)).await.is_err(),
        "the new name must not resolve at the parent"
    );

    // Below the similarity threshold there is NO rename to follow: git sees
    // delete+add, every line blames to the renaming commit, and no
    // `previous` header appears (so the "blame parent" affordance hides).
    repo.write("tiny.txt", "one\ntwo\nthree\n");
    repo.commit_all("add tiny").await;
    repo.git(&["mv", "tiny.txt", "tiny2.txt"]).await;
    repo.write("tiny2.txt", "one\nTWO, rewritten far beyond recognition\nTHREE, also fully rewritten\n");
    repo.commit_all("rename tiny + heavy edit").await;
    let tiny_head = repo.head().await;
    let hunks = repo.backend.blame(Path::new("tiny2.txt"), None).await.expect("blame tiny2");
    assert!(
        hunks.iter().all(|h| h.sha.as_str() == tiny_head && h.previous_sha.is_none()),
        "below-threshold rename must not follow: {hunks:?}"
    );

    // Non-ASCII old name: git emits `previous <sha> "sp\303\244ter.txt"`
    // (C-quoted octal); the parsed path must come back as real UTF-8.
    repo.write("später.txt", "eins\nzwei\n");
    repo.commit_all("add unicode-named file").await;
    let uni_parent = repo.head().await;
    repo.git(&["mv", "später.txt", "plain.txt"]).await;
    repo.write("plain.txt", "eins\nZWEI\n");
    repo.commit_all("rename away from unicode name").await;
    let uni_head = repo.head().await;

    let hunks = repo.backend.blame(Path::new("plain.txt"), None).await.expect("blame plain");
    let hunk = hunks
        .iter()
        .find(|h| h.sha.as_str() == uni_head)
        .expect("the unicode-rename commit owns the edited line");
    assert_eq!(
        hunk.previous_path.as_deref(),
        Some("später.txt"),
        "C-quoted previous path must be unquoted"
    );
    assert_eq!(hunk.previous_sha.as_ref().map(|s| s.as_str()), Some(uni_parent.as_str()));
}

#[tokio::test]
async fn merge_base_resolves_the_fork_point() {
    let repo = TestRepo::init().await;
    conflicting_branches(&repo).await; // base -> feature + main diverge
    let base = repo.git(&["rev-parse", "main~1"]).await.trim().to_string();

    let mb = repo.backend.merge_base("main", "feature").await.unwrap();
    assert_eq!(mb.as_deref(), Some(base.as_str()));

    // Unknown revs are an error, not a silent None.
    assert!(repo.backend.merge_base("main", "no-such-rev").await.is_err());
}

// ---------------------------------------------------------------------------
// set / clear upstream
// ---------------------------------------------------------------------------

#[tokio::test]
async fn set_and_clear_upstream_change_the_tracking_config() {
    // A local branch works as the upstream target — no network needed to
    // validate the config round-trip.
    let repo = TestRepo::init().await;
    repo.write("a.txt", "base\n");
    repo.commit_all("base").await;
    repo.git(&["branch", "feature"]).await;

    repo.backend.set_upstream("feature", Some("main")).await.unwrap();
    let up = repo
        .git(&["rev-parse", "--abbrev-ref", "feature@{upstream}"])
        .await;
    assert_eq!(up.trim(), "main");

    repo.backend.set_upstream("feature", None).await.unwrap();
    let runner = GitRunner::for_repo("git", &repo.path);
    let out = runner
        .run(&["rev-parse", "--abbrev-ref", "feature@{upstream}"])
        .await
        .expect("spawn git");
    assert!(!out.success, "upstream should be gone: {}", out.stdout);
}

// ---------------------------------------------------------------------------
// interactive rebase against real git (validates the printf editor trick)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn interactive_rebase_reorders_squashes_and_drops() {
    use legit_core::RebaseStep;

    let repo = TestRepo::init().await;
    repo.write("base.txt", "base\n");
    repo.commit_all("base").await;
    let base = repo.head().await;

    repo.write("a.txt", "a\n");
    repo.commit_all("add a").await;
    let c1 = repo.head().await;
    repo.write("b.txt", "b\n");
    repo.commit_all("add b").await;
    let c2 = repo.head().await;
    repo.write("c.txt", "c\n");
    repo.commit_all("add c").await;
    let c3 = repo.head().await;

    // Reorder (c2 first), squash c1 into it, drop c3.
    let plan = vec![
        RebaseStep::new(legit_core::RebaseAction::Pick, &c2),
        RebaseStep::new(legit_core::RebaseAction::Squash, &c1),
        RebaseStep::new(legit_core::RebaseAction::Drop, &c3),
    ];
    let outcome = repo.backend.rebase_interactive(&base, &plan).await.unwrap();
    assert_eq!(outcome, RebaseOutcome::Completed);

    // One squashed commit on top of base, with both files and neither c3's
    // file nor its commit.
    assert!(repo.exists("a.txt") && repo.exists("b.txt"));
    assert!(!repo.exists("c.txt"));
    let count = repo.git(&["rev-list", "--count", "HEAD"]).await;
    assert_eq!(count.trim(), "2");
    let msg = repo.git(&["log", "-1", "--format=%B"]).await;
    assert!(msg.contains("add b") && msg.contains("add a"), "{msg}");
    assert!(matches!(repo.backend.op_state().await.unwrap(), RepoOpState::None));
}

#[tokio::test]
async fn interactive_rebase_conflict_pauses_the_normal_rebase_machinery() {
    use legit_core::RebaseStep;

    let repo = TestRepo::init().await;
    repo.write("a.txt", "base\n");
    repo.commit_all("base").await;
    let base = repo.head().await;
    repo.write("a.txt", "one\n");
    repo.commit_all("one").await;
    let c1 = repo.head().await;
    repo.write("a.txt", "two\n");
    repo.commit_all("two").await;
    let c2 = repo.head().await;
    let tip = repo.head().await;

    // Reordering two commits that touch the same lines must conflict.
    let plan = vec![
        RebaseStep::new(legit_core::RebaseAction::Pick, &c2),
        RebaseStep::new(legit_core::RebaseAction::Pick, &c1),
    ];
    let outcome = repo.backend.rebase_interactive(&base, &plan).await.unwrap();
    assert!(matches!(outcome, RebaseOutcome::Conflicts { .. }), "{outcome:?}");
    assert!(matches!(
        repo.backend.op_state().await.unwrap(),
        RepoOpState::Rebase { .. }
    ));

    // The existing abort path restores the original tip.
    repo.backend.rebase_abort().await.unwrap();
    assert_eq!(repo.head().await, tip);
    assert_eq!(repo.read("a.txt"), "two\n");
}

#[tokio::test]
async fn interactive_rebase_refuses_a_stale_plan_instead_of_dropping_commits() {
    // Regression test for silent data loss: the injected todo REPLACES
    // git's generated one, and with the default rebase.missingCommitsCheck
    // ("ignore") git drops any base..HEAD commit missing from the todo
    // without a word. A plan that does not cover the range exactly - stale
    // (a commit landed after it was built) or truncated (UI listing cap) -
    // must be refused before git runs.
    use legit_core::{RebaseAction, RebaseStep};

    let repo = TestRepo::init().await;
    repo.write("base.txt", "base\n");
    repo.commit_all("base").await;
    let base = repo.head().await;
    repo.write("a.txt", "a\n");
    repo.commit_all("add a").await;
    let c1 = repo.head().await;
    repo.write("b.txt", "b\n");
    repo.commit_all("add b").await;
    let tip = repo.head().await;

    // Plan built before "add b" existed: covers only c1.
    let stale = vec![RebaseStep::new(RebaseAction::Pick, &c1)];
    let err = repo.backend.rebase_interactive(&base, &stale).await;
    assert!(err.is_err(), "stale plan must be refused: {err:?}");

    // Nothing ran: history intact, no rebase in progress.
    assert_eq!(repo.head().await, tip);
    let count = repo.git(&["rev-list", "--count", "HEAD"]).await;
    assert_eq!(count.trim(), "3");
    assert!(matches!(repo.backend.op_state().await.unwrap(), RepoOpState::None));
}

#[tokio::test]
async fn interactive_rebase_refuses_a_range_containing_a_merge_commit() {
    // `pick <merge>` stops the rebase mid-flight ("is a merge but no -m
    // option was given"; plain continue re-hits the rescheduled pick) -
    // the range is refused up front, before any git mutation.
    use legit_core::{RebaseAction, RebaseStep};

    let repo = TestRepo::init().await;
    repo.write("base.txt", "base\n");
    repo.commit_all("base").await;
    let base = repo.head().await;
    let main = repo.git(&["rev-parse", "--abbrev-ref", "HEAD"]).await;
    let main = main.trim().to_string();

    repo.git(&["checkout", "-b", "side"]).await;
    repo.write("side.txt", "side\n");
    repo.commit_all("side work").await;
    let side = repo.head().await;
    repo.git(&["checkout", &main]).await;
    repo.write("main.txt", "main\n");
    repo.commit_all("main work").await;
    let c1 = repo.head().await;
    repo.git(&["merge", "--no-ff", "-m", "merge side", "side"]).await;
    let merge = repo.head().await;
    let tip = merge.clone();

    // The panel's base..HEAD listing includes the merge and both parents'
    // commits; picking the merge is unsupported and must be refused.
    let plan = vec![
        RebaseStep::new(RebaseAction::Pick, &c1),
        RebaseStep::new(RebaseAction::Pick, &side),
        RebaseStep::new(RebaseAction::Pick, &merge),
    ];
    let err = repo.backend.rebase_interactive(&base, &plan).await;
    assert!(err.is_err(), "merge in range must be refused: {err:?}");
    assert_eq!(repo.head().await, tip);
    assert!(matches!(repo.backend.op_state().await.unwrap(), RepoOpState::None));
}

// ---------------------------------------------------------------------------
// reset / revert / cherry-pick against real git
// ---------------------------------------------------------------------------

/// Two commits on main; returns (first sha, second sha).
async fn two_commits(repo: &TestRepo) -> (String, String) {
    repo.write("a.txt", "one\n");
    repo.commit_all("one").await;
    let first = repo.head().await;
    repo.write("a.txt", "two\n");
    repo.commit_all("two").await;
    (first, repo.head().await)
}

#[tokio::test]
async fn reset_soft_moves_head_and_keeps_the_index() {
    let repo = TestRepo::init().await;
    let (first, _) = two_commits(&repo).await;

    repo.backend.reset(&first, ResetMode::Soft).await.unwrap();

    assert_eq!(repo.head().await, first);
    let staged = repo.git(&["diff", "--cached", "--name-only"]).await;
    assert_eq!(staged.trim(), "a.txt");
    assert_eq!(repo.read("a.txt"), "two\n");
}

#[tokio::test]
async fn reset_mixed_unstages_but_keeps_the_worktree() {
    let repo = TestRepo::init().await;
    let (first, _) = two_commits(&repo).await;

    repo.backend.reset(&first, ResetMode::Mixed).await.unwrap();

    assert_eq!(repo.head().await, first);
    let staged = repo.git(&["diff", "--cached", "--name-only"]).await;
    assert_eq!(staged.trim(), "");
    assert_eq!(repo.read("a.txt"), "two\n");
}

#[tokio::test]
async fn reset_hard_discards_the_change() {
    let repo = TestRepo::init().await;
    let (first, _) = two_commits(&repo).await;

    repo.backend.reset(&first, ResetMode::Hard).await.unwrap();

    assert_eq!(repo.head().await, first);
    assert_eq!(repo.read("a.txt"), "one\n");
}

#[tokio::test]
async fn revert_creates_a_revert_commit() {
    let repo = TestRepo::init().await;
    let (_, second) = two_commits(&repo).await;

    let outcome = repo.backend.revert(&[second.clone()], None).await.unwrap();
    assert_eq!(outcome, SequenceOutcome::Completed);

    assert_eq!(repo.read("a.txt"), "one\n");
    let subject = repo.git(&["log", "-1", "--format=%s"]).await;
    assert!(subject.starts_with("Revert"), "{subject}");
    assert!(matches!(repo.backend.op_state().await.unwrap(), RepoOpState::None));
}

#[tokio::test]
async fn cherry_pick_of_two_commits_applies_both_in_one_sequence() {
    // Bulk cherry-pick: two side-branch commits (separate files, no
    // conflicts) picked oldest-first in ONE call land as two commits on
    // main and leave no sequencer state behind.
    let repo = TestRepo::init().await;
    repo.write("a.txt", "base\n");
    repo.commit_all("base").await;
    repo.git(&["switch", "-c", "feature"]).await;
    repo.write("f1.txt", "one\n");
    repo.commit_all("feat one").await;
    let older = repo.head().await;
    repo.write("f2.txt", "two\n");
    repo.commit_all("feat two").await;
    let newer = repo.head().await;
    repo.git(&["switch", "main"]).await;

    let outcome = repo
        .backend
        .cherry_pick(&[older.clone(), newer.clone()], None)
        .await
        .unwrap();
    assert_eq!(outcome, SequenceOutcome::Completed);

    assert_eq!(repo.read("f1.txt"), "one\n");
    assert_eq!(repo.read("f2.txt"), "two\n");
    let subjects = repo.git(&["log", "--format=%s", "-3"]).await;
    assert_eq!(subjects.trim(), "feat two\nfeat one\nbase");
    assert!(matches!(repo.backend.op_state().await.unwrap(), RepoOpState::None));
}

#[tokio::test]
async fn revert_of_two_commits_unwinds_both_newest_first() {
    // Bulk revert: newest-first order unwinds each commit on top of the
    // previous revert; the file ends back at its initial content.
    let repo = TestRepo::init().await;
    repo.write("a.txt", "one\n");
    repo.commit_all("one").await;
    repo.write("a.txt", "two\n");
    repo.commit_all("two").await;
    let second = repo.head().await;
    repo.write("a.txt", "three\n");
    repo.commit_all("three").await;
    let third = repo.head().await;

    let outcome = repo
        .backend
        .revert(&[third.clone(), second.clone()], None)
        .await
        .unwrap();
    assert_eq!(outcome, SequenceOutcome::Completed);

    assert_eq!(repo.read("a.txt"), "one\n");
    let subjects = repo.git(&["log", "--format=%s", "-2"]).await;
    assert!(subjects.starts_with("Revert"), "{subjects}");
    assert!(matches!(repo.backend.op_state().await.unwrap(), RepoOpState::None));
}

#[tokio::test]
async fn cherry_pick_conflict_resolve_continue() {
    let repo = TestRepo::init().await;
    conflicting_branches(&repo).await;
    let feature_tip = repo.git(&["rev-parse", "feature"]).await.trim().to_string();

    let outcome = repo.backend.cherry_pick(&[feature_tip.clone()], None).await.unwrap();
    assert!(matches!(outcome, SequenceOutcome::Conflicts { .. }), "{outcome:?}");

    // Real sequencer state drives the op detection.
    match repo.backend.op_state().await.unwrap() {
        RepoOpState::CherryPick { sha } => assert!(feature_tip.starts_with(&sha)),
        other => panic!("expected CherryPick op state, got {other:?}"),
    }

    repo.backend
        .resolve_take_side(std::path::Path::new("a.txt"), ConflictSide::Theirs)
        .await
        .unwrap();
    let outcome = repo.backend.cherry_pick_continue().await.unwrap();
    assert_eq!(outcome, SequenceOutcome::Completed);

    assert_eq!(repo.read("a.txt"), "feature\n");
    assert!(matches!(repo.backend.op_state().await.unwrap(), RepoOpState::None));
}

#[tokio::test]
async fn conflict_file_sides_expose_the_real_index_stages() {
    let repo = TestRepo::init().await;
    conflicting_branches(&repo).await;
    repo.backend
        .merge("feature", MergeOptions::default())
        .await
        .unwrap();

    let sides = repo
        .backend
        .conflict_file_sides(std::path::Path::new("a.txt"))
        .await
        .unwrap();
    assert_eq!(sides.base.as_deref(), Some("base\n"));
    assert_eq!(sides.ours.as_deref(), Some("main\n"));
    assert_eq!(sides.theirs.as_deref(), Some("feature\n"));
}

#[tokio::test]
async fn revert_conflict_abort_restores_state() {
    // Reverting an older commit whose change was since built upon conflicts;
    // abort must restore the pre-revert state.
    let repo = TestRepo::init().await;
    repo.write("a.txt", "base\n");
    repo.commit_all("base").await;
    repo.write("a.txt", "v2\n");
    repo.commit_all("v2").await;
    let middle = repo.head().await;
    repo.write("a.txt", "v3\n");
    repo.commit_all("v3").await;

    let outcome = repo.backend.revert(&[middle.clone()], None).await.unwrap();
    assert!(matches!(outcome, SequenceOutcome::Conflicts { .. }), "{outcome:?}");
    match repo.backend.op_state().await.unwrap() {
        RepoOpState::Revert { sha } => assert!(middle.starts_with(&sha)),
        other => panic!("expected Revert op state, got {other:?}"),
    }

    repo.backend.revert_abort().await.unwrap();
    assert_eq!(repo.read("a.txt"), "v3\n");
    assert!(matches!(repo.backend.op_state().await.unwrap(), RepoOpState::None));
}

#[tokio::test]
async fn reflog_lists_head_movements_newest_first() {
    let repo = TestRepo::init().await;
    let (first, _) = two_commits(&repo).await;
    repo.backend.reset(&first, ResetMode::Hard).await.unwrap();

    let entries = repo.backend.reflog(50).await.unwrap();
    // Two commits + the reset = at least three movements, newest first.
    assert!(entries.len() >= 3, "{entries:?}");
    assert_eq!(entries[0].selector, "HEAD@{0}");
    assert_eq!(entries[0].sha.as_str(), first);
    assert_eq!(entries[0].action, "reset");
    assert!(entries.iter().any(|e| e.action == "commit"));
}

// ---------------------------------------------------------------------------
// cherry-pick / revert state detection (detection ships; triggers are future)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn conflicted_cherry_pick_is_detected() {
    let repo = TestRepo::init().await;
    conflicting_branches(&repo).await;
    let feature_tip = repo.git(&["rev-parse", "feature"]).await.trim().to_string();

    // Setup via raw git: the app has no cherry-pick trigger yet.
    repo.git_any(&["cherry-pick", &feature_tip]).await;

    match repo.backend.op_state().await.unwrap() {
        RepoOpState::CherryPick { sha } => {
            assert!(feature_tip.starts_with(&sha), "{sha} vs {feature_tip}");
        }
        other => panic!("expected CherryPick op state, got {other:?}"),
    }
    assert!(!repo.backend.conflict_entries().await.unwrap().is_empty());
}

// ---------------------------------------------------------------------------
// branch listing: %(upstream:track) divergence (validates the parser's
// assumption about real git's "[ahead N, behind M]" / "[gone]" text)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn branch_list_reports_upstream_divergence_and_gone() {
    let repo = TestRepo::init().await;
    repo.write("a.txt", "base\n");
    repo.commit_all("base").await;

    // A local branch as upstream is enough for %(upstream:track): create `up`
    // at base, diverge it by one commit, and put one extra commit on main.
    repo.git(&["branch", "up"]).await;
    repo.git(&["branch", "--set-upstream-to=up", "main"]).await;
    repo.git(&["switch", "up"]).await;
    repo.write("up.txt", "up\n");
    repo.commit_all("up change").await;
    repo.git(&["switch", "main"]).await;
    repo.write("b.txt", "main\n");
    repo.commit_all("main change").await;

    let branches = repo.backend.branches().await.unwrap();
    let main = branches.iter().find(|b| b.name == "main").expect("main listed");
    assert_eq!(main.ahead, Some(1), "{main:?}");
    assert_eq!(main.behind, Some(1), "{main:?}");
    assert!(!main.upstream_gone);

    // A branch in sync with its upstream reports no divergence.
    let up = branches.iter().find(|b| b.name == "up").expect("up listed");
    assert_eq!((up.ahead, up.behind), (None, None), "{up:?}");

    // Deleting the upstream ref turns the tracking info into "[gone]".
    repo.git(&["branch", "-D", "up"]).await;
    let branches = repo.backend.branches().await.unwrap();
    let main = branches.iter().find(|b| b.name == "main").expect("main listed");
    assert!(main.upstream_gone, "{main:?}");
    assert_eq!((main.ahead, main.behind), (None, None), "{main:?}");
}

// ---------------------------------------------------------------------------
// log author filter: fixed-string, case-insensitive, and no stash injection
// ---------------------------------------------------------------------------

#[tokio::test]
async fn log_author_filter_matches_fixed_string_and_skips_stashes() {
    let repo = TestRepo::init().await;
    repo.write("a.txt", "one\n");
    repo.commit_all("by default author").await;
    repo.write("a.txt", "two\n");
    repo.git(&["add", "-A"]).await;
    // Author with regex metacharacters in the email - must match literally.
    repo.git(&["-c", "user.name=Other Person", "-c", "user.email=o.p+git@example.invalid",
               "commit", "-m", "by other"]).await;
    // A stash: must NOT appear as a synthetic node in a filtered walk.
    repo.write("a.txt", "wip\n");
    repo.git(&["stash", "push", "-m", "wip"]).await;

    let opts = |author: &str| LogOptions {
        refs: RefSelector::AllLocalBranches,
        author: Some(author.to_string()),
        ..Default::default()
    };

    // Case-insensitive name match.
    let by_other = repo.backend.log(opts("other person")).await.unwrap();
    assert_eq!(by_other.len(), 1, "{by_other:?}");
    assert_eq!(by_other[0].message.trim(), "by other");

    // Fixed-string email match ('.' and '+' stay literal).
    let by_email = repo.backend.log(opts("o.p+git@example.invalid")).await.unwrap();
    assert_eq!(by_email.len(), 1, "{by_email:?}");

    // The unfiltered walk injects the stash; the filtered one must not.
    let unfiltered = repo
        .backend
        .log(LogOptions { refs: RefSelector::AllLocalBranches, ..Default::default() })
        .await
        .unwrap();
    assert!(unfiltered.len() > 2, "stash node expected in {unfiltered:?}");
    let filtered = repo.backend.log(opts("LeGit Test")).await.unwrap();
    assert_eq!(filtered.len(), 1, "no stash node expected: {filtered:?}");
}

// ---------------------------------------------------------------------------
// branch-filtered log: stash nodes appear iff their BASE commit is in the
// walked window and the caller opted in (include_stashes)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn range_walk_injects_only_stashes_based_in_the_window() {
    let repo = TestRepo::init().await;
    repo.write("a.txt", "base\n");
    repo.commit_all("base").await;
    // Branch `dev` diverges; a stash is created on top of dev's tip.
    repo.git(&["switch", "-c", "dev"]).await;
    repo.write("a.txt", "dev\n");
    repo.commit_all("dev work").await;
    repo.write("a.txt", "wip\n");
    repo.git(&["stash", "push", "-m", "dev wip"]).await;
    // `main` moves on separately - the stash's base is NOT on main.
    repo.git(&["switch", "main"]).await;
    repo.write("b.txt", "main\n");
    repo.commit_all("main work").await;

    let range_opts = |range: &str, include: bool| LogOptions {
        revision_range: Some(range.to_string()),
        refs: RefSelector::Head,
        include_stashes: include,
        ..Default::default()
    };
    let has_stash = |commits: &[legit_core::types::Commit]| {
        commits.iter().any(|c| {
            c.decorations
                .iter()
                .any(|d| matches!(d, legit_core::types::RefDecoration::Stash(_)))
        })
    };

    // Filter to dev: the stash's base (dev tip) is in the window -> injected.
    let dev = repo.backend.log(range_opts("dev", true)).await.unwrap();
    assert!(has_stash(&dev), "{dev:?}");

    // Filter to main: base not reachable -> no stash node.
    let main = repo.backend.log(range_opts("main", true)).await.unwrap();
    assert!(!has_stash(&main), "{main:?}");

    // Same dev walk WITHOUT the opt-in (interactive-rebase style) -> none.
    let plain = repo.backend.log(range_opts("dev", false)).await.unwrap();
    assert!(!has_stash(&plain), "{plain:?}");
}

/// Commit the worktree with a pinned author+committer date (ISO 8601). The
/// runner scrubs inherited GIT_* vars, so the dates ride a per-invocation
/// `run_with_env` override.
async fn commit_all_at(repo: &TestRepo, msg: &str, date: &str) {
    repo.git(&["add", "-A"]).await;
    git_at(repo, &["commit", "-m", msg], date).await;
}

async fn git_at(repo: &TestRepo, args: &[&str], date: &str) {
    let runner = GitRunner::for_repo("git", &repo.path);
    let out = runner
        .run_with_env(args, &[("GIT_AUTHOR_DATE", date), ("GIT_COMMITTER_DATE", date)])
        .await
        .expect("spawn git");
    assert!(out.success, "`git {args:?}` failed: {}", out.stderr);
}

#[tokio::test]
async fn log_lists_children_before_parents_on_equal_timestamps() {
    // Regression (found 2026-08-19 in a real repo): git log's DEFAULT order
    // is a commit-date priority queue with NO parent-after-child guarantee.
    // When a parent is discovered early via one child and then TIES another
    // child on committer timestamp, git emits the parent first - and the
    // graph's lane algorithm (which walks children -> parents downward)
    // breaks the connector edge. `--date-order` adds exactly the missing
    // guarantee; this pins it against the real binary.
    //
    // Topology (t2 is the tie):
    //   A(t0) -- M(t2, merge A+P) -- Cm(t3) -- T(t5, merge Cm+Cp)   [main]
    //     \      /                            /
    //      P(t2) ------------------ Cp(t4) --                       [via side]
    //
    // Walking from T: Cp(t4) pops before Cm(t3) and discovers P(t2) FIRST;
    // Cm then discovers M(t2), which ties P and (insert-after-equal) queues
    // behind it -> default order emits parent P before its child M.
    let repo = TestRepo::init().await;
    repo.write("base.txt", "base\n");
    commit_all_at(&repo, "A base", "2026-01-01T10:00:00+00:00").await;

    repo.git(&["switch", "-c", "side"]).await;
    repo.write("p.txt", "p\n");
    commit_all_at(&repo, "P tied parent", "2026-01-01T10:02:00+00:00").await;
    let p = repo.head().await;

    repo.git(&["switch", "main"]).await;
    git_at(
        &repo,
        &["merge", "--no-ff", "-m", "M tied child (merge)", "side"],
        "2026-01-01T10:02:00+00:00",
    )
    .await;
    let m = repo.head().await;

    // P's OTHER, newer child - the discovery path that seeds P early.
    repo.git(&["switch", "-c", "other", "side"]).await;
    repo.write("cp.txt", "cp\n");
    commit_all_at(&repo, "Cp late child of P", "2026-01-01T10:04:00+00:00").await;

    repo.git(&["switch", "main"]).await;
    repo.write("cm.txt", "cm\n");
    commit_all_at(&repo, "Cm child of M", "2026-01-01T10:03:00+00:00").await;
    git_at(
        &repo,
        &["merge", "--no-ff", "-m", "T top merge", "other"],
        "2026-01-01T10:05:00+00:00",
    )
    .await;

    let commits = repo.backend.log(LogOptions::default()).await.unwrap();
    let pos = |sha: &str| {
        commits
            .iter()
            .position(|c| c.id.as_str() == sha)
            .unwrap_or_else(|| panic!("{sha} missing from the walk"))
    };
    assert!(
        pos(&m) < pos(&p),
        "child M must be listed before its parent P despite the timestamp tie \
         (got M at {}, P at {})",
        pos(&m),
        pos(&p),
    );
}

// ---------------------------------------------------------------------------
// resolve_commit: rev-parse expressions name commits; tags peel; junk errors
// ---------------------------------------------------------------------------

#[tokio::test]
async fn resolve_commit_accepts_shas_refs_and_expressions() {
    let repo = TestRepo::init().await;
    repo.write("a.txt", "v1\n");
    repo.commit_all("v1").await;
    let first = repo.head().await;
    repo.git(&["tag", "-a", "v1.0", "-m", "release"]).await;
    repo.write("a.txt", "v2\n");
    repo.commit_all("v2").await;
    let second = repo.head().await;

    let b = &repo.backend;
    assert_eq!(b.resolve_commit("main").await.unwrap().0, second);
    assert_eq!(b.resolve_commit("HEAD~1").await.unwrap().0, first);
    // Annotated tag peels to the tagged commit, not the tag object.
    assert_eq!(b.resolve_commit("v1.0").await.unwrap().0, first);
    // Unique SHA prefix resolves too.
    assert_eq!(b.resolve_commit(&second[..8]).await.unwrap().0, second);
    // Junk and dash-leading input error instead of resolving or hanging.
    assert!(b.resolve_commit("no-such-thing").await.is_err());
    assert!(b.resolve_commit("--all").await.is_err());
}

// ---------------------------------------------------------------------------
// ref creation dates: %(creatordate:unix) yields a parseable Unix timestamp
// for branches and for both tag kinds (drives the user-selectable ref sort)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn branch_and_tag_listings_carry_creation_dates() {
    let repo = TestRepo::init().await;
    repo.write("a.txt", "base\n");
    repo.commit_all("base").await;
    repo.git(&["tag", "light"]).await;
    repo.git(&["tag", "-a", "annot", "-m", "annotated"]).await;

    // "a real date, not the parser's 0 fallback": anything past 2001-09-09.
    const EPOCH_FLOOR: i64 = 1_000_000_000;

    let branches = repo.backend.branches().await.unwrap();
    let main = branches.iter().find(|b| b.name == "main").expect("main listed");
    assert!(main.created_at > EPOCH_FLOOR, "{main:?}");

    let tags = repo.backend.tags().await.unwrap();
    for name in ["light", "annot"] {
        let tag = tags.iter().find(|t| t.name == name).expect("tag listed");
        assert!(tag.created_at > EPOCH_FLOOR, "{tag:?}");
    }
}

// ---------------------------------------------------------------------------
// files at revision: `ls-tree -r` lists the commit's tree - tracked content
// only, and a file deleted later still shows at the old rev
// ---------------------------------------------------------------------------

#[tokio::test]
async fn files_at_revision_list_the_commits_tree_only() {
    let repo = TestRepo::init().await;
    repo.write("kept.txt", "v1\n");
    repo.write("doomed.txt", "short-lived\n");
    repo.commit_all("both files").await;
    repo.git(&["rm", "-q", "doomed.txt"]).await;
    repo.git(&["commit", "-q", "-m", "drop doomed"]).await;
    repo.write("untracked.txt", "never added\n");

    let head = repo.backend.list_files_at_revision("HEAD").await.unwrap();
    let head_names: Vec<_> = head.iter().map(|f| f.path.to_string_lossy().to_string()).collect();
    assert!(head_names.contains(&"kept.txt".to_string()), "{head_names:?}");
    assert!(!head_names.contains(&"doomed.txt".to_string()), "{head_names:?}");
    // Untracked files never appear at a revision - a commit only records
    // tracked content (the design decision behind the Files rev mode).
    assert!(!head_names.contains(&"untracked.txt".to_string()), "{head_names:?}");

    let old = repo.backend.list_files_at_revision("HEAD~1").await.unwrap();
    let old_names: Vec<_> = old.iter().map(|f| f.path.to_string_lossy().to_string()).collect();
    assert!(old_names.contains(&"doomed.txt".to_string()), "{old_names:?}");
}

#[tokio::test]
async fn gitlinks_carry_the_submodule_flag_in_both_listings() {
    // A gitlink created via update-index (no .gitmodules needed): mode 160000
    // in `ls-files --stage`, type `commit` in `ls-tree -r` - the two encodings
    // the submodule flag is parsed from.
    let repo = TestRepo::init().await;
    repo.write("a.txt", "base\n");
    repo.commit_all("base").await;
    let head = repo.head().await;
    repo.git(&["update-index", "--add", "--cacheinfo", &format!("160000,{head},sub")])
        .await;
    repo.git(&["commit", "-m", "add gitlink"]).await;

    let live = repo.backend.list_repo_files(false).await.unwrap();
    let sub = live.iter().find(|f| f.path == PathBuf::from("sub")).expect("gitlink listed");
    assert!(sub.submodule, "{sub:?}");
    let plain = live.iter().find(|f| f.path == PathBuf::from("a.txt")).expect("blob listed");
    assert!(!plain.submodule, "{plain:?}");

    let at_rev = repo.backend.list_files_at_revision("HEAD").await.unwrap();
    let sub = at_rev.iter().find(|f| f.path == PathBuf::from("sub")).expect("gitlink listed");
    assert!(sub.submodule, "{sub:?}");
    let plain = at_rev.iter().find(|f| f.path == PathBuf::from("a.txt")).expect("blob listed");
    assert!(!plain.submodule, "{plain:?}");
}

// ---------------------------------------------------------------------------
// file at revision: read (`show rev:path`) and restore (`checkout rev -- path`)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn file_at_revision_reads_and_restores_historic_content() {
    let repo = TestRepo::init().await;
    repo.write("a.txt", "v1\n");
    repo.commit_all("v1").await;
    repo.write("a.txt", "v2\n");
    repo.commit_all("v2").await;
    repo.write("a.txt", "dirty\n"); // uncommitted local edit

    let content = repo
        .backend
        .file_at_revision("HEAD~1", std::path::Path::new("a.txt"))
        .await
        .unwrap();
    assert_eq!(content, legit_core::FileAtRevision::Text("v1\n".to_string()));

    // A path missing at the rev is an error, not empty content.
    let missing = repo
        .backend
        .file_at_revision("HEAD~1", std::path::Path::new("nope.txt"))
        .await;
    assert!(missing.is_err());

    // Restore overwrites the dirty working-tree copy AND stages the content
    // (a pathspec checkout touches index + worktree, without complaint).
    repo.backend
        .restore_file_at_revision("HEAD~1", std::path::Path::new("a.txt"))
        .await
        .unwrap();
    assert_eq!(repo.read("a.txt"), "v1\n");
    let staged = repo.git(&["diff", "--cached", "--name-only"]).await;
    assert!(staged.contains("a.txt"), "restore should stage the file: {staged}");
}

/// Binary content (NUL in the leading bytes) is classified, not returned as
/// mojibake, and the reported size is the blob's exact byte size - validated
/// against the real binary because the lossy decode inflates invalid bytes
/// (each becomes a 3-byte U+FFFD), so `stdout.len()` would be wrong.
#[tokio::test]
async fn file_at_revision_classifies_binary_with_exact_size() {
    let repo = TestRepo::init().await;
    let bytes: Vec<u8> = vec![0x89, b'P', b'N', b'G', 0x00, 0xFF, 0xFE, 0x01, 0x02, 0x03];
    std::fs::write(repo.path.join("blob.bin"), &bytes).expect("write binary file");
    repo.commit_all("binary").await;

    let content = repo
        .backend
        .file_at_revision("HEAD", std::path::Path::new("blob.bin"))
        .await
        .unwrap();
    assert_eq!(
        content,
        legit_core::FileAtRevision::Binary { size_bytes: bytes.len() as u64 }
    );
}

// ---------------------------------------------------------------------------
// file history: --follow across a rename, path-as-of-then feeds file_at_revision
// ---------------------------------------------------------------------------

#[tokio::test]
async fn file_history_follows_renames_and_reports_the_path_at_each_commit() {
    let repo = TestRepo::init().await;
    repo.write("a.txt", "v1\n");
    repo.commit_all("add a").await;
    repo.write("a.txt", "v2\n");
    repo.commit_all("modify a").await;
    repo.git(&["mv", "a.txt", "b.txt"]).await;
    repo.commit_all("rename a to b").await;
    repo.write("b.txt", "v3\n");
    repo.commit_all("modify b").await;

    let history = repo
        .backend
        .file_history(std::path::Path::new("b.txt"), 200, 0, None)
        .await
        .unwrap();

    // Newest first: modify b, rename, modify a, add a - all four, following
    // the rename past the point where the file was named a.txt.
    let subjects: Vec<&str> = history.iter().map(|e| e.summary.as_str()).collect();
    assert_eq!(subjects, ["modify b", "rename a to b", "modify a", "add a"]);

    // The rename commit reports the new path and the old name it came from.
    assert_eq!(history[1].path, "b.txt");
    assert_eq!(history[1].old_path.as_deref(), Some("a.txt"));

    // Pre-rename commits carry the OLD path - so addressing the file at those
    // commits with that path actually resolves (the whole point of tracking
    // path-as-of-then).
    assert_eq!(history[2].path, "a.txt");
    assert_eq!(history[3].path, "a.txt");
    let old = repo
        .backend
        .file_at_revision(history[3].commit_id.as_str(), std::path::Path::new(&history[3].path))
        .await
        .unwrap();
    assert_eq!(old, legit_core::FileAtRevision::Text("v1\n".to_string()));

    // Paging: skipping the newest leaves the remaining three.
    let page = repo
        .backend
        .file_history(std::path::Path::new("b.txt"), 200, 1, None)
        .await
        .unwrap();
    assert_eq!(page.len(), 3);
    assert_eq!(page[0].summary, "rename a to b");
}

/// The bug the start-rev walk fixes: a file that only exists on a side branch
/// has NO history from HEAD (the panel showed empty while the user was
/// browsing that branch's tree). Walking from the browsed rev finds it.
#[tokio::test]
async fn file_history_from_a_rev_outside_head_ancestry_finds_the_file() {
    let repo = TestRepo::init().await;
    repo.write("base.txt", "base\n");
    repo.commit_all("base").await;
    repo.git(&["switch", "-c", "side"]).await;
    repo.write("only-on-side.txt", "v1\n");
    repo.commit_all("add side file").await;
    let side_tip = repo.head().await;
    repo.git(&["switch", "main"]).await;
    repo.write("base.txt", "base2\n");
    repo.commit_all("advance main").await;

    let from_head = repo
        .backend
        .file_history(std::path::Path::new("only-on-side.txt"), 200, 0, None)
        .await
        .unwrap();
    assert!(from_head.is_empty(), "pre-fix behavior: HEAD walk finds nothing");

    let from_rev = repo
        .backend
        .file_history(std::path::Path::new("only-on-side.txt"), 200, 0, Some(&side_tip))
        .await
        .unwrap();
    let subjects: Vec<&str> = from_rev.iter().map(|e| e.summary.as_str()).collect();
    assert_eq!(subjects, ["add side file"]);
}

/// Start-rev scoping: the walk excludes commits newer than the rev, so the
/// history matches the browsed tree. Also pins the verified-against-real-git
/// fact (2026-07-31) that a deleted file's HEAD walk is NOT empty - the
/// original backlog claim was imprecise, deletion alone never was the bug.
#[tokio::test]
async fn file_history_from_a_rev_excludes_later_commits() {
    let repo = TestRepo::init().await;
    repo.write("a.txt", "v1\n");
    repo.commit_all("add a").await;
    repo.write("a.txt", "v2\n");
    repo.commit_all("modify a").await;
    let pre_delete = repo.head().await;
    repo.git(&["rm", "a.txt"]).await;
    repo.commit_all("delete a").await;

    let from_head = repo
        .backend
        .file_history(std::path::Path::new("a.txt"), 200, 0, None)
        .await
        .unwrap();
    let head_subjects: Vec<&str> = from_head.iter().map(|e| e.summary.as_str()).collect();
    assert_eq!(head_subjects, ["delete a", "modify a", "add a"]);

    let from_rev = repo
        .backend
        .file_history(std::path::Path::new("a.txt"), 200, 0, Some(&pre_delete))
        .await
        .unwrap();
    let subjects: Vec<&str> = from_rev.iter().map(|e| e.summary.as_str()).collect();
    assert_eq!(subjects, ["modify a", "add a"]);
}

/// `--follow` keeps tracking renames when the walk starts at an explicit rev.
#[tokio::test]
async fn file_history_from_a_rev_still_follows_renames() {
    let repo = TestRepo::init().await;
    repo.write("a.txt", "v1\n");
    repo.commit_all("add a").await;
    repo.git(&["mv", "a.txt", "b.txt"]).await;
    repo.commit_all("rename a to b").await;
    repo.write("b.txt", "v2\n");
    repo.commit_all("modify b").await;
    let rev = repo.head().await;
    repo.write("b.txt", "v3\n");
    repo.commit_all("later change").await;

    let history = repo
        .backend
        .file_history(std::path::Path::new("b.txt"), 200, 0, Some(&rev))
        .await
        .unwrap();
    let subjects: Vec<&str> = history.iter().map(|e| e.summary.as_str()).collect();
    assert_eq!(subjects, ["modify b", "rename a to b", "add a"]);
    assert_eq!(history[2].path, "a.txt");
}

// ---------------------------------------------------------------------------
// credential helper injection via GIT_CONFIG_* environment config
// (the in-app credential prompt depends on: env config applies like `-c`,
// a `!shell` helper runs with the op appended, and its output is consumed)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn env_injected_credential_helper_is_consulted() {
    use std::io::Write as _;
    use std::process::{Command, Stdio};

    let dir = tempfile::tempdir().expect("tempdir");
    let helper = r#"!f() { test "$1" = get && printf 'username=u-from-helper\npassword=p-from-helper\n'; }; f"#;

    let mut child = Command::new("git")
        .current_dir(dir.path())
        .env("GIT_CONFIG_COUNT", "1")
        .env("GIT_CONFIG_KEY_0", "credential.helper")
        .env("GIT_CONFIG_VALUE_0", helper)
        .env("GIT_TERMINAL_PROMPT", "0")
        .args(["credential", "fill"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn git credential fill");
    child
        .stdin
        .take()
        .unwrap()
        .write_all(b"protocol=https\nhost=example.invalid\n\n")
        .unwrap();
    let out = child.wait_with_output().expect("git credential fill");
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(out.status.success(), "stderr: {}", String::from_utf8_lossy(&out.stderr));
    assert!(stdout.contains("username=u-from-helper"), "{stdout}");
    assert!(stdout.contains("password=p-from-helper"), "{stdout}");
}

// ---------------------------------------------------------------------------
// non-UTF-8 output survives the runner (lossy decode, never silently empty)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn non_utf8_file_content_is_not_silently_dropped() {
    let repo = TestRepo::init().await;
    // Latin-1 "caf<e9>" + newline: invalid UTF-8, but text to git (no NUL).
    std::fs::write(repo.path.join("latin1.txt"), b"caf\xe9\n").expect("write file");
    repo.commit_all("latin1").await;

    // Latin-1 is invalid UTF-8 but has no NUL, so it must stay classified as
    // TEXT (lossy-decoded), never flip to the binary notice.
    let content = repo
        .backend
        .file_at_revision("HEAD", std::path::Path::new("latin1.txt"))
        .await
        .unwrap();
    let legit_core::FileAtRevision::Text(content) = content else {
        panic!("NUL-free non-UTF-8 content must classify as text: {content:?}");
    };
    assert!(!content.is_empty(), "non-UTF-8 content must not vanish");
    assert!(content.starts_with("caf"), "{content:?}");

    // The same guarantee for a diff of such a file.
    std::fs::write(repo.path.join("latin1.txt"), b"caf\xe9 au lait\n").expect("write file");
    let diff = repo
        .backend
        .file_diff(
            &legit_core::DiffSource::WorkingUnstaged,
            std::path::Path::new("latin1.txt"),
            None,
            3,
        )
        .await
        .unwrap();
    match diff {
        legit_core::DiffEntry::Text(text) => {
            assert!(!text.hunks.is_empty(), "diff of a modified non-UTF-8 file must show hunks");
        }
        other => panic!("expected a text diff, got {other:?}"),
    }
}

// ---------------------------------------------------------------------------
// CRLF content survives hunk staging (rebuilt patches must keep the \r bytes)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn hunk_staging_works_on_crlf_files() {
    let repo = TestRepo::init().await; // pins core.autocrlf=false
    repo.write("c.txt", "a\r\nb\r\nc\r\n");
    repo.commit_all("crlf base").await;
    repo.write("c.txt", "a\r\nB\r\nc\r\n");

    repo.backend
        .apply_hunk(std::path::Path::new("c.txt"), 0, legit_core::HunkOp::Stage)
        .await
        .expect("staging a CRLF hunk must succeed");

    let staged = repo.git(&["diff", "--cached"]).await;
    assert!(staged.contains("+B\r"), "staged patch kept the CR: {staged:?}");
    // Nothing left unstaged: the whole change was one hunk.
    let unstaged = repo.git(&["diff"]).await;
    assert!(unstaged.trim().is_empty(), "{unstaged:?}");
}

// ---------------------------------------------------------------------------
// Files tree — list_repo_files classification and rm_cached, against real git
// ---------------------------------------------------------------------------

fn kind_of(files: &[RepoFileEntry], rel: &str) -> Option<RepoFileKind> {
    files
        .iter()
        .find(|f| f.path == PathBuf::from(rel))
        .map(|f| f.kind)
}

#[tokio::test]
async fn list_repo_files_classifies_tracked_untracked_ignored() {
    let repo = TestRepo::init().await;
    repo.write(".gitignore", "*.log\n");
    std::fs::create_dir_all(repo.path.join("src")).unwrap();
    repo.write("src/main.rs", "fn main() {}\n");
    repo.commit_all("seed").await; // .gitignore + src/main.rs are now tracked
    repo.write("notes.txt", "todo\n"); // untracked, not ignored
    repo.write("debug.log", "noise\n"); // ignored by *.log

    // Without ignored: tracked + untracked only, sorted, no debug.log.
    let files = repo.backend.list_repo_files(false).await.unwrap();
    assert_eq!(kind_of(&files, ".gitignore"), Some(RepoFileKind::Tracked));
    assert_eq!(kind_of(&files, "src/main.rs"), Some(RepoFileKind::Tracked));
    assert_eq!(kind_of(&files, "notes.txt"), Some(RepoFileKind::Untracked));
    assert_eq!(kind_of(&files, "debug.log"), None, "ignored file leaked in");
    // Sorted by path.
    let paths: Vec<_> = files.iter().map(|f| f.path.clone()).collect();
    let mut sorted = paths.clone();
    sorted.sort();
    assert_eq!(paths, sorted, "files not sorted by path");

    // With ignored: debug.log now appears, classified Ignored.
    let files = repo.backend.list_repo_files(true).await.unwrap();
    assert_eq!(kind_of(&files, "debug.log"), Some(RepoFileKind::Ignored));
}

#[tokio::test]
async fn list_repo_files_reports_a_nested_repo_as_one_slashless_entry() {
    // `ls-files --others` does not descend into a foreign work tree - it
    // reports the nested repo as `dir/` WITH a trailing slash. Encoded here
    // because the Files tree must never see the slash form: it would render
    // as a folder containing an empty-named child row.
    let repo = TestRepo::init().await;
    repo.write("a.txt", "base\n");
    repo.commit_all("base").await;
    std::fs::create_dir_all(repo.path.join("nested")).unwrap();
    let nested_runner = GitRunner::for_repo("git", &repo.path.join("nested"));
    let out = nested_runner.run(&["init", "-b", "main"]).await.expect("spawn git");
    assert!(out.success, "nested init failed: {}", out.stderr);
    repo.write("nested/file.txt", "x\n");

    let files = repo.backend.list_repo_files(false).await.unwrap();
    assert_eq!(kind_of(&files, "nested"), Some(RepoFileKind::Untracked), "{files:?}");
    assert!(
        files.iter().all(|f| !f.path.to_string_lossy().ends_with('/')),
        "trailing-slash path leaked into the listing: {files:?}"
    );
    // The trailing-slash form is what marks a nested repo - kept as the flag.
    let nested = files.iter().find(|f| f.path == PathBuf::from("nested")).unwrap();
    assert!(nested.submodule, "{nested:?}");
}

#[tokio::test]
async fn rm_cached_untracks_but_keeps_file_on_disk() {
    let repo = TestRepo::init().await;
    repo.write("secret.env", "TOKEN=abc\n");
    repo.commit_all("add secret").await;
    assert_eq!(
        repo.backend.list_repo_files(false).await.unwrap().pop().map(|f| f.kind),
        Some(RepoFileKind::Tracked),
    );

    repo.backend.rm_cached(&[PathBuf::from("secret.env")]).await.unwrap();

    // Still on disk, now untracked (would move to the Untracked group).
    assert!(repo.exists("secret.env"), "rm --cached deleted the file");
    let files = repo.backend.list_repo_files(false).await.unwrap();
    assert_eq!(kind_of(&files, "secret.env"), Some(RepoFileKind::Untracked));
}

// ---------------------------------------------------------------------------
// status - numstat line counts against real git
// ---------------------------------------------------------------------------

#[tokio::test]
async fn status_reports_line_counts_per_side() {
    let repo = TestRepo::init().await;
    repo.write("a.txt", "one\ntwo\n");
    repo.commit_all("base").await;

    // Stage a two-line addition, then remove three lines in the worktree.
    repo.write("a.txt", "one\ntwo\nthree\nfour\n");
    repo.git(&["add", "a.txt"]).await;
    repo.write("a.txt", "one\n");
    // A staged binary file and an untracked file.
    std::fs::write(repo.path.join("pic.bin"), b"\x89PNG\0\x01junk").expect("write binary");
    repo.git(&["add", "pic.bin"]).await;
    repo.write("untracked.txt", "x\n");

    let status = repo.backend.status().await.unwrap();
    let find = |path: &str, staged: bool| {
        status
            .iter()
            .find(|s| s.path == PathBuf::from(path) && s.staged == staged)
            .unwrap_or_else(|| panic!("no entry for {path} staged={staged}"))
    };

    let staged = find("a.txt", true);
    assert_eq!((staged.additions, staged.deletions), (Some(2), Some(0)));
    let unstaged = find("a.txt", false);
    assert_eq!((unstaged.additions, unstaged.deletions), (Some(0), Some(3)));

    let binary = find("pic.bin", true);
    assert!(binary.binary, "numstat `-`/`-` must mark the entry binary");
    assert_eq!((binary.additions, binary.deletions), (None, None));

    let untracked = find("untracked.txt", false);
    assert_eq!(untracked.state, FileState::Untracked);
    assert_eq!((untracked.additions, untracked.deletions), (None, None));
}

#[tokio::test]
async fn status_counts_work_before_the_first_commit() {
    // `diff --cached` runs against an unborn HEAD here; the counts must either
    // come back (git diffs the index against the empty tree) or degrade to
    // None - status itself must never fail over count enrichment.
    let repo = TestRepo::init().await;
    repo.write("a.txt", "one\ntwo\n");
    repo.git(&["add", "a.txt"]).await;

    let status = repo.backend.status().await.unwrap();
    assert_eq!(status.len(), 1);
    assert_eq!(status[0].state, FileState::Added);
    assert!(status[0].staged);
    assert!(
        status[0].additions == Some(2) || status[0].additions.is_none(),
        "unexpected staged additions: {:?}",
        status[0].additions
    );
}

#[tokio::test]
async fn status_reports_counts_for_a_staged_rename() {
    // Rename detection must key counts by the destination path, matching the
    // porcelain status record (which reports the new path).
    let repo = TestRepo::init().await;
    repo.write("old.txt", "one\ntwo\nthree\n");
    repo.commit_all("base").await;
    repo.git(&["mv", "old.txt", "new.txt"]).await;
    repo.write("new.txt", "one\ntwo\nthree\nfour\n");
    repo.git(&["add", "new.txt"]).await;

    let status = repo.backend.status().await.unwrap();
    let entry = status
        .iter()
        .find(|s| s.path == PathBuf::from("new.txt") && s.staged)
        .expect("staged rename entry");
    assert_eq!(entry.state, FileState::Renamed);
    assert_eq!((entry.additions, entry.deletions), (Some(1), Some(0)));
}

#[tokio::test]
async fn status_reports_a_conflict_as_a_single_unstaged_entry() {
    // Conflicts arrive as porcelain v2 `u` records; the parser must fold each
    // into exactly one Conflicted entry (never split staged/unstaged, never
    // duplicated), matching the old v1 behavior for `UU` forms.
    let repo = TestRepo::init().await;
    conflicting_branches(&repo).await;
    let outcome = repo.backend.merge("feature", MergeOptions::default()).await.unwrap();
    assert!(matches!(outcome, MergeOutcome::Conflicts { .. }), "{outcome:?}");

    let status = repo.backend.status().await.unwrap();
    let conflicted: Vec<_> = status
        .iter()
        .filter(|s| s.path == PathBuf::from("a.txt"))
        .collect();
    assert_eq!(conflicted.len(), 1, "one entry for the conflicted path: {status:?}");
    assert_eq!(conflicted[0].state, FileState::Conflicted);
    assert!(!conflicted[0].staged);
    assert_eq!((conflicted[0].additions, conflicted[0].deletions), (None, None));
}

// ---------------------------------------------------------------------------
// submodules - enumeration, status classification, diffs, range logs
// ---------------------------------------------------------------------------

#[tokio::test]
async fn submodules_reports_a_real_submodule() {
    let (sup, _lib) = repo_with_submodule().await;

    let subs = sup.backend.submodules().await.unwrap();
    assert_eq!(subs.len(), 1);
    let s = &subs[0];
    assert_eq!(s.name, "lib");
    assert_eq!(s.path, PathBuf::from("lib"));
    assert!(s.state.initialized && s.state.populated);
    assert!(!s.state.pointer_moved && !s.state.orphan_gitlink);
    assert_eq!(s.recorded_sha, s.checked_out_sha);
    assert!(s.gitmodules_url.is_some());

    // Move the submodule's HEAD: pointer_moved must flip.
    let sub_path = sup.path.join("lib").to_string_lossy().into_owned();
    sup.git(&["-C", &sub_path, "commit", "--allow-empty", "-m", "bump"]).await;
    let subs = sup.backend.submodules().await.unwrap();
    assert!(subs[0].state.pointer_moved);

    // Untracked file inside: dirty_untracked must flip.
    sup.write("lib/junk.txt", "x\n");
    let subs = sup.backend.submodules().await.unwrap();
    assert!(subs[0].state.dirty_untracked);
}

#[tokio::test]
async fn submodule_move_relocates_worktree_gitmodules_and_stays_functional() {
    let (sup, _lib) = repo_with_submodule().await;
    // Dirty content must travel with the move.
    sup.write("lib/wip.txt", "uncommitted\n");

    sup.backend
        .submodule_move(Path::new("lib"), Path::new("vendor/lib"))
        .await
        .unwrap();

    // Worktree moved (dirt included), .gitmodules rewritten, change staged.
    assert!(sup.exists("vendor/lib/lib.txt"));
    assert!(sup.exists("vendor/lib/wip.txt"));
    assert!(!sup.exists("lib"));
    assert!(sup.read(".gitmodules").contains("path = vendor/lib"));
    let staged = sup.git(&["diff", "--cached", "--name-only"]).await;
    assert!(staged.contains(".gitmodules"), "{staged}");
    // The gitfile link still resolves: git works inside the moved submodule,
    // and the gitdir key kept the ORIGINAL name.
    let gitdir = sup.git(&["-C", "vendor/lib", "rev-parse", "--absolute-git-dir"]).await;
    assert!(
        gitdir.replace('\\', "/").contains(".git/modules/lib"),
        "gitdir key must keep the original name: {gitdir}"
    );
    // The enumeration sees the new path under the old name.
    let subs = sup.backend.submodules().await.unwrap();
    assert_eq!(subs.len(), 1);
    assert_eq!(subs[0].name, "lib");
    assert_eq!(subs[0].path, PathBuf::from("vendor/lib"));
    // A follow-up commit of the staged move succeeds.
    sup.git(&["commit", "-m", "move submodule"]).await;

    // Occupied target: refused, nothing changed.
    sup.write("taken", "occupied\n");
    let err = sup
        .backend
        .submodule_move(Path::new("vendor/lib"), Path::new("taken"))
        .await
        .unwrap_err();
    assert!(err.to_string().contains("already exists"), "{err:?}");
    assert!(sup.exists("vendor/lib/lib.txt"));
}

#[tokio::test]
async fn submodule_move_works_on_an_uninitialized_submodule() {
    // Encodes real git's behavior for moving a deinit-ed submodule: the
    // gitlink and .gitmodules entry move even without a populated worktree.
    let (sup, _lib) = repo_with_submodule().await;
    sup.git(&["submodule", "deinit", "-f", "--", "lib"]).await;

    sup.backend
        .submodule_move(Path::new("lib"), Path::new("third_party/lib"))
        .await
        .unwrap();

    assert!(sup.read(".gitmodules").contains("path = third_party/lib"));
    let subs = sup.backend.submodules().await.unwrap();
    assert_eq!(subs.len(), 1);
    assert_eq!(subs[0].name, "lib");
    assert_eq!(subs[0].path, PathBuf::from("third_party/lib"));
    assert!(!subs[0].state.populated);
}

#[tokio::test]
async fn submodule_update_attach_branch_reattaches_the_configured_branch() {
    // Encodes the assumptions the branch-attach feature is built on:
    // (1) `submodule update` checks out the recorded SHA DETACHED even when
    //     the configured branch points at exactly that commit (the premise);
    // (2) `for-each-ref --points-at HEAD --format=%(refname:short)` lists
    //     that branch;
    // (3) the follow-up `checkout` attaches and leaves both worktrees clean.
    let (sup, _lib) = repo_with_submodule().await;
    // Track `main` in .gitmodules (read back by submodules()); commit the
    // .gitmodules edit so the final cleanliness assertion sees only what the
    // attach itself did.
    sup.backend
        .submodule_set_branch(Path::new("lib"), Some("main"))
        .await
        .unwrap();
    sup.git(&["add", ".gitmodules"]).await;
    sup.git(&["commit", "-m", "track main"]).await;

    // Move the submodule's HEAD off the recorded SHA (update skips a
    // submodule already sitting at the gitlink): a detached commit inside
    // the submodule. `main` keeps pointing at the recorded commit.
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

#[tokio::test]
async fn status_classifies_submodule_pointer_moves_and_dirt() {
    let (sup, _lib) = repo_with_submodule().await;
    let sub_path = sup.path.join("lib").to_string_lossy().into_owned();

    // Dirty-only (untracked file inside): visible as the informational
    // SubmoduleDirty entry (unmoved pointer - nothing stageable).
    sup.write("lib/junk.txt", "x\n");
    let status = sup.backend.status().await.unwrap();
    let entry = status
        .iter()
        .find(|s| s.path == PathBuf::from("lib"))
        .expect("dirty-only submodule must be visible");
    assert_eq!(entry.state, FileState::SubmoduleDirty);
    assert!(!entry.staged);
    assert_eq!((entry.additions, entry.deletions), (None, None));
    std::fs::remove_file(sup.path.join("lib/junk.txt")).unwrap();

    // Worktree pointer move: unstaged SubmoduleChanged.
    sup.git(&["-C", &sub_path, "commit", "--allow-empty", "-m", "bump"]).await;
    let status = sup.backend.status().await.unwrap();
    let entry = status
        .iter()
        .find(|s| s.path == PathBuf::from("lib"))
        .expect("pointer move must appear");
    assert_eq!(entry.state, FileState::SubmoduleChanged);
    assert!(!entry.staged);
    assert_eq!((entry.additions, entry.deletions), (None, None));

    // Staged pointer move: staged SubmoduleChanged.
    sup.git(&["add", "lib"]).await;
    let status = sup.backend.status().await.unwrap();
    let entry = status
        .iter()
        .find(|s| s.path == PathBuf::from("lib"))
        .expect("staged move must appear");
    assert_eq!(entry.state, FileState::SubmoduleChanged);
    assert!(entry.staged);
}

#[tokio::test]
async fn file_diff_returns_a_submodule_entry_for_a_pointer_move() {
    let (sup, _lib) = repo_with_submodule().await;
    let sub_path = sup.path.join("lib").to_string_lossy().into_owned();
    let old = sup.git(&["-C", &sub_path, "rev-parse", "HEAD"]).await.trim().to_string();
    sup.git(&["-C", &sub_path, "commit", "--allow-empty", "-m", "bump"]).await;
    let new = sup.git(&["-C", &sub_path, "rev-parse", "HEAD"]).await.trim().to_string();

    let entry = sup
        .backend
        .file_diff(&DiffSource::WorkingUnstaged, Path::new("lib"), None, 3)
        .await
        .unwrap();
    let DiffEntry::Submodule(sub) = entry else { panic!("expected Submodule: {entry:?}") };
    assert_eq!(sub.old_sha.as_ref().map(|s| s.as_str().to_string()), Some(old));
    assert_eq!(sub.new_sha.as_ref().map(|s| s.as_str().to_string()), Some(new));
    assert!(!sub.dirty);
}

#[tokio::test]
async fn commit_files_classifies_a_submodule_bump() {
    let (sup, _lib) = repo_with_submodule().await;
    let sub_path = sup.path.join("lib").to_string_lossy().into_owned();
    sup.git(&["-C", &sub_path, "commit", "--allow-empty", "-m", "bump"]).await;
    sup.git(&["add", "lib"]).await;
    sup.git(&["commit", "-m", "bump submodule"]).await;

    let head = sup.head().await;
    let files = sup.backend.commit_files(&CommitId::new(head)).await.unwrap();
    let lib = files.iter().find(|f| f.path == PathBuf::from("lib")).expect("lib entry");
    assert_eq!(lib.change, FileState::SubmoduleChanged);
}

#[tokio::test]
async fn submodule_log_reports_the_commits_between_pointers() {
    let (sup, _lib) = repo_with_submodule().await;
    let sub_path = sup.path.join("lib").to_string_lossy().into_owned();
    let old = sup.git(&["-C", &sub_path, "rev-parse", "HEAD"]).await.trim().to_string();
    sup.git(&["-C", &sub_path, "commit", "--allow-empty", "-m", "bump one"]).await;
    sup.git(&["-C", &sub_path, "commit", "--allow-empty", "-m", "bump two"]).await;
    let new = sup.git(&["-C", &sub_path, "rev-parse", "HEAD"]).await.trim().to_string();

    let log = sup
        .backend
        .submodule_log(Path::new("lib"), Some(&CommitId::new(old)), &CommitId::new(new))
        .await
        .unwrap();
    let SubmoduleLog::Commits { commits } = log else { panic!("{log:?}") };
    assert_eq!(commits.len(), 2);
    assert_eq!(commits[0].subject, "bump two"); // newest first

    // A fabricated SHA is an unfetched target, not an error.
    let log = sup
        .backend
        .submodule_log(
            Path::new("lib"),
            None,
            &CommitId::new("0123456789012345678901234567890123456789"),
        )
        .await
        .unwrap();
    assert!(matches!(log, SubmoduleLog::TargetMissing));
}

#[tokio::test]
async fn submodule_ops_roundtrip_deinit_update_init() {
    let (sup, _lib) = repo_with_submodule().await;

    // Make it uninitialized+unpopulated the way a fresh clone would be.
    sup.git(&["submodule", "deinit", "-f", "--", "lib"]).await;
    let subs = sup.backend.submodules().await.unwrap();
    assert!(!subs[0].state.initialized && !subs[0].state.populated);

    // `update --init` registers AND populates at the recorded SHA (the
    // registration is folded into the update; there is no separate init).
    sup.backend
        .submodule_update(
            SubmoduleUpdateOptions {
                init: true,
                paths: vec![PathBuf::from("lib")],
                ..Default::default()
            },
            OperationId("t".into()),
        )
        .await
        .unwrap();
    let subs = sup.backend.submodules().await.unwrap();
    assert!(
        subs[0].state.initialized && subs[0].state.populated && !subs[0].state.pointer_moved,
        "{:?}",
        subs[0].state
    );

    // sync succeeds (URL copy is a no-op here but must not error).
    sup.backend.submodule_sync(&[PathBuf::from("lib")], false).await.unwrap();
}

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

    let results = sup
        .backend
        .submodule_update_remote(
            &[PathBuf::from("lib")],
            SubmoduleUpdateStrategy::Checkout,
            SwitchDirtyBehavior::AutoStash,
            false,
            OperationId("t".into()),
        )
        .await
        .unwrap();
    assert!(matches!(results[0].status, SubmoduleAutoUpdateStatus::Updated), "{results:?}");

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

#[tokio::test]
async fn submodule_update_remote_handles_dirty_submodules_safely() {
    // The E2EQSS scenario: "Pull latest" on a submodule with local edits.
    let (sup, lib) = repo_with_submodule().await;
    let sub_path = sup.path.join("lib").to_string_lossy().into_owned();
    sup.git(&["-C", &sub_path, "config", "protocol.file.allow", "always"]).await;
    let old = sup.git(&["-C", &sub_path, "rev-parse", "HEAD"]).await.trim().to_string();

    // Upstream changes lib.txt; the local edit conflicts with it.
    lib.write("lib.txt", "upstream v2\n");
    lib.commit_all("lib v2").await;
    sup.write("lib/lib.txt", "local work\n");

    // AutoStash + conflicting carry-over: rolled back, changes intact.
    let results = sup
        .backend
        .submodule_update_remote(
            &[PathBuf::from("lib")],
            SubmoduleUpdateStrategy::Checkout,
            SwitchDirtyBehavior::AutoStash,
            false,
            OperationId("t1".into()),
        )
        .await
        .unwrap();
    assert!(
        matches!(results[0].status, SubmoduleAutoUpdateStatus::RolledBack { .. }),
        "{results:?}"
    );
    let head = sup.git(&["-C", &sub_path, "rev-parse", "HEAD"]).await.trim().to_string();
    assert_eq!(head, old, "rolled back to the pre-pull commit");
    assert_eq!(sup.read("lib/lib.txt"), "local work\n", "changes intact, no markers");
    // No staged pointer: the move did not stick.
    let status = sup.backend.status().await.unwrap();
    assert!(
        !status.iter().any(|s| s.path == PathBuf::from("lib") && s.staged),
        "nothing staged after rollback: {status:?}"
    );

    // Non-conflicting dirt (untracked file): drop the conflicting edit,
    // then the untracked file is carried to the new commit and the pointer
    // staged.
    sup.git(&["-C", &sub_path, "checkout", "--", "lib.txt"]).await;
    sup.write("lib/notes.txt", "wip\n");
    let results = sup
        .backend
        .submodule_update_remote(
            &[PathBuf::from("lib")],
            SubmoduleUpdateStrategy::Checkout,
            SwitchDirtyBehavior::AutoStash,
            false,
            OperationId("t2".into()),
        )
        .await
        .unwrap();
    assert!(
        matches!(results[0].status, SubmoduleAutoUpdateStatus::ChangesCarried),
        "{results:?}"
    );
    assert_eq!(sup.read("lib/notes.txt"), "wip\n");
    let status = sup.backend.status().await.unwrap();
    assert!(
        status.iter().any(|s| s.path == PathBuf::from("lib") && s.staged),
        "moved pointer staged: {status:?}"
    );
}

#[tokio::test]
async fn submodule_remove_keeps_gitdir_and_delete_is_separate() {
    let (sup, _lib) = repo_with_submodule().await;
    let sub_path = sup.path.join("lib").to_string_lossy().into_owned();

    // Dirty submodule: remove must refuse and change nothing.
    sup.write("lib/wip.txt", "precious\n");
    let err = sup.backend.submodule_remove(Path::new("lib")).await.unwrap_err();
    assert!(
        matches!(err, legit_core::GitError::WouldOverwriteLocalChanges(_)),
        "{err:?}"
    );
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

/// `.git/modules/<name>` replaced by a symlink: the gitdir helpers must
/// refuse it rather than report or delete whatever it points at.
#[cfg(unix)]
#[tokio::test]
async fn submodule_gitdir_symlink_is_refused() {
    let (sup, _lib) = repo_with_submodule().await;
    sup.backend.submodule_remove(Path::new("lib")).await.unwrap();
    let modules_lib = sup.path.join(".git").join("modules").join("lib");
    assert!(modules_lib.is_dir(), "retained gitdir expected at {}", modules_lib.display());

    std::fs::remove_dir_all(&modules_lib).unwrap();
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("precious.txt"), "keep\n").unwrap();
    std::os::unix::fs::symlink(outside.path(), &modules_lib).unwrap();

    let err = sup.backend.submodule_gitdir_info("lib").await.unwrap_err();
    assert!(matches!(err, legit_core::GitError::Internal(_)), "{err:?}");
    let err = sup.backend.submodule_delete_gitdir("lib").await.unwrap_err();
    assert!(matches!(err, legit_core::GitError::Internal(_)), "{err:?}");
    assert!(
        outside.path().join("precious.txt").exists(),
        "the symlink target must be untouched"
    );
}

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
    let results = sup.backend.submodule_auto_update(SwitchDirtyBehavior::AutoStash, false).await.unwrap();
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
    let results = sup.backend.submodule_auto_update(SwitchDirtyBehavior::AutoStash, false).await.unwrap();
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
    let results = sup.backend.submodule_auto_update(SwitchDirtyBehavior::AutoStash, false).await.unwrap();
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
    let results = sup.backend.submodule_auto_update(SwitchDirtyBehavior::StashAndKeep, false).await.unwrap();
    assert!(matches!(results[0].status, SubmoduleAutoUpdateStatus::ChangesStashed), "{results:?}");
    let sub_path = sup.path.join("lib").to_string_lossy().into_owned();
    let head = sup.git(&["-C", &sub_path, "rev-parse", "HEAD"]).await.trim().to_string();
    assert_eq!(head, new);
    let stashes = sup.git(&["-C", &sub_path, "stash", "list"]).await;
    assert!(!stashes.trim().is_empty(), "changes parked in the submodule stash");
}

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

// ---------------------------------------------------------------------------
// remote flows against ephemeral bare file:// remotes
//
// A throwaway bare repo behind a file:// URL exercises the same fetch/push/
// pull code paths as a network remote (the file:// form forces the real
// transport instead of the local hardlink optimization) minus authentication,
// fully offline and CI-safe.
// ---------------------------------------------------------------------------

/// An ephemeral bare "remote": its tempdir (keep it alive), its path (for
/// running git against the remote itself), and its file:// URL.
async fn bare_remote() -> (TempDir, PathBuf, String) {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().to_path_buf();
    let runner = GitRunner::for_repo("git", &path);
    let out = runner
        .run(&["init", "--bare", "-b", "main"])
        .await
        .expect("spawn git");
    assert!(out.success, "bare init failed: {}", out.stderr);
    let url = format!(
        "file:///{}",
        path.to_string_lossy().replace('\\', "/").trim_start_matches('/')
    );
    (dir, path, url)
}

fn push_opts(branch: &str, set_upstream: bool, force_with_lease: bool) -> PushOptions {
    PushOptions {
        remote: "origin".into(),
        branch: branch.into(),
        set_upstream,
        force_with_lease,
        recurse_submodules: None,
    }
}

#[tokio::test]
async fn push_publishes_branch_and_tracking_counts_ahead() {
    let (_keep, _, url) = bare_remote().await;
    let repo = TestRepo::init().await;
    repo.write("a.txt", "base\n");
    repo.commit_all("base").await;
    repo.git(&["remote", "add", "origin", &url]).await;

    // Publish with upstream: tracking must exist and be in sync.
    repo.backend
        .push(push_opts("main", true, false), OperationId::new())
        .await
        .unwrap();
    let t = repo.backend.tracking_status().await.unwrap().expect("tracking after publish");
    assert_eq!(t.upstream, "origin/main");
    assert_eq!((t.ahead, t.behind), (0, 0));

    // A new local commit shows as ahead=1; pushing again drains it.
    repo.write("a.txt", "more\n");
    repo.commit_all("more").await;
    let t = repo.backend.tracking_status().await.unwrap().unwrap();
    assert_eq!((t.ahead, t.behind), (1, 0));

    repo.backend
        .push(push_opts("main", false, false), OperationId::new())
        .await
        .unwrap();
    let t = repo.backend.tracking_status().await.unwrap().unwrap();
    assert_eq!((t.ahead, t.behind), (0, 0));
}

#[tokio::test]
async fn push_targets_a_non_checked_out_branch_even_with_a_same_named_tag() {
    let (_keep, remote_path, url) = bare_remote().await;
    let repo = TestRepo::init().await;
    repo.write("a.txt", "base\n");
    repo.commit_all("base").await;
    repo.git(&["remote", "add", "origin", &url]).await;

    // A branch that is NOT checked out, plus a same-named tag: a bare-name
    // refspec is ambiguous here ("src refspec matches more than one"), so the
    // push must address refs/heads/ explicitly - this is what the branch
    // context menu's "Push to …" relies on.
    repo.git(&["branch", "feature"]).await;
    repo.git(&["tag", "feature"]).await;
    assert_eq!(repo.git(&["branch", "--show-current"]).await.trim(), "main");

    repo.backend
        .push(push_opts("feature", true, false), OperationId::new())
        .await
        .unwrap();

    // The BRANCH arrived on the remote (not the tag), and --set-upstream
    // configured tracking for the non-current branch.
    let remote_runner = GitRunner::for_repo("git", &remote_path);
    let refs = remote_runner
        .run(&["for-each-ref", "--format=%(refname)"])
        .await
        .expect("spawn git");
    assert!(refs.success, "{}", refs.stderr);
    let names: Vec<&str> = refs.stdout.lines().collect();
    assert!(names.contains(&"refs/heads/feature"), "{names:?}");
    assert!(!names.contains(&"refs/tags/feature"), "tag must not be pushed: {names:?}");

    let up = repo.git(&["rev-parse", "--abbrev-ref", "feature@{upstream}"]).await;
    assert_eq!(up.trim(), "origin/feature");
}

#[tokio::test]
async fn push_flips_the_tag_lists_target_on_remote_flag() {
    // The auto-push-tags feature diffs `TagInfo::target_on_remote` around a
    // push (snapshot before, recompute after; tags that flipped ride along).
    // That depends on `git push` updating the LOCAL remote-tracking ref,
    // which is what the tag list's `rev-list --tags --not --remotes` check
    // reads - pin that assumption against the real binary.
    let (_keep, _, url) = bare_remote().await;
    let repo = TestRepo::init().await;
    repo.write("a.txt", "base\n");
    repo.commit_all("base").await;
    repo.git(&["remote", "add", "origin", &url]).await;
    repo.git(&["tag", "v1"]).await;

    let tags = repo.backend.tags().await.unwrap();
    assert!(
        !tags.iter().find(|t| t.name == "v1").unwrap().target_on_remote,
        "before any push the tag target must be on no remote"
    );

    repo.backend
        .push(push_opts("main", true, false), OperationId::new())
        .await
        .unwrap();

    let tags = repo.backend.tags().await.unwrap();
    assert!(
        tags.iter().find(|t| t.name == "v1").unwrap().target_on_remote,
        "the push must flip target_on_remote without a fetch"
    );
}

// Pins the real `git branch -d` refusal (exit code + "not fully merged"
// stderr) that `classify_branch_delete_error` matches on.
#[tokio::test]
async fn branch_delete_unmerged_refusal_classifies() {
    let repo = TestRepo::init().await;
    repo.write("a.txt", "base\n");
    repo.commit_all("base").await;
    repo.git(&["switch", "-c", "feature"]).await;
    repo.write("f.txt", "work\n");
    repo.commit_all("feature work").await;
    repo.git(&["switch", "main"]).await;

    let err = repo
        .backend
        .delete_branch("feature", false)
        .await
        .expect_err("unmerged safe delete must be refused");
    match err {
        GitError::BranchNotFullyMerged { branch, stderr } => {
            assert_eq!(branch, "feature");
            assert!(
                stderr.to_lowercase().contains("not fully merged"),
                "unexpected stderr: {stderr}"
            );
        }
        other => panic!("expected BranchNotFullyMerged, got {other:?}"),
    }
}

// Validates the LFS missing-object assumptions against the real binaries
// (git + git-lfs, file:// standalone transfer): a default-config pull fails
// loudly with the stderr shapes `parse_lfs_download_failure` matches, and
// under `lfs.skipdownloaderrors` the same pull exits 0 leaving pointer stubs
// the `PullOutcome` must report. Skipped where git-lfs is not installed
// (e.g. plain WSL); CI runners ship it.
#[tokio::test]
async fn pull_with_missing_lfs_objects_classifies_and_reports_stubs() {
    let author = TestRepo::init().await;
    let probe = GitRunner::for_repo("git", &author.path)
        .run(&["lfs", "version"])
        .await
        .expect("spawn git");
    if !probe.success {
        eprintln!("git-lfs not available; skipping LFS flow test");
        return;
    }

    let (_keep, remote_path, url) = bare_remote().await;
    author.git(&["lfs", "install", "--local"]).await;
    author.write("base.txt", "base\n");
    author.commit_all("base").await;
    author.git(&["remote", "add", "origin", &url]).await;
    author.git(&["push", "-u", "origin", "main"]).await;
    author.git(&["lfs", "track", "*.bin"]).await;
    author.write("big.bin", "lfs payload\n");
    author.commit_all("lfs file").await;
    author.git(&["push", "origin", "main"]).await;
    author.git(&["switch", "-c", "feature"]).await;
    author.write("feat.bin", "other lfs payload\n");
    author.commit_all("feature lfs file").await;
    author.git(&["push", "origin", "feature"]).await;
    author.git(&["switch", "main"]).await;

    // The uploads never reached the server, as far as the reader knows.
    std::fs::remove_dir_all(remote_path.join("lfs")).expect("delete remote lfs objects");

    // Reader at the base commit; the pull brings the LFS commit in.
    let reader = TestRepo::init().await;
    reader.git(&["lfs", "install", "--local"]).await;
    reader.git(&["remote", "add", "origin", &url]).await;
    reader.git(&["fetch", "origin"]).await;
    reader.git(&["reset", "--hard", "origin/main~1"]).await;
    reader.git(&["branch", "--set-upstream-to=origin/main", "main"]).await;

    let err = reader
        .backend
        .pull(
            PullOptions { strategy: PullStrategy::Default },
            OperationId("lfs-pull".into()),
        )
        .await
        .expect_err("default-config pull must fail loudly");
    match err {
        GitError::LfsDownloadFailed { files, missing_on_remote, .. } => {
            assert_eq!(files, vec!["big.bin".to_string()]);
            assert!(missing_on_remote);
        }
        other => panic!("expected LfsDownloadFailed, got {other:?}"),
    }

    // The failed checkout leaves untracked leftovers; clear them, then the
    // tolerant config makes the same pull "succeed" with pointer stubs.
    reader.git(&["clean", "-fd"]).await;
    reader.git(&["config", "lfs.skipdownloaderrors", "true"]).await;
    let outcome = reader
        .backend
        .pull(
            PullOptions { strategy: PullStrategy::Default },
            OperationId("lfs-pull-2".into()),
        )
        .await
        .expect("skipdownloaderrors pull exits 0");
    let stubs = outcome.lfs_stubs.expect("stubs reported");
    assert_eq!(stubs.files, vec!["big.bin".to_string()]);
    assert!(stubs.missing_on_remote);
    assert!(
        reader.read("big.bin").starts_with("version https://git-lfs.github.com/spec/v1"),
        "the file on disk must be a pointer stub"
    );

    // A switch under the same tolerant config also exits 0 with stubs: the
    // SwitchResult must carry them.
    reader.git(&["branch", "feature", "origin/feature"]).await;
    let switch = reader
        .backend
        .switch_branch("feature", SwitchDirtyBehavior::TryDirectly)
        .await
        .expect("skipdownloaderrors switch exits 0");
    assert_eq!(switch.outcome, SwitchOutcome::Clean);
    let stubs = switch.lfs_stubs.expect("switch stubs reported");
    assert_eq!(stubs.files, vec!["feat.bin".to_string()]);
    assert!(stubs.missing_on_remote);
}

// A true (`--no-ff`) merge whose result the checked-out branch does not yet
// contain: `-d` is still refused, but the analysis names the merged-into ref.
#[tokio::test]
async fn branch_merge_analysis_reports_a_true_merge() {
    let repo = TestRepo::init().await;
    repo.write("a.txt", "base\n");
    repo.commit_all("base").await;
    let base = repo.head().await;
    repo.git(&["switch", "-c", "feature"]).await;
    repo.write("f.txt", "work\n");
    repo.commit_all("feature work").await;
    repo.git(&["switch", "main"]).await;
    repo.git(&["merge", "--no-ff", "--no-edit", "feature"]).await;
    repo.git(&["switch", "-c", "other", &base]).await;

    let err = repo.backend.delete_branch("feature", false).await.expect_err("refused");
    assert!(matches!(err, GitError::BranchNotFullyMerged { .. }), "{err:?}");

    let a = repo.backend.branch_merge_analysis("feature").await.unwrap();
    assert_eq!(a.merged_into, vec!["main".to_string()]);
    assert_eq!(a.equivalent_in, None, "no remote, so no baseline");
}

// The PR squash-merge shape: the branch's changes landed on the remote
// default branch under a different SHA, so no ref contains the tip - only
// the patch-id check can say the work is merged.
#[tokio::test]
async fn branch_merge_analysis_detects_a_squash_merge_on_the_remote() {
    let (_keep, _remote_path, url) = bare_remote().await;
    let repo = TestRepo::init().await;
    repo.write("a.txt", "base\n");
    repo.commit_all("base").await;
    repo.git(&["remote", "add", "origin", &url]).await;
    repo.git(&["push", "-u", "origin", "main"]).await;

    repo.git(&["switch", "-c", "feature"]).await;
    repo.write("f.txt", "work\n");
    repo.commit_all("feature work").await;
    repo.git(&["switch", "main"]).await;
    repo.git(&["merge", "--squash", "feature"]).await;
    repo.git(&["commit", "-m", "feature (#1)"]).await;
    repo.git(&["push", "origin", "main"]).await;

    let err = repo.backend.delete_branch("feature", false).await.expect_err("refused");
    assert!(matches!(err, GitError::BranchNotFullyMerged { .. }), "{err:?}");

    let a = repo.backend.branch_merge_analysis("feature").await.unwrap();
    assert!(a.merged_into.is_empty(), "{a:?}");
    assert_eq!(a.equivalent_in.as_deref(), Some("origin/main"));
}

// Genuinely unmerged work must trip neither signal - the UI's data-loss
// warning depends on both staying empty.
#[tokio::test]
async fn branch_merge_analysis_reports_nothing_for_unmerged_work() {
    let repo = TestRepo::init().await;
    repo.write("a.txt", "base\n");
    repo.commit_all("base").await;
    repo.git(&["switch", "-c", "feature"]).await;
    repo.write("f.txt", "work\n");
    repo.commit_all("feature work").await;
    repo.git(&["switch", "main"]).await;

    let a = repo.backend.branch_merge_analysis("feature").await.unwrap();
    assert!(a.merged_into.is_empty(), "{a:?}");
    assert_eq!(a.equivalent_in, None);
}

#[tokio::test]
async fn delete_remote_branch_removes_it_from_the_remote_only() {
    let (_keep, remote_path, url) = bare_remote().await;
    let repo = TestRepo::init().await;
    repo.write("a.txt", "base\n");
    repo.commit_all("base").await;
    repo.git(&["remote", "add", "origin", &url]).await;
    repo.backend.push(push_opts("main", true, false), OperationId::new()).await.unwrap();

    // Publish a second branch, plus a same-named tag on the remote: the
    // deletion must address refs/heads/ explicitly so it can never take the
    // tag instead of the branch.
    repo.git(&["branch", "feature"]).await;
    repo.backend.push(push_opts("feature", false, false), OperationId::new()).await.unwrap();
    repo.git(&["tag", "feature"]).await;
    repo.git(&["push", "origin", "refs/tags/feature"]).await;

    repo.backend
        .delete_remote_branch("origin", "feature", OperationId::new())
        .await
        .unwrap();

    // On the remote: branch gone, tag and main still present. The local
    // branch must be untouched.
    let remote_runner = GitRunner::for_repo("git", &remote_path);
    let refs = remote_runner
        .run(&["for-each-ref", "--format=%(refname)"])
        .await
        .expect("spawn git");
    assert!(refs.success, "{}", refs.stderr);
    let names: Vec<&str> = refs.stdout.lines().collect();
    assert!(!names.contains(&"refs/heads/feature"), "branch still on remote: {names:?}");
    assert!(names.contains(&"refs/heads/main"), "{names:?}");
    assert!(names.contains(&"refs/tags/feature"), "tag must survive: {names:?}");

    let local = repo.git(&["branch", "--list", "feature"]).await;
    assert!(local.contains("feature"), "local branch must survive");
}

#[tokio::test]
async fn non_fast_forward_push_is_classified_and_lease_force_recovers() {
    let (_keep, _, url) = bare_remote().await;

    // Writer A publishes the base.
    let a = TestRepo::init().await;
    a.write("a.txt", "base\n");
    a.commit_all("base").await;
    a.git(&["remote", "add", "origin", &url]).await;
    a.backend.push(push_opts("main", true, false), OperationId::new()).await.unwrap();

    // Writer B advances the remote past A.
    let b = TestRepo::init().await;
    b.git(&["remote", "add", "origin", &url]).await;
    b.git(&["fetch", "origin"]).await;
    b.git(&["reset", "--hard", "origin/main"]).await;
    b.write("a.txt", "from b\n");
    b.commit_all("b change").await;
    b.backend.push(push_opts("main", true, false), OperationId::new()).await.unwrap();

    // A commits divergently: a plain push must classify as PushRejected, not
    // a generic failure (panels rely on the variant for actionable text).
    a.write("a.txt", "from a\n");
    a.commit_all("a change").await;
    let err = a
        .backend
        .push(push_opts("main", false, false), OperationId::new())
        .await
        .unwrap_err();
    assert!(matches!(err, legit_core::GitError::PushRejected { .. }), "{err:?}");

    // After fetching (lease info up to date), force-with-lease succeeds.
    a.backend
        .fetch(
            FetchOptions { all: false, prune: false, remote: Some("origin".into()) },
            OperationId::new(),
        )
        .await
        .unwrap();
    a.backend
        .push(push_opts("main", false, true), OperationId::new())
        .await
        .unwrap();
    let t = a.backend.tracking_status().await.unwrap().unwrap();
    assert_eq!((t.ahead, t.behind), (0, 0));
}

#[tokio::test]
async fn fetch_prune_drops_stale_remote_tracking_refs() {
    let (_keep, bare_path, url) = bare_remote().await;

    // Seed the remote with main + feature.
    let seed = TestRepo::init().await;
    seed.write("a.txt", "base\n");
    seed.commit_all("base").await;
    seed.git(&["remote", "add", "origin", &url]).await;
    seed.git(&["push", "origin", "main", "main:refs/heads/feature"]).await;

    // Consumer sees both remote-tracking refs.
    let repo = TestRepo::init().await;
    repo.git(&["remote", "add", "origin", &url]).await;
    let fetch = |prune: bool| {
        let backend = &repo.backend;
        async move {
            backend
                .fetch(
                    FetchOptions { all: false, prune, remote: Some("origin".into()) },
                    OperationId::new(),
                )
                .await
                .unwrap();
        }
    };
    fetch(false).await;
    repo.git(&["rev-parse", "origin/feature"]).await;

    // The branch dies on the remote; a plain fetch keeps the stale ref, a
    // pruning fetch removes it.
    let bare_runner = GitRunner::for_repo("git", &bare_path);
    let out = bare_runner.run(&["branch", "-D", "feature"]).await.expect("spawn git");
    assert!(out.success, "{}", out.stderr);

    fetch(false).await;
    repo.git(&["rev-parse", "origin/feature"]).await; // still there without --prune

    fetch(true).await;
    let runner = GitRunner::for_repo("git", &repo.path);
    let gone = runner.run(&["rev-parse", "origin/feature"]).await.expect("spawn git");
    assert!(!gone.success, "origin/feature should be pruned");
}

#[tokio::test]
async fn fetch_all_updates_every_remote() {
    let (_k1, _, url1) = bare_remote().await;
    let (_k2, _, url2) = bare_remote().await;

    // Seed both remotes at c1; the consumer learns about them.
    let seed = TestRepo::init().await;
    seed.write("a.txt", "one\n");
    seed.commit_all("c1").await;
    seed.git(&["remote", "add", "r1", &url1]).await;
    seed.git(&["remote", "add", "r2", &url2]).await;
    seed.git(&["push", "r1", "main"]).await;
    seed.git(&["push", "r2", "main"]).await;

    let repo = TestRepo::init().await;
    repo.git(&["remote", "add", "r1", &url1]).await;
    repo.git(&["remote", "add", "r2", &url2]).await;

    // Both remotes advance to c2 while the consumer is stale.
    seed.write("a.txt", "two\n");
    seed.commit_all("c2").await;
    seed.git(&["push", "r1", "main"]).await;
    seed.git(&["push", "r2", "main"]).await;
    let c2 = seed.head().await;

    repo.backend
        .fetch(FetchOptions { all: true, prune: false, remote: None }, OperationId::new())
        .await
        .unwrap();
    assert_eq!(repo.git(&["rev-parse", "r1/main"]).await.trim(), c2);
    assert_eq!(repo.git(&["rev-parse", "r2/main"]).await.trim(), c2);
}

#[tokio::test]
async fn pull_fast_forwards_then_merges_divergence() {
    let (_keep, _, url) = bare_remote().await;

    // Publisher seeds the remote.
    let seed = TestRepo::init().await;
    seed.write("a.txt", "base\n");
    seed.commit_all("base").await;
    seed.git(&["remote", "add", "origin", &url]).await;
    seed.git(&["push", "-u", "origin", "main"]).await;

    // Consumer tracks origin/main.
    let repo = TestRepo::init().await;
    repo.git(&["remote", "add", "origin", &url]).await;
    repo.git(&["fetch", "origin"]).await;
    repo.git(&["reset", "--hard", "origin/main"]).await;
    repo.git(&["branch", "--set-upstream-to=origin/main", "main"]).await;

    // Remote advances; a default pull fast-forwards.
    seed.write("a.txt", "v2\n");
    seed.commit_all("v2").await;
    seed.git(&["push", "origin", "main"]).await;
    let v2 = seed.head().await;

    repo.backend
        .pull(PullOptions { strategy: PullStrategy::FfOnly }, OperationId::new())
        .await
        .unwrap();
    assert_eq!(repo.head().await, v2);
    assert_eq!(repo.read("a.txt"), "v2\n");

    // Divergence: local commit in b.txt, remote commit in c.txt. FfOnly must
    // fail; the Merge strategy integrates with a two-parent merge commit.
    repo.write("b.txt", "local\n");
    repo.commit_all("local change").await;
    seed.write("c.txt", "remote\n");
    seed.commit_all("remote change").await;
    seed.git(&["push", "origin", "main"]).await;

    let err = repo
        .backend
        .pull(PullOptions { strategy: PullStrategy::FfOnly }, OperationId::new())
        .await;
    assert!(err.is_err(), "ff-only pull on divergence must fail");

    repo.backend
        .pull(PullOptions { strategy: PullStrategy::Merge }, OperationId::new())
        .await
        .unwrap();
    let parents = repo.git(&["rev-list", "--parents", "-1", "HEAD"]).await;
    assert_eq!(
        parents.split_whitespace().count(),
        3,
        "expected a two-parent merge commit, got: {parents}"
    );
    assert!(repo.exists("b.txt") && repo.exists("c.txt"));
}

#[tokio::test]
async fn merge_commit_revert_and_cherry_pick_with_mainline() {
    // base -> feature adds f.txt -> merged into main (a real 2-parent merge).
    let repo = TestRepo::init().await;
    repo.write("a.txt", "base\n");
    repo.commit_all("base").await;
    let base = repo.head().await;
    repo.git(&["switch", "-c", "feature"]).await;
    repo.write("f.txt", "feature\n");
    repo.commit_all("feature work").await;
    repo.git(&["switch", "main"]).await;
    repo.write("a.txt", "main v2\n");
    repo.commit_all("main work").await;
    repo.git(&["merge", "--no-ff", "--no-edit", "feature"]).await;
    let merge_sha = repo.head().await;

    // Without a mainline, git refuses a merge - stays an error, surfaced as-is.
    let err = repo.backend.revert(&[merge_sha.clone()], None).await;
    assert!(
        matches!(err, Err(GitError::CommandFailed { .. })),
        "merge revert without -m must stay an error: {err:?}"
    );

    // Revert relative to parent 1 (main): the merged-in file goes away, the
    // merge itself stays recorded in history.
    let outcome = repo.backend.revert(&[merge_sha.clone()], Some(1)).await.unwrap();
    assert_eq!(outcome, SequenceOutcome::Completed);
    assert!(!repo.exists("f.txt"), "revert -m 1 must remove the merged-in change");
    assert_eq!(repo.read("a.txt"), "main v2\n", "mainline changes must survive");

    // Cherry-pick the merge onto an unrelated branch with -m 1: the merged-in
    // changes land as ONE commit.
    repo.git(&["switch", "-c", "port", &base]).await;
    let outcome = repo.backend.cherry_pick(&[merge_sha.clone()], Some(1)).await.unwrap();
    assert_eq!(outcome, SequenceOutcome::Completed);
    assert!(repo.exists("f.txt"), "cherry-pick -m 1 must bring the merged-in change");
    let parents = repo.git(&["rev-list", "--parents", "-1", "HEAD"]).await;
    assert_eq!(
        parents.split_whitespace().count(),
        2,
        "the pick lands as a single-parent commit: {parents}"
    );
}

#[tokio::test]
async fn gitmodules_consistency_reflects_staged_state_only() {
    let (sup, _lib) = repo_with_submodule().await;

    // Clean tree: the gate diff is empty, no findings, nothing else runs.
    assert_eq!(sup.backend.gitmodules_consistency().await.unwrap(), vec![]);

    // A staged pointer bump makes the gate fire (gitlink mode in the staged
    // diff) but the state is consistent - still no findings.
    sup.write("lib/lib.txt", "v2\n");
    sup.git(&["-C", "lib", "add", "."]).await;
    sup.git(&["-C", "lib", "commit", "-m", "lib v2"]).await;
    sup.git(&["add", "lib"]).await;
    assert_eq!(sup.backend.gitmodules_consistency().await.unwrap(), vec![]);
    sup.git(&["commit", "-m", "bump"]).await;

    // The Aug-4 breakage shape: section removed, gitlink kept.
    sup.git(&["config", "-f", ".gitmodules", "--remove-section", "submodule.lib"]).await;
    sup.git(&["add", ".gitmodules"]).await;
    assert_eq!(
        sup.backend.gitmodules_consistency().await.unwrap(),
        vec![GitmodulesFinding::GitlinkWithoutEntry { path: "lib".into() }]
    );

    // STAGED semantics: restoring the WORKTREE file without restaging must
    // not change the verdict - the commit would still record the broken blob.
    sup.git(&["restore", "--worktree", "--source=HEAD", "--", ".gitmodules"]).await;
    assert_eq!(
        sup.backend.gitmodules_consistency().await.unwrap(),
        vec![GitmodulesFinding::GitlinkWithoutEntry { path: "lib".into() }]
    );

    // Staging the restored file heals it.
    sup.git(&["add", ".gitmodules"]).await;
    assert_eq!(sup.backend.gitmodules_consistency().await.unwrap(), vec![]);

    // Dangling entry: a section whose path has no gitlink.
    sup.git(&["config", "-f", ".gitmodules", "submodule.ghost.path", "ghost"]).await;
    sup.git(&["add", ".gitmodules"]).await;
    assert_eq!(
        sup.backend.gitmodules_consistency().await.unwrap(),
        vec![GitmodulesFinding::EntryWithoutGitlink {
            name: "ghost".into(),
            path: "ghost".into(),
        }]
    );
}

#[tokio::test]
async fn gitmodules_consistency_handles_unborn_head() {
    // Before the first commit `diff --cached` has no HEAD to compare with -
    // the check must not error (gate failure falls through to the full
    // check, which finds a consistent empty state).
    let repo = TestRepo::init().await;
    repo.write("a.txt", "x\n");
    repo.git(&["add", "a.txt"]).await;
    assert_eq!(repo.backend.gitmodules_consistency().await.unwrap(), vec![]);
}

#[tokio::test]
async fn checkout_remote_branch_tracks_then_fast_forwards_stale_local() {
    let (_keep, _, url) = bare_remote().await;

    // Publisher seeds main + a topic branch on the remote.
    let seed = TestRepo::init().await;
    seed.write("a.txt", "base\n");
    seed.commit_all("base").await;
    seed.git(&["remote", "add", "origin", &url]).await;
    seed.git(&["push", "-u", "origin", "main"]).await;
    seed.git(&["switch", "-c", "topic"]).await;
    seed.write("t.txt", "t1\n");
    seed.commit_all("t1").await;
    seed.git(&["push", "-u", "origin", "topic"]).await;
    let t1 = seed.head().await;

    // Consumer knows the remote but has no local topic yet.
    let repo = TestRepo::init().await;
    repo.git(&["remote", "add", "origin", &url]).await;
    repo.git(&["fetch", "origin"]).await;
    repo.git(&["reset", "--hard", "origin/main"]).await;

    // No local counterpart: creates a tracking branch at the remote tip.
    let outcome = repo
        .backend
        .checkout_remote_branch("origin/topic", SwitchDirtyBehavior::TryDirectly, true)
        .await
        .unwrap();
    assert_eq!(outcome.switch, SwitchOutcome::Clean);
    assert_eq!(outcome.fast_forward, FastForwardResult::UpToDate);
    assert_eq!(outcome.local_branch, "topic");
    assert_eq!(repo.head().await, t1);
    let upstream = repo.git(&["rev-parse", "--abbrev-ref", "topic@{upstream}"]).await;
    assert_eq!(upstream.trim(), "origin/topic");

    // Remote advances; the consumer's local topic goes stale.
    seed.write("t.txt", "t2\n");
    seed.commit_all("t2").await;
    seed.git(&["push", "origin", "topic"]).await;
    let t2 = seed.head().await;
    repo.git(&["switch", "main"]).await;
    repo.git(&["fetch", "origin"]).await;

    // fast_forward = false: plain checkout, the stale tip stays stale.
    let outcome = repo
        .backend
        .checkout_remote_branch("origin/topic", SwitchDirtyBehavior::TryDirectly, false)
        .await
        .unwrap();
    assert_eq!(outcome.fast_forward, FastForwardResult::NotAttempted);
    assert_eq!(repo.head().await, t1);

    // fast_forward = true: the branch moves to the remote tip. Validates the
    // real ff-only stdout against `classify_fast_forward`.
    repo.git(&["switch", "main"]).await;
    let outcome = repo
        .backend
        .checkout_remote_branch("origin/topic", SwitchDirtyBehavior::TryDirectly, true)
        .await
        .unwrap();
    assert_eq!(outcome.switch, SwitchOutcome::Clean);
    assert_eq!(outcome.fast_forward, FastForwardResult::FastForwarded);
    assert_eq!(repo.head().await, t2);
    assert_eq!(repo.read("t.txt"), "t2\n");

    // Re-running when already at the tip reports UpToDate.
    repo.git(&["switch", "main"]).await;
    let outcome = repo
        .backend
        .checkout_remote_branch("origin/topic", SwitchDirtyBehavior::TryDirectly, true)
        .await
        .unwrap();
    assert_eq!(outcome.fast_forward, FastForwardResult::UpToDate);
}

#[tokio::test]
async fn checkout_remote_branch_divergence_is_outcome_and_leaves_branch_untouched() {
    let (_keep, _, url) = bare_remote().await;

    let seed = TestRepo::init().await;
    seed.write("a.txt", "base\n");
    seed.commit_all("base").await;
    seed.git(&["remote", "add", "origin", &url]).await;
    seed.git(&["push", "-u", "origin", "main"]).await;
    seed.git(&["switch", "-c", "topic"]).await;
    seed.write("t.txt", "t1\n");
    seed.commit_all("t1").await;
    seed.git(&["push", "-u", "origin", "topic"]).await;

    // Consumer holds topic at t1 plus a local-only commit; the remote gains
    // a different commit: diverged.
    let repo = TestRepo::init().await;
    repo.git(&["remote", "add", "origin", &url]).await;
    repo.git(&["fetch", "origin"]).await;
    repo.git(&["reset", "--hard", "origin/main"]).await;
    repo.git(&["switch", "--track", "origin/topic"]).await;
    repo.write("local.txt", "mine\n");
    repo.commit_all("local-only").await;
    let local_tip = repo.head().await;
    seed.write("t.txt", "t2\n");
    seed.commit_all("t2").await;
    seed.git(&["push", "origin", "topic"]).await;
    repo.git(&["switch", "main"]).await;
    repo.git(&["fetch", "origin"]).await;

    // Validates the real "Not possible to fast-forward" refusal is classified
    // as the Diverged OUTCOME (never an error) and mutates nothing.
    let outcome = repo
        .backend
        .checkout_remote_branch("origin/topic", SwitchDirtyBehavior::TryDirectly, true)
        .await
        .unwrap();
    assert_eq!(outcome.switch, SwitchOutcome::Clean);
    assert_eq!(outcome.fast_forward, FastForwardResult::Diverged);
    assert_eq!(repo.head().await, local_tip, "diverged branch must be left untouched");
    let on = repo.git(&["rev-parse", "--abbrev-ref", "HEAD"]).await;
    assert_eq!(on.trim(), "topic", "the checkout itself must still land on the branch");
}

#[tokio::test]
async fn stash_paths_takes_only_the_given_files() {
    // Encodes the pathspec-stash assumptions: `stash push -- <paths>` takes
    // the named files (untracked included via --include-untracked) and
    // leaves other changes in place; a pathspec matching only clean files
    // exits 0 without stashing (tip-compare decides the outcome).
    let repo = TestRepo::init().await;
    repo.write("a.txt", "base a\n");
    repo.write("b.txt", "base b\n");
    repo.commit_all("base").await;
    repo.write("a.txt", "changed a\n");
    repo.write("b.txt", "changed b\n");
    repo.write("new.txt", "untracked\n");

    let outcome = repo
        .backend
        .create_stash_paths(
            Some("partial"),
            &[PathBuf::from("a.txt"), PathBuf::from("new.txt")],
        )
        .await
        .unwrap();
    assert_eq!(outcome, StashOutcome::Created);
    assert_eq!(repo.read("a.txt"), "base a\n");
    assert!(!repo.exists("new.txt"));
    assert_eq!(repo.read("b.txt"), "changed b\n");

    // The just-stashed path is clean now - nothing further to stash there.
    let outcome = repo
        .backend
        .create_stash_paths(None, &[PathBuf::from("a.txt")])
        .await
        .unwrap();
    assert_eq!(outcome, StashOutcome::NothingToStash);

    // Popping the entry brings exactly the stashed files back.
    let stashes = repo.backend.stashes().await.unwrap();
    assert_eq!(stashes.len(), 1);
    repo.backend.pop_stash(&stashes[0].stash_sha.0).await.unwrap();
    assert_eq!(repo.read("a.txt"), "changed a\n");
    assert!(repo.exists("new.txt"));
    assert_eq!(repo.read("b.txt"), "changed b\n");
}

#[tokio::test]
async fn stash_pop_with_conflicting_tree_reports_conflicts_outcome() {
    // Validates the phrases `stash_apply_left_conflicts` keys on against the
    // real binary: a pop onto a conflicting tree must classify as the
    // Conflicts OUTCOME (stash applied with markers, git keeps the entry),
    // never a plain error.
    let repo = TestRepo::init().await;
    repo.write("a.txt", "base\n");
    repo.commit_all("base").await;

    repo.write("a.txt", "stashed change\n");
    let outcome = repo.backend.create_stash(Some("mine"), true, false).await.unwrap();
    assert_eq!(outcome, StashOutcome::Created);

    // Commit a different change to the same lines so the pop conflicts.
    repo.write("a.txt", "committed change\n");
    repo.commit_all("collider").await;

    let stashes = repo.backend.stashes().await.unwrap();
    assert_eq!(stashes.len(), 1);
    let result = repo
        .backend
        .pop_stash(&stashes[0].stash_sha.0)
        .await
        .unwrap();
    assert!(
        matches!(result, StashApplyOutcome::Conflicts { .. }),
        "expected Conflicts outcome, got {result:?}"
    );
    // The stash entry survives a conflicted pop (guidance: resolve, then drop).
    assert_eq!(repo.backend.stashes().await.unwrap().len(), 1);
    // And the working tree holds the conflict markers.
    assert!(repo.read("a.txt").contains("<<<<<<<"));
}

#[tokio::test]
async fn stash_paths_leaves_other_staged_changes_out_of_the_stash() {
    // The reason create_stash_paths isolates the index: a plain pathspec
    // `stash push` embeds the ENTIRE index in the stash entry, so another
    // file's staged change rides along - and popping the stash after that
    // change was discarded resurrects it. The isolation dance must prevent
    // exactly that.
    let repo = TestRepo::init().await;
    repo.write("a.txt", "base a\n");
    repo.write("c.txt", "base c\n");
    repo.commit_all("base").await;

    // a.txt: staged foreign change. c.txt: staged + unstaged halves.
    repo.write("a.txt", "base a\nstaged a\n");
    repo.backend.stage(&[PathBuf::from("a.txt")]).await.unwrap();
    repo.write("c.txt", "base c\nstaged c\n");
    repo.backend.stage(&[PathBuf::from("c.txt")]).await.unwrap();
    repo.write("c.txt", "base c\nstaged c\nunstaged c\n");

    let outcome = repo
        .backend
        .create_stash_paths(None, &[PathBuf::from("c.txt")])
        .await
        .unwrap();
    assert_eq!(outcome, StashOutcome::Created);

    // a.txt is untouched and STILL STAGED; c.txt fully gone from the tree.
    let porcelain = repo.git(&["status", "--porcelain"]).await;
    assert_eq!(porcelain.trim(), "M  a.txt", "{porcelain}");

    // Discard a.txt's staged change, then pop: it must NOT come back.
    repo.git(&["restore", "--staged", "a.txt"]).await;
    repo.git(&["restore", "a.txt"]).await;
    let stashes = repo.backend.stashes().await.unwrap();
    repo.backend.pop_stash(&stashes[0].stash_sha.0).await.unwrap();
    assert_eq!(repo.read("a.txt"), "base a\n");
    assert_eq!(repo.read("c.txt"), "base c\nstaged c\nunstaged c\n");
}

#[tokio::test]
async fn stashed_untracked_file_can_be_applied_per_file() {
    // A file stashed from UNTRACKED state is stored in the stash's third
    // parent, not the stash commit's tree - restore_file_at_revision must
    // fall back there (a plain checkout at the stash SHA fails on it).
    let repo = TestRepo::init().await;
    repo.write("a.txt", "base\n");
    repo.commit_all("base").await;
    repo.write("new.txt", "untracked content\n");

    let outcome = repo
        .backend
        .create_stash_paths(None, &[PathBuf::from("new.txt")])
        .await
        .unwrap();
    assert_eq!(outcome, StashOutcome::Created);
    assert!(!repo.exists("new.txt"));

    let stashes = repo.backend.stashes().await.unwrap();
    repo.backend
        .apply_stash_file(&stashes[0].stash_sha.0, Path::new("new.txt"))
        .await
        .unwrap();
    assert_eq!(repo.read("new.txt"), "untracked content\n");
    // Unstaged apply: the file comes back exactly as it left - untracked.
    let porcelain = repo.git(&["status", "--porcelain"]).await;
    assert_eq!(porcelain.trim(), "?? new.txt", "{porcelain}");

    // A tracked file applies unstaged too (whole-stash apply semantics).
    repo.write("a.txt", "base\nmodified\n");
    repo.backend
        .create_stash_paths(None, &[PathBuf::from("a.txt")])
        .await
        .unwrap();
    let stashes = repo.backend.stashes().await.unwrap();
    repo.backend
        .apply_stash_file(&stashes[0].stash_sha.0, Path::new("a.txt"))
        .await
        .unwrap();
    let porcelain = repo.git(&["status", "--porcelain"]).await;
    assert!(porcelain.contains(" M a.txt"), "{porcelain}");
    assert_eq!(repo.read("a.txt"), "base\nmodified\n");
}

// ---------------------------------------------------------------------------
// branch / tag / remote management against the real binary — validates the
// exit-code and behavior assumptions the flow tests encode
// ---------------------------------------------------------------------------

#[tokio::test]
async fn branch_create_rename_delete_roundtrip() {
    let repo = TestRepo::init().await;
    repo.write("a.txt", "x\n");
    repo.commit_all("base").await;

    repo.backend.create_branch("feat", None).await.unwrap();
    let names = |bs: &[legit_core::Branch]| -> Vec<String> {
        bs.iter().filter(|b| !b.is_remote).map(|b| b.name.clone()).collect()
    };
    assert!(names(&repo.backend.branches().await.unwrap()).contains(&"feat".to_string()));

    repo.backend.rename_branch("feat", "feature/x").await.unwrap();
    let branches = repo.backend.branches().await.unwrap();
    let local = names(&branches);
    assert!(local.contains(&"feature/x".to_string()), "{local:?}");
    assert!(!local.contains(&"feat".to_string()));

    // Safe delete works on a merged (same-tip) branch.
    repo.backend.delete_branch("feature/x", false).await.unwrap();
    assert!(!names(&repo.backend.branches().await.unwrap()).contains(&"feature/x".to_string()));
}

#[tokio::test]
async fn delete_branch_safe_refuses_unmerged_force_deletes() {
    // Encodes the -d vs -D contract: git refuses an unmerged branch with -d
    // (that refusal is the data-loss guard) and obeys -D.
    let repo = TestRepo::init().await;
    repo.write("a.txt", "base\n");
    repo.commit_all("base").await;

    repo.backend.create_branch("wip", None).await.unwrap();
    repo.backend
        .switch_branch("wip", SwitchDirtyBehavior::TryDirectly)
        .await
        .unwrap();
    repo.write("a.txt", "wip work\n");
    repo.commit_all("wip commit").await;
    repo.backend
        .switch_branch("main", SwitchDirtyBehavior::TryDirectly)
        .await
        .unwrap();

    let err = repo.backend.delete_branch("wip", false).await.unwrap_err();
    assert!(
        matches!(&err, GitError::BranchNotFullyMerged { branch, .. } if branch == "wip"),
        "safe delete must refuse an unmerged branch, got {err:?}"
    );
    // The branch survived the refused delete.
    assert!(repo
        .backend
        .branches()
        .await
        .unwrap()
        .iter()
        .any(|b| !b.is_remote && b.name == "wip"));

    repo.backend.delete_branch("wip", true).await.unwrap();
    assert!(!repo
        .backend
        .branches()
        .await
        .unwrap()
        .iter()
        .any(|b| !b.is_remote && b.name == "wip"));
}

#[tokio::test]
async fn checkout_commit_detaches_head() {
    let repo = TestRepo::init().await;
    repo.write("a.txt", "one\n");
    repo.commit_all("first").await;
    let first = repo.git(&["rev-parse", "HEAD"]).await.trim().to_string();
    repo.write("a.txt", "two\n");
    repo.commit_all("second").await;

    let outcome = repo
        .backend
        .checkout_commit(&first, SwitchDirtyBehavior::TryDirectly)
        .await
        .unwrap();
    assert_eq!(outcome.outcome, SwitchOutcome::Clean);
    // HEAD is detached at the first commit.
    let head = repo.git(&["rev-parse", "HEAD"]).await.trim().to_string();
    assert_eq!(head, first);
    let sym = repo.git(&["rev-parse", "--abbrev-ref", "HEAD"]).await.trim().to_string();
    assert_eq!(sym, "HEAD", "expected detached HEAD");
    assert_eq!(repo.read("a.txt"), "one\n");
}

#[tokio::test]
async fn tag_create_delete_roundtrip_lightweight_and_annotated() {
    let repo = TestRepo::init().await;
    repo.write("a.txt", "x\n");
    repo.commit_all("base").await;

    repo.backend.create_tag("v1", None, None).await.unwrap();
    repo.backend.create_tag("v2", None, Some("second release")).await.unwrap();
    let tags = repo.backend.tags().await.unwrap();
    let v1 = tags.iter().find(|t| t.name == "v1").expect("v1 exists");
    let v2 = tags.iter().find(|t| t.name == "v2").expect("v2 exists");
    assert!(!v1.annotated, "plain tag must be lightweight");
    assert!(v2.annotated, "message tag must be annotated");

    repo.backend.delete_tag("v1").await.unwrap();
    let names: Vec<String> =
        repo.backend.tags().await.unwrap().iter().map(|t| t.name.clone()).collect();
    assert!(!names.contains(&"v1".to_string()));
    assert!(names.contains(&"v2".to_string()));
}

#[tokio::test]
async fn tag_push_and_remote_delete_roundtrip() {
    let repo = TestRepo::init().await;
    repo.write("a.txt", "x\n");
    repo.commit_all("base").await;
    let (_dir, remote_path, url) = bare_remote().await;
    repo.backend.add_remote("origin", &url).await.unwrap();
    // The tag's target must exist on the remote first.
    repo.git(&["push", "origin", "HEAD:refs/heads/main"]).await;

    repo.backend.create_tag("v1", None, None).await.unwrap();
    repo.backend
        .push_tag("origin", "v1", OperationId("push-tag".into()))
        .await
        .unwrap();
    let remote_runner = GitRunner::for_repo("git", &remote_path);
    let listed = remote_runner.run(&["tag", "--list"]).await.unwrap().stdout;
    assert!(listed.lines().any(|l| l.trim() == "v1"), "{listed}");

    repo.backend
        .delete_remote_tag("origin", "v1", OperationId("del-tag".into()))
        .await
        .unwrap();
    let listed = remote_runner.run(&["tag", "--list"]).await.unwrap().stdout;
    assert!(!listed.lines().any(|l| l.trim() == "v1"), "{listed}");
    // Local tag untouched: remote deletion is a separate, deliberate action.
    assert!(repo.backend.tags().await.unwrap().iter().any(|t| t.name == "v1"));
}

#[tokio::test]
async fn remote_management_roundtrip() {
    let repo = TestRepo::init().await;
    repo.write("a.txt", "x\n");
    repo.commit_all("base").await;

    repo.backend.add_remote("upstream", "https://x.invalid/r.git").await.unwrap();
    repo.backend.rename_remote("upstream", "mirror").await.unwrap();
    repo.backend
        .set_remote_url("mirror", "https://y.invalid/r.git", false)
        .await
        .unwrap();
    repo.backend
        .set_remote_url("mirror", "ssh://y.invalid/push.git", true)
        .await
        .unwrap();

    let remotes = repo.backend.list_remotes().await.unwrap();
    assert_eq!(remotes.len(), 1);
    assert_eq!(remotes[0].name, "mirror");
    assert_eq!(remotes[0].fetch_url, "https://y.invalid/r.git");
    assert_eq!(remotes[0].push_url, "ssh://y.invalid/push.git");

    repo.backend.remove_remote("mirror").await.unwrap();
    assert!(repo.backend.list_remotes().await.unwrap().is_empty());
}

/// Global-scope `git config` semantics the global writers depend on
/// (`src-tauri/commands/config_util.rs` `write_config_global`, used by the
/// identity / signing / line-endings sections): the write path tolerates
/// exit 5 from `--unset-all` and `--unset`, and a single plain value reads
/// back via `--get-all`. `GIT_CONFIG_GLOBAL` redirects the global file into
/// the tempdir - passed through `run_with_env`, which wins over the runner's
/// scrubbed base env - so the developer's real `~/.gitconfig` is never touched.
#[tokio::test]
async fn global_config_unset_all_and_helper_round_trip() {
    let repo = TestRepo::init().await;
    let gcfg = repo.path.join("fake-global-config");
    let gcfg_s = gcfg.to_str().expect("utf8 tempdir path").to_string();
    let env: &[(&str, &str)] = &[("GIT_CONFIG_GLOBAL", &gcfg_s)];
    let runner = GitRunner::for_repo("git", &repo.path);

    // `--unset-all` exits 5 when the global config file doesn't exist yet...
    let out = runner
        .run_with_env(&["config", "--global", "--unset-all", "credential.helper"], env)
        .await
        .expect("spawn git");
    assert!(!out.success);
    assert_eq!(out.exit_code, Some(5), "missing global file: {}", out.stderr);

    // ...and equally when the file exists but the key is absent.
    let out = runner
        .run_with_env(&["config", "--global", "user.name", "Global Name"], env)
        .await
        .expect("spawn git");
    assert!(out.success, "{}", out.stderr);
    let out = runner
        .run_with_env(&["config", "--global", "--unset-all", "credential.helper"], env)
        .await
        .expect("spawn git");
    assert_eq!(out.exit_code, Some(5), "absent key: {}", out.stderr);

    // A single plain global helper round-trips through `--get-all`.
    let out = runner
        .run_with_env(&["config", "--global", "--add", "credential.helper", "manager"], env)
        .await
        .expect("spawn git");
    assert!(out.success, "{}", out.stderr);
    let out = runner
        .run_with_env(&["config", "--global", "--get-all", "credential.helper"], env)
        .await
        .expect("spawn git");
    assert!(out.success, "{}", out.stderr);
    assert_eq!(out.stdout.trim(), "manager");

    // The writes landed in the redirected file, not the real global config.
    assert!(repo.exists("fake-global-config"));

    // Unsetting the only entry then reading exits 1 (key gone): the read path
    // maps that to "no helper set".
    let out = runner
        .run_with_env(&["config", "--global", "--unset-all", "credential.helper"], env)
        .await
        .expect("spawn git");
    assert!(out.success, "{}", out.stderr);
    let out = runner
        .run_with_env(&["config", "--global", "--get-all", "credential.helper"], env)
        .await
        .expect("spawn git");
    assert!(!out.success);
    assert_eq!(out.exit_code, Some(1), "unset key reads back empty: {}", out.stderr);
}

/// Why the global-settings views read `--global`/`--system` only
/// (`config_util::read_config_global_scopes`): an unbound runner inherits the
/// app process's cwd, which can lie inside SOME repo (tauri dev runs inside
/// the LeGit source repo). Run inside a repo, an unflagged `git config --get`
/// resolves the repo's LOCAL value; only a `--global`-flagged read is immune.
#[tokio::test]
async fn config_global_flag_ignores_repo_local_values() {
    let repo = TestRepo::init().await; // pins local user.name = "LeGit Test"
    let gcfg = repo.path.join("fake-global-config");
    let gcfg_s = gcfg.to_str().expect("utf8 tempdir path").to_string();
    let env: &[(&str, &str)] = &[("GIT_CONFIG_GLOBAL", &gcfg_s)];
    let runner = GitRunner::for_repo("git", &repo.path);

    let out = runner
        .run_with_env(&["config", "--global", "user.name", "Global Name"], env)
        .await
        .expect("spawn git");
    assert!(out.success, "{}", out.stderr);

    // Unflagged read inside the repo: LOCAL wins. This is the leak a global
    // view would exhibit if it consulted local scope.
    let out = runner
        .run_with_env(&["config", "--get", "user.name"], env)
        .await
        .expect("spawn git");
    assert!(out.success, "{}", out.stderr);
    assert_eq!(out.stdout.trim(), "LeGit Test");

    // `--global`-flagged read inside the same repo: immune to local scope.
    let out = runner
        .run_with_env(&["config", "--global", "--get", "user.name"], env)
        .await
        .expect("spawn git");
    assert!(out.success, "{}", out.stderr);
    assert_eq!(out.stdout.trim(), "Global Name");
}

// ---------------------------------------------------------------------------
// Line-ending check-in assumptions (repo_line_ending_status)
// ---------------------------------------------------------------------------

/// `cat-file --batch` resolves `:path` (index) and `HEAD:path` specs and
/// reports unresolvable ones - the framing our batch parser encodes.
#[tokio::test]
async fn cat_file_batch_resolves_index_and_head_specs() {
    use legit_core::parse_cat_file_batch;

    let repo = TestRepo::init().await;
    repo.write("a.txt", "one\ntwo\n");
    repo.git(&["add", "a.txt"]).await;
    repo.git(&["commit", "-m", "init"]).await;
    repo.write("a.txt", "one\r\ntwo\r\n");
    repo.git(&["add", "a.txt"]).await;

    let runner = GitRunner::for_repo("git", &repo.path);
    let out = runner
        .run_with_stdin_bytes(&["cat-file", "--batch"], ":a.txt\nHEAD:a.txt\n:gone.txt\n")
        .await
        .expect("spawn");
    let parsed = parse_cat_file_batch(&out.stdout).expect("framing");
    assert_eq!(parsed.len(), 3);
    assert_eq!(parsed[0].as_deref(), Some(b"one\r\ntwo\r\n".as_slice()));
    assert_eq!(parsed[1].as_deref(), Some(b"one\ntwo\n".as_slice()));
    assert_eq!(parsed[2], None);
}

/// `check-attr -z --stdin text eol` emits path NUL attr NUL value NUL
/// triples with the values our parser encodes.
#[tokio::test]
async fn check_attr_z_output_shape() {
    use legit_core::{parse_check_attr_z, EolTextAttr};

    let repo = TestRepo::init().await;
    repo.write(
        ".gitattributes",
        "set.txt text\nbin.dat -text\nauto.txt text=auto\nforced.txt eol=lf\n",
    );
    let runner = GitRunner::for_repo("git", &repo.path);
    let out = runner
        .run_with_stdin(
            &["check-attr", "-z", "--stdin", "text", "eol"],
            "set.txt\0bin.dat\0auto.txt\0forced.txt\0plain.txt\0",
        )
        .await
        .expect("spawn");
    assert!(out.success, "{}", out.stderr);
    let map = parse_check_attr_z(&out.stdout);
    assert_eq!(map["set.txt"], (EolTextAttr::Set, false));
    assert_eq!(map["bin.dat"], (EolTextAttr::Unset, false));
    assert_eq!(map["auto.txt"], (EolTextAttr::Auto, false));
    assert_eq!(map["forced.txt"], (EolTextAttr::Unspecified, true));
    assert_eq!(map["plain.txt"], (EolTextAttr::Unspecified, false));
}

/// The check-in normalization rules encoded in `checkin_normalizes` match
/// what `git add` actually stages, per scenario. For each: configure, write,
/// add, then compare the staged blob's classification with our prediction.
#[tokio::test]
async fn checkin_kind_matches_real_git() {
    use legit_core::{
        checkin_normalizes, classify_line_endings, classify_line_endings_normalized,
        parse_autocrlf, EolTextAttr, LineEndingKind,
    };

    // (autocrlf, content, expected staged kind for a FIRST add - no index blob)
    let cases: &[(&str, &str, LineEndingKind)] = &[
        ("false", "a\r\nb\r\n", LineEndingKind::Crlf), // no policy: raw CRLF staged
        ("true", "a\r\nb\r\n", LineEndingKind::Lf),    // autocrlf=true normalizes
        ("input", "a\r\nb\r\n", LineEndingKind::Lf),   // input too
        ("true", "a\rb\r", LineEndingKind::Cr),        // lone CR never converted
        ("true", "a\nb\n", LineEndingKind::Lf),        // LF stays LF
    ];
    for (i, (autocrlf, content, expected)) in cases.iter().enumerate() {
        let repo = TestRepo::init().await;
        repo.git(&["config", "core.autocrlf", autocrlf]).await;
        let name = format!("f{i}.txt");
        repo.write(&name, content);
        repo.git(&["add", &name]).await;
        let staged = repo.git(&["show", &format!(":{name}")]).await;
        assert_eq!(
            classify_line_endings(&staged),
            *expected,
            "case {i}: autocrlf={autocrlf} content={content:?}"
        );
        // And our prediction agrees.
        let raw = classify_line_endings(content);
        let normalizes = checkin_normalizes(
            EolTextAttr::Unspecified,
            false,
            parse_autocrlf(autocrlf),
            raw,
            None,
        );
        let predicted = if normalizes {
            classify_line_endings_normalized(content)
        } else {
            raw
        };
        assert_eq!(predicted, *expected, "prediction diverges in case {i}");
    }
}

/// The auto-mode exemption: a file already committed with CRLF is NOT
/// renormalized by autocrlf=true on a later add - while an explicit `text`
/// attribute DOES renormalize it. Both encoded in `checkin_normalizes`.
#[tokio::test]
async fn committed_crlf_not_renormalized_under_auto() {
    use legit_core::{
        checkin_normalizes, classify_line_endings, AutocrlfSetting, EolTextAttr, LineEndingKind,
    };

    let repo = TestRepo::init().await;
    repo.write("f.txt", "a\r\nb\r\n");
    repo.git(&["add", "f.txt"]).await;
    repo.git(&["commit", "-m", "crlf blob"]).await;

    // Auto mode: modify, re-add - the staged blob keeps CRLF.
    repo.git(&["config", "core.autocrlf", "true"]).await;
    repo.write("f.txt", "a\r\nb\r\nc\r\n");
    repo.git(&["add", "f.txt"]).await;
    let staged = repo.git(&["show", ":f.txt"]).await;
    assert_eq!(classify_line_endings(&staged), LineEndingKind::Crlf);
    assert!(!checkin_normalizes(
        EolTextAttr::Unspecified,
        false,
        AutocrlfSetting::True,
        LineEndingKind::Crlf,
        Some(LineEndingKind::Crlf),
    ));

    // Explicit text attr: the same add DOES normalize.
    repo.write(".gitattributes", "f.txt text\n");
    repo.write("f.txt", "a\r\nb\r\nc\r\nd\r\n");
    repo.git(&["add", "f.txt"]).await;
    let staged = repo.git(&["show", ":f.txt"]).await;
    assert_eq!(classify_line_endings(&staged), LineEndingKind::Lf);
    assert!(checkin_normalizes(
        EolTextAttr::Set,
        false,
        AutocrlfSetting::True,
        LineEndingKind::Crlf,
        Some(LineEndingKind::Crlf),
    ));
}

/// End-to-end: a real repo where one file flips endings unstaged, one is
/// staged with a flip, exercising the same call sequence the
/// `repo_line_ending_status` command runs (cat-file batch + derivation).
#[tokio::test]
async fn line_ending_status_pipeline_against_real_repo() {
    use legit_core::types::LineEndingTransition;
    use legit_core::{
        derive_line_ending_entry, parse_cat_file_batch, AutocrlfSetting, EolTextAttr,
        LineEndingKind,
    };

    let repo = TestRepo::init().await;
    repo.write("flip.txt", "a\nb\n");
    repo.write("staged.txt", "a\nb\n");
    repo.git(&["add", "."]).await;
    repo.git(&["commit", "-m", "init"]).await;
    repo.write("flip.txt", "a\r\nb\r\n"); // unstaged CRLF flip
    repo.write("staged.txt", "a\r\nb\r\n");
    repo.git(&["add", "staged.txt"]).await; // staged CRLF flip

    let runner = GitRunner::for_repo("git", &repo.path);
    let blobs = runner
        .run_with_stdin_bytes(
            &["cat-file", "--batch"],
            ":flip.txt\nHEAD:flip.txt\n:staged.txt\nHEAD:staged.txt\n",
        )
        .await
        .expect("spawn");
    let parsed = parse_cat_file_batch(&blobs.stdout).expect("framing");

    let flip = derive_line_ending_entry(
        "flip.txt",
        Some(b"a\r\nb\r\n"),
        parsed[0].as_deref(),
        parsed[1].as_deref(),
        EolTextAttr::Unspecified,
        false,
        AutocrlfSetting::False,
    );
    assert_eq!(
        flip.unstaged,
        Some(LineEndingTransition { from: LineEndingKind::Lf, to: LineEndingKind::Crlf })
    );
    assert_eq!(flip.staged, None);

    let staged = derive_line_ending_entry(
        "staged.txt",
        Some(b"a\r\nb\r\n"),
        parsed[2].as_deref(),
        parsed[3].as_deref(),
        EolTextAttr::Unspecified,
        false,
        AutocrlfSetting::False,
    );
    assert_eq!(
        staged.staged,
        Some(LineEndingTransition { from: LineEndingKind::Lf, to: LineEndingKind::Crlf })
    );
    assert_eq!(staged.unstaged, None); // working matches index
}

// ---------------------------------------------------------------------------
// log: ref selector walks (which refs reach the graph)
// ---------------------------------------------------------------------------

/// A fetched remote branch that is ahead of every local ref must show up in
/// the full-graph walk (`AllBranchesAndRemotes`) and must NOT leak into the
/// local-only walk (`AllLocalBranches`). Simulates the post-fetch state with
/// `update-ref refs/remotes/...`: no networking involved.
#[tokio::test]
async fn log_walks_remote_only_commits_with_the_remotes_selector() {
    let repo = TestRepo::init().await;
    repo.write("a.txt", "base\n");
    repo.commit_all("base").await;

    // Build a commit reachable only from a remote-tracking ref.
    repo.git(&["switch", "-c", "tmp"]).await;
    repo.write("a.txt", "remote\n");
    repo.commit_all("remote-only change").await;
    let sha = repo.head().await;
    repo.git(&["switch", "main"]).await;
    repo.git(&["update-ref", "refs/remotes/origin/feature", &sha]).await;
    repo.git(&["branch", "-D", "tmp"]).await;

    let local = repo
        .backend
        .log(LogOptions { refs: RefSelector::AllLocalBranches, ..Default::default() })
        .await
        .expect("local log");
    assert!(
        !local.iter().any(|c| c.id.0 == sha),
        "local-only walk must not contain the remote-only commit"
    );

    let all = repo
        .backend
        .log(LogOptions { refs: RefSelector::AllBranchesAndRemotes, ..Default::default() })
        .await
        .expect("full log");
    let found = all
        .iter()
        .find(|c| c.id.0 == sha)
        .expect("remote-only commit must be in the full-graph walk");
    assert!(
        found
            .decorations
            .iter()
            .any(|d| matches!(d, RefDecoration::Remote(r) if r == "refs/remotes/origin/feature")),
        "remote-only commit must carry its remote decoration: {:?}",
        found.decorations
    );
}

/// A freshly initialized repo has an unborn HEAD: `git log HEAD --branches`
/// exits 128 with "ambiguous argument 'HEAD'". The branch selectors add HEAD
/// explicitly (to keep detached-HEAD commits visible), so the walk must
/// tolerate the unresolvable HEAD (`--ignore-missing`) and return an empty
/// log instead of erroring (regression: fatal surfaced right after repo
/// init). Commit search shares the same ref universe.
#[tokio::test]
async fn log_and_search_return_empty_on_fresh_repo_with_unborn_head() {
    use legit_core::CommitSearchKind;

    let repo = TestRepo::init().await;

    for refs in [RefSelector::AllLocalBranches, RefSelector::AllBranchesAndRemotes] {
        let commits = repo
            .backend
            .log(LogOptions { refs, ..Default::default() })
            .await
            .expect("log on a fresh repo must not error");
        assert!(commits.is_empty(), "{commits:?}");
    }

    let found = repo
        .backend
        .search_commits("anything", CommitSearchKind::Message, 50)
        .await
        .expect("commit search on a fresh repo must not error");
    assert!(found.is_empty(), "{found:?}");
}

// ---------------------------------------------------------------------------
// log: signature-presence enrichment (real cat-file --batch framing)
// ---------------------------------------------------------------------------

/// `signature_presence` flags signed commits via the batched raw-header scan
/// (real `cat-file --batch` byte framing). The signed commit is fabricated:
/// HEAD's raw object with a garbage `gpgsig` header spliced in, stored via
/// `hash-object --literally` - no keys, no signing config (the harness pins
/// `commit.gpgsign=false`), which also proves the flag comes from the header
/// scan and not from any verifier.
#[tokio::test]
async fn signature_presence_flags_signed_commits_without_verifying() {
    let repo = TestRepo::init().await;
    repo.write("a.txt", "one\n");
    repo.commit_all("unsigned base").await;
    let unsigned_sha = repo.head().await;

    let raw = repo.git(&["cat-file", "-p", "HEAD"]).await;
    let sig = "gpgsig -----BEGIN PGP SIGNATURE-----\n fabricated-for-presence-test\n -----END PGP SIGNATURE-----";
    let signed_obj = raw.replacen("\n\n", &format!("\n{sig}\n\n"), 1);
    assert_ne!(signed_obj, raw, "splice point (blank line) must exist");

    let runner = GitRunner::for_repo("git", &repo.path);
    let out = runner
        .run_with_stdin(
            &["hash-object", "-t", "commit", "-w", "--stdin", "--literally"],
            &signed_obj,
        )
        .await
        .expect("spawn git");
    assert!(out.success, "hash-object failed: {}", out.stderr);
    let signed_sha = out.stdout.trim().to_string();
    repo.git(&["branch", "signed", &signed_sha]).await;

    let signed = repo
        .backend
        .signature_presence(&[CommitId::new(signed_sha.clone()), CommitId::new(unsigned_sha)])
        .await
        .expect("signature_presence");
    assert_eq!(
        signed,
        vec![CommitId::new(signed_sha)],
        "exactly the gpgsig-bearing commit is flagged"
    );

    // The list itself stays signature-free (presence is pay-per-view).
    let commits = repo
        .backend
        .log(LogOptions { refs: RefSelector::AllLocalBranches, ..Default::default() })
        .await
        .expect("log");
    assert!(
        commits.iter().all(|c| c.signature.is_none() && !c.has_signature),
        "the list must carry no signature data"
    );
}

/// SSH-signature verification classification against the real binary. The
/// "[SSH:] GOOD_SIGNATURE" format the parser once matched was assumed, wrong,
/// and never emitted by real git - every ssh-signed commit classified as
/// NoSignature. This pins the REAL `verify-commit --raw` output shapes:
/// trusted principal -> Good, key missing from allowedSignersFile ->
/// Untrusted, tampered content -> BadSignature.
#[tokio::test]
async fn commit_details_classifies_real_ssh_signatures() {
    // Signing needs ssh-keygen; skip (don't fail) where it isn't installed.
    if std::process::Command::new("ssh-keygen").arg("-?").output().is_err() {
        eprintln!("skipping: ssh-keygen not available");
        return;
    }

    let repo = TestRepo::init().await;
    let keydir = repo.path.join(".git").join("test-keys");
    std::fs::create_dir_all(&keydir).expect("mkdir keydir");
    let gen_key = |name: &str| {
        let path = keydir.join(name);
        let st = std::process::Command::new("ssh-keygen")
            .args(["-q", "-t", "ed25519", "-N", "", "-C", "legit-flows", "-f"])
            .arg(&path)
            .status()
            .expect("spawn ssh-keygen");
        assert!(st.success(), "ssh-keygen failed for {name}");
        path
    };
    let trusted = gen_key("trusted");
    let unknown = gen_key("unknown");

    // allowed_signers holds ONLY the trusted key, bound to the pinned
    // committer identity.
    let pubkey = std::fs::read_to_string(trusted.with_extension("pub")).expect("read pub");
    let mut fields = pubkey.split_whitespace();
    let (ktype, kdata) = (fields.next().expect("key type"), fields.next().expect("key data"));
    let signers = keydir.join("allowed_signers");
    std::fs::write(&signers, format!("test@example.invalid {ktype} {kdata}\n")).expect("write signers");

    repo.git(&["config", "gpg.format", "ssh"]).await;
    repo.git(&["config", "gpg.ssh.allowedSignersFile", signers.to_str().unwrap()]).await;
    repo.git(&["config", "user.signingkey", trusted.to_str().unwrap()]).await;

    // 1. Trusted key + allowed_signers entry -> Good, with signer + key id.
    repo.write("a.txt", "one\n");
    repo.git(&["add", "a.txt"]).await;
    repo.git(&["commit", "-S", "-m", "ssh signed trusted"]).await;
    let good_sha = repo.head().await;

    let details = repo
        .backend
        .commit_details(&CommitId::new(good_sha.clone()))
        .await
        .expect("details (trusted)");
    assert!(details.commit.has_signature, "presence flag must be set");
    let sig = details.commit.signature.expect("verification must run");
    assert_eq!(sig.status, SignatureStatus::Good, "raw: {:?}", sig.raw);
    assert_eq!(sig.signer.as_deref(), Some("test@example.invalid"));
    assert!(sig.key_id.is_some(), "fingerprint must be extracted");

    // 2. Key absent from allowed_signers -> valid signature, Untrusted.
    let key_cfg = format!("user.signingkey={}", unknown.to_str().unwrap());
    repo.write("a.txt", "two\n");
    repo.git(&["add", "a.txt"]).await;
    repo.git(&["-c", &key_cfg, "commit", "-S", "-m", "ssh signed unknown"]).await;
    let untrusted_sha = repo.head().await;

    let details = repo
        .backend
        .commit_details(&CommitId::new(untrusted_sha))
        .await
        .expect("details (unknown key)");
    let sig = details.commit.signature.expect("verification must run");
    assert_eq!(sig.status, SignatureStatus::Untrusted, "raw: {:?}", sig.raw);

    // 3. Tampered content -> BadSignature. Rewrite the signed commit's
    // message and store the forgery with `hash-object --literally`.
    let raw = repo.git(&["cat-file", "-p", &good_sha]).await;
    let tampered = raw.replacen("ssh signed trusted", "ssh signed TAMPERED", 1);
    assert_ne!(tampered, raw);
    let runner = GitRunner::for_repo("git", &repo.path);
    let out = runner
        .run_with_stdin(
            &["hash-object", "-t", "commit", "-w", "--stdin", "--literally"],
            &tampered,
        )
        .await
        .expect("spawn git");
    assert!(out.success, "hash-object failed: {}", out.stderr);
    let bad_sha = out.stdout.trim().to_string();

    let details = repo
        .backend
        .commit_details(&CommitId::new(bad_sha))
        .await
        .expect("details (tampered)");
    let sig = details.commit.signature.expect("verification must run");
    assert_eq!(sig.status, SignatureStatus::BadSignature, "raw: {:?}", sig.raw);
}

/// Local-scope semantics the repo Custom editor depends on
/// (`src-tauri/commands/profiles.rs` `write_repo_managed_config`): a local
/// value overrides global, and unsetting it returns resolution to the global
/// value. `GIT_CONFIG_GLOBAL` redirects the global file into the tempdir so
/// the developer's real `~/.gitconfig` is never touched.
#[tokio::test]
async fn local_config_unset_falls_back_to_global() {
    let repo = TestRepo::init().await;
    let gcfg = repo.path.join("fake-global-config");
    let gcfg_s = gcfg.to_str().expect("utf8 tempdir path").to_string();
    let env: &[(&str, &str)] = &[("GIT_CONFIG_GLOBAL", &gcfg_s)];
    let runner = GitRunner::for_repo("git", &repo.path);

    let out = runner
        .run_with_env(&["config", "--global", "user.signingkey", "GLOBALKEY"], env)
        .await
        .expect("spawn git");
    assert!(out.success, "{}", out.stderr);
    let out = runner
        .run_with_env(&["config", "--local", "user.signingkey", "LOCALKEY"], env)
        .await
        .expect("spawn git");
    assert!(out.success, "{}", out.stderr);

    // Local wins while set...
    let out = runner
        .run_with_env(&["config", "--get", "user.signingkey"], env)
        .await
        .expect("spawn git");
    assert_eq!(out.stdout.trim(), "LOCALKEY");

    // ...and resolution falls back to global once unset.
    let out = runner
        .run_with_env(&["config", "--local", "--unset", "user.signingkey"], env)
        .await
        .expect("spawn git");
    assert!(out.success, "{}", out.stderr);
    let out = runner
        .run_with_env(&["config", "--get", "user.signingkey"], env)
        .await
        .expect("spawn git");
    assert_eq!(out.stdout.trim(), "GLOBALKEY", "unset local key must fall back to global");
}

// --- renormalize -----------------------------------------------------------

#[tokio::test]
async fn renormalize_restages_crlf_blobs_as_lf() {
    let repo = TestRepo::init().await;
    repo.write("a.txt", "one\r\ntwo\r\n");
    repo.commit_all("crlf").await;
    repo.write(".gitattributes", "* text=auto\n");

    let preview = repo.backend.renormalize_preview().await.unwrap();
    assert_eq!(preview, vec!["a.txt".to_string()]);
    // The preview must not have touched the real index.
    let staged = repo.git(&["diff", "--cached", "--name-only"]).await;
    assert_eq!(staged.trim(), "", "preview must leave the real index untouched");

    let outcome = repo.backend.renormalize().await.unwrap();
    assert_eq!(outcome.restaged, vec!["a.txt".to_string()]);

    let eol = repo.git(&["ls-files", "--eol", "a.txt"]).await;
    assert!(eol.contains("i/lf"), "index should be LF after renormalize: {eol}");
    // Working tree bytes untouched.
    assert_eq!(repo.read("a.txt"), "one\r\ntwo\r\n");
}

#[tokio::test]
async fn renormalize_on_normalized_repo_stages_nothing() {
    let repo = TestRepo::init().await;
    repo.write(".gitattributes", "* text=auto\n");
    repo.write("a.txt", "one\n");
    repo.commit_all("lf").await;

    assert!(repo.backend.renormalize_preview().await.unwrap().is_empty());
    let outcome = repo.backend.renormalize().await.unwrap();
    assert!(outcome.restaged.is_empty());
    let staged = repo.git(&["diff", "--cached", "--name-only"]).await;
    assert_eq!(staged.trim(), "");
}

#[tokio::test]
async fn renormalize_clears_phantom_crlf_status_without_content_changes() {
    // Validated git behavior: writing `* text=auto` does NOT hide a
    // CRLF-resaved file from status - it stays "modified" (with an empty
    // content diff) until an add refreshes the stat cache. Renormalize is
    // that refresh: it reports no content change (the index blob was
    // already LF) yet the phantom modification disappears, and the disk
    // bytes keep their CRLF.
    let repo = TestRepo::init().await;
    repo.write("a.txt", "one\ntwo\n");
    repo.commit_all("lf").await;
    // An editor re-saves the file with CRLF: with autocrlf=false this is a
    // phantom "modified".
    repo.write("a.txt", "one\r\ntwo\r\n");
    repo.write(".gitattributes", "* text=auto\n");
    let dirty = repo.backend.status().await.unwrap();
    assert!(
        dirty.iter().any(|s| s.path == Path::new("a.txt")),
        "text=auto alone must NOT clear the phantom modification (git keeps reporting it)"
    );

    // The preview agrees nothing would change content-wise.
    assert!(repo.backend.renormalize_preview().await.unwrap().is_empty());

    let outcome = repo.backend.renormalize().await.unwrap();
    assert!(outcome.restaged.is_empty(), "no index entry changed content");
    let after = repo.backend.status().await.unwrap();
    assert!(
        !after.iter().any(|s| s.path == Path::new("a.txt")),
        "renormalize must clear the phantom modification"
    );
    assert_eq!(repo.read("a.txt"), "one\r\ntwo\r\n", "disk bytes must be untouched");
}

#[tokio::test]
async fn renormalize_preview_reports_non_ascii_paths_raw() {
    let repo = TestRepo::init().await;
    repo.write("ümlaut ö.txt", "x\r\n");
    repo.commit_all("crlf").await;
    repo.write(".gitattributes", "* text=auto\n");
    let files = repo.backend.renormalize_preview().await.unwrap();
    assert_eq!(files, vec!["ümlaut ö.txt".to_string()]);
}

#[tokio::test]
async fn stale_preview_lock_blocks_the_preview() {
    // git refuses to write GIT_INDEX_FILE while `<file>.lock` exists - a
    // preview killed mid-run leaves that lock behind and would block every
    // future preview. This pins the failure mode the command layer's
    // before/after cleanup (`remove_preview_index`) exists to heal.
    let repo = TestRepo::init().await;
    repo.write("a.txt", "one\n");
    repo.commit_all("base").await;
    repo.write(".git/index.legit-renormalize-preview.lock", "");
    assert!(
        repo.backend.renormalize_preview().await.is_err(),
        "a stale preview lock must surface as an error, not a silent empty preview"
    );
}

#[tokio::test]
async fn console_color_flag_yields_ansi_on_pipes_but_not_in_porcelain() {
    // The Git Console injects `-c color.ui=always` so a human sees coloured
    // output despite the piped (non-TTY) stdout, where `color.ui=auto`
    // resolves to off. Two assumptions ride on that flag and are pinned
    // here against the real binary: (1) `always` really does force ANSI
    // codes through a pipe, and (2) machine formats (`--porcelain`) stay
    // clean even under `always`, so the flag can be injected unconditionally.
    let repo = TestRepo::init().await;
    repo.write("a.txt", "one\n");
    repo.commit_all("base").await;
    repo.write("a.txt", "two\n");

    let colored = repo.git(&["-c", "color.ui=always", "diff"]).await;
    assert!(
        colored.contains('\u{1b}'),
        "color.ui=always must emit ANSI escapes on a piped diff, got: {colored:?}"
    );

    let plain = repo.git(&["diff"]).await;
    assert!(
        !plain.contains('\u{1b}'),
        "without the flag a piped diff must stay uncoloured (auto -> off), got: {plain:?}"
    );

    let porcelain = repo
        .git(&["-c", "color.ui=always", "status", "--porcelain"])
        .await;
    assert!(
        !porcelain.contains('\u{1b}'),
        "porcelain output must stay machine-clean under color.ui=always, got: {porcelain:?}"
    );
}

// ---------------------------------------------------------------------------
// LFS probes (spec: 2026-08-17-lfs-detection-warning-design.md). These pin
// the encoded assumptions against the real binary: git grep's exit-1-no-hits
// contract, `:(glob)**/.gitattributes` matching root AND nested files, and
// check-attr's output shape. They must pass whether or not git-lfs is
// installed on this machine: nothing asserts the machine-dependent value of
// `installed`.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn lfs_status_detects_usage_from_root_and_nested_gitattributes() {
    let repo = TestRepo::init().await;
    repo.write("readme.md", "hi\n");
    repo.commit_all("init").await;

    // No .gitattributes anywhere: grep exits 1 ("no hits") - must classify
    // as "does not use LFS", not as an error.
    let status = repo.backend.lfs_status().await.expect("no-lfs repo");
    assert!(!status.uses_lfs);
    assert!(!status.installed);
    assert_eq!(status.version, None);
    assert!(!status.initialized);

    // Rules in a NESTED .gitattributes must be found (monorepo layout).
    std::fs::create_dir_all(repo.path.join("assets")).expect("mkdir assets");
    repo.write("assets/.gitattributes", "*.png filter=lfs diff=lfs merge=lfs -text\n");
    repo.commit_all("track pngs via lfs (nested)").await;
    let status = repo.backend.lfs_status().await.expect("nested lfs repo");
    assert!(status.uses_lfs);
    // installed/initialized are machine-dependent (git-lfs may be absent
    // here) - assert structure only: a missing binary must not report a
    // version, and the call itself must never error.
    if !status.installed {
        assert_eq!(status.version, None);
    }

    // Root .gitattributes works too.
    repo.write(".gitattributes", "*.bin filter=lfs diff=lfs merge=lfs -text\n");
    repo.commit_all("track bins via lfs (root)").await;
    assert!(repo.backend.lfs_status().await.expect("root lfs repo").uses_lfs);
}

#[tokio::test]
async fn lfs_tracked_subset_matches_check_attr_against_real_git() {
    let repo = TestRepo::init().await;
    repo.write(".gitattributes", "*.png filter=lfs diff=lfs merge=lfs -text\n");
    repo.write("logo.png", "not a real png\n");
    repo.write("notes.txt", "text\n");
    repo.commit_all("seed").await;

    let subset = repo
        .backend
        .lfs_tracked_subset(&["logo.png".to_string(), "notes.txt".to_string()])
        .await
        .expect("check-attr");
    assert_eq!(subset, vec!["logo.png".to_string()]);
}

/// Pins the blob_bytes contract against the real binary: byte-exact content
/// through the batch framing (NULs + invalid UTF-8 survive), "missing" for
/// an absent path AND for a root commit's `^` (both exit 0), cap reporting.
#[tokio::test]
async fn blob_bytes_is_byte_exact_and_classifies_missing() {
    let repo = TestRepo::init().await;
    let bytes: Vec<u8> = vec![0x89, b'P', b'N', b'G', 0x00, 0xFF, 0xFE, 0x0A, 0x00];
    std::fs::write(repo.path.join("img.png"), &bytes).expect("write binary");
    repo.commit_all("img").await;

    match repo.backend.blob_bytes("HEAD:img.png", 1024).await.unwrap() {
        BlobBytes::Bytes(b) => assert_eq!(b, bytes, "bytes must round-trip exactly"),
        other => panic!("expected Bytes, got {other:?}"),
    }
    assert_eq!(
        repo.backend.blob_bytes("HEAD:absent.png", 1024).await.unwrap(),
        BlobBytes::Missing
    );
    // Root commit has no parent: the diff preview's old side (`<sha>^`)
    // resolves to Missing, which renders as "added".
    assert_eq!(
        repo.backend.blob_bytes("HEAD^:img.png", 1024).await.unwrap(),
        BlobBytes::Missing
    );
    assert_eq!(
        repo.backend.blob_bytes("HEAD:img.png", 4).await.unwrap(),
        BlobBytes::TooLarge { size: bytes.len() as u64 }
    );
}

/// Reword via carrier + fixup -C, end to end: message replaced verbatim
/// (multi-line body), author preserved, content untouched - combined with a
/// reorder so the empty-diff carrier property is exercised.
#[tokio::test]
async fn interactive_rebase_rewords_a_mid_history_commit() {
    use legit_core::{RebaseAction, RebaseStep};
    let repo = TestRepo::init().await;
    repo.write("a.txt", "a\n");
    repo.commit_all("base").await;
    let base = repo.head().await;
    repo.write("b.txt", "b\n");
    repo.git(&["add", "-A"]).await;
    repo.git(&[
        "-c", "user.name=Ada Lovelace",
        "-c", "user.email=ada@example.invalid",
        "commit", "-m", "second",
    ])
    .await;
    let reworded = repo.head().await;
    repo.write("c.txt", "c\n");
    repo.commit_all("third").await;
    let third = repo.head().await;

    let plan = [
        // Reorder: third first, then the reworded second.
        RebaseStep::new(RebaseAction::Pick, &third),
        RebaseStep::reword(&reworded, "renamed subject\n\nwith a body line"),
    ];
    let outcome = repo.backend.rebase_interactive(&base, &plan).await.expect("rebase");
    assert!(matches!(outcome, RebaseOutcome::Completed), "got {outcome:?}");

    let log = repo
        .git(&["log", "--format=%s|%an|%ae", &format!("{base}..HEAD")])
        .await;
    let lines: Vec<&str> = log.trim().lines().collect();
    // Newest first: the reworded commit is on top after the reorder.
    assert_eq!(lines[0], "renamed subject|Ada Lovelace|ada@example.invalid");
    assert_eq!(lines[1], "third|LeGit Test|test@example.invalid");
    let body = repo.git(&["log", "-1", "--format=%b"]).await;
    assert_eq!(body.trim(), "with a body line");
    // Content untouched: both files exist with their content.
    assert_eq!(repo.read("b.txt"), "b\n");
    assert_eq!(repo.read("c.txt"), "c\n");
}

/// Pins the two probes behind the pushed-warning + transplant notice:
/// `rev-list --not @{upstream}` (exit 128 without an upstream) and
/// `merge-base --is-ancestor`'s 0/1 exit contract.
#[tokio::test]
async fn rebase_range_info_probes_upstream_and_ancestry() {
    let repo = TestRepo::init().await;
    repo.write("a.txt", "a\n");
    repo.commit_all("base").await;
    let base = repo.head().await;
    repo.write("b.txt", "b\n");
    repo.commit_all("pushed-commit").await;

    // No upstream yet: unpushed = None; base is an ancestor.
    let info = repo.backend.rebase_range_info(&base).await.expect("info");
    assert_eq!(info.unpushed, None);
    assert!(!info.transplant);

    // Publish, then add one local-only commit: exactly it is unpushed.
    let remote = tempfile::tempdir().expect("tempdir");
    let remote_path = remote.path().to_string_lossy().into_owned();
    let remote_runner = GitRunner::for_repo("git", remote.path());
    let out = remote_runner.run(&["init", "--bare"]).await.expect("spawn git");
    assert!(out.success, "bare init failed: {}", out.stderr);
    repo.git(&["remote", "add", "origin", &remote_path]).await;
    repo.git(&["push", "-u", "origin", "main"]).await;
    repo.write("c.txt", "c\n");
    repo.commit_all("local-only").await;
    let local_only = repo.head().await;
    let info = repo.backend.rebase_range_info(&base).await.expect("info");
    assert_eq!(info.unpushed, Some(vec![local_only.clone()]));

    // A base on a parallel branch: transplant = true.
    repo.git(&["switch", "-c", "side", &base]).await;
    repo.write("side.txt", "s\n");
    repo.commit_all("side commit").await;
    let side = repo.head().await;
    repo.git(&["switch", "main"]).await;
    let info = repo.backend.rebase_range_info(&side).await.expect("info");
    assert!(info.transplant);
}

/// Assumptions behind the cancelled-clone cleanup (`CloneCleanup` in the
/// app layer): git REFUSES to clone into a non-empty directory without
/// touching its contents (so a cancel racing that early failure has nothing
/// it may delete), and ACCEPTS an existing empty directory (so cleanup there
/// removes the contents git wrote but keeps the user's directory itself).
#[tokio::test]
async fn clone_target_directory_assumptions() {
    let origin = TestRepo::init().await;
    origin.write("a.txt", "x\n");
    origin.commit_all("c1").await;
    let origin_path = origin.path.to_string_lossy().into_owned();

    let work = tempfile::tempdir().expect("tempdir");
    let runner = GitRunner::for_repo("git", work.path());

    // Non-empty target: refused, contents untouched.
    let occupied = work.path().join("occupied");
    std::fs::create_dir(&occupied).expect("mkdir");
    std::fs::write(occupied.join("precious.txt"), "user data").expect("write");
    let out = runner
        .run(&["clone", &origin_path, "occupied"])
        .await
        .expect("spawn git");
    assert!(!out.success, "git must refuse a non-empty clone target");
    assert_eq!(
        std::fs::read_to_string(occupied.join("precious.txt")).expect("read"),
        "user data"
    );
    assert_eq!(
        std::fs::read_dir(&occupied).expect("read_dir").count(),
        1,
        "the refused clone must not have added or removed anything"
    );

    // Existing empty target: accepted, git fills the directory.
    let empty = work.path().join("empty");
    std::fs::create_dir(&empty).expect("mkdir");
    let out = runner
        .run(&["clone", &origin_path, "empty"])
        .await
        .expect("spawn git");
    assert!(
        out.success,
        "git must accept an existing empty clone target: {}",
        out.stderr
    );
    assert!(empty.join(".git").exists());
}

// ---------------------------------------------------------------------------
// Option-like ref names (argument injection) - real git
// ---------------------------------------------------------------------------

/// Encodes the git behavior the `safe_ref` guard exists for, against the real
/// binary, in three steps: such a ref CAN exist, it DOES reach the UI, and it
/// must never reach a `rebase` argv.
///
/// `git rebase` has `--exec=<cmd>`, which runs `<cmd>` through a shell for
/// every rebased commit. A refname may not contain a space, but `$IFS`
/// supplies one, so `--exec=git$IFStag$IFSLEGIT_PWNED` is a complete payload
/// in a legal refname. `git update-ref` accepts such a name (git's refname
/// rules do not forbid a leading dash), `git clone` copies `refs/tags/*`
/// verbatim, and a remote whose `HEAD` points at such a branch even makes
/// clone create and check out a LOCAL branch with that name - so the value
/// arrives with the repository, and "Rebase onto" in the ref's own context
/// menu used to run it. Pre-fix, the rebase succeeded and created the
/// `LEGIT_PWNED` tag.
#[tokio::test]
async fn option_like_ref_never_reaches_rebase_exec() {
    let repo = TestRepo::init().await;
    repo.write("a.txt", "one\n");
    repo.commit_all("one").await;
    let payload = "--exec=git$IFStag$IFSLEGIT_PWNED";

    // 1. Git itself accepts the refname: this is a real repository state, not
    //    a hypothetical.
    repo.git(&["update-ref", &format!("refs/tags/{payload}"), "HEAD"])
        .await;
    repo.write("a.txt", "two\n");
    repo.commit_all("two").await;

    // 2. It reaches the UI like any other tag, so the user can act on it.
    let tags = repo.backend.tags().await.expect("tags");
    assert!(
        tags.iter().any(|t| t.name == payload),
        "the option-like tag must be listed like any other: {tags:?}"
    );

    // 3. Acting on it is refused before git runs, and nothing executed.
    let err = repo.backend.rebase(payload).await.expect_err("must refuse");
    assert!(
        matches!(err, GitError::UnsafeArgument(_)),
        "expected UnsafeArgument, got {err:?}"
    );
    let pwned = repo.git(&["tag", "-l", "LEGIT_PWNED"]).await;
    assert!(
        pwned.trim().is_empty(),
        "the payload RAN: `rebase --exec` executed and created a tag"
    );

    // The second layer, independent of the guard: even handed straight to
    // git, `--end-of-options` makes the payload a (nonexistent) REVISION
    // instead of an option. This is the assumption `rebase_args` encodes.
    let runner = GitRunner::for_repo("git", &repo.path);
    let out = runner
        .run(&["rebase", "--autostash", "--end-of-options", payload])
        .await
        .expect("spawn git");
    // git resolved it as the (existing) tag: a no-op rebase, not an option.
    // `--exec` announces itself with an "Executing:" line, and it would have
    // left the tag behind.
    let combined = format!("{}{}", out.stdout, out.stderr);
    assert!(
        !combined.contains("Executing"),
        "--end-of-options did not stop --exec: {combined}"
    );
    let pwned = repo.git(&["tag", "-l", "LEGIT_PWNED"]).await;
    assert!(
        pwned.trim().is_empty(),
        "--end-of-options did not stop --exec: {combined}"
    );
}

/// The flip side of the guard: `--end-of-options` must not break the ordinary
/// path. Every ref-taking command whose argv now carries it still works on a
/// normal ref (a typo here would break rebase/merge/switch for everyone).
#[tokio::test]
async fn end_of_options_does_not_break_normal_refs() {
    let repo = TestRepo::init().await;
    repo.write("a.txt", "one\n");
    repo.commit_all("one").await;
    let base = repo.head().await;
    repo.git(&["branch", "feature"]).await;
    repo.write("a.txt", "two\n");
    repo.commit_all("two").await;

    // create_tag (lightweight + annotated), then delete_tag
    repo.backend.create_tag("v1", Some(&base), None).await.expect("tag v1");
    repo.backend
        .create_tag("v2", None, Some("release two"))
        .await
        .expect("tag v2");
    let tags = repo.backend.tags().await.expect("tags");
    assert!(tags.iter().any(|t| t.name == "v1" && !t.annotated), "{tags:?}");
    assert!(tags.iter().any(|t| t.name == "v2" && t.annotated), "{tags:?}");
    repo.backend.delete_tag("v1").await.expect("delete tag");

    // create_branch (with and without a start point), switch, rename, delete
    repo.backend.create_branch("from-base", Some(&base)).await.expect("branch");
    repo.backend.create_branch("plain", None).await.expect("branch");
    repo.backend
        .switch_branch("from-base", SwitchDirtyBehavior::TryDirectly)
        .await
        .expect("switch");
    assert_eq!(repo.head().await, base);
    repo.backend.rename_branch("plain", "renamed").await.expect("rename");
    repo.backend.delete_branch("renamed", true).await.expect("delete");

    // checkout_commit (detached), then back to a branch
    repo.backend
        .checkout_commit(&base, SwitchDirtyBehavior::TryDirectly)
        .await
        .expect("detach");
    repo.backend
        .switch_branch("main", SwitchDirtyBehavior::TryDirectly)
        .await
        .expect("switch back");

    // merge and rebase across the two lines of history
    repo.backend
        .switch_branch("feature", SwitchDirtyBehavior::TryDirectly)
        .await
        .expect("switch feature");
    repo.write("b.txt", "b\n");
    repo.commit_all("feature work").await;
    let outcome = repo.backend.rebase("main").await.expect("rebase");
    assert!(
        matches!(outcome, RebaseOutcome::Completed),
        "rebase onto a normal ref must succeed: {outcome:?}"
    );
    repo.backend
        .switch_branch("main", SwitchDirtyBehavior::TryDirectly)
        .await
        .expect("switch main");
    let merged = repo
        .backend
        .merge("feature", MergeOptions { ff: legit_core::FfMode::Auto, squash: false })
        .await
        .expect("merge");
    assert!(
        matches!(merged, MergeOutcome::FastForwarded | MergeOutcome::Merged),
        "merge of a normal ref must succeed: {merged:?}"
    );
    assert!(repo.exists("b.txt"));

    // cherry-pick and revert, reset, and set_upstream's unset path
    let tip = repo.head().await;
    repo.backend.revert(&[tip.clone()], Some(1)).await.expect("revert merge");
    repo.backend.reset(&tip, ResetMode::Hard).await.expect("reset");
    // set_upstream, both argv shapes: `--set-upstream-to=<up>` then
    // `--unset-upstream`. Needs a remote-tracking ref to point at.
    // `--set-upstream-to` only accepts a ref git considers a remote branch,
    // which needs the remote (and its fetch refspec) configured.
    repo.git(&["remote", "add", "origin", "."]).await;
    repo.git(&["update-ref", "refs/remotes/origin/main", &tip]).await;
    repo.backend
        .set_upstream("main", Some("origin/main"))
        .await
        .expect("set upstream");
    repo.backend.set_upstream("main", None).await.expect("unset upstream");
    repo.git(&["switch", "-c", "pick-target", &base]).await;
    let pick = repo.git(&["rev-parse", "feature"]).await.trim().to_string();
    repo.backend.cherry_pick(&[pick.clone()], None).await.expect("cherry-pick");
}

/// Why `reset` and `checkout` rely on the dash guard alone, with NO
/// `--end-of-options`: gits before 2.43.1 mishandle it - `reset` errors on
/// it, and `checkout` reads it as a PATHSPEC (a "guard everywhere" pass once
/// silently broke the submodule branch attach exactly this way). Git 2.43.1
/// taught both commands to accept the flag, so the behavior is
/// version-split; this pins whichever side the host git is on, keeping the
/// rationale encoded: as long as pre-2.43.1 gits are supported, neither
/// command may be given `--end-of-options`.
#[tokio::test]
async fn reset_and_checkout_end_of_options_depends_on_git_version() {
    let repo = TestRepo::init().await;
    repo.write("a.txt", "one\n");
    repo.commit_all("one").await;
    repo.git(&["branch", "feature"]).await;
    let runner = GitRunner::for_repo("git", &repo.path);

    // "git version 2.43.0" (possibly with a platform suffix) -> (2, 43, 0).
    let version = runner.run(&["--version"]).await.expect("spawn git");
    let nums: Vec<u32> = version
        .stdout
        .split(|c: char| !c.is_ascii_digit())
        .filter(|p| !p.is_empty())
        .take(3)
        .map(|p| p.parse().unwrap_or(0))
        .collect();
    let triple = (
        nums.first().copied().unwrap_or(0),
        nums.get(1).copied().unwrap_or(0),
        nums.get(2).copied().unwrap_or(0),
    );
    let accepts = triple >= (2, 43, 1);

    let out = runner
        .run(&["reset", "--soft", "--end-of-options", "HEAD"])
        .await
        .expect("spawn git");
    if accepts {
        assert!(out.success, "reset rejected --end-of-options on git {triple:?}: {out:?}");
    } else {
        assert!(!out.success, "reset accepted --end-of-options: {out:?}");
        assert!(
            out.stderr.contains("--end-of-options"),
            "unexpected reset failure: {}",
            out.stderr
        );
    }

    let out = runner
        .run(&["checkout", "--end-of-options", "feature"])
        .await
        .expect("spawn git");
    if accepts {
        assert!(out.success, "checkout rejected --end-of-options on git {triple:?}: {out:?}");
        assert_eq!(
            repo.git(&["rev-parse", "--abbrev-ref", "HEAD"]).await.trim(),
            "feature",
            "checkout must have treated 'feature' as the branch"
        );
    } else {
        assert!(!out.success, "checkout accepted --end-of-options: {out:?}");
        assert!(
            out.stderr.contains("pathspec"),
            "checkout must treat it as a pathspec: {}",
            out.stderr
        );
    }
}

/// The rename lane of `file_diff`: it passes `--find-renames` plus BOTH
/// paths. That flag now goes in BEFORE the revs, because `--end-of-options`
/// has to be the last option (after it, git reads `--find-renames` as a
/// pathspec and the diff comes back empty). Pins the argv ORDER against real
/// git, which the fake executor cannot judge.
#[tokio::test]
async fn file_diff_of_a_rename_still_finds_hunks() {
    use legit_core::{DiffEntry, DiffSource};

    let repo = TestRepo::init().await;
    // Enough identical lines that git scores the rename above its threshold.
    repo.write("old.txt", "a\nb\nc\nd\ne\nf\ng\nh\n");
    repo.commit_all("add old").await;
    repo.git(&["mv", "old.txt", "new.txt"]).await;
    repo.write("new.txt", "a\nb\nC\nd\ne\nf\ng\nh\n");
    repo.commit_all("rename + edit").await;

    let source = DiffSource::Commit { commit_id: CommitId::new(&repo.head().await) };
    let entry = repo
        .backend
        .file_diff(&source, Path::new("new.txt"), Some(Path::new("old.txt")), 3)
        .await
        .expect("file_diff");
    match entry {
        DiffEntry::Text(t) => assert!(
            !t.hunks.is_empty(),
            "a renamed-and-edited file must still produce hunks (argv order?)"
        ),
        other => panic!("expected a text diff, got {other:?}"),
    }
}
