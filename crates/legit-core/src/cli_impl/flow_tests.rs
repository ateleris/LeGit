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
use crate::types::{BlobBytes, KeyId};
use std::collections::VecDeque;
use std::sync::Mutex;

/// One scripted step: the exact args expected, the env overrides expected
/// (None = a plain run), the stdin expected (None = not asserted), and the
/// output to return.
struct Step {
    args: Vec<String>,
    env: Option<Vec<(String, String)>>,
    stdin: Option<String>,
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
            stdin: None,
            output,
        });
        self
    }

    /// Expect an invocation carrying per-invocation env overrides.
    fn expect_env(&self, args: &[&str], env: &[(&str, &str)], output: RunOutput) -> &Self {
        self.script.lock().unwrap().push_back(Step {
            args: args.iter().map(|s| s.to_string()).collect(),
            env: Some(env.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()),
            stdin: None,
            output,
        });
        self
    }

    /// Expect an invocation fed the given stdin (asserted exactly).
    fn expect_stdin(&self, args: &[&str], stdin: &str, output: RunOutput) -> &Self {
        self.script.lock().unwrap().push_back(Step {
            args: args.iter().map(|s| s.to_string()).collect(),
            env: None,
            stdin: Some(stdin.to_string()),
            output,
        });
        self
    }

    fn next(&self, actual: &[&str], actual_env: Option<&[(&str, &str)]>) -> RunOutput {
        self.next_with_stdin(actual, actual_env, None)
    }

    fn next_with_stdin(
        &self,
        actual: &[&str],
        actual_env: Option<&[(&str, &str)]>,
        actual_stdin: Option<&str>,
    ) -> RunOutput {
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
        // Stdin is asserted only when the step declares an expectation:
        // legacy steps script stdin-fed commands (check-attr, apply) via
        // plain `expect` and keep asserting nothing.
        if step.stdin.is_some() {
            assert_eq!(
                actual_stdin.map(str::to_string),
                step.stdin,
                "git invoked with unexpected stdin"
            );
        }
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
        stdin_data: &str,
    ) -> Result<RunOutput, RunnerError> {
        Ok(self.next_with_stdin(args, None, Some(stdin_data)))
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
    (GitCliBackend::new(lock, Arc::new(crate::fs::LocalFs)), exec)
}

const STASH_PUSH_MSG: &str = "legit: auto-stash before switching to feature";

// ---------------------------------------------------------------------------
// run_with_auto_stash (via switch_branch) - full sequencing
// ---------------------------------------------------------------------------

