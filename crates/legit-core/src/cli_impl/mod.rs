//! `GitCliBackend` — the CLI-backed `GitBackend` implementation.
//!
//! Every trait method shells out through the executor seam (`GitExecutor`;
//! `GitRunner` in production) and hands raw text to the pure parsers in
//! `parsers/`. Composed flows (auto-stash switch, conflict handling,
//! submodule updates, ...) live here and are tested at two levels:
//! `flow_tests.rs` scripts exact command sequences against a `FakeExecutor`,
//! and `tests/git_flows.rs` validates the encoded git-behavior assumptions
//! against the real binary.

use crate::backend::GitBackend;
use crate::error::GitError;
use crate::executor::GitExecutor;
use crate::fs::HostPath;
use crate::runner::{GitRunner, OperationId};
use crate::types::{
    BlameHunk, BlobBytes, Branch, BranchMergeAnalysis, CaseDriftEntry, Commit, CommitDetails, CommitFileChange, CommitId, CommitOptions,
    CommitSearchKind, ConflictEntry, ConflictFileSides, ConflictSide, DiffEntry, DiffSource,
    FastForwardResult, FetchOptions, FfMode, FileAtRevision, FileHistoryEntry, FileState, FileStatus,
    GitmodulesFinding,
    HunkOp, LfsStatus, LfsStubs, LogOptions, MergeOptions, MergeOutcome, PullOptions, PullOutcome, PullStrategy, PushOptions, PushRecurseMode,
    RebaseAction, RebaseOutcome, RebaseRangeInfo, RebaseStep, RefDecoration, RefSelector,
    ReflogEntry, Remote,
    RemoteCheckoutOutcome, RemoteTag,
    RenormalizeOutcome, RepoFileEntry, RepoFileKind, RepoOpState, ResetMode, SequenceOutcome, SignMode, StashApplyOutcome, StashEntry,
    StashOutcome, SubmoduleAutoUpdateResult, SubmoduleChange, SubmoduleGitdirInfo,
    SubmoduleInfo, SubmoduleLog, SubmoduleUpdateOptions, SubmoduleUpdateStrategy,
    SwitchDirtyBehavior, SwitchOutcome, SwitchResult, TagInfo, TrackingStatus, WorktreeAddMode, WorktreeInfo,
};

/// Display cap for a single file's diff text. Above this the entry crosses
/// IPC as `DiffEntry::TooLarge` instead of content - aligned with the
/// preview path's `MAX_PREVIEW_BYTES` (20 MB).
const MAX_DIFF_TEXT_BYTES: usize = 20 * 1024 * 1024;

/// Git's well-known empty-tree object id, used as the "before" side when
/// diffing a root commit (which has no parent).
const EMPTY_TREE_OID: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/// Git's binary heuristic: a NUL byte within the leading window marks the
/// content binary. The window matches git's own (`buffer_is_binary`, 8000
/// bytes) so LeGit and git classify a blob identically; lossy UTF-8 decoding
/// preserves NUL bytes, so sniffing the decoded string is sound.
pub const BINARY_SNIFF_WINDOW: usize = 8000;

/// Byte-level form of the sniff, for callers that hold raw bytes.
pub fn is_binary_bytes(bytes: &[u8]) -> bool {
    bytes.iter().take(BINARY_SNIFF_WINDOW).any(|&b| b == 0)
}

fn is_binary_content(content: &str) -> bool {
    is_binary_bytes(content.as_bytes())
}
use async_trait::async_trait;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::RwLock;

pub mod parsers;
mod case_drift;
mod classify;
use classify::*;
mod history;
mod changes;
use changes::*;
mod commits;
mod lfs;
mod remote;
mod branch;
mod tags;
#[cfg(test)]
use tags::*;
mod stash;
use stash::*;
mod sequencer;
#[cfg(test)]
use sequencer::*;
mod conflicts;
pub use classify::{classify_remote_error, lfs_stubs_from_stderr};
mod line_endings;
mod worktrees;
pub use line_endings::*;
mod submodules;

