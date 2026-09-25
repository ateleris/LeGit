use super::*;

// ---------------------------------------------------------------------------
// log - ref selector walks
// ---------------------------------------------------------------------------

#[tokio::test]
async fn log_all_branches_and_remotes_walks_remote_refs_too() {
    let fmt = format!("--format={}", parsers::log::LOG_FORMAT);
    let stash_fmt = format!("--format={}", parsers::stash::STASH_FORMAT);
    let fake = FakeExecutor::default();
    // --date-order is load-bearing: git's DEFAULT order has no
    // parent-after-child guarantee (a parent discovered via another child can
    // win a committer-timestamp tie), which breaks the graph's lane edges -
    // real-git case in tests/git_flows.rs
    // (log_lists_children_before_parents_on_equal_timestamps).
    fake.expect(
        &[
            "log", fmt.as_str(), "--max-count=500", "--date-order", "--decorate=full",
            "--ignore-missing", "HEAD", "--branches", "--remotes",
        ],
        ok(""),
    );
    // The full-graph walk injects stashes afterwards, same as the local-only one.
    fake.expect(&["stash", "list", stash_fmt.as_str()], ok(""));
    let (b, exec) = backend(fake);

    let commits = b
        .log(LogOptions { refs: RefSelector::AllBranchesAndRemotes, ..Default::default() })
        .await
        .unwrap();
    assert!(commits.is_empty());
    exec.assert_done();
}

// ---------------------------------------------------------------------------
// signature_presence - batched pay-per-view scan, never a verifier
// ---------------------------------------------------------------------------

const SIG_SHA_A: &str = "aaaa000011112222333344445555666677778888";
const SIG_SHA_B: &str = "bbbb000011112222333344445555666677778888";

/// One LOG_FORMAT record (11 newline-separated fields + RS terminator).
fn log_record(sha: &str, subject: &str) -> String {
    let ts = "2024-03-15T12:00:00+00:00";
    [sha, "", "Alice", "a@b.com", ts, "Alice", "a@b.com", ts, "", subject, ""].join("\n") + "\x1e"
}

/// One `cat-file --batch` entry for a commit object.
fn batch_commit_entry(sha: &str, signed: bool) -> String {
    let sig = if signed {
        "gpgsig -----BEGIN PGP SIGNATURE-----\n fake\n -----END PGP SIGNATURE-----\n"
    } else {
        ""
    };
    let obj = format!(
        "tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\n\
         author Alice <a@b.com> 1710504000 +0000\n\
         committer Alice <a@b.com> 1710504000 +0000\n\
         {sig}\nSubject\n"
    );
    format!("{sha} commit {}\n{obj}\n", obj.len())
}

fn ids(shas: &[&str]) -> Vec<CommitId> {
    shas.iter().map(|s| CommitId::new(*s)).collect()
}

#[tokio::test]
async fn log_never_scans_signatures() {
    // The list is exactly one subprocess: presence is a separate pay-per-view
    // pass (`signature_presence`), and no verifier may ever run here - the
    // strict FIFO script plus assert_done encodes both.
    let fmt = format!("--format={}", parsers::log::LOG_FORMAT);
    let fake = FakeExecutor::default();
    fake.expect(
        &["log", fmt.as_str(), "--max-count=500", "--date-order", "--decorate=full",
          "--ignore-missing", "HEAD"],
        ok(&log_record(SIG_SHA_A, "some commit")),
    );
    let (b, exec) = backend(fake);

    let commits = b.log(LogOptions::default()).await.unwrap();
    assert_eq!(commits.len(), 1);
    assert!(!commits[0].has_signature, "the list carries no signature data");
    exec.assert_done();
}

#[tokio::test]
async fn signature_presence_scans_with_one_batch_and_no_verifier() {
    let fake = FakeExecutor::default();
    fake.expect_stdin(
        &["cat-file", "--batch"],
        &format!("{SIG_SHA_A}\n{SIG_SHA_B}\n"),
        ok(&(batch_commit_entry(SIG_SHA_A, true) + &batch_commit_entry(SIG_SHA_B, false))),
    );
    let (b, exec) = backend(fake);

    let signed = b.signature_presence(&ids(&[SIG_SHA_A, SIG_SHA_B])).await.unwrap();
    assert_eq!(signed, ids(&[SIG_SHA_A]), "only the gpgsig-bearing commit is returned");
    exec.assert_done();
}

#[tokio::test]
async fn signature_presence_is_cached_per_sha() {
    // Presence is immutable per SHA: a repeat query answers entirely from the
    // cache (no git call), and a superset query batches only the unseen SHA.
    let fake = FakeExecutor::default();
    fake.expect_stdin(&["cat-file", "--batch"], &format!("{SIG_SHA_A}\n"), ok(&batch_commit_entry(SIG_SHA_A, true)));
    // Second call introduces SIG_SHA_B: one more batch (for it alone).
    fake.expect_stdin(&["cat-file", "--batch"], &format!("{SIG_SHA_B}\n"), ok(&batch_commit_entry(SIG_SHA_B, false)));
    let (b, exec) = backend(fake);

    assert_eq!(b.signature_presence(&ids(&[SIG_SHA_A])).await.unwrap(), ids(&[SIG_SHA_A]));
    // Same SHA again: no scripted git call left for it - cache must answer.
    assert_eq!(b.signature_presence(&ids(&[SIG_SHA_A])).await.unwrap(), ids(&[SIG_SHA_A]));
    // Superset: only SIG_SHA_B is unseen.
    assert_eq!(
        b.signature_presence(&ids(&[SIG_SHA_A, SIG_SHA_B])).await.unwrap(),
        ids(&[SIG_SHA_A])
    );
    exec.assert_done();
}