#[tokio::test]
async fn switch_try_directly_runs_only_the_switch() {
    let fake = FakeExecutor::default();
    fake.expect(&["switch", "--end-of-options", "feature"], ok(""));
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
    fake.expect(&["stash", "list", "--format=%H %s"], ok(""));
    fake.expect(
        &["stash", "push", "--include-untracked", "-m", STASH_PUSH_MSG],
        ok("Saved working directory and index state"),
    );
    fake.expect(
        &["stash", "list", "--format=%H %s"],
        ok(&format!("aaa111 On main: {STASH_PUSH_MSG}\n")),
    );
    fake.expect(&["switch", "--end-of-options", "feature"], ok("Switched to branch 'feature'"));
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
async fn switch_auto_stash_ignores_concurrently_created_foreign_stash() {
    // A stash created by ANOTHER process lands between our push and the list
    // read: it is the tip, ours sits below. The pop must address OUR entry
    // (matched by the marker message), never adopt the foreign tip.
    let fake = FakeExecutor::default();
    fake.expect(&["stash", "list", "--format=%H %s"], ok(""));
    fake.expect(
        &["stash", "push", "--include-untracked", "-m", STASH_PUSH_MSG],
        ok("Saved"),
    );
    fake.expect(
        &["stash", "list", "--format=%H %s"],
        ok(&format!(
            "fff999 On main: WIP from another client\naaa111 On main: {STASH_PUSH_MSG}\n"
        )),
    );
    fake.expect(&["switch", "--end-of-options", "feature"], ok(""));
    fake.expect(
        &["stash", "list", "--format=%H %gd"],
        ok("fff999 stash@{0}\naaa111 stash@{1}\n"),
    );
    fake.expect(&["stash", "pop", "stash@{1}"], ok(""));
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
    fake.expect(
        &["stash", "list", "--format=%H %s"],
        ok("zzz999 On main: WIP on main\n"),
    );
    fake.expect(
        &["stash", "push", "--include-untracked", "-m", STASH_PUSH_MSG],
        ok("No local changes to save"),
    );
    fake.expect(
        &["stash", "list", "--format=%H %s"],
        ok("zzz999 On main: WIP on main\n"),
    );
    fake.expect(&["switch", "--end-of-options", "feature"], ok(""));
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
    fake.expect(&["stash", "list", "--format=%H %s"], ok(""));
    fake.expect(
        &["stash", "push", "--include-untracked", "-m", STASH_PUSH_MSG],
        ok("Saved"),
    );
    fake.expect(
        &["stash", "list", "--format=%H %s"],
        ok(&format!("aaa111 On main: {STASH_PUSH_MSG}\n")),
    );
    fake.expect(
        &["switch", "--end-of-options", "feature"],
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
    fake.expect(&["stash", "list", "--format=%H %s"], ok(""));
    fake.expect(
        &["stash", "push", "--include-untracked", "-m", STASH_PUSH_MSG],
        ok("Saved"),
    );
    fake.expect(
        &["stash", "list", "--format=%H %s"],
        ok(&format!("aaa111 On main: {STASH_PUSH_MSG}\n")),
    );
    fake.expect(
        &["switch", "--end-of-options", "feature"],
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
    fake.expect(&["stash", "list", "--format=%H %s"], ok(""));
    fake.expect(
        &["stash", "push", "--include-untracked", "-m", STASH_PUSH_MSG],
        ok("Saved"),
    );
    fake.expect(
        &["stash", "list", "--format=%H %s"],
        ok(&format!("aaa111 On main: {STASH_PUSH_MSG}\n")),
    );
    fake.expect(&["switch", "--end-of-options", "feature"], ok(""));
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
    fake.expect(&["stash", "list", "--format=%H %s"], ok(""));
    fake.expect(
        &["stash", "push", "--include-untracked", "-m", STASH_PUSH_MSG],
        ok("Saved"),
    );
    fake.expect(
        &["stash", "list", "--format=%H %s"],
        ok(&format!("aaa111 On main: {STASH_PUSH_MSG}\n")),
    );
    fake.expect(&["switch", "--end-of-options", "feature"], ok(""));
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
    fake.expect(&["switch", "--end-of-options", "feature-x"], ok(""));
    let (b, exec) = backend(fake);

    let outcome = b
        .checkout_remote_branch("origin/feature-x", SwitchDirtyBehavior::TryDirectly, false)
        .await
        .unwrap();
    assert_eq!(outcome.switch, SwitchOutcome::Clean);
    assert_eq!(outcome.local_branch, "feature-x");
    // fast_forward = false must never run a merge (the "no network / no
    // surprise mutation" half of the setting) - assert_done pins that the
    // script ended at the switch.
    assert_eq!(outcome.fast_forward, FastForwardResult::NotAttempted);
    exec.assert_done();
}

#[tokio::test]
async fn checkout_remote_branch_tracks_when_no_local_exists() {
    let fake = FakeExecutor::default();
    fake.expect(
        &["rev-parse", "-q", "--verify", "refs/heads/feature-x"],
        fail(1, ""),
    );
    fake.expect(&["switch", "--track", "--end-of-options", "origin/feature-x"], ok(""));
    let (b, exec) = backend(fake);

    let outcome = b
        .checkout_remote_branch("origin/feature-x", SwitchDirtyBehavior::TryDirectly, false)
        .await
        .unwrap();
    assert_eq!(outcome.switch, SwitchOutcome::Clean);
    exec.assert_done();
}

#[tokio::test]
async fn checkout_remote_branch_accepts_full_ref_form() {
    let fake = FakeExecutor::default();
    fake.expect(
        &["rev-parse", "-q", "--verify", "refs/heads/feat/nested"],
        fail(1, ""),
    );
    fake.expect(&["switch", "--track", "--end-of-options", "origin/feat/nested"], ok(""));
    let (b, exec) = backend(fake);

    let outcome = b
        .checkout_remote_branch(
            "refs/remotes/origin/feat/nested",
            SwitchDirtyBehavior::TryDirectly,
            false,
        )
        .await
        .unwrap();
    assert_eq!(outcome.local_branch, "feat/nested");
    exec.assert_done();
}

// ---------------------------------------------------------------------------
// checkout_remote_branch - the fast-forward step ("Fast-forward on remote
// checkout" setting). Must be a LOCAL `merge --ff-only` against the
// remote-tracking ref, never a network pull.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn checkout_remote_branch_fast_forwards_existing_local() {
    let fake = FakeExecutor::default();
    fake.expect(
        &["rev-parse", "-q", "--verify", "refs/heads/feature-x"],
        ok("abc123\n"),
    );
    fake.expect(&["switch", "--end-of-options", "feature-x"], ok(""));
    fake.expect(
        &["merge", "--ff-only", "--no-edit", "--end-of-options", "origin/feature-x"],
        ok("Updating abc123..def456\nFast-forward\n a.txt | 1 +\n"),
    );
    let (b, exec) = backend(fake);

    let outcome = b
        .checkout_remote_branch("origin/feature-x", SwitchDirtyBehavior::TryDirectly, true)
        .await
        .unwrap();
    assert_eq!(outcome.switch, SwitchOutcome::Clean);
    assert_eq!(outcome.fast_forward, FastForwardResult::FastForwarded);
    exec.assert_done();
}

#[tokio::test]
async fn checkout_remote_branch_ff_reports_up_to_date() {
    let fake = FakeExecutor::default();
    fake.expect(
        &["rev-parse", "-q", "--verify", "refs/heads/feature-x"],
        ok("abc123\n"),
    );
    fake.expect(&["switch", "--end-of-options", "feature-x"], ok(""));
    fake.expect(
        &["merge", "--ff-only", "--no-edit", "--end-of-options", "origin/feature-x"],
        ok("Already up to date.\n"),
    );
    let (b, exec) = backend(fake);

    let outcome = b
        .checkout_remote_branch("origin/feature-x", SwitchDirtyBehavior::TryDirectly, true)
        .await
        .unwrap();
    assert_eq!(outcome.fast_forward, FastForwardResult::UpToDate);
    exec.assert_done();
}

#[tokio::test]
async fn checkout_remote_branch_ff_divergence_is_outcome_not_error() {
    let fake = FakeExecutor::default();
    fake.expect(
        &["rev-parse", "-q", "--verify", "refs/heads/feature-x"],
        ok("abc123\n"),
    );
    fake.expect(&["switch", "--end-of-options", "feature-x"], ok(""));
    fake.expect(
        &["merge", "--ff-only", "--no-edit", "--end-of-options", "origin/feature-x"],
        fail(128, "fatal: Not possible to fast-forward, aborting.\n"),
    );
    let (b, exec) = backend(fake);

    let outcome = b
        .checkout_remote_branch("origin/feature-x", SwitchDirtyBehavior::TryDirectly, true)
        .await
        .unwrap();
    assert_eq!(outcome.switch, SwitchOutcome::Clean);
    assert_eq!(outcome.fast_forward, FastForwardResult::Diverged);
    exec.assert_done();
}

#[tokio::test]
async fn checkout_remote_branch_ff_other_failure_is_outcome_with_message() {
    let fake = FakeExecutor::default();
    fake.expect(
        &["rev-parse", "-q", "--verify", "refs/heads/feature-x"],
        ok("abc123\n"),
    );
    fake.expect(&["switch", "--end-of-options", "feature-x"], ok(""));
    fake.expect(
        &["merge", "--ff-only", "--no-edit", "--end-of-options", "origin/feature-x"],
        fail(
            1,
            "error: Your local changes to the following files would be overwritten by merge:\n\ta.txt\n",
        ),
    );
    let (b, exec) = backend(fake);

    let outcome = b
        .checkout_remote_branch("origin/feature-x", SwitchDirtyBehavior::TryDirectly, true)
        .await
        .unwrap();
    assert_eq!(outcome.switch, SwitchOutcome::Clean);
    match outcome.fast_forward {
        FastForwardResult::Failed { message } => {
            assert!(message.contains("would be overwritten"), "{message}");
        }
        other => panic!("expected Failed, got {other:?}"),
    }
    exec.assert_done();
}

#[tokio::test]
async fn checkout_remote_branch_ff_skips_merge_for_new_tracking_branch() {
    // `switch --track` creates the local branch AT the remote tip - a merge
    // afterwards is pointless, so it must NOT run (assert_done pins that).
    let fake = FakeExecutor::default();
    fake.expect(
        &["rev-parse", "-q", "--verify", "refs/heads/feature-x"],
        fail(1, ""),
    );
    fake.expect(&["switch", "--track", "--end-of-options", "origin/feature-x"], ok(""));
    let (b, exec) = backend(fake);

    let outcome = b
        .checkout_remote_branch("origin/feature-x", SwitchDirtyBehavior::TryDirectly, true)
        .await
        .unwrap();
    assert_eq!(outcome.fast_forward, FastForwardResult::UpToDate);
    exec.assert_done();
}

// ---------------------------------------------------------------------------
// gitmodules_consistency - staged .gitmodules vs staged gitlinks
// ---------------------------------------------------------------------------

const RAW_DIFF: [&str; 5] = ["diff", "--cached", "--raw", "-z", "--no-renames"];
const STAGED_GITMODULES: [&str; 6] =
    ["config", "--blob", ":.gitmodules", "-z", "--get-regexp", "^submodule\\."];

#[tokio::test]
async fn gitmodules_check_skips_when_staged_diff_is_irrelevant() {
    // A commit touching neither .gitmodules nor a gitlink must cost exactly
    // one gate diff - assert_done pins that config/ls-files never run.
    let fake = FakeExecutor::default();
    fake.expect(
        &RAW_DIFF,
        ok(":100644 100644 aaa bbb M\0src/main.rs\0"),
    );
    let (b, exec) = backend(fake);

    let findings = b.gitmodules_consistency().await.unwrap();
    assert_eq!(findings, vec![]);
    exec.assert_done();
}

#[tokio::test]
async fn gitmodules_check_flags_orphaned_gitlink() {
    // .gitmodules changed; the staged blob has no sections left (config
    // exits 1) while a gitlink is still staged - the Aug-4 "sure" breakage.
    let fake = FakeExecutor::default();
    fake.expect(&RAW_DIFF, ok(":100644 100644 aaa bbb M\0.gitmodules\0"));
    fake.expect(&STAGED_GITMODULES, fail(1, ""));
    fake.expect(
        &["ls-files", "--stage", "-z"],
        ok("160000 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 0\tsubs/x\0"),
    );
    let (b, exec) = backend(fake);

    let findings = b.gitmodules_consistency().await.unwrap();
    assert_eq!(
        findings,
        vec![GitmodulesFinding::GitlinkWithoutEntry { path: "subs/x".into() }]
    );
    exec.assert_done();
}

#[tokio::test]
async fn gitmodules_check_flags_dangling_entry() {
    let fake = FakeExecutor::default();
    fake.expect(&RAW_DIFF, ok(":100644 100644 aaa bbb M\0.gitmodules\0"));
    fake.expect(
        &STAGED_GITMODULES,
        ok("submodule.lib.path\nvendor/lib\0submodule.lib.url\nhttps://x.invalid/lib.git\0"),
    );
    fake.expect(&["ls-files", "--stage", "-z"], ok(""));
    let (b, exec) = backend(fake);

    let findings = b.gitmodules_consistency().await.unwrap();
    assert_eq!(
        findings,
        vec![GitmodulesFinding::EntryWithoutGitlink {
            name: "lib".into(),
            path: "vendor/lib".into(),
        }]
    );
    exec.assert_done();
}

#[tokio::test]
async fn gitmodules_check_gate_failure_falls_through_to_the_full_check() {
    // The gate diff is an optimization: if it fails (e.g. unborn HEAD on
    // some git versions), the check proceeds rather than erroring or
    // silently skipping.
    let fake = FakeExecutor::default();
    fake.expect(&RAW_DIFF, fail(128, "fatal: bad revision 'HEAD'\n"));
    fake.expect(&STAGED_GITMODULES, fail(1, ""));
    fake.expect(&["ls-files", "--stage", "-z"], ok(""));
    let (b, exec) = backend(fake);

    let findings = b.gitmodules_consistency().await.unwrap();
    assert_eq!(findings, vec![]);
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
    fake.expect(&["stash", "branch", "--end-of-options", "topic", "stash@{1}"], ok(""));
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
        &["stash", "branch", "--end-of-options", "topic", "stash@{0}"],
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
// log - ref selector walks
// ---------------------------------------------------------------------------

#[tokio::test]
async fn log_all_branches_and_remotes_walks_remote_refs_too() {
    let fmt = format!("--format={}", parsers::log::LOG_FORMAT);
    let stash_fmt = format!("--format={}", parsers::stash::STASH_FORMAT);
    let fake = FakeExecutor::default();
    // --date-order is load-bearing: git's DEFAULT order has no
    // parent-after-child guarantee (a parent discovered via another child can
    // win a committer-timestamp tie), which breaks the graph's lane edges -
    // real-git case in tests/git_flows.rs
    // (log_lists_children_before_parents_on_equal_timestamps).
    fake.expect(
        &[
            "log", fmt.as_str(), "--max-count=500", "--date-order", "--decorate=full",
            "--ignore-missing", "HEAD", "--branches", "--remotes",
        ],
        ok(""),
    );
    // The full-graph walk injects stashes afterwards, same as the local-only one.
    fake.expect(&["stash", "list", stash_fmt.as_str()], ok(""));
    let (b, exec) = backend(fake);

    let commits = b
        .log(LogOptions { refs: RefSelector::AllBranchesAndRemotes, ..Default::default() })
        .await
        .unwrap();
    assert!(commits.is_empty());
    exec.assert_done();
}

// ---------------------------------------------------------------------------
// signature_presence - batched pay-per-view scan, never a verifier
// ---------------------------------------------------------------------------

const SIG_SHA_A: &str = "aaaa000011112222333344445555666677778888";
const SIG_SHA_B: &str = "bbbb000011112222333344445555666677778888";

/// One LOG_FORMAT record (11 newline-separated fields + RS terminator).
fn log_record(sha: &str, subject: &str) -> String {
    let ts = "2024-03-15T12:00:00+00:00";
    [sha, "", "Alice", "a@b.com", ts, "Alice", "a@b.com", ts, "", subject, ""].join("\n") + "\x1e"
}

/// One `cat-file --batch` entry for a commit object.
fn batch_commit_entry(sha: &str, signed: bool) -> String {
    let sig = if signed {
        "gpgsig -----BEGIN PGP SIGNATURE-----\n fake\n -----END PGP SIGNATURE-----\n"
    } else {
        ""
    };
    let obj = format!(
        "tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\n\
         author Alice <a@b.com> 1710504000 +0000\n\
         committer Alice <a@b.com> 1710504000 +0000\n\
         {sig}\nSubject\n"
    );
    format!("{sha} commit {}\n{obj}\n", obj.len())
}

fn ids(shas: &[&str]) -> Vec<CommitId> {
    shas.iter().map(|s| CommitId::new(*s)).collect()
}

#[tokio::test]
async fn log_never_scans_signatures() {
    // The list is exactly one subprocess: presence is a separate pay-per-view
    // pass (`signature_presence`), and no verifier may ever run here - the
    // strict FIFO script plus assert_done encodes both.
    let fmt = format!("--format={}", parsers::log::LOG_FORMAT);
    let fake = FakeExecutor::default();
    fake.expect(
        &["log", fmt.as_str(), "--max-count=500", "--date-order", "--decorate=full",
          "--ignore-missing", "HEAD"],
        ok(&log_record(SIG_SHA_A, "some commit")),
    );
    let (b, exec) = backend(fake);

    let commits = b.log(LogOptions::default()).await.unwrap();
    assert_eq!(commits.len(), 1);
    assert!(!commits[0].has_signature, "the list carries no signature data");
    exec.assert_done();
}

#[tokio::test]
async fn signature_presence_scans_with_one_batch_and_no_verifier() {
    let fake = FakeExecutor::default();
    fake.expect(
        &["cat-file", "--batch"],
        ok(&(batch_commit_entry(SIG_SHA_A, true) + &batch_commit_entry(SIG_SHA_B, false))),
    );
    let (b, exec) = backend(fake);

    let signed = b.signature_presence(&ids(&[SIG_SHA_A, SIG_SHA_B])).await.unwrap();
    assert_eq!(signed, ids(&[SIG_SHA_A]), "only the gpgsig-bearing commit is returned");
    exec.assert_done();
}

#[tokio::test]
async fn signature_presence_is_cached_per_sha() {
    // Presence is immutable per SHA: a repeat query answers entirely from the
    // cache (no git call), and a superset query batches only the unseen SHA.
    let fake = FakeExecutor::default();
    fake.expect(&["cat-file", "--batch"], ok(&batch_commit_entry(SIG_SHA_A, true)));
    // Second call introduces SIG_SHA_B: one more batch (for it alone).
    fake.expect(&["cat-file", "--batch"], ok(&batch_commit_entry(SIG_SHA_B, false)));
    let (b, exec) = backend(fake);

    assert_eq!(b.signature_presence(&ids(&[SIG_SHA_A])).await.unwrap(), ids(&[SIG_SHA_A]));
    // Same SHA again: no scripted git call left for it - cache must answer.
    assert_eq!(b.signature_presence(&ids(&[SIG_SHA_A])).await.unwrap(), ids(&[SIG_SHA_A]));
    // Superset: only SIG_SHA_B is unseen.
    assert_eq!(
        b.signature_presence(&ids(&[SIG_SHA_A, SIG_SHA_B])).await.unwrap(),
        ids(&[SIG_SHA_A])
    );
    exec.assert_done();
}

#[tokio::test]
async fn signature_presence_empty_input_makes_no_git_call() {
    let (b, exec) = backend(FakeExecutor::default());
    assert!(b.signature_presence(&[]).await.unwrap().is_empty());
    exec.assert_done();
}

#[tokio::test]
async fn signature_presence_cat_file_failure_is_an_error_and_uncached() {
    // A failure surfaces as an error (react-query handles it) and must not
    // poison the cache: the retry pays the batch again.
    let fake = FakeExecutor::default();
    fake.expect(&["cat-file", "--batch"], fail(128, "fatal: not a git repository"));
    fake.expect(&["cat-file", "--batch"], ok(&batch_commit_entry(SIG_SHA_A, true)));
    let (b, exec) = backend(fake);

    assert!(b.signature_presence(&ids(&[SIG_SHA_A])).await.is_err());
    assert_eq!(b.signature_presence(&ids(&[SIG_SHA_A])).await.unwrap(), ids(&[SIG_SHA_A]));
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
                "--ignore-missing", "HEAD", "--branches", "--decorate=full",
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
        &["log", fmt.as_str(), "--max-count=50", "-S", "needle", "--ignore-missing", "HEAD", "--branches", "--decorate=full"],
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
// Files tree — list_repo_files / rm_cached
// ---------------------------------------------------------------------------

#[tokio::test]
async fn list_repo_files_without_ignored_runs_two_ls_files() {
    // Tracked (--stage, for the gitlink mode) then untracked, and NO ignored
    // query when show_ignored is false.
    let fake = FakeExecutor::default();
    fake.expect(
        &["ls-files", "-z", "--stage"],
        ok("100644 aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111 0\tsrc/main.rs\0"),
    );
    fake.expect(&["ls-files", "-z", "--others", "--exclude-standard"], ok("notes.txt\0"));
    let (b, exec) = backend(fake);

    let files = b.list_repo_files(false).await.unwrap();
    assert_eq!(
        files,
        vec![
            RepoFileEntry { path: PathBuf::from("notes.txt"), kind: RepoFileKind::Untracked, submodule: false },
            RepoFileEntry { path: PathBuf::from("src/main.rs"), kind: RepoFileKind::Tracked, submodule: false },
        ],
    );
    exec.assert_done();
}

#[tokio::test]
async fn list_repo_files_with_ignored_adds_third_ls_files() {
    let fake = FakeExecutor::default();
    fake.expect(
        &["ls-files", "-z", "--stage"],
        ok("100644 aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111 0\ta.txt\0"),
    );
    fake.expect(&["ls-files", "-z", "--others", "--exclude-standard"], ok(""));
    fake.expect(
        &["ls-files", "-z", "--others", "--ignored", "--exclude-standard"],
        ok("target/x\0"),
    );
    let (b, exec) = backend(fake);

    let files = b.list_repo_files(true).await.unwrap();
    assert_eq!(
        files,
        vec![
            RepoFileEntry { path: PathBuf::from("a.txt"), kind: RepoFileKind::Tracked, submodule: false },
            RepoFileEntry { path: PathBuf::from("target/x"), kind: RepoFileKind::Ignored, submodule: false },
        ],
    );
    exec.assert_done();
}

#[tokio::test]
async fn rm_cached_runs_git_rm_cached_with_pathspec() {
    let fake = FakeExecutor::default();
    fake.expect(&["rm", "--cached", "--", "secret.env"], ok(""));
    let (b, exec) = backend(fake);

    b.rm_cached(&[PathBuf::from("secret.env")]).await.unwrap();
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
        &["diff-tree", "--no-commit-id", "-r", "-M", "-z", "--raw", "--end-of-options", "main", "feature"],
        ok(":100644 100644 aaaaaaa bbbbbbb M\0a.txt\0:000000 100644 0000000 bbbbbbb A\0b.txt\0"),
    );
    fake.expect(
        &["diff-tree", "--no-commit-id", "-r", "-M", "-z", "--numstat", "--end-of-options", "main", "feature"],
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
        &["-c", "diff.submodule=short", "diff", "--no-color", "--no-ext-diff", "-U3", "--end-of-options", "main", "feature", "--", "a.txt"],
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

#[tokio::test]
async fn file_diff_untracked_probe_failure_is_an_error_not_untracked() {
    // A failing `ls-files` also has empty stdout - that must surface as the
    // failure it is, NOT read as "path is untracked" (which would silently
    // fall through to `diff --no-index`). Encoded per the house rule that
    // exit-code assumptions live in tests.
    let fake = FakeExecutor::default();
    fake.expect(
        &["-c", "diff.submodule=short", "diff", "--no-color", "--no-ext-diff", "-U3", "--", "a.txt"],
        ok(""),
    );
    fake.expect(&["ls-files", "-z", "--", "a.txt"], fail(128, "fatal: not a git repository"));
    let (b, exec) = backend(fake);

    let res = b
        .file_diff(&DiffSource::WorkingUnstaged, Path::new("a.txt"), None, 3)
        .await;
    assert!(
        matches!(res, Err(GitError::CommandFailed { exit_code: 128, .. })),
        "expected CommandFailed, got {res:?}"
    );
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
async fn interactive_rebase_verifies_the_range_then_injects_the_todo() {
    // The plan is checked against `rev-list --parents base..HEAD` FIRST -
    // the injected todo fully replaces git's own, and any range commit
    // missing from it would be silently dropped. Then, no temp script: the
    // sequence editor is `printf '<todo>' >`, which sh completes with the
    // todo path git appends — the plan is written straight into git's own
    // todo file. GIT_EDITOR=true accepts squash messages.
    let fake = FakeExecutor::default();
    fake.expect(
        &["rev-list", "--parents", "base123..HEAD"],
        ok("ccc333 bbb222\nbbb222 aaa111\naaa111 base123\n"),
    );
    fake.expect_env(
        &["rebase", "-i", "--autostash", "--end-of-options", "base123"],
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
        RebaseStep::new(RebaseAction::Pick, "aaa111"),
        RebaseStep::new(RebaseAction::Drop, "bbb222"),
        RebaseStep::new(RebaseAction::Squash, "ccc333"),
    ];
    let outcome = b.rebase_interactive("base123", &plan).await.unwrap();
    assert_eq!(outcome, RebaseOutcome::Completed);
    exec.assert_done();
}

#[tokio::test]
async fn interactive_rebase_refuses_a_plan_that_does_not_cover_the_range() {
    // A stale plan (a commit landed after it was built) or a truncated one
    // (UI listing cap) must be refused BEFORE `git rebase` runs - the todo
    // overwrite would silently drop the unlisted commit. assert_done proves
    // no rebase was attempted.
    let fake = FakeExecutor::default();
    fake.expect(
        &["rev-list", "--parents", "base123..HEAD"],
        // ccc333 exists in the range but not in the plan.
        ok("ccc333 bbb222\nbbb222 aaa111\naaa111 base123\n"),
    );
    let (b, exec) = backend(fake);

    let plan = vec![
        RebaseStep::new(RebaseAction::Pick, "aaa111"),
        RebaseStep::new(RebaseAction::Pick, "bbb222"),
    ];
    assert!(b.rebase_interactive("base123", &plan).await.is_err());
    exec.assert_done();
}

#[tokio::test]
async fn interactive_rebase_refuses_a_range_containing_a_merge() {
    // `pick <merge>` stops the rebase mid-flight ("is a merge but no -m
    // option was given") in a state plain continue re-hits - refuse up
    // front, before any git mutation.
    let fake = FakeExecutor::default();
    fake.expect(
        &["rev-list", "--parents", "base123..HEAD"],
        // bbb222 has two parents: a merge commit.
        ok("bbb222 aaa111 fff666\naaa111 base123\n"),
    );
    let (b, exec) = backend(fake);

    let plan = vec![
        RebaseStep::new(RebaseAction::Pick, "aaa111"),
        RebaseStep::new(RebaseAction::Pick, "bbb222"),
    ];
    assert!(b.rebase_interactive("base123", &plan).await.is_err());
    exec.assert_done();
}

#[tokio::test]
async fn interactive_rebase_rejects_bad_plans_without_running_git() {
    let (b, exec) = backend(FakeExecutor::default());

    // Empty plan.
    assert!(b.rebase_interactive("base", &[]).await.is_err());
    // First kept step cannot meld into a predecessor.
    let squash_first = vec![RebaseStep::new(RebaseAction::Squash, "aaa111")];
    assert!(b.rebase_interactive("base", &squash_first).await.is_err());
    // Drops before a leading squash don't provide a predecessor either.
    let drop_then_squash = vec![
        RebaseStep::new(RebaseAction::Drop, "aaa111"),
        RebaseStep::new(RebaseAction::Fixup, "bbb222"),
    ];
    assert!(b.rebase_interactive("base", &drop_then_squash).await.is_err());
    // A non-hex sha must never reach the shell-interpreted editor string.
    let bad_sha = vec![RebaseStep::new(RebaseAction::Pick, "abc'; rm -rf")];
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
        &["revert", "--no-edit", "--end-of-options", "abc123"],
        ok("[main 1a2b3c] Revert \"x\""),
    );
    let (b, exec) = backend(fake);

    let outcome = b.revert(&["abc123".into()], None).await.unwrap();
    assert_eq!(outcome, SequenceOutcome::Completed);
    exec.assert_done();
}

#[tokio::test]
async fn revert_of_a_merge_passes_the_mainline_parent() {
    let fake = FakeExecutor::default();
    fake.expect(
        &["revert", "--no-edit", "-m", "1", "--end-of-options", "abc123"],
        ok("[main 1a2b3c] Revert \"merge x\""),
    );
    let (b, exec) = backend(fake);

    let outcome = b.revert(&["abc123".into()], Some(1)).await.unwrap();
    assert_eq!(outcome, SequenceOutcome::Completed);
    exec.assert_done();
}

#[tokio::test]
async fn cherry_pick_of_a_merge_passes_the_mainline_parent() {
    let fake = FakeExecutor::default();
    fake.expect(&["cherry-pick", "-m", "2", "--end-of-options", "def456"], ok(""));
    let (b, exec) = backend(fake);

    let outcome = b.cherry_pick(&["def456".into()], Some(2)).await.unwrap();
    assert_eq!(outcome, SequenceOutcome::Completed);
    exec.assert_done();
}

#[tokio::test]
async fn cherry_pick_of_multiple_commits_is_one_invocation_in_the_given_order() {
    // Bulk cherry-pick must be ONE git invocation with the shas in the
    // caller's order (oldest first): git's sequencer then owns mid-set
    // conflicts, so continue/skip/abort apply unchanged. Per-sha invocations
    // would fail after the first conflict.
    let fake = FakeExecutor::default();
    fake.expect(
        &["cherry-pick", "--end-of-options", "aaa111", "bbb222", "ccc333"],
        ok(""),
    );
    let (b, exec) = backend(fake);

    let shas = vec!["aaa111".to_string(), "bbb222".to_string(), "ccc333".to_string()];
    let outcome = b.cherry_pick(&shas, None).await.unwrap();
    assert_eq!(outcome, SequenceOutcome::Completed);
    exec.assert_done();
}

#[tokio::test]
async fn revert_of_multiple_commits_is_one_invocation_in_the_given_order() {
    // Same single-invocation rule as bulk cherry-pick; callers order
    // newest-first so each revert unwinds on top of the previous one.
    let fake = FakeExecutor::default();
    fake.expect(
        &["revert", "--no-edit", "--end-of-options", "ccc333", "bbb222"],
        ok(""),
    );
    let (b, exec) = backend(fake);

    let shas = vec!["ccc333".to_string(), "bbb222".to_string()];
    let outcome = b.revert(&shas, None).await.unwrap();
    assert_eq!(outcome, SequenceOutcome::Completed);
    exec.assert_done();
}

#[tokio::test]
async fn cherry_pick_conflict_is_an_outcome_not_an_error() {
    let fake = FakeExecutor::default();
    fake.expect(
        &["cherry-pick", "--end-of-options", "def456"],
        out(
            1,
            "Auto-merging a.txt\nCONFLICT (content): Merge conflict in a.txt",
            "error: could not apply def456... feature change\nhint: After resolving the conflicts, mark them with \"git add\"",
        ),
    );
    let (b, exec) = backend(fake);

    let outcome = b.cherry_pick(&["def456".into()], None).await.unwrap();
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
        &["branch", "--set-upstream-to=origin/main", "--end-of-options", "main"],
        ok("branch 'main' set up to track 'origin/main'."),
    );
    let (b, exec) = backend(fake);

    b.set_upstream("main", Some("origin/main")).await.unwrap();
    exec.assert_done();
}

#[tokio::test]
async fn clear_upstream_uses_unset_upstream() {
    let fake = FakeExecutor::default();
    fake.expect(&["branch", "--unset-upstream", "--end-of-options", "main"], ok(""));
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
        &["status", "--porcelain=v2", "-z", "--untracked-files=all"],
        ok("1 .M N... 100644 100644 100644 aaaaaaa bbbbbbb tracked.txt\0? untracked.txt\0"),
    );
    fake.expect(&["restore", "--worktree", "--", "tracked.txt"], ok(""));
    fake.expect(&["clean", "-f", "--", "untracked.txt"], ok(""));
    let (b, exec) = backend(fake);

    b.discard(&[PathBuf::from("tracked.txt"), PathBuf::from("untracked.txt")])
        .await
        .unwrap();
    exec.assert_done();
}

// ---------------------------------------------------------------------------
// status - numstat count enrichment
// ---------------------------------------------------------------------------

#[tokio::test]
async fn status_enriches_entries_with_numstat_counts() {
    let fake = FakeExecutor::default();
    fake.expect(
        &["status", "--porcelain=v2", "-z", "--untracked-files=all"],
        ok("1 MM N... 100644 100644 100644 aaaaaaa bbbbbbb file.rs\0? new.txt\0"),
    );
    // Staged (index vs HEAD) first, then unstaged (worktree vs index).
    fake.expect(&["diff", "--numstat", "-M", "-z", "--cached"], ok("3\t1\tfile.rs\0"));
    fake.expect(&["diff", "--numstat", "-M", "-z"], ok("2\t0\tfile.rs\0"));
    let (b, exec) = backend(fake);

    let statuses = b.status().await.unwrap();
    assert_eq!(statuses.len(), 3);
    assert!(statuses[0].staged);
    assert_eq!((statuses[0].additions, statuses[0].deletions), (Some(3), Some(1)));
    assert!(!statuses[1].staged);
    assert_eq!((statuses[1].additions, statuses[1].deletions), (Some(2), Some(0)));
    // Untracked: no counts, ever.
    assert_eq!((statuses[2].additions, statuses[2].deletions), (None, None));
    exec.assert_done();
}

#[tokio::test]
async fn status_skips_numstat_for_an_all_untracked_tree() {
    // No countable entry -> neither diff may run (assert_done catches extras).
    let fake = FakeExecutor::default();
    fake.expect(
        &["status", "--porcelain=v2", "-z", "--untracked-files=all"],
        ok("? a.txt\0? b.txt\0"),
    );
    let (b, exec) = backend(fake);

    let statuses = b.status().await.unwrap();
    assert_eq!(statuses.len(), 2);
    exec.assert_done();
}

#[tokio::test]
async fn status_survives_a_failing_numstat() {
    // Counts are cosmetic: a failing diff degrades to None, never an error.
    let fake = FakeExecutor::default();
    fake.expect(
        &["status", "--porcelain=v2", "-z", "--untracked-files=all"],
        // Mode/hash tokens are positional filler the parser skips; the zeroed
        // HEAD-side values mirror real git output for a path absent from HEAD.
        ok("1 A. N... 000000 100644 100644 0000000 bbbbbbb new.txt\0"),
    );
    fake.expect(
        &["diff", "--numstat", "-M", "-z", "--cached"],
        fail(129, "fatal: bad revision"),
    );
    let (b, exec) = backend(fake);

    let statuses = b.status().await.unwrap();
    assert_eq!(statuses.len(), 1);
    assert_eq!(statuses[0].additions, None);
    assert_eq!(statuses[0].deletions, None);
    exec.assert_done();
}

// ---------------------------------------------------------------------------
// file_at_revision - binary classification (NUL sniff) + size lookup
// ---------------------------------------------------------------------------

#[tokio::test]
async fn file_at_revision_returns_text_without_a_size_lookup() {
    let fake = FakeExecutor::default();
    fake.expect(&["show", "--end-of-options", "abc123:src/main.rs"], ok("fn main() {}\n"));
    let (b, exec) = backend(fake);

    let content = b
        .file_at_revision("abc123", Path::new("src/main.rs"))
        .await
        .unwrap();
    assert_eq!(content, FileAtRevision::Text("fn main() {}\n".to_string()));
    // No `cat-file -s` for text content.
    exec.assert_done();
}

#[tokio::test]
async fn file_at_revision_classifies_binary_and_reports_the_blob_size() {
    let fake = FakeExecutor::default();
    // NUL in the content marks it binary (git's own heuristic)...
    fake.expect(&["show", "--end-of-options", "abc123:logo.png"], ok("\u{89}PNG\0\u{1a}junk"));
    // ...which triggers exactly one exact-size lookup.
    fake.expect(&["cat-file", "-s", "abc123:logo.png"], ok("51234\n"));
    let (b, exec) = backend(fake);

    let content = b
        .file_at_revision("abc123", Path::new("logo.png"))
        .await
        .unwrap();
    assert_eq!(content, FileAtRevision::Binary { size_bytes: 51234 });
    exec.assert_done();
}

/// The sniff only inspects the leading bytes (like git): a NUL later in a
/// huge text file must not flip it to binary, and the check must not scan
/// the whole blob. Mirrors `is_binary_content`'s 8000-byte window.
#[test]
fn binary_sniff_checks_only_the_leading_window() {
    assert!(is_binary_content("abc\0def"));
    assert!(!is_binary_content("plain text\n"));
    let mut long_text = "x".repeat(9000);
    long_text.push('\0');
    assert!(!is_binary_content(&long_text));
}

// ---------------------------------------------------------------------------
// file_history - exact argument vector (--follow / --name-status / paging)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn file_history_runs_follow_name_status_with_paging() {
    let fake = FakeExecutor::default();
    fake.expect(
        &[
            "log",
            "--follow",
            "-M",
            "--name-status",
            "--format=%x1e%H%n%an%n%at%n%s",
            "--max-count=200",
            "--skip=0",
            "--",
            "src/a.rs",
        ],
        ok("\x1eaaa\nAlice\n1783288808\nmodify\n\nM\tsrc/a.rs\n"),
    );
    let (b, exec) = backend(fake);

    let entries = b.file_history(Path::new("src/a.rs"), 200, 0, None).await.unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].commit_id.as_str(), "aaa");
    assert_eq!(entries[0].path, "src/a.rs");
    exec.assert_done();
}

