use super::*;

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