#[tokio::test]
async fn signature_presence_empty_input_makes_no_git_call() {
    let (b, exec) = backend(FakeExecutor::default());
    assert!(b.signature_presence(&[]).await.unwrap().is_empty());
    exec.assert_done();
}

#[tokio::test]
async fn signature_presence_cat_file_failure_is_an_error_and_uncached() {
    // A failure surfaces as an error (react-query handles it) and must not
    // poison the cache: the retry pays the batch again.
    let fake = FakeExecutor::default();
    fake.expect_stdin(&["cat-file", "--batch"], &format!("{SIG_SHA_A}\n"), fail(128, "fatal: not a git repository"));
    fake.expect_stdin(&["cat-file", "--batch"], &format!("{SIG_SHA_A}\n"), ok(&batch_commit_entry(SIG_SHA_A, true)));
    let (b, exec) = backend(fake);

    assert!(b.signature_presence(&ids(&[SIG_SHA_A])).await.is_err());
    assert_eq!(b.signature_presence(&ids(&[SIG_SHA_A])).await.unwrap(), ids(&[SIG_SHA_A]));
    exec.assert_done();
}

// ---------------------------------------------------------------------------
// search - commits (message/author/content) and paths
// ---------------------------------------------------------------------------

#[tokio::test]
async fn search_commits_builds_the_right_log_args_per_kind() {
    let fmt = format!("--format={}", parsers::log::LOG_FORMAT);
    for (kind, flag) in [
        (CommitSearchKind::Message, "--grep=fix bug".to_string()),
        (CommitSearchKind::Author, "--author=fix bug".to_string()),
    ] {
        let fake = FakeExecutor::default();
        fake.expect(
            &[
                "log", fmt.as_str(), "--max-count=50", "--regexp-ignore-case", flag.as_str(),
                "--ignore-missing", "HEAD", "--branches", "--decorate=full",
            ],
            ok(""),
        );
        let (b, exec) = backend(fake);
        let commits = b.search_commits("fix bug", kind, 50).await.unwrap();
        assert!(commits.is_empty());
        exec.assert_done();
    }

    // Content search is git's pickaxe: -S <literal>, no regex flag.
    let fake = FakeExecutor::default();
    fake.expect(
        &["log", fmt.as_str(), "--max-count=50", "-S", "needle", "--ignore-missing", "HEAD", "--branches", "--decorate=full"],
        ok(""),
    );
    let (b, exec) = backend(fake);
    b.search_commits("needle", CommitSearchKind::Content, 50).await.unwrap();
    exec.assert_done();
}

#[tokio::test]
async fn search_paths_filters_ls_files_case_insensitively() {
    let fake = FakeExecutor::default();
    fake.expect(
        &["ls-files", "-z"],
        ok("src/Main.rs\0docs/readme.md\0src/lib/mainHelper.ts\0"),
    );
    let (b, exec) = backend(fake);

    let paths = b.search_paths("main", 10).await.unwrap();
    assert_eq!(
        paths,
        vec![PathBuf::from("src/Main.rs"), PathBuf::from("src/lib/mainHelper.ts")],
    );
    exec.assert_done();
}

// ---------------------------------------------------------------------------
// file_history - exact argument vector (--follow / --name-status / paging)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn file_history_runs_follow_name_status_with_paging() {
    let fake = FakeExecutor::default();
    fake.expect(
        &[
            "log",
            "--follow",
            "-M",
            "--name-status",
            "--format=%x1e%H%n%an%n%at%n%s",
            "--max-count=200",
            "--skip=0",
            "--",
            "src/a.rs",
        ],
        ok("\x1eaaa\nAlice\n1783288808\nmodify\n\nM\tsrc/a.rs\n"),
    );
    let (b, exec) = backend(fake);

    let entries = b.file_history(Path::new("src/a.rs"), 200, 0, None).await.unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].commit_id.as_str(), "aaa");
    assert_eq!(entries[0].path, "src/a.rs");
    exec.assert_done();
}

#[tokio::test]
async fn file_history_with_start_rev_walks_from_that_rev() {
    let fake = FakeExecutor::default();
    fake.expect(
        &[
            "log",
            "--follow",
            "-M",
            "--name-status",
            "--format=%x1e%H%n%an%n%at%n%s",
            "--max-count=200",
            "--skip=0",
            "abc123",
            "--",
            "src/a.rs",
        ],
        ok("\x1eaaa\nAlice\n1783288808\nmodify\n\nM\tsrc/a.rs\n"),
    );
    let (b, exec) = backend(fake);

    let entries = b
        .file_history(Path::new("src/a.rs"), 200, 0, Some("abc123"))
        .await
        .unwrap();
    assert_eq!(entries.len(), 1);
    exec.assert_done();
}