#[tokio::test]
async fn file_history_with_start_rev_walks_from_that_rev() {
    let fake = FakeExecutor::default();
    fake.expect(
        &[
            "log",
            "--follow",
            "-M",
            "--name-status",
            "--format=%x1e%H%n%an%n%at%n%s",
            "--max-count=200",
            "--skip=0",
            "abc123",
            "--",
            "src/a.rs",
        ],
        ok("\x1eaaa\nAlice\n1783288808\nmodify\n\nM\tsrc/a.rs\n"),
    );
    let (b, exec) = backend(fake);

    let entries = b
        .file_history(Path::new("src/a.rs"), 200, 0, Some("abc123"))
        .await
        .unwrap();
    assert_eq!(entries.len(), 1);
    exec.assert_done();
}

// ---------------------------------------------------------------------------
// submodules - enumeration orchestration
// ---------------------------------------------------------------------------

#[tokio::test]
async fn submodules_without_gitlinks_runs_only_ls_files() {
    // A repo without submodules answers from the index listing alone: the
    // config `--get-regexp` reads (which exit 1 on "no matches" and used to
    // land as failed calls in the Git Log on every derived refetch) and the
    // status read must not run - assert_done encodes that.
    let sha_a = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let fake = FakeExecutor::default();
    fake.expect(
        &["ls-files", "--stage", "-z"],
        ok(&format!("100644 {sha_a} 0\tREADME.md\0100644 {sha_a} 0\tsrc/main.rs\0")),
    );
    let (b, exec) = backend(fake);

    assert!(b.submodules().await.unwrap().is_empty());
    exec.assert_done();
}