#[cfg(test)]
mod flow_tests;

/// The CLI-backed implementation of `GitBackend`. Holds a shared
/// `Arc<RwLock<Arc<E>>>` so the runner can be hot-swapped by
/// `RepoSession` (e.g. on per-repo git-path override) without disrupting
/// in-flight operations. Each method snapshots the current runner by locking,
/// cloning the inner `Arc`, then releasing before use (DESIGN-v0.3.md §C.5/F.3).
///
/// Generic over `GitExecutor` so composed flows are testable with a scripted
/// fake; production code uses the default `GitRunner` and is unaffected.
pub struct GitCliBackend<E: GitExecutor + ?Sized = GitRunner> {
    runner: Arc<RwLock<Arc<E>>>,
    /// Host-filesystem access for the few flows that must read/mutate repo
    /// files directly (op-state probe, submodule gitdir maintenance). Always
    /// the filesystem of the machine the *repo* lives on — `LocalFs` for
    /// local repos, the agent-backed impl for remote ones.
    fs: Arc<dyn crate::fs::RepoFs>,
    /// Per-SHA signature-*presence* results (see `signature_presence`).
    /// Presence is immutable per SHA, so entries are never invalidated: a
    /// repeat query only pays the batched `cat-file` for commits not seen
    /// this session. std Mutex - held only for map access, never across an
    /// await.
    sig_presence: std::sync::Mutex<HashMap<String, bool>>,
}

impl<E: GitExecutor + ?Sized> GitCliBackend<E> {
    pub fn new(runner: Arc<RwLock<Arc<E>>>, fs: Arc<dyn crate::fs::RepoFs>) -> Self {
        Self {
            runner,
            fs,
            sig_presence: std::sync::Mutex::new(HashMap::new()),
        }
    }

    /// Snapshot the current runner without holding the lock during I/O.
    pub async fn runner(&self) -> Arc<E> {
        self.runner.read().await.clone()
    }

    /// Run a cancellable remote operation (fetch/pull/push) and map a non-zero
    /// exit through `classify_remote_error` so auth/rejection failures surface as
    /// specific `GitError` variants. A user-cancelled op also returns a non-zero
    /// `RunOutput` (the frontend, which initiated the cancel, suppresses its toast).
    async fn run_remote(
        &self,
        runner: &E,
        args: &[String],
        op_id: OperationId,
    ) -> Result<(), GitError> {
        self.run_remote_output(runner, args, op_id).await.map(|_| ())
    }

    /// `run_remote` keeping the successful output: for flows that must
    /// inspect an exit-0 stderr (a pull can "succeed" while LFS downloads
    /// failed).
    async fn run_remote_output(
        &self,
        runner: &E,
        args: &[String],
        op_id: OperationId,
    ) -> Result<crate::runner::RunOutput, GitError> {
        let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
        let output = runner
            .run_with_op_progress(&arg_refs, op_id)
            .await?;
        if !output.success {
            return Err(classify_remote_error(
                output.exit_code.unwrap_or(-1),
                &output.stderr,
            ));
        }
        Ok(output)
    }

    /// Run args and return (exit_code, stdout, stderr) with 0 for success:
    /// the classifier-friendly shape for merge/rebase commands, whose non-zero
    /// exits may still be successful *outcomes* (conflicts).
    async fn run_classified(&self, args: &[&str]) -> Result<(i32, String, String), GitError> {
        let runner = self.runner().await;
        let out = runner
            .run(args)
            .await?;
        let code = if out.success { 0 } else { out.exit_code.unwrap_or(-1) };
        Ok((code, out.stdout, out.stderr))
    }

