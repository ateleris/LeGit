//! Git sequences for the settings-sync repository (a local checkout that
//! mirrors shareable app settings; see design/2026-10-02-settings-sync-git.md).
//! Pure sequences over `GitExecutor`: the engine orchestrating them lives in
//! the app crate.

use crate::error::GitError;
use crate::executor::GitExecutor;
use crate::runner::GitRequest;

pub const SYNC_SETTINGS_FILE: &str = "legit-sync.json";
pub const SYNC_THEMES_DIR: &str = "themes";

/// Fixed identity so sync never depends on the machine's git config.
pub const SYNC_COMMIT_ENV: [(&str, &str); 4] = [
    ("GIT_AUTHOR_NAME", "LeGit Sync"),
    ("GIT_AUTHOR_EMAIL", "sync@legit.local"),
    ("GIT_COMMITTER_NAME", "LeGit Sync"),
    ("GIT_COMMITTER_EMAIL", "sync@legit.local"),
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SyncPullOutcome {
    Pulled,
    NoUpstream,
    Offline,
    Conflict,
    Failed(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SyncCommitOutcome {
    Committed,
    NothingToCommit,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SyncPushOutcome {
    Pushed,
    Rejected,
    Offline,
    Failed(String),
}

/// Auth outranks the network markers (ssh auth failures also carry "Could
/// not read from remote repository"): a revoked key must be a loud failure,
/// never a quiet Offline.
fn is_auth_failure(stderr: &str) -> bool {
    let lower = stderr.to_lowercase();
    [
        "authentication failed",
        "permission denied (publickey",
        "could not read username",
        "could not read password",
        "terminal prompts disabled",
        "access denied",
    ]
    .iter()
    .any(|marker| lower.contains(marker))
}

fn is_network_failure(stderr: &str) -> bool {
    let lower = stderr.to_lowercase();
    [
        "could not resolve host",
        "unable to access",
        "connection refused",
        "connection timed out",
        "operation timed out",
        "could not read from remote repository",
        "network is unreachable",
    ]
    .iter()
    .any(|marker| lower.contains(marker))
}

pub fn classify_pull_failure(stderr: &str) -> SyncPullOutcome {
    let lower = stderr.to_lowercase();
    if lower.contains("no tracking information") || lower.contains("couldn't find remote ref") {
        return SyncPullOutcome::NoUpstream;
    }
    if stderr.contains("CONFLICT") || lower.contains("could not apply") {
        return SyncPullOutcome::Conflict;
    }
    if is_auth_failure(stderr) {
        return SyncPullOutcome::Failed(stderr.trim().to_string());
    }
    if is_network_failure(stderr) {
        return SyncPullOutcome::Offline;
    }
    SyncPullOutcome::Failed(stderr.trim().to_string())
}

pub fn classify_push_failure(stderr: &str) -> SyncPushOutcome {
    let lower = stderr.to_lowercase();
    if lower.contains("[rejected]") || lower.contains("non-fast-forward") || lower.contains("fetch first")
    {
        return SyncPushOutcome::Rejected;
    }
    if is_auth_failure(stderr) {
        return SyncPushOutcome::Failed(stderr.trim().to_string());
    }
    if is_network_failure(stderr) {
        return SyncPushOutcome::Offline;
    }
    SyncPushOutcome::Failed(stderr.trim().to_string())
}

fn command_failed(out: &crate::runner::RunOutput) -> GitError {
    GitError::CommandFailed {
        exit_code: out.exit_code.unwrap_or(-1),
        stderr: out.stderr.trim().to_string(),
    }
}

pub async fn first_remote(exec: &dyn GitExecutor) -> Result<Option<String>, GitError> {
    let out = exec.run(&["remote"]).await?;
    if !out.success {
        return Err(command_failed(&out));
    }
    Ok(out.stdout.lines().map(str::trim).find(|l| !l.is_empty()).map(str::to_string))
}

/// Commits the upstream does not have; `None` when no upstream is configured
/// (the caller must then assume unpushed work exists).
pub async fn commits_ahead(exec: &dyn GitExecutor) -> Result<Option<u64>, GitError> {
    let out = exec.run_expecting(&["rev-list", "--count", "@{upstream}..HEAD"], &[128]).await?;
    if !out.success {
        return Ok(None);
    }
    Ok(out.stdout.trim().parse().ok())
}

pub async fn rebase_in_progress(exec: &dyn GitExecutor) -> Result<bool, GitError> {
    // exit 1 = no REBASE_HEAD: an answer, not a failure.
    let out = exec.run_expecting(&["rev-parse", "-q", "--verify", "REBASE_HEAD"], &[1]).await?;
    Ok(out.success)
}

pub async fn sync_pull(exec: &dyn GitExecutor) -> Result<SyncPullOutcome, GitError> {
    let out = exec.run_expecting(&["pull", "--rebase"], &[1, 128]).await?;
    if out.success {
        return Ok(SyncPullOutcome::Pulled);
    }
    Ok(classify_pull_failure(&out.stderr))
}

pub async fn sync_commit(exec: &dyn GitExecutor) -> Result<SyncCommitOutcome, GitError> {
    let add = exec.run(&["add", "-A", "--", SYNC_SETTINGS_FILE]).await?;
    if !add.success {
        return Err(command_failed(&add));
    }
    // Separate pathspec: `add` exits 128 when `themes` matches nothing, which
    // is the normal state before the first theme ever syncs.
    let add_themes = exec.run_expecting(&["add", "-A", "--", SYNC_THEMES_DIR], &[128]).await?;
    if !add_themes.success && !add_themes.stderr.contains("did not match any files") {
        return Err(command_failed(&add_themes));
    }
    // exit 1 = staged changes exist; 0 = nothing staged.
    let diff = exec.run_expecting(&["diff", "--cached", "--quiet"], &[1]).await?;
    if diff.success {
        return Ok(SyncCommitOutcome::NothingToCommit);
    }
    // --no-gpg-sign: a machine's commit.gpgsign config must never make sync
    // commits prompt for (or hang on) a signing key.
    let commit = exec
        .execute(
            GitRequest::new(&["commit", "--no-gpg-sign", "-m", "Sync settings"])
                .env(&SYNC_COMMIT_ENV),
        )
        .await?
        .into_text();
    if !commit.success {
        return Err(command_failed(&commit));
    }
    Ok(SyncCommitOutcome::Committed)
}

pub async fn sync_push(exec: &dyn GitExecutor, remote: &str) -> Result<SyncPushOutcome, GitError> {
    let out = exec.run_expecting(&["push", "-u", remote, "HEAD"], &[1, 128]).await?;
    if out.success {
        return Ok(SyncPushOutcome::Pushed);
    }
    Ok(classify_push_failure(&out.stderr))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{fail, ok, FakeExecutor};

    #[test]
    fn pull_failure_classification() {
        use SyncPullOutcome::*;
        assert_eq!(
            classify_pull_failure("There is no tracking information for the current branch."),
            NoUpstream
        );
        assert_eq!(classify_pull_failure("fatal: couldn't find remote ref main"), NoUpstream);
        assert_eq!(
            classify_pull_failure(
                "fatal: unable to access 'https://x/': Could not resolve host: x"
            ),
            Offline
        );
        assert_eq!(
            classify_pull_failure(
                "ssh: connect to host x port 22: Connection refused\nfatal: Could not read from remote repository."
            ),
            Offline
        );
        assert_eq!(
            classify_pull_failure(
                "CONFLICT (content): Merge conflict in legit-sync.json\nerror: could not apply abc123..."
            ),
            Conflict
        );
        assert_eq!(
            classify_pull_failure("fatal: something else"),
            Failed("fatal: something else".into())
        );
    }

    #[test]
    fn auth_failures_are_loud_not_offline() {
        // Auth outranks the network markers: ssh auth failures also carry
        // "Could not read from remote repository", and a quiet Offline would
        // hide a revoked key forever.
        let ssh = "git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.";
        let https = "fatal: Authentication failed for 'https://example.com/x.git/'";
        assert!(matches!(classify_pull_failure(ssh), SyncPullOutcome::Failed(_)));
        assert!(matches!(classify_pull_failure(https), SyncPullOutcome::Failed(_)));
        assert!(matches!(classify_push_failure(ssh), SyncPushOutcome::Failed(_)));
        assert!(matches!(
            classify_push_failure("fatal: could not read Username for 'https://x': terminal prompts disabled"),
            SyncPushOutcome::Failed(_)
        ));
    }

    #[test]
    fn push_failure_classification() {
        use SyncPushOutcome::*;
        assert_eq!(classify_push_failure(" ! [rejected] main -> main (fetch first)"), Rejected);
        assert_eq!(
            classify_push_failure(
                "hint: Updates were rejected because the remote contains work\n ! [rejected] (non-fast-forward)"
            ),
            Rejected
        );
        assert_eq!(
            classify_push_failure(
                "fatal: unable to access 'https://x/': Could not resolve host: x"
            ),
            Offline
        );
        assert_eq!(classify_push_failure("fatal: other"), Failed("fatal: other".into()));
    }

    #[tokio::test]
    async fn commit_sequence_adds_only_sync_paths_and_commits_with_fixed_identity() {
        let fake = FakeExecutor::default();
        fake.expect(&["add", "-A", "--", SYNC_SETTINGS_FILE], ok(""))
            .expect(&["add", "-A", "--", SYNC_THEMES_DIR], ok(""))
            .expect(&["diff", "--cached", "--quiet"], fail(1, ""))
            .expect_env(
                &["commit", "--no-gpg-sign", "-m", "Sync settings"],
                &SYNC_COMMIT_ENV,
                ok("[main abc] Sync settings"),
            );
        assert_eq!(sync_commit(&fake).await.unwrap(), SyncCommitOutcome::Committed);
        fake.assert_done();
    }

    #[tokio::test]
    async fn commits_ahead_counts_unpushed_commits() {
        let fake = FakeExecutor::default();
        fake.expect(&["rev-list", "--count", "@{upstream}..HEAD"], ok("2\n"));
        assert_eq!(commits_ahead(&fake).await.unwrap(), Some(2));
        let fake = FakeExecutor::default();
        fake.expect(&["rev-list", "--count", "@{upstream}..HEAD"], ok("0\n"));
        assert_eq!(commits_ahead(&fake).await.unwrap(), Some(0));
        // No upstream yet: unknown, the caller must assume unpushed work.
        let fake = FakeExecutor::default();
        fake.expect(
            &["rev-list", "--count", "@{upstream}..HEAD"],
            fail(128, "fatal: no upstream configured for branch 'main'"),
        );
        assert_eq!(commits_ahead(&fake).await.unwrap(), None);
    }

    #[tokio::test]
    async fn commit_tolerates_a_missing_themes_dir() {
        // `git add` exits 128 on a pathspec that matches nothing: expected
        // before the first theme ever syncs, never an error.
        let fake = FakeExecutor::default();
        fake.expect(&["add", "-A", "--", SYNC_SETTINGS_FILE], ok(""))
            .expect(
                &["add", "-A", "--", SYNC_THEMES_DIR],
                fail(128, "fatal: pathspec 'themes' did not match any files"),
            )
            .expect(&["diff", "--cached", "--quiet"], fail(1, ""))
            .expect_env(
                &["commit", "--no-gpg-sign", "-m", "Sync settings"],
                &SYNC_COMMIT_ENV,
                ok("[main abc] Sync settings"),
            );
        assert_eq!(sync_commit(&fake).await.unwrap(), SyncCommitOutcome::Committed);
        fake.assert_done();
    }

    #[tokio::test]
    async fn commit_still_fails_on_other_add_errors() {
        let fake = FakeExecutor::default();
        fake.expect(&["add", "-A", "--", SYNC_SETTINGS_FILE], ok(""))
            .expect(&["add", "-A", "--", SYNC_THEMES_DIR], fail(128, "fatal: index locked"));
        assert!(sync_commit(&fake).await.is_err());
        fake.assert_done();
    }

    #[tokio::test]
    async fn commit_is_skipped_when_nothing_staged() {
        let fake = FakeExecutor::default();
        fake.expect(&["add", "-A", "--", SYNC_SETTINGS_FILE], ok(""))
            .expect(&["add", "-A", "--", SYNC_THEMES_DIR], ok(""))
            .expect(&["diff", "--cached", "--quiet"], ok(""));
        assert_eq!(sync_commit(&fake).await.unwrap(), SyncCommitOutcome::NothingToCommit);
        // assert_done pins that NO commit runs on a clean tree
        fake.assert_done();
    }

    #[tokio::test]
    async fn pull_runs_rebase_and_reports_outcomes() {
        let fake = FakeExecutor::default();
        fake.expect(&["pull", "--rebase"], ok("Updating abc..def"));
        assert_eq!(sync_pull(&fake).await.unwrap(), SyncPullOutcome::Pulled);
        fake.assert_done();
    }

    #[tokio::test]
    async fn pull_classifies_a_conflicted_rebase() {
        let fake = FakeExecutor::default();
        fake.expect(
            &["pull", "--rebase"],
            fail(1, "CONFLICT (content): Merge conflict in legit-sync.json"),
        );
        assert_eq!(sync_pull(&fake).await.unwrap(), SyncPullOutcome::Conflict);
        fake.assert_done();
    }

    #[tokio::test]
    async fn push_targets_the_given_remote_with_upstream() {
        let fake = FakeExecutor::default();
        fake.expect(&["push", "-u", "origin", "HEAD"], ok(""));
        assert_eq!(sync_push(&fake, "origin").await.unwrap(), SyncPushOutcome::Pushed);
        fake.assert_done();
    }

    #[tokio::test]
    async fn push_classifies_a_rejection() {
        let fake = FakeExecutor::default();
        fake.expect(
            &["push", "-u", "origin", "HEAD"],
            fail(1, " ! [rejected] main -> main (fetch first)"),
        );
        assert_eq!(sync_push(&fake, "origin").await.unwrap(), SyncPushOutcome::Rejected);
        fake.assert_done();
    }

    #[tokio::test]
    async fn rebase_in_progress_checks_rebase_head() {
        let fake = FakeExecutor::default();
        fake.expect(&["rev-parse", "-q", "--verify", "REBASE_HEAD"], ok("abc123"));
        assert!(rebase_in_progress(&fake).await.unwrap());
        let fake = FakeExecutor::default();
        fake.expect(&["rev-parse", "-q", "--verify", "REBASE_HEAD"], fail(1, ""));
        assert!(!rebase_in_progress(&fake).await.unwrap());
    }

    #[tokio::test]
    async fn first_remote_returns_the_first_listed() {
        let fake = FakeExecutor::default();
        fake.expect(&["remote"], ok("origin\nbackup\n"));
        assert_eq!(first_remote(&fake).await.unwrap().as_deref(), Some("origin"));
        let fake = FakeExecutor::default();
        fake.expect(&["remote"], ok(""));
        assert_eq!(first_remote(&fake).await.unwrap(), None);
    }
}
