//! Composed-flow tests for `GitCliBackend` against a scripted `FakeExecutor`.
//!
//! These encode the backend's assumptions about *which git commands run, in
//! which order, and how their outputs are reacted to* - without a real git
//! binary. The fake asserts each invocation's exact argument vector against a
//! FIFO script and returns a canned `RunOutput`; an unexpected or missing
//! invocation fails the test. Complementary to `tests/git_flows.rs`, which
//! validates the same flows against the real binary.

use super::*;
use crate::executor::GitExecutor;
use crate::runner::{RunOutput, RunnerError};
use crate::types::KeyId;
use std::collections::VecDeque;
use std::sync::Mutex;

/// One scripted step: the exact args expected, the env overrides expected
/// (None = a plain run), and the output to return.
struct Step {
    args: Vec<String>,
    env: Option<Vec<(String, String)>>,
    output: RunOutput,
}

/// A strict-FIFO scripted executor. Every `run*` call must match the next
/// step's args exactly; the script must be fully consumed by the end of the
/// test (`assert_done`).
#[derive(Default)]
struct FakeExecutor {
    script: Mutex<VecDeque<Step>>,
}

fn out(exit_code: i32, stdout: &str, stderr: &str) -> RunOutput {
    RunOutput {
        stdout: stdout.to_string(),
        stderr: stderr.to_string(),
        exit_code: Some(exit_code),
        success: exit_code == 0,
        duration_ms: 0,
    }
}

fn ok(stdout: &str) -> RunOutput {
    out(0, stdout, "")
}

fn fail(exit_code: i32, stderr: &str) -> RunOutput {
    out(exit_code, "", stderr)
}

impl FakeExecutor {
    fn expect(&self, args: &[&str], output: RunOutput) -> &Self {
        self.script.lock().unwrap().push_back(Step {
            args: args.iter().map(|s| s.to_string()).collect(),
            env: None,
            output,
        });
        self
    }

    /// Expect an invocation carrying per-invocation env overrides.
    fn expect_env(&self, args: &[&str], env: &[(&str, &str)], output: RunOutput) -> &Self {
        self.script.lock().unwrap().push_back(Step {
            args: args.iter().map(|s| s.to_string()).collect(),
            env: Some(env.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()),
            output,
        });
        self
    }

    fn next(&self, actual: &[&str], actual_env: Option<&[(&str, &str)]>) -> RunOutput {
        let mut script = self.script.lock().unwrap();
        let step = script
            .pop_front()
            .unwrap_or_else(|| panic!("unexpected git invocation: {actual:?}"));
        assert_eq!(
            actual.to_vec(),
            step.args.iter().map(String::as_str).collect::<Vec<_>>(),
            "git invoked with unexpected args"
        );
        let actual_env: Option<Vec<(String, String)>> = actual_env
            .map(|e| e.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect());
        assert_eq!(actual_env, step.env, "git invoked with unexpected env overrides");
        step.output
    }

    fn assert_done(&self) {
        let script = self.script.lock().unwrap();
        assert!(
            script.is_empty(),
            "expected {} more git invocation(s), next: {:?}",
            script.len(),
            script.front().map(|s| &s.args)
        );
    }
}

#[async_trait]
impl GitExecutor for FakeExecutor {
    async fn run(&self, args: &[&str]) -> Result<RunOutput, RunnerError> {
        Ok(self.next(args, None))
    }

    async fn run_with_op(
        &self,
        args: &[&str],
        _op_id: OperationId,
    ) -> Result<RunOutput, RunnerError> {
        Ok(self.next(args, None))
    }

    async fn run_with_stdin(
        &self,
        args: &[&str],
        _stdin_data: &str,
    ) -> Result<RunOutput, RunnerError> {
        Ok(self.next(args, None))
    }

    async fn run_with_env(
        &self,
        args: &[&str],
        extra_env: &[(&str, &str)],
    ) -> Result<RunOutput, RunnerError> {
        Ok(self.next(args, Some(extra_env)))
    }
}

/// Build a backend over a scripted executor; the returned Arc lets the test
/// call `assert_done` after exercising the flow.
fn backend(script: FakeExecutor) -> (GitCliBackend<FakeExecutor>, Arc<FakeExecutor>) {
    let exec = Arc::new(script);
    let lock = Arc::new(RwLock::new(exec.clone()));
    (GitCliBackend::new(lock), exec)
}

const STASH_PUSH_MSG: &str = "legit: auto-stash before switching to feature";

// ---------------------------------------------------------------------------
// run_with_auto_stash (via switch_branch) - full sequencing
// ---------------------------------------------------------------------------