    /// Like `run_classified`, but with per-invocation env overrides (see
    /// `EDITOR_ACCEPT_ENV`).
    async fn run_classified_env(
        &self,
        args: &[&str],
        extra_env: &[(&str, &str)],
    ) -> Result<(i32, String, String), GitError> {
        let runner = self.runner().await;
        let out = runner
            .run_with_env(args, extra_env)
            .await?;
        let code = if out.success { 0 } else { out.exit_code.unwrap_or(-1) };
        Ok((code, out.stdout, out.stderr))
    }

    /// Run args and map a non-zero exit to `CommandFailed`, discarding output.
    async fn run_simple(&self, args: &[&str]) -> Result<(), GitError> {
        self.run_checked(args).await.map(|_| ())
    }

    /// Run args, map a non-zero exit to `CommandFailed`, and return stdout on
    /// success - the read-path counterpart to `run_simple`.
    async fn run_checked(&self, args: &[&str]) -> Result<String, GitError> {
        let runner = self.runner().await;
        let output = runner.run(args).await?;
        Self::ensure_success(&output)?;
        Ok(output.stdout)
    }

    /// The repository's git directory, absolute (worktrees and submodules
    /// relocate it away from `<root>/.git`).
    async fn absolute_git_dir(&self) -> Result<HostPath, GitError> {
        let dir = self.run_checked(&["rev-parse", "--absolute-git-dir"]).await?;
        Ok(HostPath(dir.trim().to_string()))
    }

    /// Map a non-zero exit to `CommandFailed` - the single place this variant
    /// is built for unclassified failures, so exit-code/stderr handling cannot
    /// drift between methods. Flows that classify non-zero exits as outcomes
    /// (merge, rebase, stash apply) go through `run_classified` instead.
    fn ensure_success(output: &crate::runner::RunOutput) -> Result<(), GitError> {
        if output.success {
            Ok(())
        } else {
            Err(command_failed(output.exit_code.unwrap_or(-1), &output.stderr))
        }
    }

}

#[async_trait]
impl<E: GitExecutor + ?Sized> GitBackend for GitCliBackend<E> {
    async fn status(&self) -> Result<Vec<FileStatus>, GitError> {
        self.status().await
    }

    async fn log(&self, opts: LogOptions) -> Result<Vec<Commit>, GitError> {
        self.log(opts).await
    }

    async fn signature_presence(&self, ids: &[CommitId]) -> Result<Vec<CommitId>, GitError> {
        self.signature_presence(ids).await
    }

    async fn commit_details(&self, id: &CommitId) -> Result<CommitDetails, GitError> {
        self.commit_details(id).await
    }

    async fn commit_files(&self, id: &CommitId) -> Result<Vec<CommitFileChange>, GitError> {
        self.commit_files(id).await
    }

    async fn branches(&self) -> Result<Vec<Branch>, GitError> {
        self.branches().await
    }

    async fn blame(&self, path: &Path, rev: Option<&str>) -> Result<Vec<BlameHunk>, GitError> {
        self.blame(path, rev).await
    }

    async fn merge_base(&self, a: &str, b: &str) -> Result<Option<String>, GitError> {
        self.merge_base(a, b).await
    }

    async fn search_commits(
        &self,
        query: &str,
        kind: CommitSearchKind,
        max_count: u32,
    ) -> Result<Vec<Commit>, GitError> {
        self.search_commits(query, kind, max_count).await
    }

    async fn search_paths(&self, query: &str, max_count: u32) -> Result<Vec<PathBuf>, GitError> {
        self.search_paths(query, max_count).await
    }

    async fn resolve_commit(&self, rev: &str) -> Result<CommitId, GitError> {
        self.resolve_commit(rev).await
    }

    async fn list_repo_files(
        &self,
        show_ignored: bool,
    ) -> Result<Vec<RepoFileEntry>, GitError> {
        self.list_repo_files(show_ignored).await
    }

    async fn list_files_at_revision(&self, rev: &str) -> Result<Vec<RepoFileEntry>, GitError> {
        self.list_files_at_revision(rev).await
    }

    async fn rm_cached(&self, paths: &[PathBuf]) -> Result<(), GitError> {
        self.rm_cached(paths).await
    }

