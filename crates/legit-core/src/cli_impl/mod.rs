//! `GitCliBackend` — the v0.1 `GitBackend` implementation.
//!
//! Per DESIGN.md §8, the trait methods are intentionally stubbed in v0.1.
//! v0.1 panels do not consume structured data; the Console panel exercises
//! Git directly through the runner. v1 panels will replace each `NotYet`
//! with a real implementation that calls `runner.run(...)` and a parser in
//! `parsers/`.

use crate::backend::GitBackend;
use crate::error::GitError;
use crate::runner::GitRunner;
use crate::types::{
    Branch, Commit, CommitId, CommitOptions, Diff, FileStatus, LogOptions, SubmoduleInfo,
};
use async_trait::async_trait;
use std::sync::Arc;

pub mod parsers;

/// The CLI-backed implementation of `GitBackend`. Holds an `Arc<GitRunner>`
/// so a single underlying runner is shared with the Console panel and any
/// other direct caller (DESIGN.md §3.4).
pub struct GitCliBackend {
    runner: Arc<GitRunner>,
}

impl GitCliBackend {
    pub fn new(runner: Arc<GitRunner>) -> Self {
        Self { runner }
    }

    pub fn runner(&self) -> Arc<GitRunner> {
        self.runner.clone()
    }
}

#[async_trait]
impl GitBackend for GitCliBackend {
    async fn status(&self) -> Result<Vec<FileStatus>, GitError> {
        Err(GitError::NotYet)
    }

    async fn log(&self, _opts: LogOptions) -> Result<Vec<Commit>, GitError> {
        Err(GitError::NotYet)
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
