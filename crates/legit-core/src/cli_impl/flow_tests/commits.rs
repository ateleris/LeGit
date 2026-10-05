use super::*;

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
// commit - failed-commit hook blame (probe runs only on failure, never with
// --no-verify; LocalFs stats real files in a tempdir hooks directory)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn failed_commit_with_installed_hook_is_hook_declined() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("pre-commit"), "#!/bin/sh\nexit 1\n").unwrap();

    let fake = FakeExecutor::default();
    fake.expect(&["commit", "-m", "hello"], out(1, "", "LINT FAILED\n"));
    fake.expect(
        &["rev-parse", "--path-format=absolute", "--git-path", "hooks"],
        ok(&format!("{}\n", dir.path().display())),
    );
    let (b, exec) = backend(fake);

    let err = b
        .commit(CommitOptions { message: "hello".into(), ..Default::default() })
        .await
        .unwrap_err();
    match err {
        GitError::CommitHookDeclined { hooks, exit_code, stderr } => {
            assert_eq!(hooks, vec!["pre-commit"]);
            assert_eq!(exit_code, 1);
            assert!(stderr.contains("LINT FAILED"), "{stderr}");
        }
        other => panic!("expected CommitHookDeclined, got {other:?}"),
    }
    exec.assert_done();
}

#[tokio::test]
async fn failed_commit_without_installed_hooks_is_command_failed() {
    let dir = tempfile::tempdir().unwrap();

    let fake = FakeExecutor::default();
    fake.expect(&["commit", "-m", "hello"], out(1, "", "something broke\n"));
    fake.expect(
        &["rev-parse", "--path-format=absolute", "--git-path", "hooks"],
        ok(&format!("{}\n", dir.path().display())),
    );
    let (b, exec) = backend(fake);

    let err = b
        .commit(CommitOptions { message: "hello".into(), ..Default::default() })
        .await
        .unwrap_err();
    assert!(matches!(err, GitError::CommandFailed { .. }), "{err:?}");
    exec.assert_done();
}

#[tokio::test]
async fn failed_no_verify_commit_skips_the_hook_probe() {
    let fake = FakeExecutor::default();
    // No rev-parse scripted: hooks were skipped, so none can be to blame and
    // the probe must not run.
    fake.expect(&["commit", "-m", "hello", "--no-verify"], out(1, "", "boom\n"));
    let (b, exec) = backend(fake);

    let err = b
        .commit(CommitOptions {
            message: "hello".into(),
            no_verify: true,
            ..Default::default()
        })
        .await
        .unwrap_err();
    assert!(matches!(err, GitError::CommandFailed { .. }), "{err:?}");
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
