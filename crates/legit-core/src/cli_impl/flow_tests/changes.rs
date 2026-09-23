use super::*;

// ---------------------------------------------------------------------------
// Files tree - list_repo_files / rm_cached
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
// compare view - range file list + per-file range diff
// ---------------------------------------------------------------------------

#[tokio::test]
async fn diff_files_runs_diff_tree_over_the_given_revs() {
    // Any rev spec works (branch names, HEAD~n, shas) - no parent resolution,
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

#[tokio::test]
async fn file_diff_presents_an_untracked_nested_repo_as_a_submodule_add() {
    // An untracked nested repo yields an empty `git diff` and `--no-index`
    // refuses directories, so the viewer read "no changes". It must instead
    // present what staging would record: a submodule add at the nested
    // repo's HEAD (probed like submodules()). The request path carries NO
    // trailing slash - the status parser strips git's collapsed `dir/` form,
    // so the probe cannot be gated on it.
    let sha_a = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let fake = FakeExecutor::default();
    fake.expect(
        &["-c", "diff.submodule=short", "diff", "--no-color", "--no-ext-diff", "-U3", "--", "subs/declared-only"],
        ok(""),
    );
    fake.expect(&["ls-files", "-z", "--", "subs/declared-only"], ok(""));
    fake.expect(
        &["diff", "--no-index", "--no-color", "--no-ext-diff", "-U3", "--", "/dev/null", "subs/declared-only"],
        fail(128, "fatal: not a regular file"),
    );
    fake.expect(
        &["-C", "subs/declared-only", "rev-parse", "--show-prefix", "HEAD"],
        ok(&format!("\n{sha_a}\n")),
    );
    let (b, exec) = backend(fake);

    let entry = b
        .file_diff(&DiffSource::WorkingUnstaged, Path::new("subs/declared-only"), None, 3)
        .await
        .unwrap();
    let DiffEntry::Submodule(sub) = entry else { panic!("expected Submodule: {entry:?}") };
    assert_eq!(sub.path, PathBuf::from("subs/declared-only"));
    assert_eq!(sub.old_sha, None);
    assert_eq!(sub.new_sha, Some(CommitId::new(sha_a)));
    assert!(!sub.dirty);
    exec.assert_done();
}

#[tokio::test]
async fn file_diff_untracked_nested_repo_tolerates_a_trailing_slash() {
    // Same as above with git's raw collapsed `dir/` shape, in case a caller
    // passes it through unstripped.
    let sha_a = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let fake = FakeExecutor::default();
    fake.expect(
        &["-c", "diff.submodule=short", "diff", "--no-color", "--no-ext-diff", "-U3", "--", "subs/declared-only/"],
        ok(""),
    );
    fake.expect(&["ls-files", "-z", "--", "subs/declared-only/"], ok(""));
    fake.expect(
        &["diff", "--no-index", "--no-color", "--no-ext-diff", "-U3", "--", "/dev/null", "subs/declared-only/"],
        fail(128, "fatal: not a regular file"),
    );
    fake.expect(
        &["-C", "subs/declared-only", "rev-parse", "--show-prefix", "HEAD"],
        ok(&format!("\n{sha_a}\n")),
    );
    let (b, exec) = backend(fake);

    let entry = b
        .file_diff(&DiffSource::WorkingUnstaged, Path::new("subs/declared-only/"), None, 3)
        .await
        .unwrap();
    let DiffEntry::Submodule(sub) = entry else { panic!("expected Submodule: {entry:?}") };
    assert_eq!(sub.path, PathBuf::from("subs/declared-only"));
    exec.assert_done();
}

#[tokio::test]
async fn file_diff_untracked_plain_dir_stays_no_changes() {
    // An untracked directory that is NOT a repo root: the probe escapes into
    // the superproject (non-empty prefix) and the result stays an empty text
    // diff - never a fabricated submodule entry.
    let sha_a = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let fake = FakeExecutor::default();
    fake.expect(
        &["-c", "diff.submodule=short", "diff", "--no-color", "--no-ext-diff", "-U3", "--", "plain"],
        ok(""),
    );
    fake.expect(&["ls-files", "-z", "--", "plain"], ok(""));
    fake.expect(
        &["diff", "--no-index", "--no-color", "--no-ext-diff", "-U3", "--", "/dev/null", "plain"],
        fail(128, "fatal: not a regular file"),
    );
    fake.expect(
        &["-C", "plain", "rev-parse", "--show-prefix", "HEAD"],
        ok(&format!("plain/\n{sha_a}\n")),
    );
    let (b, exec) = backend(fake);

    let entry = b
        .file_diff(&DiffSource::WorkingUnstaged, Path::new("plain"), None, 3)
        .await
        .unwrap();
    let DiffEntry::Text(text) = entry else { panic!("expected Text: {entry:?}") };
    assert!(text.hunks.is_empty());
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
// line-ending summary - fixed subprocess budget
// ---------------------------------------------------------------------------

#[tokio::test]
async fn line_ending_entries_run_three_commands_for_any_file_count() {
    // One config read, one check-attr for every path, one cat-file batch for
    // the TRACKED paths only (index + HEAD sides, in request order).
    let fake = FakeExecutor::default();
    fake.expect(&["config", "--get", "core.autocrlf"], fail(1, ""));
    fake.expect_stdin(
        &["check-attr", "-z", "--stdin", "text", "eol"],
        "a.txt\0new.txt\0",
        ok("a.txt\0text\0unspecified\0a.txt\0eol\0unspecified\0new.txt\0text\0unspecified\0new.txt\0eol\0unspecified\0"),
    );
    fake.expect_stdin(
        &["cat-file", "--batch"],
        ":a.txt\nHEAD:a.txt\n",
        ok("1111111111111111111111111111111111111111 blob 4\nx\r\ny\n\n2222222222222222222222222222222222222222 blob 4\nx\ny\n\n"),
    );
    let (b, exec) = backend(fake);
    let entries = b
        .line_ending_entries(vec![
            LineEndingInput { path: "a.txt".into(), untracked: false, working: Some(b"x\r\ny\r\n".to_vec()) },
            LineEndingInput { path: "new.txt".into(), untracked: true, working: Some(b"n\n".to_vec()) },
        ])
        .await
        .unwrap();
    assert_eq!(entries.iter().map(|e| e.path.as_str()).collect::<Vec<_>>(), ["a.txt", "new.txt"]);
    assert_eq!(entries[0].working_raw, Some(crate::types::LineEndingKind::Crlf));
    exec.assert_done();
}

#[tokio::test]
async fn line_ending_entries_for_no_files_run_nothing() {
    let (b, exec) = backend(FakeExecutor::default());
    assert!(b.line_ending_entries(vec![]).await.unwrap().is_empty());
    exec.assert_done();
}
