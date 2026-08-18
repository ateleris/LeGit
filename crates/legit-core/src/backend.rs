//! The `GitBackend` trait — the contract between the UI/command layer and
//! the implementation that actually performs Git operations.
//!
//! The only implementation is `GitCliBackend` (DESIGN.md §4.3), which runs
//! the real `git` CLI through `GitRunner`. The trait exists so composed
//! flows can be tested against a scripted executor and so the command layer
//! never depends on how git is invoked.

use crate::error::GitError;
use crate::runner::OperationId;
use crate::types::{
    BlameHunk, BlobBytes, Branch, Commit, CommitDetails, CommitFileChange, CommitId, CommitOptions,
    CommitSearchKind, ConflictEntry, ConflictFileSides, ConflictSide, DiffEntry, DiffSource,
    FetchOptions, FileAtRevision, FileHistoryEntry, FileStatus, HunkOp, LfsStatus, LogOptions,
    MergeOptions, MergeOutcome, PullOptions, PushOptions, RebaseOutcome, RebaseStep,
    ReflogEntry, Remote, RemoteTag, RenormalizeOutcome, RepoFileEntry, RepoOpState, ResetMode, SequenceOutcome, StashApplyOutcome,
    StashEntry, StashOutcome, SubmoduleAutoUpdateResult, SubmoduleGitdirInfo, SubmoduleInfo,
    SubmoduleLog, SubmoduleUpdateOptions, SubmoduleUpdateStrategy, SwitchDirtyBehavior,
    SwitchOutcome, TagInfo, TrackingStatus,
};
use async_trait::async_trait;
use std::path::{Path, PathBuf};

#[async_trait]
pub trait GitBackend: Send + Sync {
    async fn status(&self) -> Result<Vec<FileStatus>, GitError>;

    async fn log(&self, opts: LogOptions) -> Result<Vec<Commit>, GitError>;

    /// The subset of `ids` whose commit objects carry a signature header
    /// (`gpgsig`/`gpgsig-sha256`/`mergetag`) - PRESENCE only, detected via one
    /// batched raw-header scan and cached per SHA; no verifier ever spawns
    /// (verification stays on-demand in `commit_details`). Backs the Commits
    /// panel's Signed column, fetched only while that column is visible.
    async fn signature_presence(&self, ids: &[CommitId]) -> Result<Vec<CommitId>, GitError>;

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
    /// (`git show <rev>:<path>`). `rev` is any tree-ish. Binary content (NUL
    /// sniff) is classified, not returned: the variant carries the blob size
    /// (`git cat-file -s`) so the UI can describe the file instead of
    /// rendering lossy bytes.
    async fn file_at_revision(&self, rev: &str, path: &Path) -> Result<FileAtRevision, GitError>;

    /// Byte-exact content of the blob at `spec` (any `<rev>:<path>` /
    /// `:<path>` rev spec), for binary previews. Uses `cat-file --batch` raw
    /// stdout - the plain runner output is lossy-decoded and must never carry
    /// image bytes. An unresolvable spec is `Missing`, not an error.
    async fn blob_bytes(&self, spec: &str, cap: u64) -> Result<BlobBytes, GitError>;

    /// A single file's commit history, newest first, following renames
    /// (`git log --follow --name-status`). Each entry carries the file's path
    /// AS OF THAT COMMIT, so pre-rename commits address the old name. `skip`
    /// and `max_count` page the walk. `start_rev` starts the walk at that
    /// revision instead of HEAD (browse-at-commit mode): only commits
    /// reachable from it appear, matching the tree being browsed.
    async fn file_history(
        &self,
        path: &Path,
        max_count: u32,
        skip: u32,
        start_rev: Option<&str>,
    ) -> Result<Vec<FileHistoryEntry>, GitError>;

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

    /// Resolve any rev-parse expression (SHA prefix, branch, tag, `HEAD~2`,
    /// ...) to the commit it names, peeling tags. Errors when the expression
    /// doesn't name a commit. Backs the "Go to" jump in the Commits panel.
    async fn resolve_commit(&self, rev: &str) -> Result<CommitId, GitError>;

    /// Every file in the repo's working tree, classified as tracked, untracked,
    /// or (when `show_ignored`) ignored. Backs the Files tree. Sorted by path.
    async fn list_repo_files(
        &self,
        show_ignored: bool,
    ) -> Result<Vec<RepoFileEntry>, GitError>;

    /// Every entry in the tree of `rev` (`git ls-tree -r`), sorted. Backs the
    /// Files tree's browse-at-commit mode. A commit only records tracked
    /// content, so every entry is `Tracked`; gitlinks carry the `submodule`
    /// flag (ls-tree type `commit`).
    async fn list_files_at_revision(&self, rev: &str) -> Result<Vec<RepoFileEntry>, GitError>;

    /// Remove paths from the index but keep them on disk (`git rm --cached`).
    /// Used to stop tracking a file without deleting it (Files tree "Stop
    /// tracking & ignore").
    async fn rm_cached(&self, paths: &[PathBuf]) -> Result<(), GitError>;

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

