use super::*;

// ---------------------------------------------------------------------------
// worktrees - list/add/remove sequences + checked-out-elsewhere classification
// ---------------------------------------------------------------------------

#[tokio::test]
async fn worktree_list_parses_the_porcelain_stream_and_probes_dirtiness() {
    let fake = FakeExecutor::default();
    fake.expect(
        &["worktree", "list", "--porcelain", "-z"],
        ok("worktree /repo\0HEAD 1111111111111111111111111111111111111111\0branch refs/heads/main\0\0worktree /wt\0HEAD 2222222222222222222222222222222222222222\0branch refs/heads/feature\0\0"),
    );
    // Main-entry fixup probe (absorbed-submodule gitdir detection).
    fake.expect(
        &["rev-parse", "--path-format=absolute", "--git-common-dir", "--show-toplevel"],
        ok("/repo/.git\n/repo\n"),
    );
    // One read-only dirtiness probe per checkout; --no-optional-locks so
    // probing ANOTHER worktree never writes its index.
    fake.expect(
        &["--no-optional-locks", "-C", "/repo", "status", "--porcelain", "-z"],
        ok(""),
    );
    fake.expect(
        &["--no-optional-locks", "-C", "/wt", "status", "--porcelain", "-z"],
        ok(" M f.txt\0"),
    );
    let (b, exec) = backend(fake);
    let list = b.worktree_list().await.unwrap();
    assert_eq!(list.len(), 2);
    assert!(list[0].is_main);
    assert_eq!(list[0].dirty, Some(false));
    assert_eq!(list[1].branch.as_deref(), Some("feature"));
    assert_eq!(list[1].dirty, Some(true));
    exec.assert_done();
}

#[tokio::test]
async fn worktree_list_skips_the_dirty_probe_for_prunable_entries() {
    // A prunable checkout's path is gone - probing it would only error.
    let fake = FakeExecutor::default();
    fake.expect(
        &["worktree", "list", "--porcelain", "-z"],
        ok("worktree /repo\0HEAD 1111111111111111111111111111111111111111\0branch refs/heads/main\0\0worktree /gone\0HEAD 2222222222222222222222222222222222222222\0detached\0prunable gitdir file points to non-existent location\0\0"),
    );
    fake.expect(
        &["rev-parse", "--path-format=absolute", "--git-common-dir", "--show-toplevel"],
        ok("/repo/.git\n/repo\n"),
    );
    fake.expect(
        &["--no-optional-locks", "-C", "/repo", "status", "--porcelain", "-z"],
        ok(""),
    );
    let (b, exec) = backend(fake);
    let list = b.worktree_list().await.unwrap();
    assert_eq!(list[1].dirty, None);
    exec.assert_done();
}

#[tokio::test]
async fn worktree_list_rewrites_an_absorbed_submodule_gitdir_main_entry() {
    // Inside a submodule git reports the GITDIR as the main worktree's path
    // (`worktree list` ignores core.worktree); the list must name the real
    // checkout, and the dirty probe must target it too.
    let fake = FakeExecutor::default();
    fake.expect(
        &["worktree", "list", "--porcelain", "-z"],
        ok("worktree /super/.git/modules/lib\0HEAD 1111111111111111111111111111111111111111\0branch refs/heads/main\0\0"),
    );
    fake.expect(
        &["rev-parse", "--path-format=absolute", "--git-common-dir", "--show-toplevel"],
        ok("/super/.git/modules/lib\n/super/lib\n"),
    );
    fake.expect(
        &["--no-optional-locks", "-C", "/super/lib", "status", "--porcelain", "-z"],
        ok(""),
    );
    let (b, exec) = backend(fake);
    let list = b.worktree_list().await.unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].path, "/super/lib");
    assert!(list[0].is_main);
    assert_eq!(list[0].dirty, Some(false));
    exec.assert_done();
}

#[tokio::test]
async fn worktree_add_variants_build_the_right_args() {
    let fake = FakeExecutor::default();
    fake.expect(&["worktree", "add", "--", "/wt", "feature"], ok(""));
    fake.expect(&["worktree", "add", "-b", "topic", "--", "/wt2"], ok(""));
    fake.expect(
        &["worktree", "add", "-b", "hotfix", "--", "/wt3", "v1.0"],
        ok(""),
    );
    fake.expect(&["worktree", "add", "--detach", "--", "/wt4"], ok(""));
    fake.expect(
        &["worktree", "add", "--detach", "--", "/wt5", "v2.0"],
        ok(""),
    );
    let (b, exec) = backend(fake);
    b.worktree_add("/wt", &WorktreeAddMode::Checkout { branch: "feature".into() })
        .await
        .unwrap();
    b.worktree_add(
        "/wt2",
        &WorktreeAddMode::NewBranch { name: "topic".into(), start_point: None },
    )
    .await
    .unwrap();
    b.worktree_add(
        "/wt3",
        &WorktreeAddMode::NewBranch { name: "hotfix".into(), start_point: Some("v1.0".into()) },
    )
    .await
    .unwrap();
    b.worktree_add("/wt4", &WorktreeAddMode::Detach { rev: None })
        .await
        .unwrap();
    b.worktree_add("/wt5", &WorktreeAddMode::Detach { rev: Some("v2.0".into()) })
        .await
        .unwrap();
    exec.assert_done();
}