#[tokio::test]
async fn switch_try_directly_runs_only_the_switch() {
    let fake = FakeExecutor::default();
    fake.expect(&["switch", "feature"], ok(""));
    let (b, exec) = backend(fake);

    let outcome = b
        .switch_branch("feature", SwitchDirtyBehavior::TryDirectly)
        .await
        .unwrap();
    assert_eq!(outcome, SwitchOutcome::Clean);
    exec.assert_done();
}

#[tokio::test]
async fn switch_auto_stash_dirty_tree_pops_the_created_entry() {
    let fake = FakeExecutor::default();
    // No prior stash -> push creates one -> switch -> pop that exact entry.
    fake.expect(&["rev-parse", "-q", "--verify", "refs/stash"], fail(1, ""));
    fake.expect(
        &["stash", "push", "--include-untracked", "-m", STASH_PUSH_MSG],
        ok("Saved working directory and index state"),
    );
    fake.expect(&["rev-parse", "-q", "--verify", "refs/stash"], ok("aaa111\n"));
    fake.expect(&["switch", "feature"], ok("Switched to branch 'feature'"));
    fake.expect(&["stash", "list", "--format=%H %gd"], ok("aaa111 stash@{0}\n"));
    fake.expect(&["stash", "pop", "stash@{0}"], ok("Dropped refs/stash@{0}"));
    let (b, exec) = backend(fake);

    let outcome = b
        .switch_branch("feature", SwitchDirtyBehavior::AutoStash)
        .await
        .unwrap();
    assert_eq!(outcome, SwitchOutcome::Clean);
    exec.assert_done();
}

#[tokio::test]
async fn switch_auto_stash_clean_tree_never_touches_preexisting_stash() {
    // THE data-loss regression, at the flow level: `stash push` exits 0 on a
    // clean tree; with a pre-existing stash the tip is unchanged, so nothing
    // may be popped after the switch.
    let fake = FakeExecutor::default();
    fake.expect(&["rev-parse", "-q", "--verify", "refs/stash"], ok("zzz999\n"));
    fake.expect(
        &["stash", "push", "--include-untracked", "-m", STASH_PUSH_MSG],
        ok("No local changes to save"),
    );
    fake.expect(&["rev-parse", "-q", "--verify", "refs/stash"], ok("zzz999\n"));
    fake.expect(&["switch", "feature"], ok(""));
    // Deliberately NO stash list / pop steps - popping here would eat the
    // user's own stash entry.
    let (b, exec) = backend(fake);

    let outcome = b
        .switch_branch("feature", SwitchDirtyBehavior::AutoStash)
        .await
        .unwrap();
    assert_eq!(outcome, SwitchOutcome::Clean);
    exec.assert_done();
}

#[tokio::test]
async fn switch_failure_rolls_the_auto_stash_back() {
    let fake = FakeExecutor::default();
    fake.expect(&["rev-parse", "-q", "--verify", "refs/stash"], fail(1, ""));
    fake.expect(
        &["stash", "push", "--include-untracked", "-m", STASH_PUSH_MSG],
        ok("Saved"),
    );
    fake.expect(&["rev-parse", "-q", "--verify", "refs/stash"], ok("aaa111\n"));
    fake.expect(
        &["switch", "feature"],
        fail(128, "fatal: invalid reference: feature"),
    );
    // Rollback: restore the stashed changes onto the original branch.
    fake.expect(&["stash", "list", "--format=%H %gd"], ok("aaa111 stash@{0}\n"));
    fake.expect(&["stash", "pop", "stash@{0}"], ok(""));
    let (b, exec) = backend(fake);

    let err = b
        .switch_branch("feature", SwitchDirtyBehavior::AutoStash)
        .await
        .unwrap_err();
    // The original switch error survives the successful rollback unchanged.
    assert!(matches!(err, GitError::RefNotFound(_)), "{err:?}");
    exec.assert_done();
}

#[tokio::test]
async fn switch_failure_with_failed_rollback_reports_both() {
    let fake = FakeExecutor::default();
    fake.expect(&["rev-parse", "-q", "--verify", "refs/stash"], fail(1, ""));
    fake.expect(
        &["stash", "push", "--include-untracked", "-m", STASH_PUSH_MSG],
        ok("Saved"),
    );
    fake.expect(&["rev-parse", "-q", "--verify", "refs/stash"], ok("aaa111\n"));
    fake.expect(
        &["switch", "feature"],
        fail(128, "fatal: invalid reference: feature"),
    );
    fake.expect(&["stash", "list", "--format=%H %gd"], ok("aaa111 stash@{0}\n"));
    fake.expect(&["stash", "pop", "stash@{0}"], fail(1, "error: could not restore"));
    let (b, exec) = backend(fake);

    let err = b
        .switch_branch("feature", SwitchDirtyBehavior::AutoStash)
        .await
        .unwrap_err();
    // A failed best-effort recovery must not be silent: the error carries the
    // original failure AND where the changes went.
    let msg = err.to_string();
    assert!(msg.contains("invalid reference"), "{msg}");
    assert!(msg.contains("preserved in the stash"), "{msg}");
    exec.assert_done();
}