    async fn diff_files(&self, from: &str, to: &str) -> Result<Vec<CommitFileChange>, GitError> {
        self.diff_files(from, to).await
    }

    async fn file_diff(
        &self,
        source: &DiffSource,
        path: &Path,
        old_path: Option<&Path>,
        context: u32,
    ) -> Result<DiffEntry, GitError> {
        self.file_diff(source, path, old_path, context).await
    }

    async fn apply_hunk(
        &self,
        path: &Path,
        hunk_index: usize,
        op: HunkOp,
    ) -> Result<(), GitError> {
        self.apply_hunk(path, hunk_index, op).await
    }

    async fn apply_lines(
        &self,
        path: &Path,
        hunk_index: usize,
        line_indices: &[usize],
        op: HunkOp,
    ) -> Result<(), GitError> {
        self.apply_lines(path, hunk_index, line_indices, op).await
    }

    async fn commit(&self, opts: CommitOptions) -> Result<CommitId, GitError> {
        self.commit(opts).await
    }

    async fn reword_commit(&self, id: &CommitId, message: &str) -> Result<CommitId, GitError> {
        self.reword_commit(id, message).await
    }

    async fn stage(&self, paths: &[PathBuf]) -> Result<(), GitError> {
        self.stage(paths).await
    }

    async fn unstage(&self, paths: &[PathBuf]) -> Result<(), GitError> {
        self.unstage(paths).await
    }

    async fn renormalize_preview(&self) -> Result<Vec<String>, GitError> {
        self.renormalize_preview().await
    }

    async fn lfs_attribute_files(&self) -> Result<Vec<String>, GitError> {
        self.lfs_attribute_files().await
    }

    async fn absolute_git_dir(&self) -> Result<HostPath, GitError> {
        GitCliBackend::absolute_git_dir(self).await
    }

    async fn line_ending_entries(
        &self,
        inputs: Vec<LineEndingInput>,
    ) -> Result<Vec<crate::types::LineEndingStatusEntry>, GitError> {
        self.line_ending_entries(inputs).await
    }

    async fn renormalize(&self) -> Result<RenormalizeOutcome, GitError> {
        self.renormalize().await
    }

    async fn discard(&self, paths: &[PathBuf]) -> Result<(), GitError> {
        self.discard(paths).await
    }

    async fn file_at_revision(&self, rev: &str, path: &Path) -> Result<FileAtRevision, GitError> {
        self.file_at_revision(rev, path).await
    }

    async fn blob_bytes(&self, spec: &str, cap: u64) -> Result<BlobBytes, GitError> {
        self.blob_bytes(spec, cap).await
    }

    async fn restore_file_at_revision(&self, rev: &str, path: &Path) -> Result<(), GitError> {
        self.restore_file_at_revision(rev, path).await
    }

    async fn apply_stash_file(&self, stash_sha: &str, path: &Path) -> Result<(), GitError> {
        self.apply_stash_file(stash_sha, path).await
    }

    async fn file_history(
        &self,
        path: &Path,
        max_count: u32,
        skip: u32,
        start_rev: Option<&str>,
    ) -> Result<Vec<FileHistoryEntry>, GitError> {
        self.file_history(path, max_count, skip, start_rev).await
    }

    // Submodule methods delegate to the same-named inherent methods in
    // submodules.rs; inherent methods win resolution, so this is delegation,
    // not recursion.
    async fn submodules(&self) -> Result<Vec<SubmoduleInfo>, GitError> {
        self.submodules().await
    }

    async fn submodule_log(
        &self,
        path: &Path,
        from: Option<&CommitId>,
        to: &CommitId,
    ) -> Result<SubmoduleLog, GitError> {
        self.submodule_log(path, from, to).await
    }

    async fn submodule_update(
        &self,
        opts: SubmoduleUpdateOptions,
        op_id: OperationId,
    ) -> Result<Option<LfsStubs>, GitError> {
        self.submodule_update(opts, op_id).await
    }

