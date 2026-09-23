use super::*;

// ---------------------------------------------------------------------------
// conflict file sides - index stages :1/:2/:3
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