#[tokio::test]
async fn switch_stash_and_keep_leaves_the_entry_parked() {
    let fake = FakeExecutor::default();
    fake.expect(&["rev-parse", "-q", "--verify", "refs/stash"], fail(1, ""));
    fake.expect(
        &["stash", "push", "--include-untracked", "-m", STASH_PUSH_MSG],
        ok("Saved"),
    );
    fake.expect(&["rev-parse", "-q", "--verify", "refs/stash"], ok("aaa111\n"));
    fake.expect(&["switch", "feature"], ok(""));
    // No pop: the WIP deliberately stays in the stash.
    let (b, exec) = backend(fake);

    let outcome = b
        .switch_branch("feature", SwitchDirtyBehavior::StashAndKeep)
        .await
        .unwrap();
    assert_eq!(outcome, SwitchOutcome::ChangesStashed);
    exec.assert_done();
}

#[tokio::test]
async fn switch_pop_conflict_is_an_outcome_not_an_error() {
    let fake = FakeExecutor::default();
    fake.expect(&["rev-parse", "-q", "--verify", "refs/stash"], fail(1, ""));
    fake.expect(
        &["stash", "push", "--include-untracked", "-m", STASH_PUSH_MSG],
        ok("Saved"),
    );
    fake.expect(&["rev-parse", "-q", "--verify", "refs/stash"], ok("aaa111\n"));
    fake.expect(&["switch", "feature"], ok(""));
    fake.expect(&["stash", "list", "--format=%H %gd"], ok("aaa111 stash@{0}\n"));
    fake.expect(
        &["stash", "pop", "stash@{0}"],
        fail(1, "CONFLICT (content): Merge conflict in a.txt"),
    );
    let (b, exec) = backend(fake);

    let outcome = b
        .switch_branch("feature", SwitchDirtyBehavior::AutoStash)
        .await
        .unwrap();
    assert!(matches!(outcome, SwitchOutcome::StashPopConflicts { .. }), "{outcome:?}");
    exec.assert_done();
}

// ---------------------------------------------------------------------------
// checkout_remote_branch - the exists-check branch
// ---------------------------------------------------------------------------

#[tokio::test]
async fn checkout_remote_branch_switches_to_existing_local() {
    let fake = FakeExecutor::default();
    fake.expect(
        &["rev-parse", "-q", "--verify", "refs/heads/feature-x"],
        ok("abc123\n"),
    );
    fake.expect(&["switch", "feature-x"], ok(""));
    let (b, exec) = backend(fake);

    let outcome = b
        .checkout_remote_branch("origin/feature-x", SwitchDirtyBehavior::TryDirectly)
        .await
        .unwrap();
    assert_eq!(outcome, SwitchOutcome::Clean);
    exec.assert_done();
}

#[tokio::test]
async fn checkout_remote_branch_tracks_when_no_local_exists() {
    let fake = FakeExecutor::default();
    fake.expect(
        &["rev-parse", "-q", "--verify", "refs/heads/feature-x"],
        fail(1, ""),
    );
    fake.expect(&["switch", "--track", "origin/feature-x"], ok(""));
    let (b, exec) = backend(fake);

    let outcome = b
        .checkout_remote_branch("origin/feature-x", SwitchDirtyBehavior::TryDirectly)
        .await
        .unwrap();
    assert_eq!(outcome, SwitchOutcome::Clean);
    exec.assert_done();
}

#[tokio::test]
async fn checkout_remote_branch_accepts_full_ref_form() {
    let fake = FakeExecutor::default();
    fake.expect(
        &["rev-parse", "-q", "--verify", "refs/heads/feat/nested"],
        fail(1, ""),
    );
    fake.expect(&["switch", "--track", "origin/feat/nested"], ok(""));
    let (b, exec) = backend(fake);

    b.checkout_remote_branch(
        "refs/remotes/origin/feat/nested",
        SwitchDirtyBehavior::TryDirectly,
    )
    .await
    .unwrap();
    exec.assert_done();
}

// ---------------------------------------------------------------------------
// merge/rebase continue - the editor env override
// ---------------------------------------------------------------------------