#[tokio::test]
async fn submodules_enumerates_without_git_submodule_status() {
    let sha_a = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let fake = FakeExecutor::default();
    fake.expect(
        &["ls-files", "--stage", "-z"],
        ok(&format!("100644 {sha_a} 0\tREADME.md\0160000 {sha_a} 0\tlib\0")),
    );
    fake.expect(
        &["config", "-f", ".gitmodules", "-z", "--get-regexp", "^submodule\\."],
        ok("submodule.lib.path\nlib\0submodule.lib.url\nhttps://x.invalid/lib.git\0"),
    );
    fake.expect(
        &["config", "-z", "--get-regexp", "^submodule\\."],
        ok("submodule.lib.url\nhttps://x.invalid/lib.git\0submodule.lib.active\ntrue\0"),
    );
    fake.expect(
        &["status", "--porcelain=v2", "-z", "--untracked-files=all"],
        ok("1 .M S.M. 160000 160000 160000 aaaaaaa aaaaaaa lib\0"),
    );
    fake.expect(
        &["-C", "lib", "rev-parse", "--show-prefix", "HEAD"],
        ok(&format!("\n{sha_a}\n")),
    );
    fake.expect(&["-C", "lib", "rev-parse", "--abbrev-ref", "HEAD"], ok("HEAD\n"));
    let (b, exec) = backend(fake);

    let subs = b.submodules().await.unwrap();
    assert_eq!(subs.len(), 1);
    let s = &subs[0];
    assert_eq!(s.name, "lib");
    assert!(s.state.initialized && s.state.populated && s.state.dirty_tracked);
    assert!(!s.state.pointer_moved);
    assert_eq!(s.head_branch, None, "abbrev-ref HEAD means detached");
    // assert_done proves no `git submodule status` / describe ever ran.
    exec.assert_done();
}

#[tokio::test]
async fn submodules_survives_missing_gitmodules_and_failed_probe() {
    let sha_a = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let fake = FakeExecutor::default();
    fake.expect(
        &["ls-files", "--stage", "-z"],
        ok(&format!("160000 {sha_a} 0\tlib\0")),
    );
    // No .gitmodules: git config exits 1 - must degrade to empty, not error.
    fake.expect(
        &["config", "-f", ".gitmodules", "-z", "--get-regexp", "^submodule\\."],
        fail(1, ""),
    );
    fake.expect(&["config", "-z", "--get-regexp", "^submodule\\."], fail(1, ""));
    fake.expect(
        &["status", "--porcelain=v2", "-z", "--untracked-files=all"],
        ok(""),
    );
    // Unpopulated empty dir: git walks up into the superproject and reports
    // a non-empty prefix - the probe must classify that as unpopulated (and
    // must NOT go on to ask for the branch).
    fake.expect(
        &["-C", "lib", "rev-parse", "--show-prefix", "HEAD"],
        ok("lib/\ncccccccccccccccccccccccccccccccccccccccc\n"),
    );
    let (b, exec) = backend(fake);

    let subs = b.submodules().await.unwrap();
    assert_eq!(subs.len(), 1);
    assert!(subs[0].state.orphan_gitlink);
    assert!(!subs[0].state.populated);
    exec.assert_done();
}

#[tokio::test]
async fn submodule_log_lists_range_and_flags_missing_target() {
    let sha_a = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let sha_b = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    let fake = FakeExecutor::default();
    // Target present: existence probe, then the range log.
    fake.expect(&["-C", "lib", "cat-file", "-e", &format!("{sha_b}^{{commit}}")], ok(""));
    fake.expect(
        &["-C", "lib", "log", "--format=%H%x00%s%x00", "--max-count=100", &format!("{sha_a}..{sha_b}")],
        ok(&format!("{sha_b}\0bump\0")),
    );
    // Target missing: the probe fails, no log runs.
    fake.expect(
        &["-C", "lib", "cat-file", "-e", &format!("{sha_b}^{{commit}}")],
        fail(128, "fatal: Not a valid object name"),
    );
    let (b, exec) = backend(fake);

    let log = b
        .submodule_log(Path::new("lib"), Some(&CommitId::new(sha_a)), &CommitId::new(sha_b))
        .await
        .unwrap();
    let SubmoduleLog::Commits { commits } = log else { panic!("{log:?}") };
    assert_eq!(commits.len(), 1);
    assert_eq!(commits[0].subject, "bump");

    let log = b
        .submodule_log(Path::new("lib"), Some(&CommitId::new(sha_a)), &CommitId::new(sha_b))
        .await
        .unwrap();
    assert!(matches!(log, SubmoduleLog::TargetMissing));
    exec.assert_done();
}

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
            attach_branch: false,
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