#[tokio::test]
async fn worktree_remove_passes_force_only_when_asked() {
    let fake = FakeExecutor::default();
    fake.expect(&["worktree", "remove", "--", "/wt"], ok(""));
    fake.expect(&["worktree", "remove", "--force", "--", "/wt"], ok(""));
    fake.expect(&["worktree", "prune"], ok(""));
    let (b, exec) = backend(fake);
    b.worktree_remove("/wt", false).await.unwrap();
    b.worktree_remove("/wt", true).await.unwrap();
    b.worktree_prune().await.unwrap();
    exec.assert_done();
}

#[tokio::test]
async fn switch_to_a_branch_checked_out_elsewhere_is_classified() {
    let fake = FakeExecutor::default();
    fake.expect(
        &["switch", "--end-of-options", "feature"],
        fail(128, "fatal: 'feature' is already checked out at '/home/u/wt-feature'"),
    );
    let (b, exec) = backend(fake);
    let err = b
        .switch_branch("feature", SwitchDirtyBehavior::TryDirectly)
        .await
        .unwrap_err();
    match err {
        GitError::CheckedOutInWorktree { branch, path, .. } => {
            assert_eq!(branch.as_deref(), Some("feature"));
            assert_eq!(path.as_deref(), Some("/home/u/wt-feature"));
        }
        other => panic!("expected CheckedOutInWorktree, got {other:?}"),
    }
    exec.assert_done();
}

#[tokio::test]
async fn oversized_diff_classifies_as_too_large() {
    // A multi-MB diff (e.g. a minified SVG) crashed the webview with
    // renderer OOM when rendered as text - the cap turns it into a notice.
    let fake = FakeExecutor::default();
    let big = format!(
        "diff --git a/big.svg b/big.svg\n--- a/big.svg\n+++ b/big.svg\n@@ -0,0 +1 @@\n+{}\n",
        "x".repeat(21 * 1024 * 1024),
    );
    fake.expect(
        &["-c", "diff.submodule=short", "diff", "--no-color", "--no-ext-diff", "-U3", "--", "big.svg"],
        ok(&big),
    );
    let (b, exec) = backend(fake);
    let entry = b
        .file_diff(&DiffSource::WorkingUnstaged, Path::new("big.svg"), None, 3)
        .await
        .unwrap();
    match entry {
        DiffEntry::TooLarge { bytes } => assert!(bytes > 21 * 1024 * 1024, "{bytes}"),
        other => panic!("expected TooLarge, got a {} entry", diff_entry_kind(&other)),
    }
    exec.assert_done();
}

#[tokio::test]
async fn oversized_untracked_fallback_classifies_as_too_large() {
    // The worst case from the field: an UNTRACKED multi-MB file goes through
    // `diff --no-index /dev/null <file>`, turning the whole file into one
    // diff. The cap must apply to that fallback output too.
    let fake = FakeExecutor::default();
    fake.expect(
        &["-c", "diff.submodule=short", "diff", "--no-color", "--no-ext-diff", "-U3", "--", "big.svg"],
        ok(""),
    );
    fake.expect(&["ls-files", "-z", "--", "big.svg"], ok(""));
    let big = format!(
        "diff --git a/dev/null b/big.svg\n--- /dev/null\n+++ b/big.svg\n@@ -0,0 +1 @@\n+{}\n",
        "y".repeat(21 * 1024 * 1024),
    );
    fake.expect(
        &["diff", "--no-index", "--no-color", "--no-ext-diff", "-U3", "--", "/dev/null", "big.svg"],
        out(1, &big, ""),
    );
    let (b, exec) = backend(fake);
    let entry = b
        .file_diff(&DiffSource::WorkingUnstaged, Path::new("big.svg"), None, 3)
        .await
        .unwrap();
    assert!(
        matches!(entry, DiffEntry::TooLarge { .. }),
        "expected TooLarge, got a {} entry",
        diff_entry_kind(&entry)
    );
    exec.assert_done();
}

/// Variant name without dumping multi-MB content into assertion messages.
fn diff_entry_kind(e: &DiffEntry) -> &'static str {
    match e {
        DiffEntry::Text(_) => "Text",
        DiffEntry::Binary(_) => "Binary",
        DiffEntry::Submodule(_) => "Submodule",
        DiffEntry::TooLarge { .. } => "TooLarge",
    }
}

#[tokio::test]
async fn unpushed_commits_lists_shas_not_on_any_remote() {
    // Backs the bulk drop/squash menu gate: the selection must be a subset
    // of these. `--not --remotes` = all-remotes semantics, matching the
    // reword hard-block.
    let fake = FakeExecutor::default();
    fake.expect(
        &["rev-list", "-n", "500", "HEAD", "--not", "--remotes"],
        ok("2222222222222222222222222222222222222222\n1111111111111111111111111111111111111111\n"),
    );
    let (b, exec) = backend(fake);
    let shas = b.unpushed_commits(500).await.unwrap();
    assert_eq!(
        shas,
        vec![
            CommitId::new("2222222222222222222222222222222222222222"),
            CommitId::new("1111111111111111111111111111111111111111"),
        ]
    );
    exec.assert_done();
}

#[tokio::test]
async fn worktree_lock_and_unlock_build_the_right_args() {
    let fake = FakeExecutor::default();
    fake.expect(&["worktree", "lock", "--", "/wt"], ok(""));
    fake.expect(
        &["worktree", "lock", "--reason", "usb drive", "--", "/wt"],
        ok(""),
    );
    fake.expect(&["worktree", "unlock", "--", "/wt"], ok(""));
    let (b, exec) = backend(fake);
    b.worktree_lock("/wt", None).await.unwrap();
    b.worktree_lock("/wt", Some("usb drive")).await.unwrap();
    b.worktree_unlock("/wt").await.unwrap();
    exec.assert_done();
}
