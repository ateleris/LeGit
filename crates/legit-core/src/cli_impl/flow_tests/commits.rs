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