#[tokio::test]
async fn submodule_sync_fetch_build_expected_argv() {
    let fake = FakeExecutor::default();
    fake.expect(&["submodule", "sync", "--recursive", "--", "lib"], ok(""));
    fake.expect(&["-C", "lib", "fetch"], ok(""));
    let (b, exec) = backend(fake);

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

#[tokio::test]
async fn discard_resets_submodule_pointers_via_submodule_update() {
    let fake = FakeExecutor::default();
    // status: a moved submodule pointer, a modified file, an untracked file.
    fake.expect(
        &["status", "--porcelain=v2", "-z", "--untracked-files=all"],
        ok("1 .M SC.. 160000 160000 160000 aaaaaaa bbbbbbb lib\01 .M N... 100644 100644 100644 aaaaaaa bbbbbbb tracked.txt\0? untracked.txt\0"),
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

#[tokio::test]
async fn submodule_update_remote_integrates_then_stages_pointers() {
    let sha_a = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let fake = FakeExecutor::default();
    // -- submodules() enumeration: one clean, initialized submodule --
    fake.expect(&["ls-files", "--stage", "-z"], ok(&format!("160000 {sha_a} 0\tlib\0")));
    fake.expect(
        &["config", "-f", ".gitmodules", "-z", "--get-regexp", "^submodule\\."],
        ok("submodule.lib.path\nlib\0submodule.lib.url\nu\0"),
    );
    fake.expect(&["config", "-z", "--get-regexp", "^submodule\\."], ok("submodule.lib.url\nu\0"));
    fake.expect(&["status", "--porcelain=v2", "-z", "--untracked-files=all"], ok(""));
    fake.expect(&["-C", "lib", "rev-parse", "--show-prefix", "HEAD"], ok(&format!("\n{sha_a}\n")));
    fake.expect(&["-C", "lib", "rev-parse", "--abbrev-ref", "HEAD"], ok("main\n"));
    // -- clean: per-path remote move with the strategy flag, then stage --
    fake.expect(&["submodule", "update", "--remote", "--rebase", "--", "lib"], ok(""));
    fake.expect(&["add", "--", "lib"], ok(""));
    let (b, exec) = backend(fake);

    let results = b
        .submodule_update_remote(
            &[PathBuf::from("lib")],
            SubmoduleUpdateStrategy::Rebase,
            SwitchDirtyBehavior::AutoStash,
            false,
            OperationId("a".into()),
        )
        .await
        .unwrap();
    assert_eq!(results.len(), 1);
    assert!(matches!(results[0].status, SubmoduleAutoUpdateStatus::Updated), "{results:?}");
    exec.assert_done();
}

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

// ---------------------------------------------------------------------------
// submodule move - preflight + git mv sequencing
// ---------------------------------------------------------------------------

#[tokio::test]
async fn submodule_move_creates_parents_then_runs_git_mv() {
    let root = tempfile::tempdir().unwrap();
    let root_str = root.path().to_string_lossy().into_owned();
    let fake = FakeExecutor::default();
    fake.expect(&["rev-parse", "--show-toplevel"], ok(&format!("{root_str}\n")));
    fake.expect(&["mv", "--", "lib", "vendor/lib"], ok(""));
    let (b, exec) = backend(fake);

    b.submodule_move(Path::new("lib"), Path::new("vendor/lib")).await.unwrap();
    // The missing parent was created for git mv.
    assert!(root.path().join("vendor").is_dir());
    exec.assert_done();
}

#[tokio::test]
async fn submodule_move_refuses_occupied_target_and_escaping_paths() {
    let root = tempfile::tempdir().unwrap();
    std::fs::create_dir(root.path().join("vendor")).unwrap();
    std::fs::write(root.path().join("vendor/lib"), b"occupied").unwrap();
    let root_str = root.path().to_string_lossy().into_owned();
    let fake = FakeExecutor::default();
    // Occupied target: the root lookup runs, `mv` never does.
    fake.expect(&["rev-parse", "--show-toplevel"], ok(&format!("{root_str}\n")));
    let (b, exec) = backend(fake);

    let err = b.submodule_move(Path::new("lib"), Path::new("vendor/lib")).await.unwrap_err();
    assert!(err.to_string().contains("already exists"), "{err:?}");
    // Path escape: refused before ANY git command (assert_done proves it).
    let err = b.submodule_move(Path::new("lib"), Path::new("../outside")).await.unwrap_err();
    assert!(matches!(err, GitError::Internal(_)), "{err:?}");
    exec.assert_done();
}

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
    // -- auto-stash (marker-matched list-diff verified) --
    fake.expect(&["-C", "lib", "stash", "list", "--format=%H %s"], ok(""));
    fake.expect(
        &["-C", "lib", "stash", "push", "--include-untracked", "-m", "legit: auto-stash before submodule update"],
        ok("Saved"),
    );
    fake.expect(
        &["-C", "lib", "stash", "list", "--format=%H %s"],
        ok(&format!("{stash} On main: legit: auto-stash before submodule update\n")),
    );
    // -- update to recorded, pop by SHA-resolved selector: CONFLICT --
    fake.expect(&["submodule", "update", "--", "lib"], ok(""));
    fake.expect(&["-C", "lib", "stash", "list", "--format=%H %gd"], ok(&format!("{stash} stash@{{0}}\n")));
    fake.expect(&["-C", "lib", "stash", "pop", "stash@{0}"], fail(1, "CONFLICT (content): merge conflict"));
    // -- ROLLBACK: hard-reset to old (stash survived the pop), pop cleanly --
    fake.expect(&["-C", "lib", "reset", "--hard", old], ok(""));
    fake.expect(&["-C", "lib", "stash", "list", "--format=%H %gd"], ok(&format!("{stash} stash@{{0}}\n")));
    fake.expect(&["-C", "lib", "stash", "pop", "stash@{0}"], ok("Dropped"));
    let (b, exec) = backend(fake);

    let results = b.submodule_auto_update(SwitchDirtyBehavior::AutoStash, false).await.unwrap();
    assert_eq!(results.len(), 1);
    assert!(
        matches!(results[0].status, SubmoduleAutoUpdateStatus::RolledBack { .. }),
        "{results:?}"
    );
    // assert_done: no bare `stash pop`, no second update, nothing after the
    // clean reapply.
    exec.assert_done();
}

#[tokio::test]
async fn submodule_auto_update_failed_before_stash_list_read_skips() {
    // Regression: a failed BEFORE-push `stash list` used to read as an empty
    // list, so a leftover marker entry from an earlier crash could be adopted
    // as "ours" and popped. The update must abort loudly instead: Skipped,
    // and neither the stash push nor the move may run.
    let rec = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let old = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    let fake = FakeExecutor::default();
    // -- submodules() enumeration: pointer moved, dirty tracked --
    fake.expect(&["ls-files", "--stage", "-z"], ok(&format!("160000 {rec} 0\tlib\0")));
    fake.expect(
        &["config", "-f", ".gitmodules", "-z", "--get-regexp", "^submodule\\."],
        ok("submodule.lib.path\nlib\0submodule.lib.url\nu\0"),
    );
    fake.expect(&["config", "-z", "--get-regexp", "^submodule\\."], ok("submodule.lib.url\nu\0"));
    fake.expect(
        &["status", "--porcelain=v2", "-z", "--untracked-files=all"],
        ok("1 .M SCM. 160000 160000 160000 aaaaaaa bbbbbbb lib\0"),
    );
    fake.expect(&["-C", "lib", "rev-parse", "--show-prefix", "HEAD"], ok(&format!("\n{old}\n")));
    fake.expect(&["-C", "lib", "rev-parse", "--abbrev-ref", "HEAD"], ok("HEAD\n"));
    // -- the BEFORE stash-list read fails --
    fake.expect(
        &["-C", "lib", "stash", "list", "--format=%H %s"],
        fail(128, "fatal: unable to read the stash reflog"),
    );
    // assert_done proves no `stash push` and no `submodule update` ran.
    let (b, exec) = backend(fake);

    let results = b.submodule_auto_update(SwitchDirtyBehavior::AutoStash, false).await.unwrap();
    assert_eq!(results.len(), 1);
    let SubmoduleAutoUpdateStatus::Skipped { message } = &results[0].status else {
        panic!("expected Skipped, got {results:?}");
    };
    assert!(message.contains("stash list"), "{message}");
    assert!(message.contains("left untouched"), "{message}");
    exec.assert_done();
}

#[tokio::test]
async fn submodule_auto_update_failed_after_stash_list_read_is_loud() {
    // Regression: a failed AFTER-push `stash list` used to read as an empty
    // list, so `find_created_stash` saw nothing, the clean-tree branch moved
    // the submodule, and a plain Updated hid that the user's changes sat in
    // the submodule's stash. The outcome must be LOUD (ChangesInStash) and
    // the submodule must NOT move.
    let rec = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let old = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    let fake = FakeExecutor::default();
    // -- submodules() enumeration: pointer moved, dirty tracked --
    fake.expect(&["ls-files", "--stage", "-z"], ok(&format!("160000 {rec} 0\tlib\0")));
    fake.expect(
        &["config", "-f", ".gitmodules", "-z", "--get-regexp", "^submodule\\."],
        ok("submodule.lib.path\nlib\0submodule.lib.url\nu\0"),
    );
    fake.expect(&["config", "-z", "--get-regexp", "^submodule\\."], ok("submodule.lib.url\nu\0"));
    fake.expect(
        &["status", "--porcelain=v2", "-z", "--untracked-files=all"],
        ok("1 .M SCM. 160000 160000 160000 aaaaaaa bbbbbbb lib\0"),
    );
    fake.expect(&["-C", "lib", "rev-parse", "--show-prefix", "HEAD"], ok(&format!("\n{old}\n")));
    fake.expect(&["-C", "lib", "rev-parse", "--abbrev-ref", "HEAD"], ok("HEAD\n"));
    // -- auto-stash: before-list ok, push ok, AFTER-list read fails --
    fake.expect(&["-C", "lib", "stash", "list", "--format=%H %s"], ok(""));
    fake.expect(
        &["-C", "lib", "stash", "push", "--include-untracked", "-m", "legit: auto-stash before submodule update"],
        ok("Saved"),
    );
    fake.expect(
        &["-C", "lib", "stash", "list", "--format=%H %s"],
        fail(128, "fatal: unable to read the stash reflog"),
    );
    // assert_done proves no `submodule update` (no silent Updated) and no pop.
    let (b, exec) = backend(fake);

    let results = b.submodule_auto_update(SwitchDirtyBehavior::AutoStash, false).await.unwrap();
    assert_eq!(results.len(), 1);
    let SubmoduleAutoUpdateStatus::ChangesInStash { message } = &results[0].status else {
        panic!("expected ChangesInStash, got {results:?}");
    };
    assert!(message.contains("may have been auto-stashed"), "{message}");
    assert!(message.contains("stash list"), "{message}");
    exec.assert_done();
}

// ---------------------------------------------------------------------------
// submodule branch attach - opt-in re-attach after updates
// ---------------------------------------------------------------------------

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

#[tokio::test]
async fn submodule_create_branch_switches_with_c() {
    let fake = FakeExecutor::default();
    fake.expect(&["-C", "lib", "switch", "-c", "fix/detached"], ok(""));
    let (b, exec) = backend(fake);
    b.submodule_create_branch(Path::new("lib"), "fix/detached").await.unwrap();
    exec.assert_done();
}

// ---------------------------------------------------------------------------
// conflict reopen + staged-marker check
// ---------------------------------------------------------------------------

#[tokio::test]
async fn conflict_reopen_unresolves_then_regenerates_markers() {
    let fake = FakeExecutor::default();
    fake.expect(&["update-index", "--unresolve", "--", "a.txt"], ok(""));
    fake.expect(&["checkout", "-m", "--", "a.txt"], ok(""));
    let (b, exec) = backend(fake);

    b.conflict_reopen(Path::new("a.txt")).await.unwrap();
    exec.assert_done();
}

#[tokio::test]
async fn conflict_reopen_unresolve_failure_stops_before_checkout() {
    let fake = FakeExecutor::default();
    fake.expect(
        &["update-index", "--unresolve", "--", "a.txt"],
        fail(1, "fatal: no resolve-undo information"),
    );
    let (b, exec) = backend(fake);

    let err = b.conflict_reopen(Path::new("a.txt")).await.unwrap_err();
    assert!(matches!(err, GitError::CommandFailed { .. }), "{err:?}");
    // assert_done: checkout -m must NOT run when the unresolve failed.
    exec.assert_done();
}

#[tokio::test]
async fn conflict_reopen_checkout_failure_reports_partial_state() {
    let fake = FakeExecutor::default();
    fake.expect(&["update-index", "--unresolve", "--", "a.txt"], ok(""));
    fake.expect(
        &["checkout", "-m", "--", "a.txt"],
        fail(128, "fatal: unable to write file"),
    );
    let (b, exec) = backend(fake);

    let err = b.conflict_reopen(Path::new("a.txt")).await.unwrap_err();
    // The user must learn both facts: primary failure + the restored stages.
    let GitError::CommandFailed { stderr, .. } = &err else {
        panic!("expected CommandFailed, got {err:?}");
    };
    assert!(stderr.contains("unable to write file"), "{stderr}");
    assert!(stderr.contains("conflict stages for 'a.txt' were restored"), "{stderr}");
    exec.assert_done();
}

#[tokio::test]
async fn staged_marker_paths_exit_2_is_findings_not_error() {
    let fake = FakeExecutor::default();
    fake.expect(
        &["diff", "--cached", "--check"],
        out(2, "a.txt:2: trailing whitespace.\na.txt:4: leftover conflict marker\n", ""),
    );
    let (b, exec) = backend(fake);

    assert_eq!(b.staged_marker_paths().await.unwrap(), vec!["a.txt"]);
    exec.assert_done();
}

#[tokio::test]
async fn staged_marker_paths_clean_exit_is_empty() {
    let fake = FakeExecutor::default();
    fake.expect(&["diff", "--cached", "--check"], ok(""));
    let (b, exec) = backend(fake);

    assert_eq!(b.staged_marker_paths().await.unwrap(), Vec::<String>::new());
    exec.assert_done();
}

#[tokio::test]
async fn resolve_undo_paths_lists_recorded_paths() {
    let fake = FakeExecutor::default();
    let sha = "0123456789abcdef0123456789abcdef01234567";
    fake.expect(
        &["ls-files", "--resolve-undo", "-z"],
        ok(&format!("100644 {sha} 1\ta.txt\0100644 {sha} 2\ta.txt\0100644 {sha} 3\ta.txt\0")),
    );
    let (b, exec) = backend(fake);

    assert_eq!(b.resolve_undo_paths().await.unwrap(), vec!["a.txt"]);
    exec.assert_done();
}

#[tokio::test]
async fn unstaged_marker_paths_checks_the_worktree_side() {
    let fake = FakeExecutor::default();
    fake.expect(
        &["diff", "--check"],
        out(2, "a.txt:1: leftover conflict marker\n", ""),
    );
    let (b, exec) = backend(fake);

    assert_eq!(b.unstaged_marker_paths().await.unwrap(), vec!["a.txt"]);
    exec.assert_done();
}

// ---------------------------------------------------------------------------
// create_stash_paths - pathspec stash with tip-compare outcome
// ---------------------------------------------------------------------------

#[tokio::test]
async fn stash_paths_isolates_the_index_around_the_push() {
    // The full dance: save the index (write-tree), reset it to HEAD so the
    // pathspec push cannot embed other files' staged changes in the stash,
    // push, restore the index, and reset the stashed paths' index entries.
    let stash = "cccccccccccccccccccccccccccccccccccccccc";
    let tree = "dddddddddddddddddddddddddddddddddddddddd";
    let fake = FakeExecutor::default();
    fake.expect(&["rev-parse", "-q", "--verify", "refs/stash"], fail(1, ""));
    fake.expect(&["write-tree"], ok(&format!("{tree}\n")));
    fake.expect(&["read-tree", "HEAD"], ok(""));
    fake.expect(&["stash", "push", "--include-untracked", "--", "a.txt", "b.txt"], ok("Saved"));
    fake.expect(&["read-tree", tree], ok(""));
    fake.expect(&["rev-parse", "-q", "--verify", "refs/stash"], ok(&format!("{stash}\n")));
    fake.expect(&["reset", "-q", "--", "a.txt", "b.txt"], ok(""));
    let (b, exec) = backend(fake);

    let outcome = b
        .create_stash_paths(None, &[PathBuf::from("a.txt"), PathBuf::from("b.txt")])
        .await
        .unwrap();
    assert_eq!(outcome, StashOutcome::Created);
    exec.assert_done();
}

#[tokio::test]
async fn stash_paths_clean_pathspec_is_nothing_to_stash() {
    let stash = "cccccccccccccccccccccccccccccccccccccccc";
    let tree = "dddddddddddddddddddddddddddddddddddddddd";
    let fake = FakeExecutor::default();
    fake.expect(&["rev-parse", "-q", "--verify", "refs/stash"], ok(&format!("{stash}\n")));
    fake.expect(&["write-tree"], ok(&format!("{tree}\n")));
    fake.expect(&["read-tree", "HEAD"], ok(""));
    // Exit 0 with "No local changes to save" - the tip not moving is the
    // only reliable signal that nothing was stashed.
    fake.expect(
        &["stash", "push", "--include-untracked", "-m", "msg", "--", "a.txt"],
        ok("No local changes to save\n"),
    );
    fake.expect(&["read-tree", tree], ok(""));
    fake.expect(&["rev-parse", "-q", "--verify", "refs/stash"], ok(&format!("{stash}\n")));
    let (b, exec) = backend(fake);

    let outcome = b
        .create_stash_paths(Some("msg"), &[PathBuf::from("a.txt")])
        .await
        .unwrap();
    assert_eq!(outcome, StashOutcome::NothingToStash);
    // assert_done: NO trailing `reset` - nothing was stashed, so the
    // restored index is already correct.
    exec.assert_done();
}

#[tokio::test]
async fn stash_paths_push_failure_still_restores_the_index() {
    let tree = "dddddddddddddddddddddddddddddddddddddddd";
    let fake = FakeExecutor::default();
    fake.expect(&["rev-parse", "-q", "--verify", "refs/stash"], fail(1, ""));
    fake.expect(&["write-tree"], ok(&format!("{tree}\n")));
    fake.expect(&["read-tree", "HEAD"], ok(""));
    fake.expect(
        &["stash", "push", "--include-untracked", "--", "a.txt"],
        fail(1, "error: pathspec did not match"),
    );
    // The saved index is restored even though the push failed.
    fake.expect(&["read-tree", tree], ok(""));
    let (b, exec) = backend(fake);

    let err = b
        .create_stash_paths(None, &[PathBuf::from("a.txt")])
        .await
        .unwrap_err();
    assert!(matches!(err, GitError::CommandFailed { .. }), "{err:?}");
    exec.assert_done();
}

// ---------------------------------------------------------------------------
// restore_file_at_revision - stash-untracked fallback
// ---------------------------------------------------------------------------

#[tokio::test]
async fn restore_file_present_in_rev_checks_out_directly() {
    let fake = FakeExecutor::default();
    fake.expect(&["rev-parse", "-q", "--verify", "abc123:a.txt"], ok("blobsha\n"));
    fake.expect(&["checkout", "abc123", "--", "a.txt"], ok(""));
    let (b, exec) = backend(fake);

    b.restore_file_at_revision("abc123", Path::new("a.txt")).await.unwrap();
    exec.assert_done();
}

#[tokio::test]
async fn restore_stash_untracked_file_falls_back_to_the_third_parent() {
    // A file stashed from untracked state lives only in stash^3; the restore
    // must detect the miss and check out from the untracked parent instead.
    let stash = "cccccccccccccccccccccccccccccccccccccccc";
    let base = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let index = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    let untracked = "dddddddddddddddddddddddddddddddddddddddd";
    let fake = FakeExecutor::default();
    fake.expect(&["rev-parse", "-q", "--verify", &format!("{stash}:new.txt")], fail(1, ""));
    fake.expect(
        &["rev-list", "--parents", "-n", "1", stash],
        ok(&format!("{stash} {base} {index} {untracked}\n")),
    );
    fake.expect(&["stash", "list", "--format=%H"], ok(&format!("{stash}\n")));
    fake.expect(
        &["rev-parse", "-q", "--verify", &format!("{untracked}:new.txt")],
        ok("blobsha\n"),
    );
    fake.expect(&["checkout", untracked, "--", "new.txt"], ok(""));
    let (b, exec) = backend(fake);

    b.restore_file_at_revision(stash, Path::new("new.txt")).await.unwrap();
    exec.assert_done();
}

#[tokio::test]
async fn apply_stash_file_restores_worktree_only() {
    // Per-file stash apply matches whole-stash apply: unstaged, so
    // `restore --source --worktree`, never a checkout (which would stage).
    let stash = "cccccccccccccccccccccccccccccccccccccccc";
    let fake = FakeExecutor::default();
    fake.expect(&["rev-parse", "-q", "--verify", &format!("{stash}:a.txt")], ok("blobsha\n"));
    fake.expect(
        &["restore", &format!("--source={stash}"), "--worktree", "--", "a.txt"],
        ok(""),
    );
    let (b, exec) = backend(fake);

    b.apply_stash_file(stash, Path::new("a.txt")).await.unwrap();
    exec.assert_done();
}

#[tokio::test]
async fn apply_stash_file_untracked_falls_back_to_the_third_parent() {
    let stash = "cccccccccccccccccccccccccccccccccccccccc";
    let base = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let index = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    let untracked = "dddddddddddddddddddddddddddddddddddddddd";
    let fake = FakeExecutor::default();
    fake.expect(&["rev-parse", "-q", "--verify", &format!("{stash}:new.txt")], fail(1, ""));
    fake.expect(
        &["rev-list", "--parents", "-n", "1", stash],
        ok(&format!("{stash} {base} {index} {untracked}\n")),
    );
    fake.expect(&["stash", "list", "--format=%H"], ok(&format!("{stash}\n")));
    fake.expect(
        &["rev-parse", "-q", "--verify", &format!("{untracked}:new.txt")],
        ok("blobsha\n"),
    );
    fake.expect(
        &["restore", &format!("--source={untracked}"), "--worktree", "--", "new.txt"],
        ok(""),
    );
    let (b, exec) = backend(fake);

    b.apply_stash_file(stash, Path::new("new.txt")).await.unwrap();
    exec.assert_done();
}

// ---------------------------------------------------------------------------
// branch / tag / remote management — exact-argv contracts for the mutating
// (and partly destructive) commands that previously had no flow coverage
// ---------------------------------------------------------------------------

#[tokio::test]
async fn create_branch_with_and_without_start_point() {
    let fake = FakeExecutor::default();
    fake.expect(&["branch", "--end-of-options", "feat"], ok(""));
    fake.expect(&["branch", "--end-of-options", "hotfix", "v1.2"], ok(""));
    let (b, exec) = backend(fake);

    b.create_branch("feat", None).await.unwrap();
    b.create_branch("hotfix", Some("v1.2")).await.unwrap();
    exec.assert_done();
}

#[tokio::test]
async fn delete_branch_safe_vs_force_flag() {
    // -d refuses unmerged branches; -D is the destructive override. The two
    // must never swap.
    let fake = FakeExecutor::default();
    fake.expect(&["branch", "-d", "--end-of-options", "merged"], ok(""));
    fake.expect(&["branch", "-D", "--end-of-options", "wip"], ok(""));
    let (b, exec) = backend(fake);

    b.delete_branch("merged", false).await.unwrap();
    b.delete_branch("wip", true).await.unwrap();
    exec.assert_done();
}

#[tokio::test]
async fn delete_branch_failure_surfaces_stderr() {
    let fake = FakeExecutor::default();
    fake.expect(
        &["branch", "-d", "--end-of-options", "feat"],
        fail(1, "error: the branch 'feat' is not fully merged"),
    );
    let (b, exec) = backend(fake);

    let err = b.delete_branch("feat", false).await.unwrap_err();
    assert!(
        matches!(&err, GitError::CommandFailed { stderr, .. } if stderr.contains("not fully merged")),
        "{err:?}"
    );
    exec.assert_done();
}

#[tokio::test]
async fn rename_branch_uses_move_not_copy() {
    let fake = FakeExecutor::default();
    fake.expect(&["branch", "-m", "--end-of-options", "old", "new"], ok(""));
    let (b, exec) = backend(fake);

    b.rename_branch("old", "new").await.unwrap();
    exec.assert_done();
}

#[tokio::test]
async fn checkout_commit_detaches_via_switch() {
    let fake = FakeExecutor::default();
    fake.expect(&["switch", "--detach", "--end-of-options", "abc123"], ok(""));
    let (b, exec) = backend(fake);

    let outcome = b
        .checkout_commit("abc123", SwitchDirtyBehavior::TryDirectly)
        .await
        .unwrap();
    assert_eq!(outcome, SwitchOutcome::Clean);
    exec.assert_done();
}

#[tokio::test]
async fn create_tag_lightweight_vs_annotated() {
    let fake = FakeExecutor::default();
    fake.expect(&["tag", "--end-of-options", "v1", "abc123"], ok(""));
    fake.expect(
        &["tag", "-a", "-m", "release two", "--end-of-options", "v2", "def456"],
        ok(""),
    );
    let (b, exec) = backend(fake);

    b.create_tag("v1", Some("abc123"), None).await.unwrap();
    b.create_tag("v2", Some("def456"), Some("release two")).await.unwrap();
    exec.assert_done();
}

#[tokio::test]
async fn delete_tag_is_local_only() {
    let fake = FakeExecutor::default();
    fake.expect(&["tag", "-d", "--end-of-options", "v1"], ok(""));
    let (b, exec) = backend(fake);

    b.delete_tag("v1").await.unwrap();
    exec.assert_done();
}

#[tokio::test]
async fn push_tag_uses_the_full_refspec() {
    // `refs/tags/` avoids ambiguity with a same-named branch.
    let fake = FakeExecutor::default();
    fake.expect(&["push", "origin", "refs/tags/v1"], ok(""));
    let (b, exec) = backend(fake);

    b.push_tag("origin", "v1", OperationId("op".into())).await.unwrap();
    exec.assert_done();
}

#[tokio::test]
async fn delete_remote_tag_pushes_a_delete_refspec() {
    let fake = FakeExecutor::default();
    fake.expect(&["push", "origin", "--delete", "refs/tags/v1"], ok(""));
    let (b, exec) = backend(fake);

    b.delete_remote_tag("origin", "v1", OperationId("op".into()))
        .await
        .unwrap();
    exec.assert_done();
}

#[tokio::test]
async fn remote_management_argv_contracts() {
    let fake = FakeExecutor::default();
    fake.expect(&["remote", "add", "upstream", "https://x.invalid/r.git"], ok(""));
    fake.expect(&["remote", "rename", "upstream", "mirror"], ok(""));
    fake.expect(&["remote", "set-url", "mirror", "https://y.invalid/r.git"], ok(""));
    fake.expect(
        &["remote", "set-url", "--push", "mirror", "ssh://y.invalid/r.git"],
        ok(""),
    );
    fake.expect(&["remote", "remove", "mirror"], ok(""));
    let (b, exec) = backend(fake);

    b.add_remote("upstream", "https://x.invalid/r.git").await.unwrap();
    b.rename_remote("upstream", "mirror").await.unwrap();
    b.set_remote_url("mirror", "https://y.invalid/r.git", false).await.unwrap();
    b.set_remote_url("mirror", "ssh://y.invalid/r.git", true).await.unwrap();
    b.remove_remote("mirror").await.unwrap();
    exec.assert_done();
}

// ---------------------------------------------------------------------------
// fetch / pull / merge — full command sequences (previously only arg-builder
// units + real-git coverage)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn fetch_suppresses_auto_maintenance_and_shows_progress() {
    let fake = FakeExecutor::default();
    fake.expect(
        &["-c", "gc.auto=0", "-c", "maintenance.auto=false", "fetch", "--progress", "origin"],
        ok(""),
    );
    let (b, exec) = backend(fake);

    b.fetch(
        FetchOptions { all: false, prune: false, remote: Some("origin".into()) },
        OperationId("op".into()),
    )
    .await
    .unwrap();
    exec.assert_done();
}

#[tokio::test]
async fn pull_default_lets_repo_config_decide() {
    let fake = FakeExecutor::default();
    fake.expect(
        &["-c", "gc.auto=0", "-c", "maintenance.auto=false", "pull", "--progress"],
        ok(""),
    );
    let (b, exec) = backend(fake);

    b.pull(PullOptions { strategy: PullStrategy::Default }, OperationId("op".into()))
        .await
        .unwrap();
    exec.assert_done();
}

#[tokio::test]
async fn merge_ff_auto_passes_no_edit_and_classifies_clean() {
    // --no-edit: the runner's hardened GIT_EDITOR=false would otherwise fail
    // a merge-commit merge.
    let fake = FakeExecutor::default();
    fake.expect(
        &["merge", "--no-edit", "--end-of-options", "feature"],
        ok("Merge made by the 'ort' strategy."),
    );
    let (b, exec) = backend(fake);

    let outcome = b
        .merge("feature", MergeOptions { ff: FfMode::Auto, squash: false })
        .await
        .unwrap();
    assert_eq!(outcome, MergeOutcome::Merged);
    exec.assert_done();
}

#[tokio::test]
async fn renormalize_preview_runs_entirely_on_a_temp_index() {
    // Every step that could mutate an index carries GIT_INDEX_FILE pointing
    // at the throwaway copy - the sequence proves the real index is never
    // touched.
    const TMP: &str = ".git/index.legit-renormalize-preview";
    let fake = FakeExecutor::default();
    fake.expect(&["write-tree"], ok("TREESHA\n"));
    fake.expect(&["rev-parse", "--git-path", "index"], ok(".git/index\n"));
    fake.expect_env(&["read-tree", "TREESHA"], &[("GIT_INDEX_FILE", TMP)], ok(""));
    fake.expect_env(
        &["add", "--renormalize", "--", "."],
        &[("GIT_INDEX_FILE", TMP)],
        ok(""),
    );
    fake.expect_env(
        &["diff-index", "--cached", "--name-only", "-z", "TREESHA"],
        &[("GIT_INDEX_FILE", TMP)],
        ok("a.txt\0b c.txt\0"),
    );
    let (backend, fake) = backend(fake);
    let files = backend.renormalize_preview().await.unwrap();
    assert_eq!(files, vec!["a.txt".to_string(), "b c.txt".to_string()]);
    fake.assert_done();
}

#[tokio::test]
async fn renormalize_brackets_the_add_with_write_tree_and_diff_index() {
    let fake = FakeExecutor::default();
    fake.expect(&["write-tree"], ok("TREESHA\n"));
    fake.expect(&["add", "--renormalize", "--", "."], ok(""));
    fake.expect(
        &["diff-index", "--cached", "--name-only", "-z", "TREESHA"],
        ok("a.txt\0"),
    );
    let (backend, fake) = backend(fake);
    let outcome = backend.renormalize().await.unwrap();
    assert_eq!(outcome.restaged, vec!["a.txt".to_string()]);
    fake.assert_done();
}

#[tokio::test]
async fn renormalize_add_failure_propagates_as_error() {
    let fake = FakeExecutor::default();
    fake.expect(&["write-tree"], ok("TREESHA\n"));
    fake.expect(
        &["add", "--renormalize", "--", "."],
        fail(128, "fatal: unable to write index"),
    );
    let (backend, fake) = backend(fake);
    assert!(backend.renormalize().await.is_err());
    fake.assert_done();
}

// ---------------------------------------------------------------------------
// LFS probes (spec: 2026-08-17-lfs-detection-warning-design.md)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn lfs_status_short_circuits_when_repo_does_not_use_lfs() {
    let fake = FakeExecutor::default();
    // git grep exits 1 for "no hits" - an answer, not a failure.
    fake.expect(
        &["grep", "-l", "-e", "filter=lfs", "--", ":(glob)**/.gitattributes"],
        fail(1, ""),
    );
    let (backend, fake) = backend(fake);
    let status = backend.lfs_status().await.expect("lfs_status");
    assert!(!status.uses_lfs);
    assert!(!status.installed);
    assert_eq!(status.version, None);
    assert!(!status.initialized);
    // assert_done proves no `lfs version` / `config` probe ran.
    fake.assert_done();
}

