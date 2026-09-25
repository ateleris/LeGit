use super::*;

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
    fake.expect_stdin(
        &["check-attr", "-z", "--stdin", "filter"],
        "a.png\0b.txt\0z.bin\0",
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

#[tokio::test]
async fn lfs_attribute_files_lists_hits_and_treats_no_hits_as_empty() {
    const GREP: [&str; 6] = ["grep", "-l", "-e", "filter=lfs", "--", ":(glob)**/.gitattributes"];
    let fake = FakeExecutor::default();
    fake.expect(&GREP, ok(".gitattributes\nassets/.gitattributes\n"));
    fake.expect(&GREP, fail(1, ""));
    fake.expect(&GREP, fail(128, "fatal: not a git repository"));
    let (b, exec) = backend(fake);
    assert_eq!(b.lfs_attribute_files().await.unwrap(), [".gitattributes", "assets/.gitattributes"]);
    assert!(b.lfs_attribute_files().await.unwrap().is_empty());
    assert!(b.lfs_attribute_files().await.is_err());
    exec.assert_done();
}