    async fn submodule_sync(&self, paths: &[PathBuf], recursive: bool) -> Result<(), GitError> {
        self.submodule_sync(paths, recursive).await
    }

    async fn submodule_fetch(&self, path: &Path, op_id: OperationId) -> Result<(), GitError> {
        self.submodule_fetch(path, op_id).await
    }

    async fn superproject_path(&self) -> Result<Option<PathBuf>, GitError> {
        self.superproject_path().await
    }
    async fn lfs_status(&self) -> Result<LfsStatus, GitError> {
        self.lfs_status().await
    }

    async fn lfs_tracked_subset(&self, paths: &[String]) -> Result<Vec<String>, GitError> {
        self.lfs_tracked_subset(paths).await
    }

    async fn submodule_add(
        &self,
        url: &str,
        path: &Path,
        branch: Option<&str>,
        op_id: OperationId,
    ) -> Result<(), GitError> {
        self.submodule_add(url, path, branch, op_id).await
    }

    async fn submodule_set_url(&self, path: &Path, url: &str) -> Result<(), GitError> {
        self.submodule_set_url(path, url).await
    }

    async fn submodule_set_branch(&self, path: &Path, branch: Option<&str>) -> Result<(), GitError> {
        self.submodule_set_branch(path, branch).await
    }

    async fn submodule_update_remote(
        &self,
        paths: &[PathBuf],
        strategy: SubmoduleUpdateStrategy,
        behavior: SwitchDirtyBehavior,
        attach_branch: bool,
        op_id: OperationId,
    ) -> Result<Vec<SubmoduleAutoUpdateResult>, GitError> {
        self.submodule_update_remote(paths, strategy, behavior, attach_branch, op_id)
            .await
    }

    async fn gitmodules_consistency(&self) -> Result<Vec<GitmodulesFinding>, GitError> {
        self.gitmodules_consistency().await
    }

    async fn case_drift(&self) -> Result<Vec<CaseDriftEntry>, GitError> {
        self.case_drift().await
    }

    async fn stage_case_rename(&self, from: &str, to: &str) -> Result<(), GitError> {
        self.stage_case_rename(from, to).await
    }

    async fn discard_case_rename(
        &self,
        index_path: &str,
        disk_path: &str,
    ) -> Result<(), GitError> {
        self.discard_case_rename(index_path, disk_path).await
    }

    async fn worktree_list(&self) -> Result<Vec<WorktreeInfo>, GitError> {
        self.worktree_list().await
    }

    async fn worktree_add(&self, path: &str, mode: &WorktreeAddMode) -> Result<(), GitError> {
        self.worktree_add(path, mode).await
    }

    async fn worktree_remove(&self, path: &str, force: bool) -> Result<(), GitError> {
        self.worktree_remove(path, force).await
    }

    async fn worktree_prune(&self) -> Result<(), GitError> {
        self.worktree_prune().await
    }

    async fn worktree_lock(&self, path: &str, reason: Option<&str>) -> Result<(), GitError> {
        self.worktree_lock(path, reason).await
    }

    async fn worktree_unlock(&self, path: &str) -> Result<(), GitError> {
        self.worktree_unlock(path).await
    }

    async fn unpushed_commits(&self, max_count: u32) -> Result<Vec<CommitId>, GitError> {
        self.unpushed_commits(max_count).await
    }

    async fn submodule_remove(&self, path: &Path) -> Result<(), GitError> {
        self.submodule_remove(path).await
    }

    async fn submodule_move(&self, from: &Path, to: &Path) -> Result<(), GitError> {
        self.submodule_move(from, to).await
    }

    async fn submodule_gitdir_info(
        &self,
        name: &str,
    ) -> Result<Option<SubmoduleGitdirInfo>, GitError> {
        self.submodule_gitdir_info(name).await
    }

    async fn submodule_delete_gitdir(&self, name: &str) -> Result<(), GitError> {
        self.submodule_delete_gitdir(name).await
    }