#[tokio::test]
async fn lfs_status_probes_binary_and_config_when_lfs_used() {
    let fake = FakeExecutor::default();
    fake.expect(
        &["grep", "-l", "-e", "filter=lfs", "--", ":(glob)**/.gitattributes"],
        ok("assets/.gitattributes\n"),
    );
    fake.expect(
        &["lfs", "version"],
        ok("git-lfs/3.4.1 (GitHub; linux amd64; go 1.21.8)\n"),
    );
    fake.expect(
        &["config", "--get", "filter.lfs.smudge"],
        ok("git-lfs smudge -- %f\n"),
    );
    let (backend, fake) = backend(fake);
    let status = backend.lfs_status().await.expect("lfs_status");
    assert!(status.uses_lfs);
    assert!(status.installed);
    assert_eq!(
        status.version.as_deref(),
        Some("git-lfs/3.4.1 (GitHub; linux amd64; go 1.21.8)")
    );
    assert!(status.initialized);
    fake.assert_done();
}

#[tokio::test]
async fn lfs_status_reports_missing_binary_as_status_not_error() {
    let fake = FakeExecutor::default();
    fake.expect(
        &["grep", "-l", "-e", "filter=lfs", "--", ":(glob)**/.gitattributes"],
        ok(".gitattributes\n"),
    );
    // "git: 'lfs' is not a git command" - exit 1, and that IS the answer.
    fake.expect(
        &["lfs", "version"],
        fail(1, "git: 'lfs' is not a git command. See 'git --help'.\n"),
    );
    fake.expect(&["config", "--get", "filter.lfs.smudge"], fail(1, ""));
    let (backend, fake) = backend(fake);
    let status = backend.lfs_status().await.expect("must not error");
    assert!(status.uses_lfs);
    assert!(!status.installed);
    assert_eq!(status.version, None);
    assert!(!status.initialized);
    fake.assert_done();
}

