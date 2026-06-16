//! The `GitBackend` trait — the contract between the UI/command layer and
//! the implementation that actually performs Git operations.
//!
//! In v0.1 the only implementation is `GitCliBackend` (DESIGN.md §4.3) and
//! its trait methods are deliberately stubs: the Console panel exercises Git
//! directly through the runner. v1 panels will drive each method as real
//! parsing is added.

use crate::error::GitError;
use crate::types::{
    Branch, Commit, CommitDetails, CommitFileChange, CommitId, CommitOptions, Diff, FileStatus,
    LogOptions, SubmoduleInfo,
};
use async_trait::async_trait;

#[async_trait]
pub trait GitBackend: Send + Sync {
    async fn status(&self) -> Result<Vec<FileStatus>, GitError>;

    async fn log(&self, opts: LogOptions) -> Result<Vec<Commit>, GitError>;

    async fn commit_details(&self, id: &CommitId) -> Result<CommitDetails, GitError>;

    /// Files changed by `id`, relative to its first parent (or the empty tree
    /// for a root commit). Used by the Changed Files panel.
    async fn commit_files(&self, id: &CommitId) -> Result<Vec<CommitFileChange>, GitError>;

    async fn branches(&self) -> Result<Vec<Branch>, GitError>;

    async fn diff(&self, from: &CommitId, to: &CommitId) -> Result<Diff, GitError>;

    async fn commit(&self, opts: CommitOptions) -> Result<CommitId, GitError>;

    async fn submodules(&self) -> Result<Vec<SubmoduleInfo>, GitError>;
}
