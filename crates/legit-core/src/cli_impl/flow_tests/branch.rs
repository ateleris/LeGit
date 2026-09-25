use super::*;

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
    assert_eq!(outcome.outcome, SwitchOutcome::Clean);
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
    assert_eq!(outcome.outcome, SwitchOutcome::Clean);
    exec.assert_done();
}

#[tokio::test]
async fn switch_auto_stash_unverifiable_push_stops_and_says_where_the_changes_may_be() {
    // The push ran, but the stash list cannot be read to find our entry: the
    // changes may already sit in the stash while the tree looks clean. The
    // switch must not run, and the error must say so (never just the list
    // failure).
    let fake = FakeExecutor::default();
    fake.expect(&["stash", "list", "--format=%H %s"], ok(""));
    fake.expect(
        &["stash", "push", "--include-untracked", "-m", STASH_PUSH_MSG],
        ok("Saved working directory and index state"),
    );
    fake.expect(&["stash", "list", "--format=%H %s"], fail(128, "fatal: index.lock exists"));
    let (b, exec) = backend(fake);

    let err = b
        .switch_branch("feature", SwitchDirtyBehavior::AutoStash)
        .await
        .unwrap_err()
        .to_string();
    assert!(err.contains("index.lock exists"), "{err}");
    assert!(err.contains("may have been auto-stashed"), "{err}");
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
    assert_eq!(outcome.outcome, SwitchOutcome::Clean);
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
    assert_eq!(outcome.outcome, SwitchOutcome::Clean);
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
    assert_eq!(outcome.outcome, SwitchOutcome::ChangesStashed);
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
    assert!(matches!(outcome.outcome, SwitchOutcome::StashPopConflicts { .. }), "{outcome:?}");
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
