use super::*;

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
// interactive rebase - todo injection via GIT_SEQUENCE_EDITOR
// ---------------------------------------------------------------------------

#[tokio::test]
async fn interactive_rebase_verifies_the_range_then_injects_the_todo() {
    // The plan is checked against `rev-list --parents base..HEAD` FIRST -
    // the injected todo fully replaces git's own, and any range commit
    // missing from it would be silently dropped. Then, no temp script: the
    // sequence editor is `printf '<todo>' >`, which sh completes with the
    // todo path git appends - the plan is written straight into git's own
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
