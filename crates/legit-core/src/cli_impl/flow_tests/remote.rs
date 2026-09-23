use super::*;

// ---------------------------------------------------------------------------
// branch / tag / remote management - exact-argv contracts for the mutating
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
async fn delete_branch_unmerged_refusal_is_classified() {
    let fake = FakeExecutor::default();
    fake.expect(
        &["branch", "-d", "--end-of-options", "feat"],
        fail(1, "error: the branch 'feat' is not fully merged"),
    );
    let (b, exec) = backend(fake);

    let err = b.delete_branch("feat", false).await.unwrap_err();
    assert!(
        matches!(&err, GitError::BranchNotFullyMerged { branch, stderr }
            if branch == "feat" && stderr.contains("not fully merged")),
        "{err:?}"
    );
    exec.assert_done();
}

#[tokio::test]
async fn branch_merge_analysis_runs_contains_and_cherry_against_the_remote_default() {
    let fake = FakeExecutor::default();
    fake.expect(&["rev-parse", "--verify", "refs/heads/feat"], ok("abc123\n"));
    fake.expect(
        &["for-each-ref", "--contains", "abc123", "--format=%(refname:short)", "refs/heads", "refs/remotes"],
        ok("feat\norigin/feat\norigin/HEAD\norigin/main\n"),
    );
    fake.expect(&["remote"], ok("origin\n"));
    fake.expect(&["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], ok("origin/main\n"));
    fake.expect(&["cherry", "origin/main", "refs/heads/feat"], ok("- 7a5e5f\n- 9b2c1d\n"));
    let (b, exec) = backend(fake);

    let a = b.branch_merge_analysis("feat").await.unwrap();
    assert_eq!(a.merged_into, vec!["origin/main".to_string()]);
    assert_eq!(a.equivalent_in.as_deref(), Some("origin/main"));
    exec.assert_done();
}

// An unset `refs/remotes/<remote>/HEAD` symref (only clones set it) falls
// back to probing <remote>/main, then <remote>/master.
#[tokio::test]
async fn branch_merge_analysis_falls_back_to_main_when_head_symref_is_unset() {
    let fake = FakeExecutor::default();
    fake.expect(&["rev-parse", "--verify", "refs/heads/feat"], ok("abc123\n"));
    fake.expect(
        &["for-each-ref", "--contains", "abc123", "--format=%(refname:short)", "refs/heads", "refs/remotes"],
        ok("feat\n"),
    );
    fake.expect(&["remote"], ok("origin\n"));
    fake.expect(
        &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
        fail(128, "fatal: ref refs/remotes/origin/HEAD is not a symbolic ref"),
    );
    fake.expect(&["rev-parse", "--verify", "--quiet", "refs/remotes/origin/main"], ok("def456\n"));
    fake.expect(&["cherry", "origin/main", "refs/heads/feat"], ok("+ 7a5e5f\n"));
    let (b, exec) = backend(fake);

    let a = b.branch_merge_analysis("feat").await.unwrap();
    assert!(a.merged_into.is_empty(), "{a:?}");
    assert_eq!(a.equivalent_in, None, "a `+` line means unmatched commits");
    exec.assert_done();
}

// No remotes: no baseline exists, so the cherry check must NOT run.
#[tokio::test]
async fn branch_merge_analysis_without_remotes_skips_the_cherry_check() {
    let fake = FakeExecutor::default();
    fake.expect(&["rev-parse", "--verify", "refs/heads/feat"], ok("abc123\n"));
    fake.expect(
        &["for-each-ref", "--contains", "abc123", "--format=%(refname:short)", "refs/heads", "refs/remotes"],
        ok("feat\nmain\n"),
    );
    fake.expect(&["remote"], ok(""));
    let (b, exec) = backend(fake);

    let a = b.branch_merge_analysis("feat").await.unwrap();
    assert_eq!(a.merged_into, vec!["main".to_string()]);
    assert_eq!(a.equivalent_in, None);
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
    assert_eq!(outcome.outcome, SwitchOutcome::Clean);
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
// fetch / pull / merge - full command sequences (previously only arg-builder
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

// Like the pull case below: a switch can exit 0 while LFS downloads failed,
// leaving pointer stubs - the result must carry that, never a silent Clean.
#[tokio::test]
async fn switch_exit_zero_with_lfs_errors_reports_stub_files() {
    let fake = FakeExecutor::default();
    fake.expect(
        &["switch", "--end-of-options", "feature"],
        out(
            0,
            "",
            "Error downloading object: feat.bin (d686331): Smudge error: [404] Object does not exist on the server\n",
        ),
    );
    let (b, exec) = backend(fake);

    let r = b
        .switch_branch("feature", SwitchDirtyBehavior::TryDirectly)
        .await
        .unwrap();
    assert_eq!(r.outcome, SwitchOutcome::Clean);
    let stubs = r.lfs_stubs.expect("stubs reported");
    assert_eq!(stubs.files, vec!["feat.bin".to_string()]);
    assert!(stubs.missing_on_remote);
    exec.assert_done();
}

// git exits 0 under lfs.skipdownloaderrors (or a non-required filter) while
// leaving pointer stubs: the outcome must carry that, never a silent Ok.
#[tokio::test]
async fn pull_exit_zero_with_lfs_errors_reports_stub_files() {
    let fake = FakeExecutor::default();
    fake.expect(
        &["-c", "gc.auto=0", "-c", "maintenance.auto=false", "pull", "--progress"],
        out(
            0,
            "",
            "Downloading big.bin (2.0 KB)\nError downloading object: big.bin (8f786a0): Smudge error: [404] Object does not exist on the server\n",
        ),
    );
    let (b, exec) = backend(fake);

    let outcome = b
        .pull(PullOptions { strategy: PullStrategy::Default }, OperationId("op".into()))
        .await
        .unwrap();
    let stubs = outcome.lfs_stubs.expect("stubs reported");
    assert_eq!(stubs.files, vec!["big.bin".to_string()]);
    assert!(stubs.missing_on_remote);
    exec.assert_done();
}

#[tokio::test]
async fn pull_clean_success_reports_no_stub_files() {
    let fake = FakeExecutor::default();
    fake.expect(
        &["-c", "gc.auto=0", "-c", "maintenance.auto=false", "pull", "--progress"],
        ok("Already up to date.\n"),
    );
    let (b, exec) = backend(fake);

    let outcome = b
        .pull(PullOptions { strategy: PullStrategy::Default }, OperationId("op".into()))
        .await
        .unwrap();
    assert!(outcome.lfs_stubs.is_none());
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
    // touched. A stale temp index and `.lock` (a preview killed mid-run) are
    // removed first, and nothing is left behind afterwards.
    let dir = tempfile::tempdir().unwrap();
    let index = dir.path().join("index").to_string_lossy().replace('\\', "/");
    let tmp = format!("{index}.legit-renormalize-preview");
    std::fs::write(&tmp, b"stale").unwrap();
    std::fs::write(format!("{tmp}.lock"), b"stale").unwrap();
    let fake = FakeExecutor::default();
    fake.expect(&["write-tree"], ok("TREESHA\n"));
    fake.expect(&["rev-parse", "--path-format=absolute", "--git-path", "index"], ok(&format!("{index}\n")));
    fake.expect_env(&["read-tree", "TREESHA"], &[("GIT_INDEX_FILE", &tmp)], ok(""));
    fake.expect_env(
        &["add", "--renormalize", "--", "."],
        &[("GIT_INDEX_FILE", &tmp)],
        ok(""),
    );
    fake.expect_env(
        &["diff-index", "--cached", "--name-only", "-z", "TREESHA"],
        &[("GIT_INDEX_FILE", &tmp)],
        ok("a.txt\0b c.txt\0"),
    );
    let (backend, fake) = backend(fake);
    let files = backend.renormalize_preview().await.unwrap();
    assert_eq!(files, vec!["a.txt".to_string(), "b c.txt".to_string()]);
    fake.assert_done();
    assert!(!std::path::Path::new(&tmp).exists());
    assert!(!std::path::Path::new(&format!("{tmp}.lock")).exists());
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