#[tokio::test]
async fn merge_continue_overrides_the_editor_env() {
    // Regression: the base env's GIT_EDITOR=false outranks any `-c
    // core.editor=…`, so the continue must carry a per-invocation override.
    let fake = FakeExecutor::default();
    fake.expect_env(
        &["merge", "--continue"],
        &[("GIT_EDITOR", "true")],
        ok("[main abc123] Merge branch 'feature'"),
    );
    let (b, exec) = backend(fake);

    let outcome = b.merge_continue().await.unwrap();
    assert_eq!(outcome, MergeOutcome::Merged);
    exec.assert_done();
}

#[tokio::test]
async fn rebase_continue_overrides_the_editor_env() {
    let fake = FakeExecutor::default();
    fake.expect_env(
        &["rebase", "--continue"],
        &[("GIT_EDITOR", "true")],
        out(0, "", "Successfully rebased and updated refs/heads/feature.\n"),
    );
    let (b, exec) = backend(fake);

    let outcome = b.rebase_continue().await.unwrap();
    assert_eq!(outcome, RebaseOutcome::Completed);
    exec.assert_done();
}

// ---------------------------------------------------------------------------
// commit - args + HEAD resolution
// ---------------------------------------------------------------------------

#[tokio::test]
async fn commit_signs_with_key_and_resolves_new_head() {
    let fake = FakeExecutor::default();
    fake.expect(&["commit", "-m", "hello", "-SKEYID"], ok(""));
    fake.expect(&["rev-parse", "HEAD"], ok("abc123\n"));
    let (b, exec) = backend(fake);

    let id = b
        .commit(CommitOptions {
            message: "hello".into(),
            sign: SignMode::WithKey(KeyId("KEYID".into())),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(id.as_str(), "abc123");
    exec.assert_done();
}

// ---------------------------------------------------------------------------
// reword_commit - precondition sequencing
// ---------------------------------------------------------------------------

#[tokio::test]
async fn reword_rejects_non_head_before_touching_anything() {
    let fake = FakeExecutor::default();
    fake.expect(&["rev-parse", "HEAD"], ok("headhead\n"));
    // No further commands: the precondition must fail fast.
    let (b, exec) = backend(fake);

    let err = b
        .reword_commit(&CommitId("othersha".into()), "new msg")
        .await
        .unwrap_err();
    assert!(matches!(err, GitError::RewordNotHead), "{err:?}");
    exec.assert_done();
}

#[tokio::test]
async fn reword_rejects_pushed_commits() {
    let fake = FakeExecutor::default();
    fake.expect(&["rev-parse", "HEAD"], ok("headhead\n"));
    // Empty output = reachable from a remote-tracking ref = already pushed.
    fake.expect(
        &["rev-list", "-n", "1", "headhead", "--not", "--remotes"],
        ok(""),
    );
    let (b, exec) = backend(fake);

    let err = b
        .reword_commit(&CommitId("headhead".into()), "new msg")
        .await
        .unwrap_err();
    assert!(matches!(err, GitError::RewordPushed), "{err:?}");
    exec.assert_done();
}

#[tokio::test]
async fn reword_amends_only_and_returns_the_new_id() {
    let fake = FakeExecutor::default();
    fake.expect(&["rev-parse", "HEAD"], ok("headhead\n"));
    fake.expect(
        &["rev-list", "-n", "1", "headhead", "--not", "--remotes"],
        ok("headhead\n"),
    );
    // `--only` with no pathspec: never folds staged changes into the reword.
    fake.expect(&["commit", "--amend", "--only", "-m", "new msg"], ok(""));
    fake.expect(&["rev-parse", "HEAD"], ok("newsha\n"));
    let (b, exec) = backend(fake);

    let id = b
        .reword_commit(&CommitId("headhead".into()), "new msg")
        .await
        .unwrap();
    assert_eq!(id.as_str(), "newsha");
    exec.assert_done();
}

// ---------------------------------------------------------------------------
// stash flows
// ---------------------------------------------------------------------------

#[tokio::test]
async fn create_stash_clean_tree_is_nothing_to_stash() {
    // `git stash push` exits 0 with "No local changes to save" on a clean
    // tree; the outcome must come from the unmoved stash tip.
    let fake = FakeExecutor::default();
    fake.expect(&["rev-parse", "-q", "--verify", "refs/stash"], fail(1, ""));
    fake.expect(&["stash", "push"], ok("No local changes to save"));
    fake.expect(&["rev-parse", "-q", "--verify", "refs/stash"], fail(1, ""));
    let (b, exec) = backend(fake);

    let outcome = b.create_stash(None, false, false).await.unwrap();
    assert_eq!(outcome, StashOutcome::NothingToStash);
    exec.assert_done();
}

#[tokio::test]
async fn create_stash_with_message_and_untracked() {
    let fake = FakeExecutor::default();
    fake.expect(&["rev-parse", "-q", "--verify", "refs/stash"], fail(1, ""));
    fake.expect(
        &["stash", "push", "--include-untracked", "-m", "wip"],
        ok("Saved working directory"),
    );
    fake.expect(&["rev-parse", "-q", "--verify", "refs/stash"], ok("aaa111\n"));
    let (b, exec) = backend(fake);

    let outcome = b.create_stash(Some("wip"), true, false).await.unwrap();
    assert_eq!(outcome, StashOutcome::Created);
    exec.assert_done();
}

#[tokio::test]
async fn create_stash_keep_index_adds_the_flag() {
    let fake = FakeExecutor::default();
    fake.expect(&["rev-parse", "-q", "--verify", "refs/stash"], fail(1, ""));
    fake.expect(
        &["stash", "push", "--include-untracked", "--keep-index", "-m", "wip"],
        ok("Saved working directory"),
    );
    fake.expect(&["rev-parse", "-q", "--verify", "refs/stash"], ok("aaa111\n"));
    let (b, exec) = backend(fake);

    let outcome = b.create_stash(Some("wip"), true, true).await.unwrap();
    assert_eq!(outcome, StashOutcome::Created);
    exec.assert_done();
}

#[tokio::test]
async fn rename_stash_drops_then_stores_by_sha() {
    // Rename = drop the current selector + re-store the commit (which we
    // address by SHA, so the content survives a failed store).
    let fake = FakeExecutor::default();
    fake.expect(
        &["stash", "list", "--format=%H %gd"],
        ok("other000 stash@{0}\nabc123 stash@{1}\n"),
    );
    fake.expect(&["stash", "drop", "stash@{1}"], ok(""));
    fake.expect(&["stash", "store", "-m", "renamed", "abc123"], ok(""));
    let (b, exec) = backend(fake);

    b.rename_stash("abc123", "renamed").await.unwrap();
    exec.assert_done();
}

#[tokio::test]
async fn stash_branch_resolves_selector_then_branches() {
    let fake = FakeExecutor::default();
    fake.expect(
        &["stash", "list", "--format=%H %gd"],
        ok("other000 stash@{0}\nabc123 stash@{1}\n"),
    );
    fake.expect(&["stash", "branch", "topic", "stash@{1}"], ok(""));
    let (b, exec) = backend(fake);

    b.stash_branch("abc123", "topic").await.unwrap();
    exec.assert_done();
}

#[tokio::test]
async fn stash_branch_dirty_tree_is_would_overwrite() {
    // The internal checkout refuses like any switch; the classification must
    // surface WouldOverwriteLocalChanges, not a generic CommandFailed.
    let fake = FakeExecutor::default();
    fake.expect(&["stash", "list", "--format=%H %gd"], ok("abc123 stash@{0}\n"));
    fake.expect(
        &["stash", "branch", "topic", "stash@{0}"],
        fail(
            1,
            "error: Your local changes to the following files would be overwritten by checkout:\n\ta.txt",
        ),
    );
    let (b, exec) = backend(fake);

    let err = b.stash_branch("abc123", "topic").await.unwrap_err();
    assert!(matches!(err, GitError::WouldOverwriteLocalChanges(_)), "{err:?}");
    exec.assert_done();
}

#[tokio::test]
async fn stash_mutation_on_vanished_sha_is_ref_not_found() {
    let fake = FakeExecutor::default();
    fake.expect(&["stash", "list", "--format=%H %gd"], ok("other000 stash@{0}\n"));
    let (b, exec) = backend(fake);

    let err = b.drop_stash("gone999").await.unwrap_err();
    assert!(matches!(err, GitError::RefNotFound(_)), "{err:?}");
    exec.assert_done();
}

// ---------------------------------------------------------------------------
// search — commits (message/author/content) and paths
// ---------------------------------------------------------------------------

#[tokio::test]
async fn search_commits_builds_the_right_log_args_per_kind() {
    let fmt = format!("--format={}", parsers::log::LOG_FORMAT);
    for (kind, flag) in [
        (CommitSearchKind::Message, "--grep=fix bug".to_string()),
        (CommitSearchKind::Author, "--author=fix bug".to_string()),
    ] {
        let fake = FakeExecutor::default();
        fake.expect(
            &[
                "log", fmt.as_str(), "--max-count=50", "--regexp-ignore-case", flag.as_str(),
                "HEAD", "--branches", "--decorate=full",
            ],
            ok(""),
        );
        let (b, exec) = backend(fake);
        let commits = b.search_commits("fix bug", kind, 50).await.unwrap();
        assert!(commits.is_empty());
        exec.assert_done();
    }

    // Content search is git's pickaxe: -S <literal>, no regex flag.
    let fake = FakeExecutor::default();
    fake.expect(
        &["log", fmt.as_str(), "--max-count=50", "-S", "needle", "HEAD", "--branches", "--decorate=full"],
        ok(""),
    );
    let (b, exec) = backend(fake);
    b.search_commits("needle", CommitSearchKind::Content, 50).await.unwrap();
    exec.assert_done();
}

#[tokio::test]
async fn search_paths_filters_ls_files_case_insensitively() {
    let fake = FakeExecutor::default();
    fake.expect(
        &["ls-files", "-z"],
        ok("src/Main.rs\0docs/readme.md\0src/lib/mainHelper.ts\0"),
    );
    let (b, exec) = backend(fake);

    let paths = b.search_paths("main", 10).await.unwrap();
    assert_eq!(
        paths,
        vec![PathBuf::from("src/Main.rs"), PathBuf::from("src/lib/mainHelper.ts")],
    );
    exec.assert_done();
}

// ---------------------------------------------------------------------------
// compare view — range file list + per-file range diff
// ---------------------------------------------------------------------------

#[tokio::test]
async fn diff_files_runs_diff_tree_over_the_given_revs() {
    // Any rev spec works (branch names, HEAD~n, shas) — no parent resolution,
    // unlike commit_files.
    let fake = FakeExecutor::default();
    fake.expect(
        &["diff-tree", "--no-commit-id", "-r", "-M", "-z", "--name-status", "main", "feature"],
        ok("M\0a.txt\0A\0b.txt\0"),
    );
    fake.expect(
        &["diff-tree", "--no-commit-id", "-r", "-M", "-z", "--numstat", "main", "feature"],
        ok("1\t1\ta.txt\02\t0\tb.txt\0"),
    );
    let (b, exec) = backend(fake);

    let files = b.diff_files("main", "feature").await.unwrap();
    assert_eq!(files.len(), 2);
    exec.assert_done();
}

#[tokio::test]
async fn file_diff_commit_range_passes_both_revs() {
    let fake = FakeExecutor::default();
    fake.expect(
        &["diff", "--no-color", "--no-ext-diff", "-U3", "main", "feature", "--", "a.txt"],
        ok("diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-x\n+y\n"),
    );
    let (b, exec) = backend(fake);

    let source = DiffSource::CommitRange {
        from: CommitId::new("main"),
        to: CommitId::new("feature"),
    };
    let entry = b.file_diff(&source, Path::new("a.txt"), None, 3).await.unwrap();
    assert!(matches!(entry, DiffEntry::Text(_)), "{entry:?}");
    exec.assert_done();
}

// ---------------------------------------------------------------------------
// conflict file sides — index stages :1/:2/:3
// ---------------------------------------------------------------------------

#[tokio::test]
async fn conflict_sides_read_the_three_stages_and_tolerate_missing_ones() {
    // A delete/modify conflict lacks one stage: `git show :N:path` fails for
    // it, which means "no content on that side", not an error.
    let fake = FakeExecutor::default();
    fake.expect(&["show", ":1:a.txt"], ok("base\n"));
    fake.expect(&["show", ":2:a.txt"], ok("ours\n"));
    fake.expect(
        &["show", ":3:a.txt"],
        fail(128, "fatal: path 'a.txt' does not exist in ':3:a.txt'"),
    );
    let (b, exec) = backend(fake);

    let sides = b.conflict_file_sides(Path::new("a.txt")).await.unwrap();
    assert_eq!(sides.base.as_deref(), Some("base\n"));
    assert_eq!(sides.ours.as_deref(), Some("ours\n"));
    assert_eq!(sides.theirs, None);
    exec.assert_done();
}

// ---------------------------------------------------------------------------
// interactive rebase — todo injection via GIT_SEQUENCE_EDITOR
// ---------------------------------------------------------------------------

#[tokio::test]
async fn interactive_rebase_injects_the_todo_via_sequence_editor() {
    // No temp script: the sequence editor is `printf '<todo>' >`, which sh
    // completes with the todo path git appends — the plan is written straight
    // into git's own todo file. GIT_EDITOR=true accepts squash messages.
    let fake = FakeExecutor::default();
    fake.expect_env(
        &["rebase", "-i", "--autostash", "base123"],
        &[
            (
                "GIT_SEQUENCE_EDITOR",
                "printf 'pick aaa111\\ndrop bbb222\\nsquash ccc333\\n' >",
            ),
            ("GIT_EDITOR", "true"),
        ],
        ok("Successfully rebased and updated refs/heads/main."),
    );
    let (b, exec) = backend(fake);

    let plan = vec![
        RebaseStep::Pick { sha: CommitId::new("aaa111") },
        RebaseStep::Drop { sha: CommitId::new("bbb222") },
        RebaseStep::Squash { sha: CommitId::new("ccc333") },
    ];
    let outcome = b.rebase_interactive("base123", &plan).await.unwrap();
    assert_eq!(outcome, RebaseOutcome::Completed);
    exec.assert_done();
}

#[tokio::test]
async fn interactive_rebase_rejects_bad_plans_without_running_git() {
    let (b, exec) = backend(FakeExecutor::default());

    // Empty plan.
    assert!(b.rebase_interactive("base", &[]).await.is_err());
    // First kept step cannot meld into a predecessor.
    let squash_first = vec![RebaseStep::Squash { sha: CommitId::new("aaa111") }];
    assert!(b.rebase_interactive("base", &squash_first).await.is_err());
    // Drops before a leading squash don't provide a predecessor either.
    let drop_then_squash = vec![
        RebaseStep::Drop { sha: CommitId::new("aaa111") },
        RebaseStep::Fixup { sha: CommitId::new("bbb222") },
    ];
    assert!(b.rebase_interactive("base", &drop_then_squash).await.is_err());
    // A non-hex sha must never reach the shell-interpreted editor string.
    let bad_sha = vec![RebaseStep::Pick { sha: CommitId::new("abc'; rm -rf") }];
    assert!(b.rebase_interactive("base", &bad_sha).await.is_err());

    exec.assert_done();
}

// ---------------------------------------------------------------------------
// reset / revert / cherry-pick (undo & history rewriting)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn reset_passes_the_mode_flag() {
    for (mode, flag) in [
        (ResetMode::Soft, "--soft"),
        (ResetMode::Mixed, "--mixed"),
        (ResetMode::Hard, "--hard"),
    ] {
        let fake = FakeExecutor::default();
        fake.expect(&["reset", flag, "abc123"], ok(""));
        let (b, exec) = backend(fake);

        b.reset("abc123", mode).await.unwrap();
        exec.assert_done();
    }
}

#[tokio::test]
async fn revert_runs_no_edit_and_completes() {
    // --no-edit: the runner hardens GIT_EDITOR=false, so a revert that opened
    // an editor for its message would fail outright.
    let fake = FakeExecutor::default();
    fake.expect(
        &["revert", "--no-edit", "abc123"],
        ok("[main 1a2b3c] Revert \"x\""),
    );
    let (b, exec) = backend(fake);

    let outcome = b.revert("abc123").await.unwrap();
    assert_eq!(outcome, SequenceOutcome::Completed);
    exec.assert_done();
}

#[tokio::test]
async fn cherry_pick_conflict_is_an_outcome_not_an_error() {
    let fake = FakeExecutor::default();
    fake.expect(
        &["cherry-pick", "def456"],
        out(
            1,
            "Auto-merging a.txt\nCONFLICT (content): Merge conflict in a.txt",
            "error: could not apply def456... feature change\nhint: After resolving the conflicts, mark them with \"git add\"",
        ),
    );
    let (b, exec) = backend(fake);

    let outcome = b.cherry_pick("def456").await.unwrap();
    assert!(matches!(outcome, SequenceOutcome::Conflicts { .. }), "{outcome:?}");
    exec.assert_done();
}

#[tokio::test]
async fn sequencer_continue_accepts_the_prepared_message() {
    // Continue concludes with a commit whose message git opens an editor for;
    // GIT_EDITOR=true (env outranks config) accepts it unchanged.
    let fake = FakeExecutor::default();
    fake.expect_env(
        &["cherry-pick", "--continue"],
        &[("GIT_EDITOR", "true")],
        ok(""),
    );
    fake.expect_env(&["revert", "--continue"], &[("GIT_EDITOR", "true")], ok(""));
    let (b, exec) = backend(fake);

    assert_eq!(b.cherry_pick_continue().await.unwrap(), SequenceOutcome::Completed);
    assert_eq!(b.revert_continue().await.unwrap(), SequenceOutcome::Completed);
    exec.assert_done();
}

#[tokio::test]
async fn sequencer_skip_and_abort_args() {
    let fake = FakeExecutor::default();
    fake.expect_env(&["cherry-pick", "--skip"], &[("GIT_EDITOR", "true")], ok(""));
    fake.expect(&["cherry-pick", "--abort"], ok(""));
    fake.expect_env(&["revert", "--skip"], &[("GIT_EDITOR", "true")], ok(""));
    fake.expect(&["revert", "--abort"], ok(""));
    let (b, exec) = backend(fake);

    assert_eq!(b.cherry_pick_skip().await.unwrap(), SequenceOutcome::Completed);
    b.cherry_pick_abort().await.unwrap();
    assert_eq!(b.revert_skip().await.unwrap(), SequenceOutcome::Completed);
    b.revert_abort().await.unwrap();
    exec.assert_done();
}

#[tokio::test]
async fn sequencer_empty_result_is_a_paused_outcome() {
    // Resolving a cherry-pick to nothing pauses the sequencer with "the
    // previous cherry-pick is now empty" (exit 1). That is a paused state
    // (skip/abort resolve it), not a hard error.
    let fake = FakeExecutor::default();
    fake.expect_env(
        &["cherry-pick", "--continue"],
        &[("GIT_EDITOR", "true")],
        out(
            1,
            "",
            "The previous cherry-pick is now empty, possibly due to conflict resolution.\nIf you wish to commit it anyway, use:\n\n    git commit --allow-empty",
        ),
    );
    let (b, exec) = backend(fake);

    let outcome = b.cherry_pick_continue().await.unwrap();
    assert!(matches!(outcome, SequenceOutcome::Conflicts { .. }), "{outcome:?}");
    exec.assert_done();
}

// ---------------------------------------------------------------------------
// set_upstream
// ---------------------------------------------------------------------------

#[tokio::test]
async fn set_upstream_uses_set_upstream_to() {
    let fake = FakeExecutor::default();
    fake.expect(
        &["branch", "--set-upstream-to=origin/main", "main"],
        ok("branch 'main' set up to track 'origin/main'."),
    );
    let (b, exec) = backend(fake);

    b.set_upstream("main", Some("origin/main")).await.unwrap();
    exec.assert_done();
}

#[tokio::test]
async fn clear_upstream_uses_unset_upstream() {
    let fake = FakeExecutor::default();
    fake.expect(&["branch", "--unset-upstream", "main"], ok(""));
    let (b, exec) = backend(fake);

    b.set_upstream("main", None).await.unwrap();
    exec.assert_done();
}

// ---------------------------------------------------------------------------
// resolve_take_side - the delete-conflict fallback
// ---------------------------------------------------------------------------

#[tokio::test]
async fn take_side_checks_out_and_stages() {
    let fake = FakeExecutor::default();
    fake.expect(&["checkout", "--ours", "--", "a.txt"], ok(""));
    fake.expect(&["add", "--", "a.txt"], ok(""));
    let (b, exec) = backend(fake);

    b.resolve_take_side(Path::new("a.txt"), ConflictSide::Ours)
        .await
        .unwrap();
    exec.assert_done();
}

#[tokio::test]
async fn take_deleted_side_falls_back_to_git_rm() {
    let fake = FakeExecutor::default();
    fake.expect(
        &["checkout", "--theirs", "--", "a.txt"],
        fail(1, "error: path 'a.txt' does not have their version"),
    );
    fake.expect(&["rm", "-f", "--", "a.txt"], ok("rm 'a.txt'"));
    let (b, exec) = backend(fake);

    b.resolve_take_side(Path::new("a.txt"), ConflictSide::Theirs)
        .await
        .unwrap();
    exec.assert_done();
}

#[tokio::test]
async fn take_side_other_failures_stay_errors() {
    let fake = FakeExecutor::default();
    fake.expect(
        &["checkout", "--ours", "--", "a.txt"],
        fail(128, "fatal: this operation must be run in a work tree"),
    );
    let (b, exec) = backend(fake);

    let err = b
        .resolve_take_side(Path::new("a.txt"), ConflictSide::Ours)
        .await
        .unwrap_err();
    assert!(matches!(err, GitError::CommandFailed { .. }), "{err:?}");
    exec.assert_done();
}

// ---------------------------------------------------------------------------
// discard - tracked/untracked partitioning
// ---------------------------------------------------------------------------

#[tokio::test]
async fn discard_restores_tracked_and_cleans_untracked() {
    let fake = FakeExecutor::default();
    // status: one modified (tracked), one untracked.
    fake.expect(
        &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
        ok(" M tracked.txt\0?? untracked.txt\0"),
    );
    fake.expect(&["restore", "--worktree", "--", "tracked.txt"], ok(""));
    fake.expect(&["clean", "-f", "--", "untracked.txt"], ok(""));
    let (b, exec) = backend(fake);

    b.discard(&[PathBuf::from("tracked.txt"), PathBuf::from("untracked.txt")])
        .await
        .unwrap();
    exec.assert_done();
}