    async fn submodule_create_branch(&self, path: &Path, name: &str) -> Result<(), GitError> {
        self.submodule_create_branch(path, name).await
    }

    async fn submodule_auto_update(
        &self,
        behavior: SwitchDirtyBehavior,
        attach_branch: bool,
    ) -> Result<Vec<SubmoduleAutoUpdateResult>, GitError> {
        self.submodule_auto_update(behavior, attach_branch).await
    }
    async fn fetch(&self, opts: FetchOptions, op_id: OperationId) -> Result<(), GitError> {
        self.fetch(opts, op_id).await
    }

    async fn pull(&self, opts: PullOptions, op_id: OperationId) -> Result<PullOutcome, GitError> {
        self.pull(opts, op_id).await
    }

    async fn push(&self, opts: PushOptions, op_id: OperationId) -> Result<(), GitError> {
        self.push(opts, op_id).await
    }

    async fn tracking_status(&self) -> Result<Option<TrackingStatus>, GitError> {
        self.tracking_status().await
    }

    async fn list_remotes(&self) -> Result<Vec<Remote>, GitError> {
        self.list_remotes().await
    }

    async fn add_remote(&self, name: &str, url: &str) -> Result<(), GitError> {
        self.add_remote(name, url).await
    }

    async fn remove_remote(&self, name: &str) -> Result<(), GitError> {
        self.remove_remote(name).await
    }

    async fn rename_remote(&self, old: &str, new: &str) -> Result<(), GitError> {
        self.rename_remote(old, new).await
    }

    async fn set_remote_url(&self, name: &str, url: &str, push: bool) -> Result<(), GitError> {
        self.set_remote_url(name, url, push).await
    }

    async fn prune_remote(&self, name: &str, op_id: OperationId) -> Result<(), GitError> {
        self.prune_remote(name, op_id).await
    }

    async fn create_branch(&self, name: &str, start_point: Option<&str>) -> Result<(), GitError> {
        self.create_branch(name, start_point).await
    }

    async fn switch_branch(&self, name: &str, behavior: SwitchDirtyBehavior) -> Result<SwitchResult, GitError> {
        self.switch_branch(name, behavior).await
    }

    async fn checkout_commit(&self, sha: &str, behavior: SwitchDirtyBehavior) -> Result<SwitchResult, GitError> {
        self.checkout_commit(sha, behavior).await
    }

    async fn checkout_remote_branch(
        &self,
        remote_ref: &str,
        behavior: SwitchDirtyBehavior,
        fast_forward: bool,
    ) -> Result<RemoteCheckoutOutcome, GitError> {
        self.checkout_remote_branch(remote_ref, behavior, fast_forward).await
    }

    async fn delete_branch(&self, name: &str, force: bool) -> Result<(), GitError> {
        self.delete_branch(name, force).await
    }

    async fn branch_merge_analysis(&self, name: &str) -> Result<BranchMergeAnalysis, GitError> {
        self.branch_merge_analysis(name).await
    }

    async fn delete_remote_branch(
        &self,
        remote: &str,
        name: &str,
        op_id: OperationId,
    ) -> Result<(), GitError> {
        self.delete_remote_branch(remote, name, op_id).await
    }

    async fn rename_branch(&self, old_name: &str, new_name: &str) -> Result<(), GitError> {
        self.rename_branch(old_name, new_name).await
    }

    async fn tags(&self) -> Result<Vec<TagInfo>, GitError> {
        self.tags().await
    }

    async fn create_tag(
        &self,
        name: &str,
        target: Option<&str>,
        message: Option<&str>,
    ) -> Result<(), GitError> {
        self.create_tag(name, target, message).await
    }

    async fn delete_tag(&self, name: &str) -> Result<(), GitError> {
        self.delete_tag(name).await
    }

    async fn push_tag(&self, remote: &str, name: &str, op_id: OperationId) -> Result<(), GitError> {
        self.push_tag(remote, name, op_id).await
    }

