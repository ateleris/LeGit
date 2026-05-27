//! `GitCliBackend` — the CLI-backed `GitBackend` implementation.
//!
//! Per DESIGN-v0.3.md, `log()` and `commit_details()` are implemented here.
//! Other trait methods remain as `NotYet` stubs until their respective panels
//! are built.

use crate::backend::GitBackend;
use crate::error::GitError;
use crate::runner::GitRunner;
use crate::types::{
    Branch, Commit, CommitDetails, CommitId, CommitOptions, Diff, FileStatus, LogOptions,
    SubmoduleInfo,
};
use async_trait::async_trait;
use std::sync::Arc;
use tokio::sync::RwLock;

pub mod parsers;

/// The CLI-backed implementation of `GitBackend`. Holds a shared
/// `Arc<RwLock<Arc<GitRunner>>>` so the runner can be hot-swapped by
/// `RepoSession` (e.g. on per-repo git-path override) without disrupting
/// in-flight operations. Each method snapshots the current runner by locking,
/// cloning the inner `Arc`, then releasing before use (DESIGN-v0.3.md §C.5/F.3).
pub struct GitCliBackend {
    runner: Arc<RwLock<Arc<GitRunner>>>,
}

impl GitCliBackend {
    pub fn new(runner: Arc<RwLock<Arc<GitRunner>>>) -> Self {
        Self { runner }
    }

    /// Snapshot the current runner without holding the lock during I/O.
    pub async fn runner(&self) -> Arc<GitRunner> {
        self.runner.read().await.clone()
    }
}

#[async_trait]
impl GitBackend for GitCliBackend {
    async fn status(&self) -> Result<Vec<FileStatus>, GitError> {
        Err(GitError::NotYet)
    }

    async fn log(&self, opts: LogOptions) -> Result<Vec<Commit>, GitError> {
        let runner = self.runner().await;
        let fmt_arg = format!("--format={}", parsers::log::LOG_FORMAT);
        let max_count = opts.max_count.unwrap_or(500);
        let skip = opts.skip.unwrap_or(0);
        let max_count_arg = format!("--max-count={max_count}");
        let skip_arg = format!("--skip={skip}");

        let mut args = vec!["log", &fmt_arg, &max_count_arg];
        if skip > 0 {
            args.push(&skip_arg);
        }

        let output = runner
            .run(&args)
            .await
            .map_err(|e| GitError::Internal(e.to_string()))?;

        if !output.success {
            return Err(GitError::CommandFailed {
                exit_code: output.exit_code.unwrap_or(-1),
                stderr: output.stderr,
            });
        }

        parsers::log::parse_log(&output.stdout).map_err(GitError::from)
    }

    async fn commit_details(&self, id: &CommitId) -> Result<CommitDetails, GitError> {
        let runner = self.runner().await;

        let cat_output = runner
            .run(&["cat-file", "-p", id.as_str()])
            .await
            .map_err(|e| GitError::Internal(e.to_string()))?;

        if !cat_output.success {
            return Err(GitError::CommandFailed {
                exit_code: cat_output.exit_code.unwrap_or(-1),
                stderr: cat_output.stderr,
            });
        }

        let mut parsed =
            parsers::commit::parse_cat_file(id.as_str(), &cat_output.stdout)
                .map_err(GitError::from)?;

        if parsed.has_signature_header {
            let verify_output = runner
                .run(&["verify-commit", "--raw", id.as_str()])
                .await
                .map_err(|e| GitError::Internal(e.to_string()))?;
            // verify-commit exits non-zero for bad/unknown sigs — that's still
            // useful data, so we parse stderr regardless of exit code.
            let verification =
                parsers::commit::parse_verify_commit(&verify_output.stderr);
            parsed.commit.signature = verification;
        }

        Ok(CommitDetails {
            commit: parsed.commit,
            raw_object: parsed.raw_object,
        })
    }

    async fn branches(&self) -> Result<Vec<Branch>, GitError> {
        Err(GitError::NotYet)
    }

    async fn diff(&self, _from: &CommitId, _to: &CommitId) -> Result<Diff, GitError> {
        Err(GitError::NotYet)
    }

    async fn commit(&self, _opts: CommitOptions) -> Result<CommitId, GitError> {
        Err(GitError::NotYet)
    }

    async fn submodules(&self) -> Result<Vec<SubmoduleInfo>, GitError> {
        Err(GitError::NotYet)
    }
}