#[tokio::test]
async fn lfs_tracked_subset_filters_by_check_attr_and_keeps_input_order() {
    let fake = FakeExecutor::default();
    fake.expect(
        &["check-attr", "-z", "--stdin", "filter"],
        ok("a.png\0filter\0lfs\0b.txt\0filter\0unspecified\0z.bin\0filter\0lfs\0"),
    );
    let (backend, fake) = backend(fake);
    let subset = backend
        .lfs_tracked_subset(&["a.png".into(), "b.txt".into(), "z.bin".into()])
        .await
        .expect("subset");
    assert_eq!(subset, vec!["a.png".to_string(), "z.bin".to_string()]);
    fake.assert_done();
}

#[tokio::test]
async fn lfs_tracked_subset_skips_git_entirely_for_no_paths() {
    let (backend, fake) = backend(FakeExecutor::default());
    let subset = backend.lfs_tracked_subset(&[]).await.expect("subset");
    assert!(subset.is_empty());
    fake.assert_done();
}

// ---------------------------------------------------------------------------
// blob_bytes - byte framing, cap, and missing classification
// ---------------------------------------------------------------------------

#[tokio::test]
async fn blob_bytes_parses_found_capped_and_missing() {
    // Found, within cap: exact bytes back.
    let script = FakeExecutor::default();
    script.expect_stdin(
        &["cat-file", "--batch"],
        "HEAD:img.png\n",
        ok("abc123 blob 4\nPNG!\n"),
    );
    let (b, exec) = backend(script);
    assert_eq!(
        b.blob_bytes("HEAD:img.png", 100).await.unwrap(),
        BlobBytes::Bytes(b"PNG!".to_vec())
    );
    exec.assert_done();

    // Found, over cap: size reported, bytes withheld.
    let script = FakeExecutor::default();
    script.expect_stdin(&["cat-file", "--batch"], "HEAD:img.png\n", ok("abc123 blob 4\nPNG!\n"));
    let (b, exec) = backend(script);
    assert_eq!(b.blob_bytes("HEAD:img.png", 3).await.unwrap(), BlobBytes::TooLarge { size: 4 });
    exec.assert_done();

    // Unresolvable spec: cat-file exits 0 and reports "missing" on stdout.
    let script = FakeExecutor::default();
    script.expect_stdin(&["cat-file", "--batch"], "HEAD:gone.png\n", ok("HEAD:gone.png missing\n"));
    let (b, exec) = backend(script);
    assert_eq!(b.blob_bytes("HEAD:gone.png", 100).await.unwrap(), BlobBytes::Missing);
    exec.assert_done();
}

