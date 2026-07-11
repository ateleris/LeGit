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
    CommitId, GitError, ConflictKind, ConflictSide, DiffEntry, DiffSource, FetchOptions, FileState,
    GitBackend, GitCliBackend, GitRunner, MergeOptions, MergeOutcome, OperationId, PullOptions,
    PullStrategy, PushOptions, PushRecurseMode, RebaseOutcome, RemoteProgress, RepoFileEntry, RepoFileKind,
    RepoOpState, ResetMode, SequenceOutcome, StashApplyOutcome, StashOutcome, SubmoduleAutoUpdateStatus,
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
    assert_eq!(outcome, SwitchOutcome::Clean);
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
    assert_eq!(outcome, SwitchOutcome::ChangesStashed);
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
        RebaseStep::Pick { sha: legit_core::CommitId::new(&c2) },
        RebaseStep::Squash { sha: legit_core::CommitId::new(&c1) },
        RebaseStep::Drop { sha: legit_core::CommitId::new(&c3) },
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
        RebaseStep::Pick { sha: legit_core::CommitId::new(&c2) },
        RebaseStep::Pick { sha: legit_core::CommitId::new(&c1) },
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

    let outcome = repo.backend.revert(&second).await.unwrap();
    assert_eq!(outcome, SequenceOutcome::Completed);

    assert_eq!(repo.read("a.txt"), "one\n");
    let subject = repo.git(&["log", "-1", "--format=%s"]).await;
    assert!(subject.starts_with("Revert"), "{subject}");
    assert!(matches!(repo.backend.op_state().await.unwrap(), RepoOpState::None));
}

#[tokio::test]
async fn cherry_pick_conflict_resolve_continue() {
    let repo = TestRepo::init().await;
    conflicting_branches(&repo).await;
    let feature_tip = repo.git(&["rev-parse", "feature"]).await.trim().to_string();

    let outcome = repo.backend.cherry_pick(&feature_tip).await.unwrap();
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

    let outcome = repo.backend.revert(&middle).await.unwrap();
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
        .file_history(std::path::Path::new("b.txt"), 200, 0)
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
        .file_history(std::path::Path::new("b.txt"), 200, 1)
        .await
        .unwrap();
    assert_eq!(page.len(), 3);
    assert_eq!(page[0].summary, "rename a to b");
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
        matches!(&err, GitError::CommandFailed { stderr, .. } if stderr.contains("not fully merged")),
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
    assert_eq!(outcome, SwitchOutcome::Clean);
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