    /// List the index entries `git add --renormalize` would change, by
    /// simulating the run on a throwaway index (`GIT_INDEX_FILE`); the real
    /// index is untouched. NOT `add -n`: the dry run lists every tracked
    /// file, not the ones that would change. Leaves a temp file next to the
    /// real index (`RENORMALIZE_PREVIEW_INDEX_SUFFIX`) for the caller to
    /// remove best-effort.
    async fn renormalize_preview(&self) -> Result<Vec<String>, GitError>;

    /// Re-run the clean filter over all tracked files
    /// (`git add --renormalize -- .`) and report which files were restaged.
    /// `--renormalize` implies `-u`, so pending unstaged modifications and
    /// deletions of tracked files are staged too - callers must warn first.
    async fn renormalize(&self) -> Result<RenormalizeOutcome, GitError>;

    /// Discard working-tree changes for the given paths: tracked paths are
    /// reverted (`git restore --worktree`), untracked paths are removed
    /// (`git clean -f`).
    async fn discard(&self, paths: &[PathBuf]) -> Result<(), GitError>;

    /// Enumerate the repo's submodules with full state (gitlinks + config +
    /// dirt flags + per-submodule HEAD probe). Read-only; one status walk.
    async fn submodules(&self) -> Result<Vec<SubmoduleInfo>, GitError>;

    /// Commits between two submodule pointers (`git -C <path> log from..to`),
    /// or `TargetMissing` when `to` is not in the submodule's object store
    /// (unfetched pointer target). `from = None` lists from the root (new
    /// submodule).
    async fn submodule_log(
        &self,
        path: &Path,
        from: Option<&CommitId>,
        to: &CommitId,
    ) -> Result<SubmoduleLog, GitError>;

    /// Check out the recorded SHA (`git submodule update`), optionally
    /// registering (`--init`) and recursing. May fetch - cancellable.
    async fn submodule_update(
        &self,
        opts: SubmoduleUpdateOptions,
        op_id: OperationId,
    ) -> Result<(), GitError>;

    /// Copy `.gitmodules` URLs into `.git/config` and the submodules' origin
    /// remotes (`git submodule sync`). Empty `paths` = all.
    async fn submodule_sync(&self, paths: &[PathBuf], recursive: bool) -> Result<(), GitError>;

    /// Fetch inside one submodule (`git -C <path> fetch`). Cancellable.
    async fn submodule_fetch(&self, path: &Path, op_id: OperationId) -> Result<(), GitError>;

    /// The superproject working tree containing this repo, or `None` when the
    /// repo is not checked out as a submodule
    /// (`git rev-parse --show-superproject-working-tree`).
    async fn superproject_path(&self) -> Result<Option<PathBuf>, GitError>;

    /// Whether tracked `.gitattributes` declare LFS (`filter=lfs`), plus
    /// whether the `git-lfs` binary and its smudge-filter config are
    /// available. Missing binary / unset config are ANSWERS (status fields),
    /// never errors; probes are skipped when the repo does not use LFS.
    async fn lfs_status(&self) -> Result<LfsStatus, GitError>;

    /// The subset of `paths` whose effective `filter` attribute is `lfs`
    /// (`git check-attr -z --stdin filter`), in input order. Worktree
    /// attributes - callers must not apply the result to at-revision views.
    async fn lfs_tracked_subset(&self, paths: &[String]) -> Result<Vec<String>, GitError>;

    /// Add a submodule (`git submodule add [-b <branch>] -- <url> <path>`).
    /// Clones - cancellable. Relative URLs resolve against origin (git-native).
    async fn submodule_add(
        &self,
        url: &str,
        path: &Path,
        branch: Option<&str>,
        op_id: OperationId,
    ) -> Result<(), GitError>;

    /// Change a submodule's URL in `.gitmodules` and immediately `sync` it
    /// into the local config and the submodule's origin remote.
    async fn submodule_set_url(&self, path: &Path, url: &str) -> Result<(), GitError>;

    /// Set (`Some`) or clear (`None` = remote default) the `.gitmodules`
    /// branch used by `update --remote`.
    async fn submodule_set_branch(&self, path: &Path, branch: Option<&str>) -> Result<(), GitError>;

    /// Fetch and integrate each submodule's tracked branch
    /// (`update --remote` + strategy), then STAGE the moved pointers -
    /// `--remote` moves the worktree but never the index. Dirty submodules
    /// follow `behavior` with the same never-lose-changes guarantees as
    /// `submodule_auto_update` (rollback on a conflicted carry-over). Empty
    /// `paths` = all submodules. Per-submodule outcomes; cancellable.
    /// With `attach_branch`, detached HEADs re-attach to a branch at the same
    /// commit afterwards (best-effort).
    async fn submodule_update_remote(
        &self,
        paths: &[PathBuf],
        strategy: SubmoduleUpdateStrategy,
        behavior: SwitchDirtyBehavior,
        attach_branch: bool,
        op_id: OperationId,
    ) -> Result<Vec<SubmoduleAutoUpdateResult>, GitError>;

