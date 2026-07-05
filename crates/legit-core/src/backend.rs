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
    BlameHunk, Branch, Commit, CommitDetails, CommitFileChange, CommitId, CommitOptions,
    CommitSearchKind, ConflictEntry, ConflictFileSides, ConflictSide, DiffEntry, DiffSource,
    FetchOptions, FileStatus, HunkOp, LogOptions,
    MergeOptions, MergeOutcome, PullOptions, PushOptions, RebaseOutcome, RebaseStep,
    ReflogEntry, Remote, RemoteTag, RepoOpState, ResetMode, SequenceOutcome, StashApplyOutcome,
    StashEntry, StashOutcome, SubmoduleInfo, SwitchDirtyBehavior, SwitchOutcome, TagInfo,
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

    /// Blame a tracked file (`git blame --porcelain`): hunks of consecutive
    /// lines per commit, carrying line contents. `rev` blames the file as of
    /// that tree-ish; `None` blames the working tree, where uncommitted lines
    /// blame to the all-zeros sha.
    async fn blame(&self, path: &Path, rev: Option<&str>) -> Result<Vec<BlameHunk>, GitError>;

    /// The merge base of two revs (`git merge-base a b`), or `None` when the
    /// histories are unrelated. Backs the Compare panel's three-dot mode.
    async fn merge_base(&self, a: &str, b: &str) -> Result<Option<String>, GitError>;

    /// Full content of `path` (repo-relative) as of `rev`
    /// (`git show <rev>:<path>`). `rev` is any tree-ish.
    async fn file_at_revision(&self, rev: &str, path: &Path) -> Result<String, GitError>;

    /// Restore `path` in the index AND working tree to its content at `rev`
    /// (`git checkout <rev> -- <path>`). Destructive: git overwrites local
    /// changes to that file silently (a pathspec checkout has no dirty-tree
    /// guard), so confirmation is the caller's job.
    async fn restore_file_at_revision(&self, rev: &str, path: &Path) -> Result<(), GitError>;

    /// Search commits across HEAD + all local branches. `Message`/`Author`
    /// are case-insensitive regex matches; `Content` is the pickaxe (`-S`),
    /// which is expensive on big repos — keep `max_count` modest.
    async fn search_commits(
        &self,
        query: &str,
        kind: CommitSearchKind,
        max_count: u32,
    ) -> Result<Vec<Commit>, GitError>;

    /// Tracked paths containing `query` (case-insensitive substring), at most
    /// `max_count`, in `git ls-files` order.
    async fn search_paths(&self, query: &str, max_count: u32) -> Result<Vec<PathBuf>, GitError>;

    /// Files changed between two arbitrary revs (`git diff-tree <from> <to>`,
    /// rename-aware) — the Compare view's file list. Direct snapshot diff
    /// (two-dot); per-file contents come from `file_diff` with
    /// `DiffSource::CommitRange`.
    async fn diff_files(&self, from: &str, to: &str) -> Result<Vec<CommitFileChange>, GitError>;

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

    /// List local tags (`git for-each-ref refs/tags`), with annotated tags
    /// peeled to the commit they tag.
    async fn tags(&self) -> Result<Vec<TagInfo>, GitError>;

    /// Create a tag at `target` (a commit-ish; `None` = HEAD). With a
    /// `message` the tag is annotated (`-a -m`), otherwise lightweight.
    async fn create_tag(&self, name: &str, target: Option<&str>, message: Option<&str>) -> Result<(), GitError>;

    /// Delete a local tag (`git tag -d`). Does not touch remotes.
    async fn delete_tag(&self, name: &str) -> Result<(), GitError>;

    /// Push a single tag to `remote` (`git push <remote> refs/tags/<name>`).
    /// Network op: cancellable, auth/rejection classified.
    async fn push_tag(&self, remote: &str, name: &str, op_id: OperationId) -> Result<(), GitError>;

    /// Delete a tag on `remote` (`git push <remote> --delete refs/tags/<name>`).
    /// The local tag is untouched — local and remote deletion are separate,
    /// deliberate actions (GitKraken-style). Network op: cancellable,
    /// auth/rejection classified.
    async fn delete_remote_tag(&self, remote: &str, name: &str, op_id: OperationId) -> Result<(), GitError>;

    /// List the tags that exist on `remote` (`git ls-remote --tags`), peeled
    /// to the tagged commits. Network op: cancellable, auth classified. Drives
    /// the "pushed" indicator on tag chips/rows.
    async fn remote_tags(&self, remote: &str, op_id: OperationId) -> Result<Vec<RemoteTag>, GitError>;

    /// List the stash entries (`git stash list`), most recent first.
    async fn stashes(&self) -> Result<Vec<StashEntry>, GitError>;

    /// Stash the working tree (`git stash push`). `include_untracked` adds
    /// `--include-untracked`; `keep_index` adds `--keep-index` (the stash still
    /// records everything, but staged changes are re-applied to the index and
    /// worktree afterwards, so they stay staged). A clean working tree returns
    /// `NothingToStash` (not `Err`).
    async fn create_stash(
        &self,
        message: Option<&str>,
        include_untracked: bool,
        keep_index: bool,
    ) -> Result<StashOutcome, GitError>;

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

    /// Set or clear a local branch's upstream (tracking) configuration.
    /// `Some("origin/main")` runs `git branch --set-upstream-to=origin/main
    /// <branch>`; `None` runs `git branch --unset-upstream <branch>` (which
    /// fails if the branch has no upstream — callers gate on the branch's
    /// current `upstream`). Complements push `--set-upstream`, which only
    /// covers the publish path.
    async fn set_upstream(&self, branch: &str, upstream: Option<&str>) -> Result<(), GitError>;

    /// Create and check out `branch_name` at the commit the stash was based
    /// on, apply the stash, and drop it on success (`git stash branch`).
    /// Because the branch starts at the stash's own base, the apply cannot
    /// conflict - this is the escape hatch when a plain apply would (the base
    /// has since diverged). `stash_sha` is resolved like `apply_stash`. A
    /// dirty-tree checkout refusal is `WouldOverwriteLocalChanges`; an
    /// already-existing branch name is a plain `CommandFailed` (git's message
    /// names the branch).
    async fn stash_branch(&self, stash_sha: &str, branch_name: &str) -> Result<(), GitError>;

    /// Rename a stash's message. Git has no in-place rename, so this drops the
    /// entry and re-stores its commit under `new_message` (`git stash store`).
    /// Because `store` prepends, the renamed stash becomes `stash@{0}` —
    /// renaming an older stash reorders it to the top. `stash_sha` is resolved
    /// like `apply_stash`.
    async fn rename_stash(&self, stash_sha: &str, new_message: &str) -> Result<(), GitError>;

    /// Merge `target` into the current branch. Conflicts are an OUTCOME
    /// (`MergeOutcome::Conflicts` - merge in progress, resolve then
    /// continue/abort), not an error. Non-squash merges run with `--no-edit`
    /// (the runner's GIT_EDITOR=false would otherwise fail the message step).
    async fn merge(&self, target: &str, opts: MergeOptions) -> Result<MergeOutcome, GitError>;

    /// Conclude an in-progress merge after conflicts are resolved
    /// (`git merge --continue` with the editor neutralized; the prepared
    /// MERGE_MSG is used unchanged).
    async fn merge_continue(&self) -> Result<MergeOutcome, GitError>;

    /// Abort an in-progress merge, restoring the pre-merge state.
    async fn merge_abort(&self) -> Result<(), GitError>;

    /// Rebase the current branch onto `onto`, always with `--autostash`.
    /// A conflicted stash reapply after a successful rebase is
    /// `CompletedWithStashConflicts` (the stash entry is kept).
    async fn rebase(&self, onto: &str) -> Result<RebaseOutcome, GitError>;

    /// Continue an in-progress rebase after resolving conflicts.
    async fn rebase_continue(&self) -> Result<RebaseOutcome, GitError>;

    /// Skip the current commit of an in-progress rebase.
    async fn rebase_skip(&self) -> Result<RebaseOutcome, GitError>;

    /// Abort an in-progress rebase, restoring the original branch state.
    async fn rebase_abort(&self) -> Result<(), GitError>;

    /// Interactive rebase of `base..HEAD` following `plan` (git todo order,
    /// oldest first): reorder, squash/fixup, drop. The plan is injected into
    /// git's own todo file via `GIT_SEQUENCE_EDITOR` (no temp script); squash
    /// messages are git's auto-combined text, accepted unchanged. Always
    /// `--autostash`. Conflicts pause the normal rebase state machine —
    /// resolve via `rebase_continue` / `rebase_skip` / `rebase_abort`.
    /// Invalid plans (empty, leading squash/fixup, non-hex sha) fail before
    /// any git runs.
    async fn rebase_interactive(
        &self,
        base: &str,
        plan: &[RebaseStep],
    ) -> Result<RebaseOutcome, GitError>;

    /// `git reset --soft|--mixed|--hard <target>`. `Hard` is destructive
    /// (discards uncommitted changes) — the UI confirms before calling.
    async fn reset(&self, target: &str, mode: ResetMode) -> Result<(), GitError>;

    /// Revert a commit (`git revert --no-edit <sha>`). Conflicts pause the
    /// sequencer and are an outcome; conclude via `revert_continue` /
    /// `revert_skip` / `revert_abort`. Reverting a merge commit needs `-m`
    /// and is not supported yet — git's error is surfaced as-is.
    async fn revert(&self, sha: &str) -> Result<SequenceOutcome, GitError>;

    /// Cherry-pick a commit (`git cherry-pick <sha>`). Conflict handling
    /// mirrors `revert`.
    async fn cherry_pick(&self, sha: &str) -> Result<SequenceOutcome, GitError>;

    /// Continue a paused cherry-pick after resolving conflicts. Runs with
    /// `GIT_EDITOR=true` to accept the prepared message unchanged.
    async fn cherry_pick_continue(&self) -> Result<SequenceOutcome, GitError>;

    /// Skip the current commit of a paused cherry-pick (e.g. one whose
    /// resolution turned out empty).
    async fn cherry_pick_skip(&self) -> Result<SequenceOutcome, GitError>;

    /// Abort a paused cherry-pick, restoring the pre-op state.
    async fn cherry_pick_abort(&self) -> Result<(), GitError>;

    /// Continue a paused revert after resolving conflicts.
    async fn revert_continue(&self) -> Result<SequenceOutcome, GitError>;

    /// Skip the current commit of a paused revert.
    async fn revert_skip(&self) -> Result<SequenceOutcome, GitError>;

    /// Abort a paused revert, restoring the pre-op state.
    async fn revert_abort(&self) -> Result<(), GitError>;

    /// HEAD's reflog, newest first (`git reflog`), at most `max_count`
    /// entries. The undo safety net: every HEAD movement is here.
    async fn reflog(&self, max_count: u32) -> Result<Vec<ReflogEntry>, GitError>;

    /// Which multi-step operation (merge/rebase/cherry-pick/revert) the repo
    /// is currently in. Probed from git-reported state paths
    /// (`rev-parse --git-path`), never a hardcoded `.git` layout.
    async fn op_state(&self) -> Result<RepoOpState, GitError>;

    /// The currently conflicted paths with their conflict kinds
    /// (`git ls-files -u`).
    async fn conflict_entries(&self) -> Result<Vec<ConflictEntry>, GitError>;

    /// The three index stages of a conflicted path (`git show :1/:2/:3`),
    /// for the 3-way resolve view. A missing stage (add/add, delete
    /// conflicts) is `None`, not an error.
    async fn conflict_file_sides(&self, path: &Path) -> Result<ConflictFileSides, GitError>;

    /// Resolve a conflicted path by taking one side wholesale:
    /// `git checkout --ours|--theirs -- <path>` + `git add`; for a
    /// delete-conflict where the chosen side deleted the file, `git rm -f`.
    async fn resolve_take_side(&self, path: &Path, side: ConflictSide) -> Result<(), GitError>;
}
