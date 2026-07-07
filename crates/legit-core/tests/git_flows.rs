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
    ConflictKind, ConflictSide, FetchOptions, FileState, GitBackend, GitCliBackend, GitRunner,
    MergeOptions, MergeOutcome, OperationId, PullOptions, PullStrategy, PushOptions,
    RebaseOutcome, RemoteProgress, RepoFileEntry, RepoFileKind, RepoOpState, ResetMode,
    SequenceOutcome, StashOutcome, SwitchDirtyBehavior, SwitchOutcome,
};
use std::path::PathBuf;
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