// ---------------------------------------------------------------------------
// interactive rebase - reword via carrier commits + fixup -C
// ---------------------------------------------------------------------------

#[tokio::test]
async fn interactive_rebase_reword_creates_carrier_and_expands_todo() {
    let fake = FakeExecutor::default();
    // 1. Coverage check (unchanged).
    fake.expect(
        &["rev-list", "--parents", "abc..HEAD"],
        ok("2222 1111\n1111 abc\n"),
    );
    // 2. Author of the reworded commit.
    fake.expect(
        &["log", "-1", "--format=%an%x00%ae%x00%aD", "2222"],
        ok("Ada\0ada@example.com\0Mon, 1 Jan 2024 10:00:00 +0100\n"),
    );
    // 3. Carrier: same tree, parent = original, message as plain argv,
    //    author preserved via env.
    fake.expect_env(
        &["commit-tree", "2222^{tree}", "-p", "2222", "-m", "new subject\n\nnew body"],
        &[
            ("GIT_AUTHOR_NAME", "Ada"),
            ("GIT_AUTHOR_EMAIL", "ada@example.com"),
            ("GIT_AUTHOR_DATE", "Mon, 1 Jan 2024 10:00:00 +0100"),
        ],
        ok("cccc\n"),
    );
    // 4. The rebase itself, todo carrying the fixup -C line.
    fake.expect_env(
        &["rebase", "-i", "--autostash", "--end-of-options", "abc"],
        &[
            (
                "GIT_SEQUENCE_EDITOR",
                "printf 'pick 1111\\npick 2222\\nfixup -C cccc\\n' >",
            ),
            ("GIT_EDITOR", "true"),
        ],
        ok("Successfully rebased and updated refs/heads/main."),
    );
    let (b, exec) = backend(fake);
    let plan = [
        RebaseStep::new(RebaseAction::Pick, "1111"),
        RebaseStep::reword("2222", "new subject\n\nnew body"),
    ];
    let outcome = b.rebase_interactive("abc", &plan).await.expect("rebase");
    assert!(matches!(outcome, RebaseOutcome::Completed));
    exec.assert_done();
}

#[tokio::test]
async fn interactive_rebase_runs_nothing_on_a_blank_reword_message() {
    let (b, exec) = backend(FakeExecutor::default());
    let plan = [RebaseStep::reword("1111", "   ")];
    assert!(b.rebase_interactive("abc", &plan).await.is_err());
    exec.assert_done(); // not even the rev-list ran
}

#[tokio::test]
async fn interactive_rebase_creates_no_carrier_when_coverage_fails() {
    let fake = FakeExecutor::default();
    fake.expect(&["rev-list", "--parents", "abc..HEAD"], ok("1111 abc\n"));
    let (b, exec) = backend(fake);
    // Plan claims a commit the range does not have: refused BEFORE any
    // commit-tree runs.
    let plan = [RebaseStep::reword("9999", "msg")];
    assert!(b.rebase_interactive("abc", &plan).await.is_err());
    exec.assert_done();
}

// ---------------------------------------------------------------------------
// rebase_range_info - pushed set + ancestry probes
// ---------------------------------------------------------------------------

#[tokio::test]
async fn rebase_range_info_reads_unpushed_and_ancestry() {
    let fake = FakeExecutor::default();
    fake.expect(&["rev-list", "abc..HEAD", "--not", "@{upstream}"], ok("1111\n2222\n"));
    fake.expect(&["merge-base", "--is-ancestor", "--end-of-options", "abc", "HEAD"], ok(""));
    let (b, exec) = backend(fake);
    let info = b.rebase_range_info("abc").await.expect("info");
    assert_eq!(info.unpushed, Some(vec!["1111".into(), "2222".into()]));
    assert!(!info.transplant);
    exec.assert_done();
}

#[tokio::test]
async fn rebase_range_info_handles_no_upstream_and_transplant() {
    let fake = FakeExecutor::default();
    // exit 128: no upstream configured - an answer, not an error.
    fake.expect(
        &["rev-list", "abc..HEAD", "--not", "@{upstream}"],
        fail(128, "fatal: no upstream configured for branch 'main'"),
    );
    // exit 1: base is NOT an ancestor - transplant.
    fake.expect(&["merge-base", "--is-ancestor", "--end-of-options", "abc", "HEAD"], out(1, "", ""));
    let (b, exec) = backend(fake);
    let info = b.rebase_range_info("abc").await.expect("info");
    assert_eq!(info.unpushed, None);
    assert!(info.transplant);
    exec.assert_done();
}

// ---------------------------------------------------------------------------
// Option-like ref names (argument injection)
// ---------------------------------------------------------------------------

/// A ref name that begins with `-` must be refused BEFORE the first git
/// invocation: the script below is empty, so any call at all fails the test.
///
/// Such a name is not user typo territory, it arrives with the repository:
/// `git update-ref 'refs/tags/--exec=cmd'` succeeds, `git clone` copies that
/// tag verbatim, and a remote whose `HEAD` points at `refs/heads/--exec=cmd`
/// makes clone CREATE and check out a local branch with that name. Git parses
/// a positional argument starting with `-` as an OPTION, and `git rebase
/// --autostash --exec=<cmd>` runs `<cmd>` - so before this guard, one click
/// on "Rebase onto" in the ref's own context menu was arbitrary command
/// execution. Real-git counterpart:
/// `tests/git_flows.rs::option_like_ref_never_reaches_rebase_exec`.
#[tokio::test]
async fn option_like_refs_are_refused_before_git_runs() {
    let evil = "--exec=git$IFStag$IFSLEGIT_PWNED";
    let fake = FakeExecutor::default();
    let (b, exec) = backend(fake);

    macro_rules! assert_refused {
        ($call:expr, $what:literal) => {
            match $call.await {
                Err(GitError::UnsafeArgument(msg)) => {
                    assert!(msg.contains(evil), "{}: message must name the value: {msg}", $what)
                }
                other => panic!("{} accepted an option-like ref: {other:?}", $what),
            }
        };
    }

    assert_refused!(b.rebase(evil), "rebase");
    assert_refused!(
        b.merge(evil, MergeOptions { ff: FfMode::Auto, squash: false }),
        "merge"
    );
    assert_refused!(
        b.switch_branch(evil, SwitchDirtyBehavior::TryDirectly),
        "switch_branch"
    );
    assert_refused!(
        b.checkout_commit(evil, SwitchDirtyBehavior::TryDirectly),
        "checkout_commit"
    );
    assert_refused!(b.checkout_remote_branch(evil, SwitchDirtyBehavior::TryDirectly, false), "checkout_remote_branch");
    assert_refused!(b.create_branch(evil, None), "create_branch");
    assert_refused!(b.create_branch("ok", Some(evil)), "create_branch start point");
    assert_refused!(b.delete_branch(evil, false), "delete_branch");
    assert_refused!(b.rename_branch(evil, "ok"), "rename_branch");
    assert_refused!(b.delete_tag(evil), "delete_tag");
    assert_refused!(b.reset(evil, ResetMode::Hard), "reset");
    assert_refused!(b.cherry_pick(&[evil.to_string()], None), "cherry_pick");
    assert_refused!(b.revert(&[evil.to_string()], None), "revert");
    assert_refused!(b.set_upstream(evil, None), "set_upstream");
    assert_refused!(b.rebase_interactive(evil, &[]), "rebase_interactive");

    // Read-only commands too: `git log`/`diff` accept `--output=<file>`, so an
    // option-like rev there is an arbitrary FILE WRITE rather than a bad walk.
    assert_refused!(b.merge_base(evil, "HEAD"), "merge_base");
    assert_refused!(b.diff_files(evil, "HEAD"), "diff_files");
    assert_refused!(b.list_files_at_revision(evil), "list_files_at_revision");
    assert_refused!(
        b.file_at_revision(evil, std::path::Path::new("a.txt")),
        "file_at_revision"
    );
    assert_refused!(
        b.blame(std::path::Path::new("a.txt"), Some(evil)),
        "blame"
    );
    assert_refused!(
        b.log(LogOptions {
            max_count: Some(10),
            skip: None,
            revision_range: Some(evil.to_string()),
            paths: Vec::new(),
            refs: RefSelector::Head,
            author: None,
            include_stashes: false,
        }),
        "log revision_range"
    );

    // Nothing ran: the script was never touched.
    exec.assert_done();
}

/// The second, independent layer: the argv builders pass `--end-of-options`,
/// so even a name the guard somehow let through cannot be parsed as an
/// option. `reset` and `checkout <rev> -- <path>` are the two commands that
/// REJECT `--end-of-options`, which is exactly why the guard above exists as
/// its own layer rather than as belt-and-braces.
#[tokio::test]
async fn ref_taking_commands_pass_end_of_options() {
    for args in [
        rebase_args("main"),
        merge_args("dev", MergeOptions { ff: FfMode::Auto, squash: false }),
        sequencer_args(&["cherry-pick"], None, &["abc123".to_string()]).unwrap(),
        sequencer_args(&["revert", "--no-edit"], Some(2), &["abc123".to_string()]).unwrap(),
    ] {
        let pos = args.iter().position(|a| a == "--end-of-options");
        let pos = pos.unwrap_or_else(|| panic!("no --end-of-options in {args:?}"));
        assert_eq!(pos, args.len() - 2, "the guard must be the LAST option: {args:?}");
    }
    let tag = build_tag_args("v1", Some("abc123"), Some("release"));
    let pos = tag.iter().position(|a| *a == "--end-of-options").expect("tag guard");
    assert_eq!(tag[pos + 1], "v1", "the tag NAME must follow the guard: {tag:?}");
}
