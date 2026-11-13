use super::*;

const WL_SHA: &str = "aaaa000011112222333344445555666677778888";

fn work_log_record(sha: &str, subject: &str) -> String {
    format!("{sha}\tAlice\ta@b.com\t2026-11-12T09:12:00+01:00\trefs/heads/dev\t{subject}\n")
}

/// git parses `--since=@0` as INVALID and silently falls back to "now"
/// (probe-verified), which would hide every commit older than this second -
/// a non-positive cutoff must therefore omit `--since` entirely.
#[tokio::test]
async fn work_log_omits_since_for_non_positive_cutoff() {
    let fmt = format!("--format={}", parsers::worklog::WORK_LOG_FORMAT);
    let fake = FakeExecutor::default();
    fake.expect(
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        ok("/repo/.git\n"),
    );
    fake.expect(
        &[
            "log", fmt.as_str(), "--date-order", "--source",
            "--ignore-missing", "HEAD", "--branches",
        ],
        ok(""),
    );
    let (b, exec) = backend(fake);

    let data = b.work_log(0).await.unwrap();
    assert!(data.commits.is_empty());
    exec.assert_done();
}

#[tokio::test]
async fn work_log_resolves_common_dir_then_walks_local_branches_since_cutoff() {
    let fmt = format!("--format={}", parsers::worklog::WORK_LOG_FORMAT);
    let fake = FakeExecutor::default();
    fake.expect(
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        ok("/repo/.git\n"),
    );
    // Exact args pin the contract: no %G? in the format, options before
    // revisions, local branches + HEAD only (no remotes, no tags).
    fake.expect(
        &[
            "log", fmt.as_str(), "--since=@1762902000", "--date-order", "--source",
            "--ignore-missing", "HEAD", "--branches",
        ],
        ok(&work_log_record(WL_SHA, "fix stash pop guidance")),
    );
    let (b, exec) = backend(fake);

    let data = b.work_log(1762902000).await.unwrap();
    assert_eq!(data.common_dir, "/repo/.git");
    assert_eq!(data.commits.len(), 1);
    assert_eq!(data.commits[0].id.as_str(), WL_SHA);
    assert_eq!(data.commits[0].subject, "fix stash pop guidance");
    assert_eq!(data.commits[0].source_ref.as_deref(), Some("refs/heads/dev"));
    exec.assert_done();
}
