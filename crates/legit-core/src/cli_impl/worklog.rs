//! Work Log sweep: the per-day work overview's data source.

use super::*;

impl<E: GitExecutor + ?Sized> GitCliBackend<E> {
    /// Commits authored since `since_unix` on any local branch (plus HEAD),
    /// with the absolute git common dir so worktree tabs of one repository
    /// can be grouped (their branch walks would otherwise double-count).
    pub(super) async fn work_log(&self, since_unix: i64) -> Result<WorkLogRepoData, GitError> {
        let common_dir = self
            .run_checked(&["rev-parse", "--path-format=absolute", "--git-common-dir"])
            .await?
            .trim()
            .to_string();

        let fmt = parsers::format_arg(parsers::worklog::WORK_LOG_FORMAT);
        // Options before revisions. `--source` feeds `%S`; `--ignore-missing`
        // keeps an unborn HEAD (fresh repo) from failing the walk.
        let mut args = vec!["log", &fmt];
        let since = format!("--since=@{since_unix}");
        // git treats `@0` (and negatives) as an invalid date and silently
        // falls back to "now", hiding everything - omit the bound instead.
        if since_unix > 0 {
            args.push(&since);
        }
        args.extend_from_slice(&[
            "--date-order", "--source", "--ignore-missing", "HEAD", "--branches",
        ]);
        let out = self.run_checked(&args).await?;
        let commits = parsers::worklog::parse_work_log(&out).map_err(GitError::from)?;
        Ok(WorkLogRepoData { common_dir, commits })
    }
}
