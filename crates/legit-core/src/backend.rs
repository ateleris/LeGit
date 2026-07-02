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
    DiffSource, FetchOptions, FileStatus, HunkOp, LogOptions, PullOptions, PushOptions, Remote,
    StashApplyOutcome, StashEntry, StashOutcome, SubmoduleInfo, SwitchDirtyBehavior, SwitchOutcome,
    TrackingStatus,
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

    /// Reword (rename) a commit's message, returning the new commit id.
    ///
    /// v1 supports rewording **HEAD only** (`RewordNotHead` otherwise) and
    /// **refuses** a commit already reachable from a remote-tracking ref
    /// (`RewordPushed`), since rewording rewrites history. The original author
    /// and staged changes are preserved (`git commit --amend --only`).
    async fn reword_commit(&self, id: &CommitId, message: &str) -> Result<CommitId, GitError>;

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

    /// List the configured remotes with their fetch/push URLs (`git remote -v`).
    async fn list_remotes(&self) -> Result<Vec<Remote>, GitError>;

    /// Add a remote (`git remote add <name> <url>`).
    async fn add_remote(&self, name: &str, url: &str) -> Result<(), GitError>;

    /// Remove a remote and its tracking refs (`git remote remove <name>`).
    async fn remove_remote(&self, name: &str) -> Result<(), GitError>;

    /// Rename a remote (`git remote rename <old> <new>`).
    async fn rename_remote(&self, old: &str, new: &str) -> Result<(), GitError>;

    /// Set a remote's URL (`git remote set-url [--push] <name> <url>`).
    async fn set_remote_url(&self, name: &str, url: &str, push: bool) -> Result<(), GitError>;

    /// Prune stale remote-tracking refs (`git remote prune <name>`). Network op,
    /// cancellable via `op_id`.
    async fn prune_remote(&self, name: &str, op_id: OperationId) -> Result<(), GitError>;

    /// Create a local branch. `start_point` is a branch name, tag, or commit SHA;
    /// `None` creates from the current HEAD.
    async fn create_branch(&self, name: &str, start_point: Option<&str>) -> Result<(), GitError>;

    /// Switch to a branch. With `behavior = AutoStash`, stashes uncommitted
    /// changes first and reapplies *that specific* stash entry (addressed by
    /// SHA) after switching; with `StashAndKeep` the entry is deliberately
    /// left parked instead (`ChangesStashed`). A clean working tree stashes
    /// nothing and pops nothing — pre-existing stash entries are never
    /// touched. The switch succeeding but the reapply not being clean is an
    /// *outcome*, not an error: `StashPopConflicts` (applied with conflict
    /// markers, stash kept) or `StashPopFailed` (not applied, changes remain
    /// in the stash). A dirty-tree refusal under `TryDirectly` returns
    /// `WouldOverwriteLocalChanges`.
    async fn switch_branch(&self, name: &str, behavior: SwitchDirtyBehavior) -> Result<SwitchOutcome, GitError>;

    /// Check out a remote-tracking branch. Accepts `origin/feature-x` or the
    /// full `refs/remotes/origin/feature-x`. Creates a local tracking branch
    /// (`git switch --track`); if the local counterpart already exists, plain-
    /// switches to it instead. Honors `behavior` for dirty-tree handling
    /// identically to `switch_branch`.
    async fn checkout_remote_branch(&self, remote_ref: &str, behavior: SwitchDirtyBehavior) -> Result<SwitchOutcome, GitError>;

    /// Delete a local branch. `force = true` maps to `-D`; `false` uses `-d`.
    async fn delete_branch(&self, name: &str, force: bool) -> Result<(), GitError>;

    /// Rename a local branch (`git branch -m <old> <new>`).
    async fn rename_branch(&self, old_name: &str, new_name: &str) -> Result<(), GitError>;

    /// Check out a commit by SHA, entering detached HEAD.
    /// Respects `behavior` for dirty-tree handling identically to `switch_branch`.
    async fn checkout_commit(&self, sha: &str, behavior: SwitchDirtyBehavior) -> Result<SwitchOutcome, GitError>;

    /// List the stash entries (`git stash list`), most recent first.
    async fn stashes(&self) -> Result<Vec<StashEntry>, GitError>;

    /// Stash the working tree (`git stash push`). `include_untracked` adds
    /// `--include-untracked`. A clean working tree returns `NothingToStash`
    /// (not `Err`).
    async fn create_stash(&self, message: Option<&str>, include_untracked: bool) -> Result<StashOutcome, GitError>;

    /// Apply a stash without removing it (`git stash apply`). `stash_sha` is the
    /// stash's commit SHA; it is resolved to the *current* `stash@{N}` selector at
    /// call time, so the action is immune to reflog reordering between when the
    /// UI rendered and when the user clicked (positional selectors shift on every
    /// create/drop/pop, including ones made outside the app). A merge
    /// conflict returns `Conflicts` (not `Err`). A SHA that is no longer a stash
    /// entry returns `RefNotFound`.
    async fn apply_stash(&self, stash_sha: &str) -> Result<StashApplyOutcome, GitError>;

    /// Apply a stash and remove it on success (`git stash pop`). `stash_sha` is
    /// resolved like `apply_stash`. On conflict the stash is retained (git's
    /// behavior) and `Conflicts` is returned.
    async fn pop_stash(&self, stash_sha: &str) -> Result<StashApplyOutcome, GitError>;

    /// Drop a stash (`git stash drop`). `stash_sha` is resolved like
    /// `apply_stash` — dropping by SHA can never remove the wrong entry when the
    /// list has shifted since the UI rendered.
    async fn drop_stash(&self, stash_sha: &str) -> Result<(), GitError>;

    /// Rename a stash's message. Git has no in-place rename, so this drops the
    /// entry and re-stores its commit under `new_message` (`git stash store`).
    /// Because `store` prepends, the renamed stash becomes `stash@{0}` —
    /// renaming an older stash reorders it to the top. `stash_sha` is resolved
    /// like `apply_stash`.
    async fn rename_stash(&self, stash_sha: &str, new_message: &str) -> Result<(), GitError>;
}