    async fn delete_remote_tag(
        &self,
        remote: &str,
        name: &str,
        op_id: OperationId,
    ) -> Result<(), GitError> {
        self.delete_remote_tag(remote, name, op_id).await
    }

    async fn remote_tags(&self, remote: &str, op_id: OperationId) -> Result<Vec<RemoteTag>, GitError> {
        self.remote_tags(remote, op_id).await
    }

    async fn stashes(&self) -> Result<Vec<StashEntry>, GitError> {
        self.stashes().await
    }

    async fn create_stash(
        &self,
        message: Option<&str>,
        include_untracked: bool,
        keep_index: bool,
    ) -> Result<StashOutcome, GitError> {
        self.create_stash(message, include_untracked, keep_index).await
    }

    async fn create_stash_paths(
        &self,
        message: Option<&str>,
        paths: &[PathBuf],
    ) -> Result<StashOutcome, GitError> {
        self.create_stash_paths(message, paths).await
    }

    async fn apply_stash(&self, stash_sha: &str) -> Result<StashApplyOutcome, GitError> {
        self.apply_stash(stash_sha).await
    }

    async fn pop_stash(&self, stash_sha: &str) -> Result<StashApplyOutcome, GitError> {
        self.pop_stash(stash_sha).await
    }

    async fn drop_stash(&self, stash_sha: &str) -> Result<(), GitError> {
        self.drop_stash(stash_sha).await
    }

    async fn set_upstream(&self, branch: &str, upstream: Option<&str>) -> Result<(), GitError> {
        self.set_upstream(branch, upstream).await
    }

    async fn stash_branch(&self, stash_sha: &str, branch_name: &str) -> Result<(), GitError> {
        self.stash_branch(stash_sha, branch_name).await
    }

    async fn rename_stash(&self, stash_sha: &str, new_message: &str) -> Result<(), GitError> {
        self.rename_stash(stash_sha, new_message).await
    }

    async fn merge(&self, target: &str, opts: MergeOptions) -> Result<MergeOutcome, GitError> {
        self.merge(target, opts).await
    }

    async fn merge_continue(&self) -> Result<MergeOutcome, GitError> {
        self.merge_continue().await
    }

    async fn merge_abort(&self) -> Result<(), GitError> {
        self.merge_abort().await
    }

    async fn rebase(&self, onto: &str) -> Result<RebaseOutcome, GitError> {
        self.rebase(onto).await
    }

    async fn rebase_continue(&self) -> Result<RebaseOutcome, GitError> {
        self.rebase_continue().await
    }

    async fn rebase_skip(&self) -> Result<RebaseOutcome, GitError> {
        self.rebase_skip().await
    }

    async fn rebase_abort(&self) -> Result<(), GitError> {
        self.rebase_abort().await
    }

    async fn conflict_file_sides(&self, path: &Path) -> Result<ConflictFileSides, GitError> {
        self.conflict_file_sides(path).await
    }

    async fn rebase_interactive(
        &self,
        base: &str,
        plan: &[RebaseStep],
    ) -> Result<RebaseOutcome, GitError> {
        self.rebase_interactive(base, plan).await
    }

    async fn rebase_range_info(&self, base: &str) -> Result<RebaseRangeInfo, GitError> {
        self.rebase_range_info(base).await
    }

    async fn reset(&self, target: &str, mode: ResetMode) -> Result<(), GitError> {
        self.reset(target, mode).await
    }

    async fn revert(&self, shas: &[String], mainline: Option<u32>) -> Result<SequenceOutcome, GitError> {
        self.revert(shas, mainline).await
    }

    async fn cherry_pick(&self, shas: &[String], mainline: Option<u32>) -> Result<SequenceOutcome, GitError> {
        self.cherry_pick(shas, mainline).await
    }

    async fn cherry_pick_continue(&self) -> Result<SequenceOutcome, GitError> {
        self.cherry_pick_continue().await
    }