    /// Remove a submodule the safe way (magit semantics): refuse if its
    /// worktree is dirty/conflicted, absorb an embedded gitdir, `deinit -f`,
    /// then `git rm -f` (stages the `.gitmodules` edit). The gitdir under
    /// `.git/modules/<name>` is deliberately KEPT - see
    /// `submodule_gitdir_info` / `submodule_delete_gitdir`.
    async fn submodule_remove(&self, path: &Path) -> Result<(), GitError>;

    /// Move a submodule's path (`git mv`): moves the worktree, rewrites
    /// `.gitmodules`, moves the index gitlink, fixes the gitfile link, and
    /// STAGES it all. The submodule NAME (`.git/modules/<name>`) stays
    /// unchanged. Missing parent directories of `to` are created; an
    /// occupied target is refused before anything runs.
    async fn submodule_move(&self, from: &Path, to: &Path) -> Result<(), GitError>;

    /// Inspect a removed submodule's retained gitdir: `None` when it does
    /// not exist; `unpushed = true` when local branches hold commits on no
    /// remote (deletion would destroy them).
    async fn submodule_gitdir_info(&self, name: &str)
        -> Result<Option<SubmoduleGitdirInfo>, GitError>;

    /// Permanently delete `.git/modules/<name>`. The caller confirms first
    /// (destructive; unpushed commits are gone for good).
    async fn submodule_delete_gitdir(&self, name: &str) -> Result<(), GitError>;

    /// Create and switch to a branch at the submodule's current (typically
    /// detached) HEAD - the one-click escape from detached-HEAD work loss.
    async fn submodule_create_branch(&self, path: &Path, name: &str) -> Result<(), GitError>;

    /// After a superproject switch/pull moved submodule pointers, bring the
    /// populated submodules to their recorded SHAs. Dirty submodules follow
    /// `behavior` (the global switch strategy); a conflicted auto-stash pop
    /// ROLLS the submodule BACK (changes reapplied on their original base).
    /// Per-submodule atomicity: failures are reported per entry, the batch
    /// continues. Local changes are never lost in any path.
    /// With `attach_branch`, detached HEADs re-attach to a branch at the same
    /// commit afterwards (best-effort).
    async fn submodule_auto_update(
        &self,
        behavior: SwitchDirtyBehavior,
        attach_branch: bool,
    ) -> Result<Vec<SubmoduleAutoUpdateResult>, GitError>;

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

    /// Delete a branch on `remote` (`git push <remote> --delete
    /// refs/heads/<name>`; the explicit refs/heads/ can never take a
    /// same-named tag). The local branch is untouched — local and remote
    /// deletion are separate, deliberate actions, like tags. Network op:
    /// cancellable, auth/rejection classified.
    async fn delete_remote_branch(&self, remote: &str, name: &str, op_id: OperationId) -> Result<(), GitError>;

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

    /// Stash only the given paths (`git stash push -- <pathspec>`), taking
    /// each file's FULL change (staged and unstaged halves). Always passes
    /// `--include-untracked` so untracked selections stash too (a bare
    /// pathspec push errors on paths git doesn't track). A pathspec matching
    /// only clean files returns `NothingToStash` (git exits 0 there), decided
    /// by the stash-tip compare, never the exit code.
    async fn create_stash_paths(
        &self,
        message: Option<&str>,
        paths: &[PathBuf],
    ) -> Result<StashOutcome, GitError>;

    /// Apply ONE file from a stash to the working tree, without touching the
    /// index (matching whole-stash apply, which lands changes unstaged) and
    /// without removing anything from the stash. Files stashed from
    /// untracked state are found in the stash's third parent and come back
    /// untracked. Overwrites the current worktree copy - the
    /// destructive-confirm gate lives in the UI.
    async fn apply_stash_file(&self, stash_sha: &str, path: &Path) -> Result<(), GitError>;

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

    /// Paths whose conflict was resolved and staged during the in-progress
    /// operation (`git ls-files --resolve-undo`) - the candidates for
    /// `conflict_reopen`. The record persists until the merge commit.
    async fn resolve_undo_paths(&self) -> Result<Vec<String>, GitError>;

    /// Staged paths whose staged content still contains leftover conflict
    /// markers (`git diff --cached --check`, exit 2 = findings, not failure).
    async fn staged_marker_paths(&self) -> Result<Vec<String>, GitError>;

    /// Modified-but-unstaged paths whose worktree content still contains
    /// leftover conflict markers (`git diff --check`) - e.g. a staged
    /// resolution that was unstaged again. Also matches currently conflicted
    /// paths; callers filter those (they are already surfaced as conflicts).
    async fn unstaged_marker_paths(&self) -> Result<Vec<String>, GitError>;

    /// Reopen a resolved-and-staged conflict: `git update-index --unresolve`
    /// restores the index stages from the resolve-undo record, then
    /// `git checkout -m -- <path>` regenerates the conflict markers in the
    /// worktree (discarding the staged resolution).
    async fn conflict_reopen(&self, path: &Path) -> Result<(), GitError>;
}
