//! The `GitBackend` trait — the contract between the UI/command layer and
//! the implementation that actually performs Git operations.
//!
//! In v0.1 the only implementation is `GitCliBackend` (DESIGN.md §4.3) and
//! its trait methods are deliberately stubs: the Console panel exercises Git
//! directly through the runner. v1 panels will drive each method as real
//! parsing is added.

use crate::error::GitError;
use crate::runner::OperationId;
use crate::types::{
    Branch, Commit, CommitDetails, CommitFileChange, CommitId, CommitOptions, Diff, DiffEntry,
    DiffSource, FetchOptions, FileStatus, HunkOp, LogOptions, PullOptions, PushOptions,
    SubmoduleInfo, TrackingStatus,
};
use async_trait::async_trait;
use std::path::{Path, PathBuf};

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

    /// The diff for a single file from one of the comparison sources, with
    /// `context` lines of surrounding context (small for chunked view, very
    /// large for whole-file view). Backs the Diff panel.
    /// `old_path` is the original path for a rename/copy (else `None`), so the
    /// diff pairs both sides: real content hunks for a modified rename, an empty
    /// diff for a pure rename.
    async fn file_diff(
        &self,
        source: &DiffSource,
        path: &Path,
        old_path: Option<&Path>,
        context: u32,
    ) -> Result<DiffEntry, GitError>;

    /// Apply a single hunk of a file's working-tree diff to the index or
    /// working tree (stage / unstage / discard). `hunk_index` indexes the hunks
    /// of the relevant source diff (unstaged for stage/discard, staged for
    /// unstage), in the order `file_diff` returns them.
    async fn apply_hunk(
        &self,
        path: &Path,
        hunk_index: usize,
        op: HunkOp,
    ) -> Result<(), GitError>;

    /// Like `apply_hunk`, but for a subset of a hunk's changed lines.
    /// `line_indices` index into the hunk's diff lines (context included), in
    /// `git diff` order. A no-op if `line_indices` is empty.
    async fn apply_lines(
        &self,
        path: &Path,
        hunk_index: usize,
        line_indices: &[usize],
        op: HunkOp,
    ) -> Result<(), GitError>;

    async fn commit(&self, opts: CommitOptions) -> Result<CommitId, GitError>;

    /// Stage the given paths (`git add`).
    async fn stage(&self, paths: &[PathBuf]) -> Result<(), GitError>;

    /// Unstage the given paths (`git restore --staged`).
    async fn unstage(&self, paths: &[PathBuf]) -> Result<(), GitError>;

    /// Discard working-tree changes for the given paths: tracked paths are
    /// reverted (`git restore --worktree`), untracked paths are removed
    /// (`git clean -f`).
    async fn discard(&self, paths: &[PathBuf]) -> Result<(), GitError>;

    async fn submodules(&self) -> Result<Vec<SubmoduleInfo>, GitError>;

    /// Fetch from remote(s). Cancellable via `op_id`.
    async fn fetch(&self, opts: FetchOptions, op_id: OperationId) -> Result<(), GitError>;

    /// Pull (fetch + integrate) for the current branch. Cancellable via `op_id`.
    async fn pull(&self, opts: PullOptions, op_id: OperationId) -> Result<(), GitError>;

    /// Push the current branch to its remote. Cancellable via `op_id`.
    async fn push(&self, opts: PushOptions, op_id: OperationId) -> Result<(), GitError>;

    /// Ahead/behind status of the current branch vs its upstream. `None` when
    /// HEAD is detached or the current branch has no upstream configured.
    async fn tracking_status(&self) -> Result<Option<TrackingStatus>, GitError>;
}