    async fn cherry_pick_skip(&self) -> Result<SequenceOutcome, GitError> {
        self.cherry_pick_skip().await
    }

    async fn cherry_pick_abort(&self) -> Result<(), GitError> {
        self.cherry_pick_abort().await
    }

    async fn revert_continue(&self) -> Result<SequenceOutcome, GitError> {
        self.revert_continue().await
    }

    async fn revert_skip(&self) -> Result<SequenceOutcome, GitError> {
        self.revert_skip().await
    }

    async fn revert_abort(&self) -> Result<(), GitError> {
        self.revert_abort().await
    }

    async fn reflog(&self, max_count: u32) -> Result<Vec<ReflogEntry>, GitError> {
        self.reflog(max_count).await
    }

    async fn op_state(&self) -> Result<RepoOpState, GitError> {
        self.op_state().await
    }

    async fn conflict_entries(&self) -> Result<Vec<ConflictEntry>, GitError> {
        self.conflict_entries().await
    }

    async fn resolve_take_side(&self, path: &Path, side: ConflictSide) -> Result<(), GitError> {
        self.resolve_take_side(path, side).await
    }

    async fn resolve_undo_paths(&self) -> Result<Vec<String>, GitError> {
        self.resolve_undo_paths().await
    }

    async fn staged_marker_paths(&self) -> Result<Vec<String>, GitError> {
        self.staged_marker_paths().await
    }

    async fn unstaged_marker_paths(&self) -> Result<Vec<String>, GitError> {
        self.unstaged_marker_paths().await
    }

    async fn conflict_reopen(&self, path: &Path) -> Result<(), GitError> {
        self.conflict_reopen(path).await
    }
}

/// The guard every ref / rev / remote name passes before it enters a
/// POSITIONAL argv slot. Refuses anything that starts with `-`.
///
/// Git accepts refnames beginning with a dash, and such a name reaches us
/// from the repository itself, not from the user: `git update-ref
/// 'refs/tags/--exec=cmd'` succeeds, `git clone` copies that tag verbatim,
/// and a remote whose `HEAD` points at `refs/heads/--exec=cmd` makes clone
/// CREATE and check out a local branch with that name. Git then parses a
/// positional argument beginning with `-` as an OPTION, and several commands
/// have options that run programs or write files - `git rebase --autostash
/// --exec=<cmd>` executes `<cmd>` for every rebased commit. So a repo the
/// user merely clones could turn one ordinary UI action (Rebase onto, from
/// the ref's own context menu) into arbitrary command execution.
///
/// Refnames can hold no spaces, but `$IFS` supplies one, so a space-free
/// payload is not a real constraint for an attacker.
///
/// This is one of TWO independent layers: the argv builders also pass
/// `--end-of-options` wherever git supports it (`reset` and
/// `checkout <rev> -- <path>` reject it, which is exactly why this layer
/// exists). Pinned by `flow_tests.rs` (argv) and `tests/git_flows.rs`
/// (real git, payload must not run).
///
/// `what` names the thing for the message ("branch", "tag", "revision", …).
/// Only leading dashes are refused: everything else git rejects on its own
/// with a better message than we could invent.
fn fs_internal(e: crate::fs::FsError) -> GitError {
    GitError::Internal(e.to_string())
}

fn safe_ref<'a>(what: &str, value: &'a str) -> Result<&'a str, GitError> {
    if value.starts_with('-') {
        return Err(GitError::UnsafeArgument(format!(
            "Refusing to run git with an option-like {what}: {value:?}. \
             A name starting with '-' would be interpreted as a command-line \
             option, not as a {what} - a repository can carry such a name on \
             purpose. Rename it (git branch -m / git tag) before using it here."
        )));
    }
    Ok(value)
}

/// `safe_ref` for an owned value, for the argv builders that work in
/// `String`s (`push`, `fetch`, …).
fn safe_ref_owned(what: &str, value: &str) -> Result<String, GitError> {
    safe_ref(what, value).map(str::to_string)
}
