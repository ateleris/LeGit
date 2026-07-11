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
use crate::runner::{GitRunner, OperationId};
use crate::types::{
    BlameHunk, Branch, Commit, CommitDetails, CommitFileChange, CommitId, CommitOptions,
    CommitSearchKind, ConflictEntry, ConflictFileSides, ConflictSide, DiffEntry, DiffSource,
    FetchOptions, FfMode, FileAtRevision, FileHistoryEntry, FileState, FileStatus,
    HunkOp, LineEndingKind, LogOptions, MergeOptions, MergeOutcome, PullOptions, PullStrategy, PushOptions, PushRecurseMode,
    RebaseOutcome, RebaseStep, RefDecoration, RefSelector, ReflogEntry, Remote, RemoteTag,
    RepoFileEntry, RepoFileKind, RepoOpState, ResetMode, SequenceOutcome, SignMode, StashApplyOutcome, StashEntry,
    StashOutcome, SubmoduleAutoUpdateResult, SubmoduleAutoUpdateStatus, SubmoduleGitdirInfo,
    SubmoduleInfo, SubmoduleLog, SubmoduleUpdateOptions, SubmoduleUpdateStrategy,
    SwitchDirtyBehavior, SwitchOutcome, TagInfo, TrackingStatus,
};

/// Target of a per-submodule move (see `update_one_submodule`).
#[derive(Debug, Clone, Copy)]
enum SubmoduleMove {
    /// Check out the SHA recorded in the superproject index.
    Recorded,
    /// Fetch and integrate the tracked remote branch (`update --remote`).
    Remote(SubmoduleUpdateStrategy),
}

/// Git's well-known empty-tree object id, used as the "before" side when
/// diffing a root commit (which has no parent).
const EMPTY_TREE_OID: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/// Git's binary heuristic: a NUL byte within the leading window marks the
/// content binary. The window matches git's own (`buffer_is_binary`, 8000
/// bytes) so LeGit and git classify a blob identically; lossy UTF-8 decoding
/// preserves NUL bytes, so sniffing the decoded string is sound.
const BINARY_SNIFF_WINDOW: usize = 8000;

fn is_binary_content(content: &str) -> bool {
    content
        .as_bytes()
        .iter()
        .take(BINARY_SNIFF_WINDOW)
        .any(|&b| b == 0)
}
use async_trait::async_trait;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::RwLock;

pub mod parsers;

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
pub struct GitCliBackend<E: GitExecutor = GitRunner> {
    runner: Arc<RwLock<Arc<E>>>,
}

impl<E: GitExecutor> GitCliBackend<E> {
    pub fn new(runner: Arc<RwLock<Arc<E>>>) -> Self {
        Self { runner }
    }

    /// Snapshot the current runner without holding the lock during I/O.
    pub async fn runner(&self) -> Arc<E> {
        self.runner.read().await.clone()
    }

    /// `git status` parsed, without line counts — the cheap form for internal
    /// flows (e.g. `discard`) that only need path classification. The trait's
    /// `status()` enriches this with numstat counts for the UI.
    async fn status_entries(&self) -> Result<Vec<FileStatus>, GitError> {
        let runner = self.runner().await;
        let output = runner
            .run(&parsers::status::STATUS_ARGS)
            .await?;
        Self::ensure_success(&output)?;
        Ok(parsers::status::parse_status(&output.stdout))
    }

    /// Run a git subcommand (`prefix`) followed by a list of pathspecs. Paths
    /// are passed after the prefix verbatim; the prefix should end with `--` so
    /// they are always treated as pathspecs. Errors on a non-zero exit.
    async fn run_pathspec(&self, prefix: &[&str], paths: &[PathBuf]) -> Result<(), GitError> {
        let runner = self.runner().await;
        let mut args: Vec<String> = prefix.iter().map(|s| s.to_string()).collect();
        for p in paths {
            args.push(p.to_string_lossy().into_owned());
        }
        let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
        let output = runner
            .run(&arg_refs)
            .await?;
        Self::ensure_success(&output)?;
        Ok(())
    }

    /// Run `git diff` for a single file from `source` and return its raw stdout.
    /// `context` becomes `-U<context>` (whole-file view passes a very large
    /// value). For a `Commit` source the comparison is against the commit's
    /// first parent (the empty tree for a root commit).
    async fn run_diff_text(
        &self,
        source: &DiffSource,
        path: &Path,
        old_path: Option<&Path>,
        context: u32,
    ) -> Result<String, GitError> {
        let runner = self.runner().await;
        let unified = format!("-U{context}");
        let path_str = path.to_string_lossy().into_owned();

        // Common flags: no color/ANSI, no external diff drivers — we need git's
        // own deterministic unified output for the parser. `diff.submodule` is
        // pinned to `short`: a user's `log`/`diff` config changes gitlink diff
        // output and breaks parsing (the magit#4538 class of bug).
        let mut args: Vec<String> = vec![
            "-c".into(),
            "diff.submodule=short".into(),
            "diff".into(),
            "--no-color".into(),
            "--no-ext-diff".into(),
            unified,
        ];

        match source {
            DiffSource::WorkingUnstaged => {}
            DiffSource::WorkingStaged => args.push("--cached".into()),
            DiffSource::Commit { commit_id } => {
                let from = self.first_parent(&runner, commit_id.as_str()).await?;
                args.push(from);
                args.push(commit_id.as_str().to_string());
            }
            DiffSource::CommitRange { from, to } => {
                args.push(from.as_str().to_string());
                args.push(to.as_str().to_string());
            }
        }
        // For a rename/copy, pass BOTH paths with rename detection so git pairs
        // them: a modified rename yields real content hunks, a pure rename yields
        // an empty diff.
        let old_str = old_path.map(|p| p.to_string_lossy().into_owned());
        if old_str.as_deref().is_some_and(|o| o != path_str) {
            args.push("--find-renames".into());
        }
        args.push("--".into());
        if let Some(old) = &old_str {
            if *old != path_str {
                args.push(old.clone());
            }
        }
        args.push(path_str.clone());

        let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
        let output = runner
            .run(&arg_refs)
            .await?;
        Self::ensure_success(&output)?;
        // Untracked files don't appear in `git diff` at all (empty output), so a
        // diff of one would read as "no changes". Show the whole file as added by
        // diffing it against the empty side instead. Two cases produce this:
        if output.stdout.trim().is_empty() {
            // 1. A working-tree untracked file (`git diff` ignores it).
            if matches!(source, DiffSource::WorkingUnstaged)
                && self.is_untracked(&runner, &path_str).await?
            {
                return self.diff_no_index(&runner, &path_str, context).await;
            }
            // 2. A file stashed via --include-untracked: it lives in the stash's
            //    untracked parent, not the stash commit's tree, so base..stash is
            //    empty for it. Diff that parent against the empty tree.
            if let DiffSource::Commit { commit_id } = source {
                if let Some(u) = self.stash_untracked_parent(&runner, commit_id.as_str()).await? {
                    return self
                        .diff_tree_file(&runner, EMPTY_TREE_OID, &u, &path_str, context)
                        .await;
                }
            }
        }
        Ok(output.stdout)
    }

    /// True when `path` is not tracked by git (so `git diff` shows nothing).
    /// A FAILED `ls-files` also has empty stdout - that is an error, not
    /// "untracked" (encoded in `file_diff_untracked_probe_failure_...`).
    async fn is_untracked(&self, runner: &E, path: &str) -> Result<bool, GitError> {
        let out = runner
            .run(&["ls-files", "-z", "--", path])
            .await?;
        Self::ensure_success(&out)?;
        Ok(out.stdout.is_empty())
    }

    /// Diff an untracked file against the empty side (all lines added).
    /// `git diff --no-index` exits 1 when the inputs differ — success for us.
    async fn diff_no_index(
        &self,
        runner: &E,
        path: &str,
        context: u32,
    ) -> Result<String, GitError> {
        let unified = format!("-U{context}");
        let args = [
            "diff",
            "--no-index",
            "--no-color",
            "--no-ext-diff",
            unified.as_str(),
            "--",
            "/dev/null",
            path,
        ];
        let out = runner
            .run(&args)
            .await?;
        // `--no-index` exits 0 (identical) or 1 (differ). Anything else (e.g.
        // the path no longer exists / belongs to another repo) is treated as
        // "no diff" rather than a hard error — this is a best-effort fallback.
        match out.exit_code {
            Some(0) | Some(1) => Ok(out.stdout),
            _ => Ok(String::new()),
        }
    }

    /// Diff a single file between two tree-ish revisions (all lines added when
    /// `from` is the empty tree). Used to surface a stash's untracked files,
    /// which live in a separate parent commit rather than the stash's own tree.
    async fn diff_tree_file(
        &self,
        runner: &E,
        from: &str,
        to: &str,
        path: &str,
        context: u32,
    ) -> Result<String, GitError> {
        let unified = format!("-U{context}");
        let args = [
            "diff",
            "--no-color",
            "--no-ext-diff",
            unified.as_str(),
            from,
            to,
            "--",
            path,
        ];
        let out = runner
            .run(&args)
            .await?;
        Self::ensure_success(&out)?;
        Ok(out.stdout)
    }

    /// Resolve a commit's first parent for diffing, falling back to git's
    /// empty-tree object for a root commit. Mirrors `commit_files`.
    async fn first_parent(
        &self,
        runner: &E,
        sha: &str,
    ) -> Result<String, GitError> {
        let rev = runner
            .run(&["rev-list", "--parents", "-n", "1", sha])
            .await?;
        Self::ensure_success(&rev)?;
        Ok(rev
            .stdout
            .split_whitespace()
            .nth(1)
            .unwrap_or(EMPTY_TREE_OID)
            .to_string())
    }

    /// If `sha` is a stash with untracked files, return that untracked-files
    /// commit (the stash's 3rd parent). `git stash push --include-untracked`
    /// stores untracked files in a 3rd parent whose tree holds ONLY those files;
    /// they are absent from the stash commit's own tree, so a `base..stash` diff
    /// never shows them.
    ///
    /// Returns `None` for anything that isn't an untracked-bearing stash. The
    /// 3-parent shape alone is ambiguous (an octopus merge has it too), so we
    /// confirm `sha` is actually in `git stash list` before treating its 3rd
    /// parent as untracked content. Cheap: the stash-list call only runs for
    /// commits that have a 3rd parent in the first place.
    async fn stash_untracked_parent(
        &self,
        runner: &E,
        sha: &str,
    ) -> Result<Option<String>, GitError> {
        let rev = runner
            .run(&["rev-list", "--parents", "-n", "1", sha])
            .await?;
        if !rev.success {
            return Ok(None);
        }
        // tokens: <sha> <base> <index> <untracked>; the untracked parent is 4th.
        let untracked = match rev.stdout.split_whitespace().nth(3) {
            Some(p) => p.to_string(),
            None => return Ok(None),
        };

        let list = runner
            .run(&["stash", "list", "--format=%H"])
            .await?;
        if !list.success {
            return Ok(None);
        }
        let is_stash = list.stdout.lines().any(|l| l.trim() == sha);
        Ok(is_stash.then_some(untracked))
    }

    /// Run `diff-tree <DIFF_TREE_FLAGS> <kind> <from> <to>` and return its
    /// stdout - the one primitive behind `commit_files` and `diff_files`.
    async fn diff_tree(&self, from: &str, to: &str, kind: &str) -> Result<String, GitError> {
        let mut args = vec!["diff-tree"];
        args.extend_from_slice(&parsers::commit_files::DIFF_TREE_FLAGS);
        args.push(kind);
        args.push(from);
        args.push(to);
        self.run_checked(&args).await
    }

    /// Whether `sha` is an entry in `git stash list`. The 3-parent commit
    /// shape alone is ambiguous (an octopus merge has it too), so stash
    /// handling must confirm membership.
    async fn is_stash_commit(&self, sha: &str) -> Result<bool, GitError> {
        let list = self.run_checked(&["stash", "list", "--format=%H"]).await?;
        Ok(list.lines().any(|l| l.trim() == sha))
    }

    /// Which diff a working-tree operation reads from: staging/discarding act on
    /// the unstaged diff (index → worktree), unstaging on the staged diff.
    fn source_for_op(op: HunkOp) -> DiffSource {
        match op {
            HunkOp::Stage | HunkOp::Discard => DiffSource::WorkingUnstaged,
            HunkOp::Unstage => DiffSource::WorkingStaged,
        }
    }

    /// Apply a prepared patch to the index/worktree per `op`. `--recount` lets a
    /// sliced/edited patch apply despite its untouched `@@` header counts.
    async fn apply_op_patch(&self, op: HunkOp, patch: &str) -> Result<(), GitError> {
        let args: &[&str] = match op {
            HunkOp::Stage => &["apply", "--cached", "--recount"],
            HunkOp::Unstage => &["apply", "--cached", "-R", "--recount"],
            HunkOp::Discard => &["apply", "-R", "--recount"],
        };
        let runner = self.runner().await;
        let output = runner
            .run_with_stdin(args, patch)
            .await?;
        Self::ensure_success(&output)?;
        Ok(())
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
        Ok(())
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

    /// Map a non-zero exit to `CommandFailed` - the single place this variant
    /// is built for unclassified failures, so exit-code/stderr handling cannot
    /// drift between methods. Flows that classify non-zero exits as outcomes
    /// (merge, rebase, stash apply) go through `run_classified` instead.
    fn ensure_success(output: &crate::runner::RunOutput) -> Result<(), GitError> {
        if output.success {
            Ok(())
        } else {
            Err(GitError::CommandFailed {
                exit_code: output.exit_code.unwrap_or(-1),
                stderr: output.stderr.clone(),
            })
        }
    }

    /// Run a `git diff [--cached] --check` invocation and parse the flagged
    /// leftover-conflict-marker paths. `--check` exits 2 when it found
    /// problems - that is the data this returns, not a failure; anything
    /// else non-zero is an error.
    async fn run_marker_check(&self, args: &[&str]) -> Result<Vec<String>, GitError> {
        let (code, stdout, stderr) = self.run_classified(args).await?;
        if code != 0 && code != 2 {
            return Err(GitError::CommandFailed {
                exit_code: code,
                stderr: stderr.trim().to_string(),
            });
        }
        Ok(parsers::resolve::parse_leftover_markers(&stdout))
    }

    /// Move ONE submodule: to the recorded SHA (`submodule update`) or to its
    /// tracked remote branch (`submodule update --remote` + strategy, which
    /// fetches - run as a cancellable remote op).
    async fn move_submodule(
        &self,
        p: &str,
        mv: SubmoduleMove,
        op_id: Option<&OperationId>,
    ) -> Result<(), GitError> {
        match mv {
            SubmoduleMove::Recorded => {
                self.run_simple(&["submodule", "update", "--", p]).await
            }
            SubmoduleMove::Remote(strategy) => {
                let flag = match strategy {
                    SubmoduleUpdateStrategy::Checkout => "--checkout",
                    SubmoduleUpdateStrategy::Rebase => "--rebase",
                    SubmoduleUpdateStrategy::Merge => "--merge",
                };
                let args: Vec<String> = vec![
                    "submodule".into(),
                    "update".into(),
                    "--remote".into(),
                    flag.into(),
                    "--".into(),
                    p.to_string(),
                ];
                let runner = self.runner().await;
                let op = op_id.cloned().unwrap_or_else(|| OperationId(String::new()));
                self.run_remote(&runner, &args, op).await
            }
        }
    }

    /// Update ONE submodule (to `mv`'s target), handling dirtiness per
    /// `behavior`. `old` is the pre-move HEAD, the rollback anchor. Never
    /// returns Err: every failure becomes a status so the caller's batch
    /// continues (per-submodule atomicity). Shared by the post-switch/pull
    /// auto-update (Recorded) and "Pull latest" (Remote).
    async fn update_one_submodule(
        &self,
        s: &SubmoduleInfo,
        old: &str,
        behavior: SwitchDirtyBehavior,
        mv: SubmoduleMove,
        op_id: Option<&OperationId>,
    ) -> SubmoduleAutoUpdateStatus {
        let p = s.path.to_string_lossy().into_owned();
        let skip = |msg: String| SubmoduleAutoUpdateStatus::Skipped { message: msg };

        if s.state.conflicted {
            return skip("the submodule is in a merge conflict".into());
        }
        let dirty = s.state.dirty_tracked || s.state.dirty_untracked;

        // Clean: just move (`submodule update` fetches on demand, unlike a
        // raw checkout).
        if !dirty {
            return match self.move_submodule(&p, mv, op_id).await {
                Ok(()) => SubmoduleAutoUpdateStatus::Updated,
                Err(e) => skip(e.to_string()),
            };
        }

        match behavior {
            // Let git decide: the move's internal checkout carries a
            // non-conflicting dirty tree over and refuses a conflicting one
            // (the submodule stays untouched).
            SwitchDirtyBehavior::TryDirectly => {
                match self.move_submodule(&p, mv, op_id).await {
                    Ok(()) => SubmoduleAutoUpdateStatus::ChangesCarried,
                    Err(e) => skip(format!("local changes could not be carried over: {e}")),
                }
            }
            SwitchDirtyBehavior::AutoStash | SwitchDirtyBehavior::StashAndKeep => {
                // Stash inside the submodule, verified by a marker-matched
                // stash-list diff (never by exit code: `stash push` exits 0
                // on a clean tree; never by the tip alone: a concurrently
                // created entry must not be adopted and later popped).
                const SUB_MARKER: &str = "legit: auto-stash before submodule update";
                let sub_list = |o: Option<crate::runner::RunOutput>| -> String {
                    match o {
                        Some(out) if out.success => out.stdout,
                        _ => String::new(),
                    }
                };
                let runner = self.runner().await;
                let before = sub_list(
                    runner
                        .run(&["-C", &p, "stash", "list", "--format=%H %s"])
                        .await
                        .ok(),
                );
                drop(runner);
                if let Err(e) = self
                    .run_simple(&[
                        "-C",
                        &p,
                        "stash",
                        "push",
                        "--include-untracked",
                        "-m",
                        SUB_MARKER,
                    ])
                    .await
                {
                    return skip(format!("could not stash local changes: {e}"));
                }
                let runner = self.runner().await;
                let after = sub_list(
                    runner
                        .run(&["-C", &p, "stash", "list", "--format=%H %s"])
                        .await
                        .ok(),
                );
                drop(runner);
                let Some(stash_sha) = find_created_stash(&before, &after, SUB_MARKER) else {
                    // Race: tree turned out clean - just move.
                    return match self.move_submodule(&p, mv, op_id).await {
                        Ok(()) => SubmoduleAutoUpdateStatus::Updated,
                        Err(e) => skip(e.to_string()),
                    };
                };

                // Move to the target (tree is clean now).
                if let Err(e) = self.move_submodule(&p, mv, op_id).await {
                    // Restore: pop the stash we just made, back on `old`.
                    return match self.pop_submodule_stash(&p, &stash_sha).await {
                        Ok(()) => skip(format!("update failed; local changes restored: {e}")),
                        Err(pop_e) => SubmoduleAutoUpdateStatus::ChangesInStash {
                            message: format!(
                                "update failed ({e}) AND restoring failed ({pop_e}) - your changes are in the submodule's stash"
                            ),
                        },
                    };
                }

                if matches!(behavior, SwitchDirtyBehavior::StashAndKeep) {
                    return SubmoduleAutoUpdateStatus::ChangesStashed;
                }

                // AutoStash: pop onto the NEW commit.
                match self.pop_submodule_stash(&p, &stash_sha).await {
                    Ok(()) => SubmoduleAutoUpdateStatus::ChangesCarried,
                    Err(pop_err) => {
                        // Conflicted/failed pop: ROLL BACK. `reset --hard`
                        // discards the marker-ridden application and clears
                        // unmerged index entries - the stash itself survived
                        // (git keeps it when a pop conflicts).
                        if let Err(e) = self.run_simple(&["-C", &p, "reset", "--hard", old]).await {
                            return SubmoduleAutoUpdateStatus::ChangesInStash {
                                message: format!(
                                    "pop conflicted ({pop_err}) AND rollback failed ({e}) - your changes are in the submodule's stash"
                                ),
                            };
                        }
                        match self.pop_submodule_stash(&p, &stash_sha).await {
                            Ok(()) => SubmoduleAutoUpdateStatus::RolledBack {
                                message: format!(
                                    "local changes conflict with the new submodule commit; the submodule was left at its previous commit with your changes intact ({pop_err})"
                                ),
                            },
                            Err(e) => SubmoduleAutoUpdateStatus::ChangesInStash {
                                message: format!(
                                    "pop conflicted ({pop_err}) AND reapplying on the original commit failed ({e}) - your changes are in the submodule's stash"
                                ),
                            },
                        }
                    }
                }
            }
        }
    }

    /// Pop the given stash SHA inside submodule `p`, resolving the SHA to its
    /// CURRENT selector first (positional selectors shift; house rule).
    async fn pop_submodule_stash(&self, p: &str, stash_sha: &str) -> Result<(), GitError> {
        let runner = self.runner().await;
        let list = runner
            .run(&["-C", p, "stash", "list", "--format=%H %gd"])
            .await?;
        Self::ensure_success(&list)?;
        let Some(selector) = find_stash_selector(&list.stdout, stash_sha) else {
            return Err(GitError::Internal(format!(
                "auto-stash {stash_sha} vanished from the submodule stash list"
            )));
        };
        drop(runner);
        self.run_simple(&["-C", p, "stash", "pop", &selector]).await
    }

    /// Resolve `.git/modules/<name>` for this repo, validated against path
    /// traversal; `None` when the directory does not exist.
    async fn submodule_gitdir_path(&self, name: &str) -> Result<Option<PathBuf>, GitError> {
        // Reject anything that could escape `<git_dir>/modules/`.
        let name_path = Path::new(name);
        if name_path.is_absolute()
            || name_path
                .components()
                .any(|c| !matches!(c, std::path::Component::Normal(_)))
        {
            return Err(GitError::Internal(format!("invalid submodule name '{name}'")));
        }
        let runner = self.runner().await;
        let out = runner
            .run(&["rev-parse", "--absolute-git-dir"])
            .await?;
        Self::ensure_success(&out)?;
        let gitdir = PathBuf::from(out.stdout.trim()).join("modules").join(name_path);
        Ok(gitdir.is_dir().then_some(gitdir))
    }

    /// Run a `git stash apply`/`pop`, mapping a merge conflict (non-zero exit
    /// whose output mentions a conflict) to `Conflicts` rather than `Err` — the
    /// apply partially succeeded and the user must resolve the working tree. Any
    /// other failure (e.g. a bad selector) is a real `CommandFailed`.
    async fn run_stash_apply(&self, args: &[&str]) -> Result<StashApplyOutcome, GitError> {
        let runner = self.runner().await;
        let output = runner
            .run(args)
            .await?;
        if output.success {
            return Ok(StashApplyOutcome::Clean);
        }
        if stash_apply_left_conflicts(&output.stdout, &output.stderr) {
            let combined = format!("{}\n{}", output.stdout, output.stderr);
            Ok(StashApplyOutcome::Conflicts {
                message: combined.trim().to_string(),
            })
        } else {
            Err(GitError::CommandFailed {
                exit_code: output.exit_code.unwrap_or(-1),
                stderr: output.stderr,
            })
        }
    }

    /// Resolve a stash commit SHA to its *current* reflog selector
    /// (`stash@{N}`). All stash mutations go through this: the UI addresses
    /// stashes by SHA (stable), while git's stash commands want the positional
    /// selector (which shifts on every create/drop/pop — including ones made
    /// outside the app). Resolving at action time guarantees the operation hits
    /// the entry the user actually clicked, or fails loudly with `RefNotFound`
    /// if that stash no longer exists.
    async fn resolve_stash_selector(&self, stash_sha: &str) -> Result<String, GitError> {
        let runner = self.runner().await;
        let output = runner
            .run(&["stash", "list", "--format=%H %gd"])
            .await?;
        Self::ensure_success(&output)?;
        find_stash_selector(&output.stdout, stash_sha).ok_or_else(|| {
            GitError::RefNotFound(format!(
                "{stash_sha} is not (or no longer) a stash entry — the stash list may have changed"
            ))
        })
    }

    /// The revision that actually holds `path`'s content for a per-file
    /// restore/apply: `rev` itself, or - when the path is absent there and
    /// `rev` is an untracked-bearing stash - the stash's third parent
    /// (files stashed from UNTRACKED state live only in that tree, which is
    /// why a plain checkout at the stash SHA fails on them; the stash's
    /// file list already includes them, so acting on them must work too).
    /// Falls back to `rev` when neither has the path, so the caller's git
    /// command reports the proper "does not exist at revision" error.
    async fn resolve_file_content_source(
        &self,
        rev: &str,
        path: &Path,
    ) -> Result<String, GitError> {
        let runner = self.runner().await;
        let spec = format!("{rev}:{}", path.to_string_lossy());
        let in_rev = runner
            .run(&["rev-parse", "-q", "--verify", &spec])
            .await?;
        if in_rev.success {
            return Ok(rev.to_string());
        }
        if let Some(untracked) = self.stash_untracked_parent(&runner, rev).await? {
            let u_spec = format!("{untracked}:{}", path.to_string_lossy());
            let in_untracked = runner
                .run(&["rev-parse", "-q", "--verify", &u_spec])
                .await?;
            if in_untracked.success {
                return Ok(untracked);
            }
        }
        Ok(rev.to_string())
    }

    /// Tree object of the current index (`git write-tree`) - used to save
    /// and restore the index around a pathspec stash.
    async fn write_tree(&self) -> Result<String, GitError> {
        let (code, stdout, stderr) = self.run_classified(&["write-tree"]).await?;
        if code != 0 {
            return Err(GitError::CommandFailed {
                exit_code: code,
                stderr: stderr.trim().to_string(),
            });
        }
        Ok(stdout.trim().to_string())
    }

    /// The current `refs/stash` tip, or `None` when there are no stash entries.
    /// This is how `create_stash`/`create_stash_paths` decide whether a
    /// `stash push` actually created an entry: `git stash push` exits **0**
    /// with "No local changes to save" (on stdout) for a clean tree, so
    /// neither the exit code nor stderr can tell — only a changed stash tip
    /// can. (Flows that go on to POP the created entry use the stronger
    /// `find_created_stash` list-diff instead.)
    async fn stash_tip(&self) -> Result<Option<String>, GitError> {
        let runner = self.runner().await;
        let output = runner
            .run(&["rev-parse", "-q", "--verify", "refs/stash"])
            .await?;
        if output.success {
            Ok(Some(output.stdout.trim().to_string()))
        } else {
            // `-q --verify` exits 1 for a missing ref without output.
            Ok(None)
        }
    }

    /// Pop a specific stash entry addressed by its commit SHA (resolved to the
    /// current selector at call time). Conflict-aware via `run_stash_apply`.
    async fn pop_stash_sha(&self, sha: &str) -> Result<StashApplyOutcome, GitError> {
        let selector = self.resolve_stash_selector(sha).await?;
        self.run_stash_apply(&["stash", "pop", &selector]).await
    }

    /// Run a `git switch`/`checkout` invocation, classifying the well-known
    /// "your local changes would be overwritten" failure into
    /// `WouldOverwriteLocalChanges` so the UI can respond specifically.
    async fn run_switch(&self, args: &[&str]) -> Result<(), GitError> {
        let runner = self.runner().await;
        let output = runner
            .run(args)
            .await?;
        if !output.success {
            return Err(classify_switch_error(
                output.exit_code.unwrap_or(-1),
                &output.stderr,
            ));
        }
        Ok(())
    }

    /// Shared auto-stash logic used by `switch_branch`, `checkout_commit` and
    /// `checkout_remote_branch`. `switch_args` are the git arguments after
    /// `git` itself, e.g. `&["switch", "main"]` or `&["switch", "--detach", "abc123"]`.
    ///
    /// With `AutoStash` / `StashAndKeep`, "did we actually stash" is detected
    /// by diffing the full stash list before and after the push and matching
    /// the marker message (see `find_created_stash` - the tip alone cannot
    /// tell our entry from one created concurrently), and the created entry
    /// is addressed *by its SHA* — never a bare `stash pop`, which would pop
    /// an unrelated pre-existing stash when nothing was auto-stashed or when
    /// the list shifted in between. The two modes differ only after a
    /// successful switch: `AutoStash` pops the entry (changes travel along),
    /// `StashAndKeep` leaves it parked.
    async fn run_with_auto_stash(
        &self,
        behavior: SwitchDirtyBehavior,
        switch_args: &[&str],
    ) -> Result<SwitchOutcome, GitError> {
        if behavior == SwitchDirtyBehavior::TryDirectly {
            self.run_switch(switch_args).await?;
            return Ok(SwitchOutcome::Clean);
        }

        let target = switch_args.last().copied().unwrap_or("?");
        let msg = format!("legit: auto-stash before switching to {}", target);
        let list_before = self.run_checked(STASH_LIST_SUBJECT_ARGS).await?;
        self.run_simple(&["stash", "push", "--include-untracked", "-m", &msg])
            .await?;
        let list_after = self.run_checked(STASH_LIST_SUBJECT_ARGS).await?;
        // The SHA of the entry *we* created; `None` when the tree was clean.
        let created = find_created_stash(&list_before, &list_after, &msg);

        if let Err(switch_err) = self.run_switch(switch_args).await {
            // Roll back: restore the auto-stash onto the original branch. It
            // was created from exactly this state, so it applies cleanly in
            // practice — but a failure here must not be silent: the user's
            // changes would sit invisibly in the stash while the tree looks
            // clean, with only the switch failure reported.
            if let Some(sha) = &created {
                match self.pop_stash_sha(sha).await {
                    Ok(StashApplyOutcome::Clean) => {}
                    Ok(StashApplyOutcome::Conflicts { .. }) => {
                        return Err(append_error_note(
                            switch_err,
                            "Additionally, restoring your auto-stashed changes produced \
                             conflicts — resolve them in the working tree (the stash entry \
                             was kept).",
                        ));
                    }
                    Err(pop_err) => {
                        return Err(append_error_note(
                            switch_err,
                            &format!(
                                "Additionally, your uncommitted changes were auto-stashed and \
                                 could not be restored automatically ({pop_err}) — they are \
                                 preserved in the stash."
                            ),
                        ));
                    }
                }
            }
            return Err(switch_err);
        }

        let Some(sha) = created else {
            // Clean tree — nothing was stashed, nothing to restore.
            return Ok(SwitchOutcome::Clean);
        };
        if behavior == SwitchDirtyBehavior::StashAndKeep {
            // Deliberately leave the entry parked: the target branch starts
            // clean and the WIP is retrievable from the stash list.
            return Ok(SwitchOutcome::ChangesStashed);
        }
        match self.pop_stash_sha(&sha).await {
            Ok(StashApplyOutcome::Clean) => Ok(SwitchOutcome::Clean),
            Ok(StashApplyOutcome::Conflicts { message }) => {
                Ok(SwitchOutcome::StashPopConflicts { message })
            }
            Err(e) => Ok(SwitchOutcome::StashPopFailed {
                message: e.to_string(),
            }),
        }
    }
}

#[async_trait]
impl<E: GitExecutor> GitBackend for GitCliBackend<E> {
    async fn status(&self) -> Result<Vec<FileStatus>, GitError> {
        let mut statuses = self.status_entries().await?;

        // Line counts come from two extra numstat diffs, run only when some
        // entry can actually carry counts (an all-untracked tree skips both).
        let need_staged = statuses
            .iter()
            .any(|s| s.staged && parsers::status::wants_counts(s));
        let need_unstaged = statuses
            .iter()
            .any(|s| !s.staged && parsers::status::wants_counts(s));
        if !need_staged && !need_unstaged {
            return Ok(statuses);
        }

        // Counts are cosmetic enrichment: a failed numstat run leaves them at
        // `None` (no badge) rather than failing status itself.
        let runner = self.runner().await;
        let staged_counts = if need_staged {
            match runner.run(&parsers::status::NUMSTAT_STAGED_ARGS).await {
                Ok(o) if o.success => parsers::commit_files::parse_numstat(&o.stdout),
                _ => Default::default(),
            }
        } else {
            Default::default()
        };
        let unstaged_counts = if need_unstaged {
            match runner.run(&parsers::status::NUMSTAT_UNSTAGED_ARGS).await {
                Ok(o) if o.success => parsers::commit_files::parse_numstat(&o.stdout),
                _ => Default::default(),
            }
        } else {
            Default::default()
        };
        parsers::status::apply_numstat(&mut statuses, &staged_counts, &unstaged_counts);
        Ok(statuses)
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

        // An explicit revision range (e.g. `base..HEAD` for the interactive
        // rebase plan) wins over the ref selector.
        if let Some(range) = opts.revision_range.as_deref().filter(|r| !r.is_empty()) {
            args.push(range);
        } else {
            match opts.refs {
                RefSelector::AllLocalBranches => {
                    // Always include HEAD so a detached HEAD commit appears even
                    // when it isn't reachable from any local branch.
                    args.push("HEAD");
                    args.push("--branches");
                }
                RefSelector::Head => {}
            }
        }
        args.push("--decorate=full");

        let output = runner
            .run(&args)
            .await?;

        Self::ensure_success(&output)?;

        let mut commits = parsers::log::parse_log(&output.stdout).map_err(GitError::from)?;

        // Inject stashes as synthetic nodes so they appear in the graph. Only for
        // the full-graph view, and best-effort: a stash-list failure must never
        // break the commit log itself.
        if matches!(opts.refs, RefSelector::AllLocalBranches) {
            if let Ok(stashes) = self.stashes().await {
                inject_stashes(&mut commits, stashes);
            }
        }

        Ok(commits)
    }

    async fn commit_details(&self, id: &CommitId) -> Result<CommitDetails, GitError> {
        let runner = self.runner().await;

        let cat_output = runner
            .run(&["cat-file", "-p", id.as_str()])
            .await?;

        Self::ensure_success(&cat_output)?;

        let mut parsed =
            parsers::commit::parse_cat_file(id.as_str(), &cat_output.stdout)
                .map_err(GitError::from)?;

        if parsed.has_signature_header {
            let verify_output = runner
                .run(&["verify-commit", "--raw", id.as_str()])
                .await?;
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

    async fn commit_files(&self, id: &CommitId) -> Result<Vec<CommitFileChange>, GitError> {
        // Resolve the parents ONCE. `rev-list --parents -n 1 <sha>` prints
        // `<sha> <parent1> <parent2> …`; a root commit prints only `<sha>`, so
        // we diff against the empty tree. Using an explicit `<from> <to>` pair
        // (rather than a bare commit) makes the diff first-parent for merges
        // and avoids diff-tree's empty default output for merge commits. The
        // 4th token, when present, is a potential stash untracked-files parent.
        let parents = self
            .run_checked(&["rev-list", "--parents", "-n", "1", id.as_str()])
            .await?;
        let from = parents
            .split_whitespace()
            .nth(1)
            .unwrap_or(EMPTY_TREE_OID)
            .to_string();
        let untracked_candidate = parents.split_whitespace().nth(3).map(str::to_string);
        let to = id.as_str();

        let mut raw = self.diff_tree(&from, to, "--raw").await?;
        let mut numstat = self.diff_tree(&from, to, "--numstat").await?;

        // A stash created with --include-untracked keeps its untracked files in a
        // separate 3rd-parent commit, NOT in the stash commit's own tree — so the
        // diff above misses them entirely. Append them as additions (empty tree →
        // untracked parent) so the stash's full contents show. Ordinary commits
        // are unaffected; a 3-parent octopus merge is filtered out by the
        // stash-list membership check.
        if let Some(untracked) = untracked_candidate {
            if self.is_stash_commit(to).await? {
                raw.push_str(&self.diff_tree(EMPTY_TREE_OID, &untracked, "--raw").await?);
                numstat.push_str(&self.diff_tree(EMPTY_TREE_OID, &untracked, "--numstat").await?);
            }
        }

        Ok(parsers::commit_files::parse_commit_files(&raw, &numstat))
    }

    async fn branches(&self) -> Result<Vec<Branch>, GitError> {
        let runner = self.runner().await;
        let fmt_arg = format!("--format={}", parsers::branches::BRANCH_FORMAT);

        let output = runner
            .run(&["for-each-ref", &fmt_arg, "refs/heads", "refs/remotes"])
            .await?;

        Self::ensure_success(&output)?;

        Ok(parsers::branches::parse_branches(&output.stdout))
    }

    async fn blame(&self, path: &Path, rev: Option<&str>) -> Result<Vec<BlameHunk>, GitError> {
        let runner = self.runner().await;
        let path_str = path.to_string_lossy();
        let mut args = vec!["blame", "--porcelain"];
        if let Some(rev) = rev {
            args.push(rev);
        }
        args.push("--");
        args.push(&path_str);
        let output = runner
            .run(&args)
            .await?;
        Self::ensure_success(&output)?;
        Ok(parsers::blame::parse_blame(&output.stdout))
    }

    async fn merge_base(&self, a: &str, b: &str) -> Result<Option<String>, GitError> {
        let runner = self.runner().await;
        let output = runner
            .run(&["merge-base", a, b])
            .await?;
        // Exit 1 = no common ancestor (unrelated histories) - that is an
        // answer, not an error. Unknown revs etc. exit 128 and are errors.
        match output.exit_code {
            Some(0) => Ok(Some(output.stdout.trim().to_string())),
            Some(1) => Ok(None),
            _ => Err(GitError::CommandFailed {
                exit_code: output.exit_code.unwrap_or(-1),
                stderr: output.stderr.trim().to_string(),
            }),
        }
    }

    async fn search_commits(
        &self,
        query: &str,
        kind: CommitSearchKind,
        max_count: u32,
    ) -> Result<Vec<Commit>, GitError> {
        let runner = self.runner().await;
        let fmt_arg = format!("--format={}", parsers::log::LOG_FORMAT);
        let max_arg = format!("--max-count={max_count}");
        let filter = match kind {
            CommitSearchKind::Message => format!("--grep={query}"),
            CommitSearchKind::Author => format!("--author={query}"),
            CommitSearchKind::Content | CommitSearchKind::ContentRegex => query.to_string(),
        };
        let mut args = vec!["log", &fmt_arg, &max_arg];
        match kind {
            CommitSearchKind::Message | CommitSearchKind::Author => {
                args.push("--regexp-ignore-case");
                args.push(&filter);
            }
            CommitSearchKind::Content => {
                args.push("-S");
                args.push(&filter);
            }
            // -G is regex by nature (unlike -S, which needs --pickaxe-regex).
            CommitSearchKind::ContentRegex => {
                args.push("-G");
                args.push(&filter);
            }
        }
        // Same ref universe as the graph: HEAD + all local branches.
        args.push("HEAD");
        args.push("--branches");
        args.push("--decorate=full");

        let output = runner
            .run(&args)
            .await?;
        Self::ensure_success(&output)?;
        parsers::log::parse_log(&output.stdout).map_err(GitError::from)
    }

    async fn search_paths(&self, query: &str, max_count: u32) -> Result<Vec<PathBuf>, GitError> {
        let runner = self.runner().await;
        let output = runner
            .run(&["ls-files", "-z"])
            .await?;
        Self::ensure_success(&output)?;
        Ok(filter_paths(&output.stdout, query, max_count as usize))
    }

    async fn list_repo_files(
        &self,
        show_ignored: bool,
    ) -> Result<Vec<RepoFileEntry>, GitError> {
        let runner = self.runner().await;
        let run = |args: &'static [&'static str]| {
            let runner = runner.clone();
            async move {
                let out = runner
                    .run(args)
                    .await?;
                Self::ensure_success(&out)?;
                Ok::<String, GitError>(out.stdout)
            }
        };
        let cached = run(&["ls-files", "-z"]).await?;
        let others = run(&["ls-files", "-z", "--others", "--exclude-standard"]).await?;
        let ignored = if show_ignored {
            run(&["ls-files", "-z", "--others", "--ignored", "--exclude-standard"]).await?
        } else {
            String::new()
        };
        Ok(classify_repo_files(&cached, &others, &ignored))
    }

    async fn rm_cached(&self, paths: &[PathBuf]) -> Result<(), GitError> {
        self.run_pathspec(&["rm", "--cached", "--"], paths).await
    }

    async fn diff_files(&self, from: &str, to: &str) -> Result<Vec<CommitFileChange>, GitError> {
        let raw = self.diff_tree(from, to, "--raw").await?;
        let numstat = self.diff_tree(from, to, "--numstat").await?;
        Ok(parsers::commit_files::parse_commit_files(&raw, &numstat))
    }

    async fn file_diff(
        &self,
        source: &DiffSource,
        path: &Path,
        old_path: Option<&Path>,
        context: u32,
    ) -> Result<DiffEntry, GitError> {
        let raw = self.run_diff_text(source, path, old_path, context).await?;
        Ok(parsers::diff::parse_file_diff(&raw))
    }

    async fn apply_hunk(
        &self,
        path: &Path,
        hunk_index: usize,
        op: HunkOp,
    ) -> Result<(), GitError> {
        // Always 3 lines of context — the panel's whole-file view doesn't change
        // which hunk an index refers to.
        let raw = self
            .run_diff_text(&Self::source_for_op(op), path, None, 3)
            .await?;
        let patch = parsers::diff::build_hunk_patch(&raw, hunk_index).ok_or_else(|| {
            GitError::Internal(format!("no hunk at index {hunk_index} for {}", path.display()))
        })?;
        self.apply_op_patch(op, &patch).await
    }

    async fn apply_lines(
        &self,
        path: &Path,
        hunk_index: usize,
        line_indices: &[usize],
        op: HunkOp,
    ) -> Result<(), GitError> {
        if line_indices.is_empty() {
            return Ok(());
        }
        let raw = self
            .run_diff_text(&Self::source_for_op(op), path, None, 3)
            .await?;
        // Unstage/discard apply with `-R`, which flips how unselected +/- lines
        // are treated when building the partial patch.
        let reverse = !matches!(op, HunkOp::Stage);
        let selected: std::collections::HashSet<usize> = line_indices.iter().copied().collect();
        let patch = parsers::diff::build_line_patch(&raw, hunk_index, &selected, reverse)
            .ok_or_else(|| {
                GitError::Internal(format!(
                    "no hunk at index {hunk_index} for {}",
                    path.display()
                ))
            })?;
        self.apply_op_patch(op, &patch).await
    }

    async fn commit(&self, opts: CommitOptions) -> Result<CommitId, GitError> {
        let runner = self.runner().await;

        let args = build_commit_args(&opts);
        let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
        let output = runner
            .run(&arg_refs)
            .await?;
        Self::ensure_success(&output)?;

        // Resolve the resulting commit id.
        let head = runner
            .run(&["rev-parse", "HEAD"])
            .await?;
        Self::ensure_success(&head)?;
        Ok(CommitId::new(head.stdout.trim().to_string()))
    }

    async fn reword_commit(&self, id: &CommitId, message: &str) -> Result<CommitId, GitError> {
        let runner = self.runner().await;

        // v1 rewords HEAD only — resolve the tip and reject anything else.
        let head = runner
            .run(&["rev-parse", "HEAD"])
            .await?;
        Self::ensure_success(&head)?;
        if head.stdout.trim() != id.0 {
            return Err(GitError::RewordNotHead);
        }

        // Hard-block rewording published history. `rev-list -n 1 <id> --not
        // --remotes` prints the sha iff it is NOT reachable from any
        // remote-tracking ref; empty output means the commit is already pushed.
        let pushed = runner
            .run(&["rev-list", "-n", "1", &id.0, "--not", "--remotes"])
            .await?;
        Self::ensure_success(&pushed)?;
        if pushed.stdout.trim().is_empty() {
            return Err(GitError::RewordPushed);
        }

        // `--amend --only` with no pathspec rewrites HEAD's message without
        // folding any staged changes, preserving the original author.
        let output = runner
            .run(&["commit", "--amend", "--only", "-m", message])
            .await?;
        Self::ensure_success(&output)?;

        // Resolve the rewritten commit's new id.
        let new_head = runner
            .run(&["rev-parse", "HEAD"])
            .await?;
        Self::ensure_success(&new_head)?;
        Ok(CommitId::new(new_head.stdout.trim().to_string()))
    }

    async fn stage(&self, paths: &[PathBuf]) -> Result<(), GitError> {
        if paths.is_empty() {
            return Ok(());
        }
        self.run_pathspec(&["add", "--"], paths).await
    }

    async fn unstage(&self, paths: &[PathBuf]) -> Result<(), GitError> {
        if paths.is_empty() {
            return Ok(());
        }
        self.run_pathspec(&["restore", "--staged", "--"], paths).await
    }

    async fn discard(&self, paths: &[PathBuf]) -> Result<(), GitError> {
        if paths.is_empty() {
            return Ok(());
        }
        // Classify paths: untracked ones must be removed with `clean`, moved
        // submodule pointers reset via `submodule update` (restore does not
        // touch gitlink worktrees), the rest reverted with `restore
        // --worktree` (restore errors on untracked). Raw entries suffice — no
        // need to pay for the numstat enrichment here.
        let status = self.status_entries().await?;
        let untracked: std::collections::HashSet<&std::path::Path> = status
            .iter()
            .filter(|f| f.state == FileState::Untracked)
            .map(|f| f.path.as_path())
            .collect();
        let submodules: std::collections::HashSet<&std::path::Path> = status
            .iter()
            .filter(|f| f.state == FileState::SubmoduleChanged && !f.staged)
            .map(|f| f.path.as_path())
            .collect();

        let mut untracked_paths = Vec::new();
        let mut submodule_paths = Vec::new();
        let mut tracked_paths = Vec::new();
        for p in paths {
            if untracked.contains(p.as_path()) {
                untracked_paths.push(p.clone());
            } else if submodules.contains(p.as_path()) {
                submodule_paths.push(p.clone());
            } else {
                tracked_paths.push(p.clone());
            }
        }

        if !tracked_paths.is_empty() {
            self.run_pathspec(&["restore", "--worktree", "--"], &tracked_paths)
                .await?;
        }
        if !untracked_paths.is_empty() {
            self.run_pathspec(&["clean", "-f", "--"], &untracked_paths)
                .await?;
        }
        if !submodule_paths.is_empty() {
            // --checkout resets to the recorded SHA; --no-fetch keeps discard
            // strictly local; git itself refuses to overwrite a dirty
            // submodule worktree, so this cannot destroy uncommitted work.
            self.run_pathspec(
                &["submodule", "update", "--checkout", "--no-fetch", "--"],
                &submodule_paths,
            )
            .await?;
        }
        Ok(())
    }

    async fn file_at_revision(&self, rev: &str, path: &Path) -> Result<FileAtRevision, GitError> {
        let runner = self.runner().await;
        let spec = format!("{rev}:{}", path.to_string_lossy());
        let output = runner
            .run(&["show", &spec])
            .await?;
        if !output.success {
            return Err(GitError::CommandFailed {
                exit_code: output.exit_code.unwrap_or(-1),
                stderr: output.stderr.trim().to_string(),
            });
        }
        if !is_binary_content(&output.stdout) {
            return Ok(FileAtRevision::Text(output.stdout));
        }
        // Binary: report the blob's exact size instead of lossy bytes. The
        // decoded string's length is NOT the byte size (each invalid byte
        // became a 3-byte U+FFFD), hence the explicit `cat-file -s`.
        let size = runner
            .run(&["cat-file", "-s", &spec])
            .await?;
        if !size.success {
            return Err(GitError::CommandFailed {
                exit_code: size.exit_code.unwrap_or(-1),
                stderr: size.stderr.trim().to_string(),
            });
        }
        let size_bytes = size.stdout.trim().parse::<u64>().map_err(|_| {
            GitError::Internal(format!("unexpected `cat-file -s` output: {:?}", size.stdout))
        })?;
        Ok(FileAtRevision::Binary { size_bytes })
    }

    async fn restore_file_at_revision(&self, rev: &str, path: &Path) -> Result<(), GitError> {
        // A pathspec checkout touches index + worktree and never refuses on
        // local changes - the destructive-confirm gate lives in the UI.
        let source = self.resolve_file_content_source(rev, path).await?;
        self.run_pathspec(&["checkout", &source, "--"], std::slice::from_ref(&path.to_path_buf()))
            .await
    }

    async fn apply_stash_file(&self, stash_sha: &str, path: &Path) -> Result<(), GitError> {
        // Per-file counterpart of `git stash apply`, which lands changes
        // UNSTAGED - so this writes the worktree only (`restore --source`),
        // never the index. Untracked-stashed files come back untracked.
        let source = self.resolve_file_content_source(stash_sha, path).await?;
        let src_arg = format!("--source={source}");
        self.run_pathspec(
            &["restore", &src_arg, "--worktree", "--"],
            std::slice::from_ref(&path.to_path_buf()),
        )
        .await
    }

    async fn file_history(
        &self,
        path: &Path,
        max_count: u32,
        skip: u32,
    ) -> Result<Vec<FileHistoryEntry>, GitError> {
        let runner = self.runner().await;
        let path_str = path.to_string_lossy();
        let fmt_arg = format!("--format={}", parsers::file_history::FILE_HISTORY_FORMAT);
        let max_arg = format!("--max-count={max_count}");
        let skip_arg = format!("--skip={skip}");
        // `--follow` requires exactly one pathspec (guaranteed here). `-M`
        // enables the rename detection that produces the `R<score>` lines.
        let mut args = vec!["log"];
        args.extend(parsers::file_history::FILE_HISTORY_FLAGS);
        args.push(&fmt_arg);
        args.push(&max_arg);
        args.push(&skip_arg);
        args.push("--");
        args.push(&path_str);
        let output = runner
            .run(&args)
            .await?;
        if !output.success {
            return Err(GitError::CommandFailed {
                exit_code: output.exit_code.unwrap_or(-1),
                stderr: output.stderr.trim().to_string(),
            });
        }
        parsers::file_history::parse_file_history(&output.stdout, &path_str).map_err(GitError::from)
    }

    async fn submodules(&self) -> Result<Vec<SubmoduleInfo>, GitError> {
        use parsers::submodules as sub;
        let runner = self.runner().await;

        let ls = runner
            .run(&sub::LS_FILES_STAGE_ARGS)
            .await?;
        Self::ensure_success(&ls)?;
        let gitlinks = sub::parse_gitlinks(&ls.stdout);

        // Both config reads exit non-zero for "no matches / no file" - that
        // is a normal repo without submodules, never an error.
        let gitmodules = match runner.run(&sub::GITMODULES_CONFIG_ARGS).await {
            Ok(o) if o.success => sub::parse_submodule_config(&o.stdout),
            _ => Default::default(),
        };
        let local = match runner.run(&sub::LOCAL_SUBMODULE_CONFIG_ARGS).await {
            Ok(o) if o.success => sub::parse_submodule_config(&o.stdout),
            _ => Default::default(),
        };

        // Dirt flags ride along the one superproject status call - never a
        // per-submodule status walk (spec: perf discipline).
        let dirt = match runner.run(&parsers::status::STATUS_ARGS).await {
            Ok(o) if o.success => sub::parse_status_submodule_flags(&o.stdout),
            _ => Default::default(),
        };

        // One probe per gitlink: HEAD sha (failure = unpopulated), then the
        // branch only for populated ones. `--show-prefix` guards against git
        // walking UP from an empty/unpopulated submodule dir into the
        // superproject (verified by `submodule_ops_roundtrip_deinit_init_update`
        // in git_flows.rs): a genuine submodule root reports an empty prefix.
        let mut probes = std::collections::HashMap::new();
        for (path, _) in &gitlinks {
            let p = path.to_string_lossy().into_owned();
            let head = match runner
                .run(&["-C", &p, "rev-parse", "--show-prefix", "HEAD"])
                .await
            {
                Ok(o) if o.success => {
                    let mut lines = o.stdout.lines();
                    let prefix = lines.next().unwrap_or("").trim().to_string();
                    let sha = lines.next().unwrap_or("").trim().to_string();
                    if !prefix.is_empty() || sha.is_empty() {
                        continue; // escaped to the superproject: unpopulated
                    }
                    sha
                }
                _ => continue,
            };
            let head_branch = match runner
                .run(&["-C", &p, "rev-parse", "--abbrev-ref", "HEAD"])
                .await
            {
                Ok(o) if o.success => {
                    let b = o.stdout.trim();
                    // `abbrev-ref HEAD` prints literally `HEAD` when detached.
                    if b == "HEAD" { None } else { Some(b.to_string()) }
                }
                _ => None,
            };
            probes.insert(
                path.clone(),
                sub::SubmoduleProbe { checked_out_sha: CommitId::new(head), head_branch },
            );
        }

        Ok(sub::assemble_submodules(&gitlinks, &gitmodules, &local, &dirt, &probes))
    }

    async fn submodule_log(
        &self,
        path: &Path,
        from: Option<&CommitId>,
        to: &CommitId,
    ) -> Result<SubmoduleLog, GitError> {
        use parsers::submodules as sub;
        let runner = self.runner().await;
        let p = path.to_string_lossy().into_owned();

        // Unfetched pointer target is an expected state, not an error.
        let probe = format!("{}^{{commit}}", to.as_str());
        match runner.run(&["-C", &p, "cat-file", "-e", &probe]).await {
            Ok(o) if o.success => {}
            Ok(_) => return Ok(SubmoduleLog::TargetMissing),
            Err(e) => return Err(GitError::Internal(e.to_string())),
        }

        let range = match from {
            Some(f) => format!("{}..{}", f.as_str(), to.as_str()),
            None => to.as_str().to_string(),
        };
        let out = runner
            .run(&["-C", &p, "log", sub::SUBMODULE_LOG_FORMAT, sub::SUBMODULE_LOG_MAX, &range])
            .await?;
        Self::ensure_success(&out)?;
        Ok(SubmoduleLog::Commits { commits: sub::parse_submodule_log(&out.stdout) })
    }

    async fn submodule_init(&self, paths: &[PathBuf]) -> Result<(), GitError> {
        if paths.is_empty() {
            return self.run_simple(&["submodule", "init"]).await;
        }
        self.run_pathspec(&["submodule", "init", "--"], paths).await
    }

    async fn submodule_update(
        &self,
        opts: SubmoduleUpdateOptions,
        op_id: OperationId,
    ) -> Result<(), GitError> {
        let runner = self.runner().await;
        let mut args: Vec<String> = vec!["submodule".into(), "update".into()];
        if opts.init {
            args.push("--init".into());
        }
        if opts.recursive {
            args.push("--recursive".into());
        }
        if !opts.paths.is_empty() {
            args.push("--".into());
            for p in &opts.paths {
                args.push(p.to_string_lossy().into_owned());
            }
        }
        // May clone/fetch missing commits: run as a remote op (progress,
        // cancel, auth-aware error classification).
        self.run_remote(&runner, &args, op_id).await
    }

    async fn submodule_sync(&self, paths: &[PathBuf], recursive: bool) -> Result<(), GitError> {
        let base: &[&str] = if recursive {
            &["submodule", "sync", "--recursive"]
        } else {
            &["submodule", "sync"]
        };
        if paths.is_empty() {
            return self.run_simple(base).await;
        }
        let mut with_sep: Vec<&str> = base.to_vec();
        with_sep.push("--");
        self.run_pathspec(&with_sep, paths).await
    }

    async fn submodule_fetch(&self, path: &Path, op_id: OperationId) -> Result<(), GitError> {
        let runner = self.runner().await;
        let args: Vec<String> = vec![
            "-C".into(),
            path.to_string_lossy().into_owned(),
            "fetch".into(),
        ];
        self.run_remote(&runner, &args, op_id).await
    }

    async fn superproject_path(&self) -> Result<Option<PathBuf>, GitError> {
        let runner = self.runner().await;
        let out = runner
            .run(&["rev-parse", "--show-superproject-working-tree"])
            .await?;
        Self::ensure_success(&out)?;
        let path = out.stdout.trim();
        Ok(if path.is_empty() { None } else { Some(PathBuf::from(path)) })
    }

    async fn submodule_add(
        &self,
        url: &str,
        path: &Path,
        branch: Option<&str>,
        op_id: OperationId,
    ) -> Result<(), GitError> {
        let runner = self.runner().await;
        let mut args: Vec<String> = vec!["submodule".into(), "add".into()];
        if let Some(b) = branch {
            args.push("-b".into());
            args.push(b.to_string());
        }
        args.push("--".into());
        args.push(url.to_string());
        args.push(path.to_string_lossy().into_owned());
        // Clones the repository: run as a remote op (progress, cancel, auth).
        self.run_remote(&runner, &args, op_id).await
    }

    async fn submodule_set_url(&self, path: &Path, url: &str) -> Result<(), GitError> {
        let p = path.to_string_lossy().into_owned();
        self.run_simple(&["submodule", "set-url", "--", &p, url]).await?;
        // set-url edits .gitmodules only; sync propagates to .git/config and
        // the submodule's origin (spec: set-url auto-syncs).
        self.run_simple(&["submodule", "sync", "--", &p]).await
    }

    async fn submodule_set_branch(&self, path: &Path, branch: Option<&str>) -> Result<(), GitError> {
        let p = path.to_string_lossy().into_owned();
        match branch {
            Some(b) => {
                self.run_simple(&["submodule", "set-branch", "--branch", b, "--", &p])
                    .await
            }
            None => {
                self.run_simple(&["submodule", "set-branch", "--default", "--", &p])
                    .await
            }
        }
    }

    async fn submodule_update_remote(
        &self,
        paths: &[PathBuf],
        strategy: SubmoduleUpdateStrategy,
        behavior: SwitchDirtyBehavior,
        op_id: OperationId,
    ) -> Result<Vec<SubmoduleAutoUpdateResult>, GitError> {
        // Per-submodule composed flow (shared with the post-switch/pull
        // auto-update): dirty submodules follow the global switch strategy
        // instead of letting git's checkout refusal surface as a raw error,
        // and a conflicted carry-over rolls back with the changes intact.
        let subs = self.submodules().await?;
        let mut results = Vec::new();
        let mut to_stage: Vec<PathBuf> = Vec::new();
        for s in subs {
            if !s.state.populated || !s.state.initialized {
                continue;
            }
            if !paths.is_empty() && !paths.contains(&s.path) {
                continue;
            }
            let Some(old) = s.checked_out_sha.clone() else { continue };
            let status = self
                .update_one_submodule(
                    &s,
                    old.as_str(),
                    behavior,
                    SubmoduleMove::Remote(strategy),
                    Some(&op_id),
                )
                .await;
            // `--remote` moves worktrees but not the index: stage the pointer
            // of every submodule that actually moved, so the operation reads
            // as one atomic "pull latest and record it" (spec sub-project 4).
            if matches!(
                status,
                SubmoduleAutoUpdateStatus::Updated
                    | SubmoduleAutoUpdateStatus::ChangesCarried
                    | SubmoduleAutoUpdateStatus::ChangesStashed
            ) {
                to_stage.push(s.path.clone());
            }
            results.push(SubmoduleAutoUpdateResult { path: s.path, status });
        }
        if !to_stage.is_empty() {
            self.run_pathspec(&["add", "--"], &to_stage).await?;
        }
        Ok(results)
    }

    async fn submodule_remove(&self, path: &Path) -> Result<(), GitError> {
        // Refuse dirty/conflicted BEFORE any mutation: `git rm -f` would
        // happily discard uncommitted submodule work.
        let runner = self.runner().await;
        let status = runner
            .run(&parsers::status::STATUS_ARGS)
            .await?;
        Self::ensure_success(&status)?;
        let dirt = parsers::submodules::parse_status_submodule_flags(&status.stdout);
        if let Some(d) = dirt.get(path) {
            if d.dirty_tracked || d.dirty_untracked || d.conflicted {
                return Err(GitError::WouldOverwriteLocalChanges(format!(
                    "submodule '{}' has uncommitted changes - commit or discard them inside the submodule first",
                    path.display()
                )));
            }
        }
        drop(runner);

        let p = path.to_string_lossy().into_owned();
        // Embedded `.git` directories move into `.git/modules/<name>` so the
        // history survives `rm` (magit runs this too; no-op when absorbed).
        self.run_simple(&["submodule", "absorbgitdirs", "--", &p]).await?;
        self.run_simple(&["submodule", "deinit", "-f", "--", &p]).await?;
        // Removes worktree + index gitlink and STAGES the .gitmodules edit.
        self.run_simple(&["rm", "-f", "--", &p]).await
    }

    async fn submodule_gitdir_info(
        &self,
        name: &str,
    ) -> Result<Option<SubmoduleGitdirInfo>, GitError> {
        let Some(gitdir) = self.submodule_gitdir_path(name).await? else {
            return Ok(None);
        };
        // Any commit on a local branch that no remote ref reaches would be
        // destroyed by deleting the gitdir - surface that before the confirm.
        let runner = self.runner().await;
        let gd = gitdir.to_string_lossy().into_owned();
        let unpushed = match runner
            .run(&["--git-dir", &gd, "log", "--branches", "--not", "--remotes", "--oneline", "-n", "1"])
            .await
        {
            Ok(o) if o.success => !o.stdout.trim().is_empty(),
            // A broken/bare-ish leftover gitdir: treat as "unknown, warn".
            _ => true,
        };
        Ok(Some(SubmoduleGitdirInfo { path: gitdir, unpushed }))
    }

    async fn submodule_delete_gitdir(&self, name: &str) -> Result<(), GitError> {
        let Some(gitdir) = self.submodule_gitdir_path(name).await? else {
            return Err(GitError::Internal(format!(
                "no retained gitdir for submodule '{name}'"
            )));
        };
        std::fs::remove_dir_all(&gitdir)
            .map_err(|e| GitError::Internal(format!("could not delete {}: {e}", gitdir.display())))
    }

    async fn submodule_create_branch(&self, path: &Path, name: &str) -> Result<(), GitError> {
        let p = path.to_string_lossy().into_owned();
        self.run_simple(&["-C", &p, "switch", "-c", name]).await
    }

    async fn submodule_auto_update(
        &self,
        behavior: SwitchDirtyBehavior,
    ) -> Result<Vec<SubmoduleAutoUpdateResult>, GitError> {
        let subs = self.submodules().await?;
        let mut results = Vec::new();
        for s in subs {
            if !s.state.populated || !s.state.pointer_moved {
                continue;
            }
            let (Some(recorded), Some(old)) = (s.recorded_sha.clone(), s.checked_out_sha.clone())
            else {
                continue;
            };
            let _ = recorded; // target derives from the index inside the move
            let status = self
                .update_one_submodule(&s, old.as_str(), behavior, SubmoduleMove::Recorded, None)
                .await;
            results.push(SubmoduleAutoUpdateResult { path: s.path, status });
        }
        Ok(results)
    }

    async fn fetch(&self, opts: FetchOptions, op_id: OperationId) -> Result<(), GitError> {
        let runner = self.runner().await;
        let args = build_fetch_args(&opts);
        self.run_remote(&runner, &args, op_id).await
    }

    async fn pull(&self, opts: PullOptions, op_id: OperationId) -> Result<(), GitError> {
        let runner = self.runner().await;
        let args = build_pull_args(&opts);
        self.run_remote(&runner, &args, op_id).await
    }

    async fn push(&self, opts: PushOptions, op_id: OperationId) -> Result<(), GitError> {
        let runner = self.runner().await;
        let args = build_push_args(&opts);
        self.run_remote(&runner, &args, op_id).await
    }

    async fn tracking_status(&self) -> Result<Option<TrackingStatus>, GitError> {
        let runner = self.runner().await;

        // Current branch (short). A detached HEAD makes symbolic-ref fail → None.
        let br = runner
            .run(&["symbolic-ref", "--quiet", "--short", "HEAD"])
            .await?;
        if !br.success {
            return Ok(None);
        }
        let branch = br.stdout.trim().to_string();
        if branch.is_empty() {
            return Ok(None);
        }

        // Upstream short ref. No upstream configured → rev-parse fails → None.
        let up = runner
            .run(&[
                "rev-parse",
                "--abbrev-ref",
                "--symbolic-full-name",
                "@{upstream}",
            ])
            .await?;
        if !up.success {
            return Ok(None);
        }
        let upstream = up.stdout.trim().to_string();
        if upstream.is_empty() {
            return Ok(None);
        }

        // Ahead/behind counts: left = behind (upstream-only), right = ahead.
        let range = format!("{upstream}...HEAD");
        let counts = runner
            .run(&["rev-list", "--left-right", "--count", &range])
            .await?;
        Self::ensure_success(&counts)?;
        let (behind, ahead) =
            parsers::tracking::parse_rev_list_counts(&counts.stdout).unwrap_or((0, 0));

        Ok(Some(TrackingStatus {
            branch,
            upstream,
            ahead,
            behind,
        }))
    }

    async fn list_remotes(&self) -> Result<Vec<Remote>, GitError> {
        let runner = self.runner().await;
        let output = runner
            .run(&parsers::remotes::REMOTE_LIST_ARGS)
            .await?;
        Self::ensure_success(&output)?;
        Ok(parsers::remotes::parse_remotes(&output.stdout))
    }

    async fn add_remote(&self, name: &str, url: &str) -> Result<(), GitError> {
        self.run_simple(&["remote", "add", name, url]).await
    }

    async fn remove_remote(&self, name: &str) -> Result<(), GitError> {
        self.run_simple(&["remote", "remove", name]).await
    }

    async fn rename_remote(&self, old: &str, new: &str) -> Result<(), GitError> {
        self.run_simple(&["remote", "rename", old, new]).await
    }

    async fn set_remote_url(&self, name: &str, url: &str, push: bool) -> Result<(), GitError> {
        self.run_simple(&build_set_url_args(name, url, push)).await
    }

    async fn prune_remote(&self, name: &str, op_id: OperationId) -> Result<(), GitError> {
        // Network op (contacts the remote) → cancellable + remote-error mapping.
        let runner = self.runner().await;
        let args = vec!["remote".to_string(), "prune".to_string(), name.to_string()];
        self.run_remote(&runner, &args, op_id).await
    }

    async fn create_branch(&self, name: &str, start_point: Option<&str>) -> Result<(), GitError> {
        let mut args = vec!["branch", name];
        if let Some(sp) = start_point {
            args.push(sp);
        }
        self.run_simple(&args).await
    }

    async fn switch_branch(&self, name: &str, behavior: SwitchDirtyBehavior) -> Result<SwitchOutcome, GitError> {
        self.run_with_auto_stash(behavior, &["switch", name]).await
    }

    async fn checkout_commit(&self, sha: &str, behavior: SwitchDirtyBehavior) -> Result<SwitchOutcome, GitError> {
        self.run_with_auto_stash(behavior, &["switch", "--detach", sha]).await
    }

    async fn checkout_remote_branch(
        &self,
        remote_ref: &str,
        behavior: SwitchDirtyBehavior,
    ) -> Result<SwitchOutcome, GitError> {
        let (short, local) = remote_ref_names(remote_ref);
        // `switch --track` refuses when the local branch already exists — the
        // common case of checking out a remote ref that was checked out once
        // before. The user's intent is "get me on that branch", so check for
        // the local counterpart first and plain-switch to it when present.
        // (Checked up front rather than retried on failure, so the auto-stash
        // runs exactly once.)
        let local_ref = format!("refs/heads/{local}");
        let runner = self.runner().await;
        let local_exists = runner
            .run(&["rev-parse", "-q", "--verify", &local_ref])
            .await?
            .success;
        let args: &[&str] = if local_exists {
            &["switch", local]
        } else {
            &["switch", "--track", short]
        };
        self.run_with_auto_stash(behavior, args).await
    }

    async fn delete_branch(&self, name: &str, force: bool) -> Result<(), GitError> {
        let flag = if force { "-D" } else { "-d" };
        self.run_simple(&["branch", flag, name]).await
    }

    async fn delete_remote_branch(
        &self,
        remote: &str,
        name: &str,
        op_id: OperationId,
    ) -> Result<(), GitError> {
        let runner = self.runner().await;
        let args = vec![
            "push".to_string(),
            remote.to_string(),
            "--delete".to_string(),
            format!("refs/heads/{name}"),
        ];
        self.run_remote(&runner, &args, op_id).await
    }

    async fn rename_branch(&self, old_name: &str, new_name: &str) -> Result<(), GitError> {
        self.run_simple(&["branch", "-m", old_name, new_name]).await
    }

    async fn tags(&self) -> Result<Vec<TagInfo>, GitError> {
        let runner = self.runner().await;
        let fmt_arg = format!("--format={}", parsers::tags::TAGS_FORMAT);
        let output = runner
            .run(&["for-each-ref", &fmt_arg, "refs/tags"])
            .await?;
        Self::ensure_success(&output)?;
        let mut tags = parsers::tags::parse_tags(&output.stdout);
        if !tags.is_empty() {
            // Mark tags whose target commit is not reachable from any
            // remote-tracking ref: pushing such a tag would upload commits no
            // remote branch references, so the UI disables it. Best-effort: a
            // failed probe leaves the permissive default (push allowed).
            let probe = runner
                .run(&parsers::tags::REV_LIST_UNPUSHED_TAG_TARGETS_ARGS)
                .await;
            if let Ok(out) = probe {
                if out.success {
                    parsers::tags::mark_unpushed_targets(&mut tags, &out.stdout);
                }
            }
        }
        Ok(tags)
    }

    async fn create_tag(
        &self,
        name: &str,
        target: Option<&str>,
        message: Option<&str>,
    ) -> Result<(), GitError> {
        self.run_simple(&build_tag_args(name, target, message)).await
    }

    async fn delete_tag(&self, name: &str) -> Result<(), GitError> {
        self.run_simple(&["tag", "-d", name]).await
    }

    async fn push_tag(&self, remote: &str, name: &str, op_id: OperationId) -> Result<(), GitError> {
        let runner = self.runner().await;
        // The full refspec avoids any ambiguity with a same-named branch.
        let args = vec![
            "push".to_string(),
            remote.to_string(),
            format!("refs/tags/{name}"),
        ];
        self.run_remote(&runner, &args, op_id).await
    }

    async fn delete_remote_tag(
        &self,
        remote: &str,
        name: &str,
        op_id: OperationId,
    ) -> Result<(), GitError> {
        let runner = self.runner().await;
        let args = vec![
            "push".to_string(),
            remote.to_string(),
            "--delete".to_string(),
            format!("refs/tags/{name}"),
        ];
        self.run_remote(&runner, &args, op_id).await
    }

    async fn remote_tags(&self, remote: &str, op_id: OperationId) -> Result<Vec<RemoteTag>, GitError> {
        let runner = self.runner().await;
        let output = runner
            .run_with_op(&["ls-remote", "--tags", remote], op_id)
            .await?;
        if !output.success {
            return Err(classify_remote_error(
                output.exit_code.unwrap_or(-1),
                &output.stderr,
            ));
        }
        Ok(parsers::tags::parse_remote_tags(&output.stdout))
    }

    async fn stashes(&self) -> Result<Vec<StashEntry>, GitError> {
        let runner = self.runner().await;
        let fmt_arg = format!("--format={}", parsers::stash::STASH_FORMAT);

        let output = runner
            .run(&["stash", "list", &fmt_arg])
            .await?;

        Self::ensure_success(&output)?;

        Ok(parsers::stash::parse_stashes(&output.stdout))
    }

    async fn create_stash(
        &self,
        message: Option<&str>,
        include_untracked: bool,
        keep_index: bool,
    ) -> Result<StashOutcome, GitError> {
        let mut args = vec!["stash", "push"];
        if include_untracked {
            args.push("--include-untracked");
        }
        if keep_index {
            args.push("--keep-index");
        }
        if let Some(msg) = message.filter(|m| !m.is_empty()) {
            args.push("-m");
            args.push(msg);
        }
        // `git stash push` on a clean tree exits 0 ("No local changes to save"
        // on stdout), so the outcome is decided by whether the stash tip moved,
        // not by the exit code (which only signals real failures).
        let tip_before = self.stash_tip().await?;
        self.run_simple(&args).await?;
        let tip_after = self.stash_tip().await?;
        if stash_created(tip_before.as_deref(), tip_after.as_deref()).is_some() {
            Ok(StashOutcome::Created)
        } else {
            Ok(StashOutcome::NothingToStash)
        }
    }

    async fn create_stash_paths(
        &self,
        message: Option<&str>,
        paths: &[PathBuf],
    ) -> Result<StashOutcome, GitError> {
        let mut prefix = vec!["stash", "push", "--include-untracked"];
        if let Some(msg) = message.filter(|m| !m.is_empty()) {
            prefix.push("-m");
            prefix.push(msg);
        }
        prefix.push("--");

        // Same tip-compare outcome as create_stash: a pathspec matching only
        // clean files exits 0 ("No local changes to save") without stashing.
        let tip_before = self.stash_tip().await?;

        // `git stash push -- <pathspec>` embeds the ENTIRE index in the stash
        // entry: other files' staged changes ride along invisibly (they stay
        // staged locally, but the stash lists them and a later pop can
        // resurrect a staged change discarded in the meantime - verified
        // against the real binary). Isolate the index around the push: save
        // it, reset it to HEAD (worktree untouched) so the push can only
        // capture the named paths, then restore it.
        let saved_index = self.write_tree().await?;
        self.run_simple(&["read-tree", "HEAD"]).await?;
        let push = self.run_pathspec(&prefix, paths).await;
        // The index is ALWAYS restored, also when the push failed. Losing the
        // restore never loses content (the worktree holds it) - staged
        // changes would merely show as unstaged - but the user must be told.
        let restore = self.run_simple(&["read-tree", &saved_index]).await;
        match (push, restore) {
            (Err(pe), Err(_)) => {
                return Err(append_error_note(
                    pe,
                    "Note: restoring the index afterwards also failed - staged changes may \
                     now show as unstaged (file contents are intact).",
                ));
            }
            (Err(pe), Ok(())) => return Err(pe),
            (Ok(()), Err(re)) => {
                return Err(append_error_note(
                    re,
                    "Note: the stash itself was created, but restoring the index failed - \
                     staged changes may now show as unstaged (file contents are intact).",
                ));
            }
            (Ok(()), Ok(())) => {}
        }

        let tip_after = self.stash_tip().await?;
        if stash_created(tip_before.as_deref(), tip_after.as_deref()).is_some() {
            // The restored index still carries the stashed paths' old staged
            // content; reset those entries to HEAD - their content lives in
            // the stash now. `reset -q` tolerates paths HEAD never had
            // (stashed-from-untracked).
            self.run_pathspec(&["reset", "-q", "--"], paths)
                .await
                .map_err(|e| {
                    append_error_note(
                        e,
                        "Note: the stash was created, but the stashed paths' index entries \
                         could not be reset - they may still show staged content.",
                    )
                })?;
            Ok(StashOutcome::Created)
        } else {
            Ok(StashOutcome::NothingToStash)
        }
    }

    async fn apply_stash(&self, stash_sha: &str) -> Result<StashApplyOutcome, GitError> {
        let selector = self.resolve_stash_selector(stash_sha).await?;
        self.run_stash_apply(&["stash", "apply", &selector]).await
    }

    async fn pop_stash(&self, stash_sha: &str) -> Result<StashApplyOutcome, GitError> {
        let selector = self.resolve_stash_selector(stash_sha).await?;
        self.run_stash_apply(&["stash", "pop", &selector]).await
    }

    async fn drop_stash(&self, stash_sha: &str) -> Result<(), GitError> {
        let selector = self.resolve_stash_selector(stash_sha).await?;
        self.run_simple(&["stash", "drop", &selector]).await
    }

    async fn set_upstream(&self, branch: &str, upstream: Option<&str>) -> Result<(), GitError> {
        match upstream {
            Some(up) => {
                let arg = format!("--set-upstream-to={up}");
                self.run_simple(&["branch", &arg, branch]).await
            }
            None => self.run_simple(&["branch", "--unset-upstream", branch]).await,
        }
    }

    async fn stash_branch(&self, stash_sha: &str, branch_name: &str) -> Result<(), GitError> {
        let selector = self.resolve_stash_selector(stash_sha).await?;
        // `stash branch` is checkout -b at the stash base + apply + drop; its
        // failure mode is the checkout's, so classify like a switch.
        self.run_switch(&["stash", "branch", branch_name, &selector]).await
    }

    async fn rename_stash(&self, stash_sha: &str, new_message: &str) -> Result<(), GitError> {
        let selector = self.resolve_stash_selector(stash_sha).await?;
        // Drop the old entry, then re-store the same commit (we already hold its
        // SHA, so the content survives even if the store step fails — it stays
        // reachable via fsck). `git stash store` prepends, so the renamed stash
        // lands at stash@{0}.
        self.run_simple(&["stash", "drop", &selector]).await?;
        self.run_simple(&["stash", "store", "-m", new_message, stash_sha]).await
    }

    async fn merge(&self, target: &str, opts: MergeOptions) -> Result<MergeOutcome, GitError> {
        let args = merge_args(target, opts);
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        let (code, stdout, stderr) = self.run_classified(&refs).await?;
        classify_merge_output(code, &stdout, &stderr, opts.squash)
    }

    async fn merge_continue(&self) -> Result<MergeOutcome, GitError> {
        let (code, stdout, stderr) = self
            .run_classified_env(&MERGE_CONTINUE_ARGS, EDITOR_ACCEPT_ENV)
            .await?;
        classify_merge_output(code, &stdout, &stderr, false)
    }

    async fn merge_abort(&self) -> Result<(), GitError> {
        self.run_simple(&MERGE_ABORT_ARGS).await
    }

    async fn rebase(&self, onto: &str) -> Result<RebaseOutcome, GitError> {
        let args = rebase_args(onto);
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        let (code, stdout, stderr) = self.run_classified(&refs).await?;
        classify_rebase_output(code, &stdout, &stderr)
    }

    async fn rebase_continue(&self) -> Result<RebaseOutcome, GitError> {
        let (code, stdout, stderr) = self
            .run_classified_env(&REBASE_CONTINUE_ARGS, EDITOR_ACCEPT_ENV)
            .await?;
        classify_rebase_output(code, &stdout, &stderr)
    }

    async fn rebase_skip(&self) -> Result<RebaseOutcome, GitError> {
        let (code, stdout, stderr) = self
            .run_classified_env(&REBASE_SKIP_ARGS, EDITOR_ACCEPT_ENV)
            .await?;
        classify_rebase_output(code, &stdout, &stderr)
    }

    async fn rebase_abort(&self) -> Result<(), GitError> {
        self.run_simple(&REBASE_ABORT_ARGS).await
    }

    async fn conflict_file_sides(&self, path: &Path) -> Result<ConflictFileSides, GitError> {
        // `git show :N:<path>` per stage; a missing stage exits non-zero and
        // means "no content on that side" (add/add, delete conflicts).
        let runner = self.runner().await;
        let mut sides = [None, None, None];
        for (i, stage) in ["1", "2", "3"].iter().enumerate() {
            let spec = format!(":{stage}:{}", path.to_string_lossy());
            let output = runner
                .run(&["show", &spec])
                .await?;
            if output.success {
                sides[i] = Some(output.stdout);
            }
        }
        let [base, ours, theirs] = sides;
        Ok(ConflictFileSides { base, ours, theirs })
    }

    async fn rebase_interactive(
        &self,
        base: &str,
        plan: &[RebaseStep],
    ) -> Result<RebaseOutcome, GitError> {
        let todo = build_rebase_todo(plan)?;
        // No temp script: sh completes `printf '<todo>' >` with the todo path
        // git appends, writing the plan straight into git's own todo file.
        // Safe to interpolate: `build_rebase_todo` rejects non-hex shas, so
        // the single-quoted printf format can never be broken out of.
        let editor = format!("printf '{todo}' >");
        let env = [("GIT_SEQUENCE_EDITOR", editor.as_str()), ("GIT_EDITOR", "true")];
        let (code, stdout, stderr) = self
            .run_classified_env(&["rebase", "-i", "--autostash", base], &env)
            .await?;
        classify_rebase_output(code, &stdout, &stderr)
    }

    async fn reset(&self, target: &str, mode: ResetMode) -> Result<(), GitError> {
        let flag = match mode {
            ResetMode::Soft => "--soft",
            ResetMode::Mixed => "--mixed",
            ResetMode::Hard => "--hard",
        };
        self.run_simple(&["reset", flag, target]).await
    }

    async fn revert(&self, sha: &str) -> Result<SequenceOutcome, GitError> {
        // --no-edit: the runner hardens GIT_EDITOR=false, so a revert that
        // opened an editor for its message would fail outright.
        let (code, stdout, stderr) = self.run_classified(&["revert", "--no-edit", sha]).await?;
        classify_sequence_output(code, &stdout, &stderr)
    }

    async fn cherry_pick(&self, sha: &str) -> Result<SequenceOutcome, GitError> {
        let (code, stdout, stderr) = self.run_classified(&["cherry-pick", sha]).await?;
        classify_sequence_output(code, &stdout, &stderr)
    }

    async fn cherry_pick_continue(&self) -> Result<SequenceOutcome, GitError> {
        let (code, stdout, stderr) = self
            .run_classified_env(&CHERRY_PICK_CONTINUE_ARGS, EDITOR_ACCEPT_ENV)
            .await?;
        classify_sequence_output(code, &stdout, &stderr)
    }

    async fn cherry_pick_skip(&self) -> Result<SequenceOutcome, GitError> {
        let (code, stdout, stderr) = self
            .run_classified_env(&CHERRY_PICK_SKIP_ARGS, EDITOR_ACCEPT_ENV)
            .await?;
        classify_sequence_output(code, &stdout, &stderr)
    }

    async fn cherry_pick_abort(&self) -> Result<(), GitError> {
        self.run_simple(&CHERRY_PICK_ABORT_ARGS).await
    }

    async fn revert_continue(&self) -> Result<SequenceOutcome, GitError> {
        let (code, stdout, stderr) = self
            .run_classified_env(&REVERT_CONTINUE_ARGS, EDITOR_ACCEPT_ENV)
            .await?;
        classify_sequence_output(code, &stdout, &stderr)
    }

    async fn revert_skip(&self) -> Result<SequenceOutcome, GitError> {
        let (code, stdout, stderr) = self
            .run_classified_env(&REVERT_SKIP_ARGS, EDITOR_ACCEPT_ENV)
            .await?;
        classify_sequence_output(code, &stdout, &stderr)
    }

    async fn revert_abort(&self) -> Result<(), GitError> {
        self.run_simple(&REVERT_ABORT_ARGS).await
    }

    async fn reflog(&self, max_count: u32) -> Result<Vec<ReflogEntry>, GitError> {
        let runner = self.runner().await;
        let fmt_arg = format!("--format={}", parsers::reflog::REFLOG_FORMAT);
        let count_arg = format!("-n{max_count}");
        let output = runner
            .run(&["reflog", &count_arg, &fmt_arg])
            .await?;
        Self::ensure_success(&output)?;
        Ok(parsers::reflog::parse_reflog(&output.stdout))
    }

    async fn op_state(&self) -> Result<RepoOpState, GitError> {
        // git reports the state paths; only existence/content is read from
        // disk. --path-format=absolute avoids joining against the workdir.
        let (code, stdout, stderr) = self
            .run_classified(&[
                "rev-parse",
                "--path-format=absolute",
                "--git-path",
                "MERGE_HEAD",
                "--git-path",
                "MERGE_MSG",
                "--git-path",
                "rebase-merge",
                "--git-path",
                "rebase-apply",
                "--git-path",
                "CHERRY_PICK_HEAD",
                "--git-path",
                "REVERT_HEAD",
            ])
            .await?;
        if code != 0 {
            return Err(GitError::CommandFailed {
                exit_code: code,
                stderr: stderr.trim().to_string(),
            });
        }
        let lines: Vec<&str> = stdout.lines().map(str::trim).collect();
        if lines.len() < 6 {
            return Err(GitError::Parse(format!(
                "rev-parse --git-path returned {} lines",
                lines.len()
            )));
        }

        async fn read_opt(p: PathBuf) -> Option<String> {
            tokio::fs::read_to_string(p).await.ok()
        }
        async fn exists(p: &Path) -> bool {
            tokio::fs::metadata(p).await.is_ok()
        }

        let merge_head = Path::new(lines[0]);
        let merge_msg = Path::new(lines[1]);
        let rebase_merge = Path::new(lines[2]);
        let rebase_apply = Path::new(lines[3]);
        let cherry = Path::new(lines[4]);
        let revert = Path::new(lines[5]);

        let probe = parsers::op_state::OpStateProbe {
            merge_head: exists(merge_head).await,
            merge_msg: read_opt(merge_msg.to_path_buf()).await,
            rebase_merge: if exists(rebase_merge).await {
                Some(parsers::op_state::RebaseMergeFiles {
                    head_name: read_opt(rebase_merge.join("head-name")).await,
                    onto: read_opt(rebase_merge.join("onto")).await,
                    msgnum: read_opt(rebase_merge.join("msgnum")).await,
                    end: read_opt(rebase_merge.join("end")).await,
                })
            } else {
                None
            },
            rebase_apply: if exists(rebase_apply).await {
                Some(parsers::op_state::RebaseApplyFiles {
                    next: read_opt(rebase_apply.join("next")).await,
                    last: read_opt(rebase_apply.join("last")).await,
                    head_name: read_opt(rebase_apply.join("head-name")).await,
                })
            } else {
                None
            },
            cherry_pick_head: read_opt(cherry.to_path_buf()).await,
            revert_head: read_opt(revert.to_path_buf()).await,
        };
        Ok(parsers::op_state::op_state_from_probe(probe))
    }

    async fn conflict_entries(&self) -> Result<Vec<ConflictEntry>, GitError> {
        let (code, stdout, stderr) = self
            .run_classified(&parsers::conflicts::LS_FILES_UNMERGED_ARGS)
            .await?;
        if code != 0 {
            return Err(GitError::CommandFailed {
                exit_code: code,
                stderr: stderr.trim().to_string(),
            });
        }
        parsers::conflicts::parse_unmerged(&stdout)
    }

    async fn resolve_take_side(&self, path: &Path, side: ConflictSide) -> Result<(), GitError> {
        let flag = match side {
            ConflictSide::Ours => "--ours",
            ConflictSide::Theirs => "--theirs",
        };
        let p = path.to_string_lossy().into_owned();
        let (code, _stdout, stderr) = self.run_classified(&["checkout", flag, "--", &p]).await?;
        if code != 0 {
            if take_side_means_delete(&stderr) {
                // The chosen side deleted the file: taking it = delete + stage
                // (git rm stages the removal itself).
                return self.run_simple(&["rm", "-f", "--", &p]).await;
            }
            return Err(GitError::CommandFailed {
                exit_code: code,
                stderr: stderr.trim().to_string(),
            });
        }
        // Stage the taken side to mark the path resolved.
        self.run_pathspec(&["add", "--"], &[path.to_path_buf()]).await
    }

    async fn resolve_undo_paths(&self) -> Result<Vec<String>, GitError> {
        let (code, stdout, stderr) = self
            .run_classified(&parsers::resolve::LS_FILES_RESOLVE_UNDO_ARGS)
            .await?;
        if code != 0 {
            return Err(GitError::CommandFailed {
                exit_code: code,
                stderr: stderr.trim().to_string(),
            });
        }
        parsers::resolve::parse_resolve_undo(&stdout)
    }

    async fn staged_marker_paths(&self) -> Result<Vec<String>, GitError> {
        self.run_marker_check(&parsers::resolve::DIFF_CACHED_CHECK_ARGS)
            .await
    }

    async fn unstaged_marker_paths(&self) -> Result<Vec<String>, GitError> {
        self.run_marker_check(&parsers::resolve::DIFF_CHECK_ARGS).await
    }

    async fn conflict_reopen(&self, path: &Path) -> Result<(), GitError> {
        let p = path.to_string_lossy().into_owned();
        self.run_simple(&["update-index", "--unresolve", "--", &p])
            .await?;
        // Regenerate the conflict markers in the worktree. If this fails the
        // reopen half-happened (stages restored, worktree still holds the old
        // resolution) - the user must learn both facts.
        self.run_simple(&["checkout", "-m", "--", &p])
            .await
            .map_err(|e| {
                append_error_note(
                    e,
                    &format!(
                        "Note: the conflict stages for '{p}' were restored (the file shows as \
                         conflicted again), but regenerating the conflict markers in the file \
                         failed - its content is still the previous resolution."
                    ),
                )
            })
    }
}

/// Build a synthetic graph node for a stash entry. The real stash object is a
/// 2–3-parent merge (base, index, optional untracked); we keep ONLY the base as
/// the parent so the lane graph hangs it cleanly off its base instead of drawing
/// edges into git-internal index/untracked blobs.
fn stash_commit(entry: &StashEntry) -> Commit {
    Commit {
        id: entry.stash_sha.clone(),
        parents: vec![entry.base_sha.clone()],
        author: entry.author.clone(),
        committer: entry.author.clone(),
        message: entry.message.clone(),
        timestamp: entry.timestamp,
        signature: None,
        decorations: vec![RefDecoration::Stash(entry.selector.clone())],
    }
}

/// Insert synthetic stash nodes into a log result so they render in the graph.
///
/// Every stash is positioned purely by time in the newest-first list — stashes
/// interleave with commits, regardless of where their base sits. Real commits
/// are never reordered; we only splice stash nodes in. The comparison uses
/// *committer* timestamps because that is what `git log`'s default ordering
/// sorts by: rebased/cherry-picked commits keep their old author dates but sort
/// by their new commit dates, so comparing author dates would splice a stash
/// far from where the surrounding list actually places its neighbours. A
/// stash's base always has an older commit date than the stash, so the base
/// still appears later in the list and the stash's first-parent edge draws
/// downward into it (just not necessarily adjacent). `git stash list` is
/// most-recent first, so inserting in that order keeps `stash@{0}` highest when
/// several stashes share a timestamp.
fn inject_stashes(commits: &mut Vec<Commit>, stashes: Vec<StashEntry>) {
    for entry in &stashes {
        let node = stash_commit(entry);
        let pos = commits
            .iter()
            .position(|c| c.committer.timestamp < node.timestamp)
            .unwrap_or(commits.len());
        commits.insert(pos, node);
    }
}

/// Build the argument vector for `git commit`. `SignMode::None` passes
/// `--no-gpg-sign` explicitly so a repo-level `commit.gpgsign=true` cannot
/// re-enable signing; `Default` passes nothing and inherits config.
fn build_commit_args(opts: &CommitOptions) -> Vec<String> {
    let mut args: Vec<String> = vec!["commit".into(), "-m".into(), opts.message.clone()];
    if opts.amend {
        args.push("--amend".into());
    }
    if opts.allow_empty {
        args.push("--allow-empty".into());
    }
    match &opts.sign {
        SignMode::None => args.push("--no-gpg-sign".into()),
        SignMode::WithKey(key) => args.push(format!("-S{}", key.0)),
        SignMode::Default => {}
    }
    args
}

/// Build the argument vector for `git tag`. A non-blank message makes the tag
/// annotated (`-a -m`); a blank/whitespace-only message is treated as absent
/// so the UI's empty input never creates an annotated tag with an empty
/// annotation. The target (when given) is always the trailing argument.
fn build_tag_args<'a>(
    name: &'a str,
    target: Option<&'a str>,
    message: Option<&'a str>,
) -> Vec<&'a str> {
    let mut args = vec!["tag"];
    if let Some(msg) = message.filter(|m| !m.trim().is_empty()) {
        args.push("-a");
        args.push(name);
        args.push("-m");
        args.push(msg);
    } else {
        args.push(name);
    }
    if let Some(t) = target {
        args.push(t);
    }
    args
}

/// Config overrides prepended to fetch/pull: suppress git's post-transfer
/// auto-maintenance (`gc --auto`). On a large repo that gc keeps repacking
/// refs in the background for seconds after the command returns; every write
/// batch trips the filesystem watcher and re-invalidates the log, so the
/// Commits panel kept refetching long after a fetch. LeGit never needs the
/// side effect — the user's own git usage still runs maintenance normally.
const NO_AUTO_MAINTENANCE: [&str; 4] = ["-c", "gc.auto=0", "-c", "maintenance.auto=false"];

/// Build the argument vector for `git fetch`. `--all` wins over a named
/// remote; an empty remote name means "default remote" (no positional arg).
/// `--progress` forces the transfer meter onto our (non-TTY) pipe;
/// `run_with_op_progress` parses and strips it.
fn build_fetch_args(opts: &FetchOptions) -> Vec<String> {
    let mut args: Vec<String> = NO_AUTO_MAINTENANCE.iter().map(|s| s.to_string()).collect();
    args.push("fetch".into());
    args.push("--progress".into());
    if opts.prune {
        args.push("--prune".into());
    }
    if opts.all {
        args.push("--all".into());
    } else if let Some(remote) = opts.remote.as_deref().filter(|r| !r.is_empty()) {
        args.push(remote.to_string());
    }
    args
}

/// Build the argument vector for `git pull`. `Default` passes no integration
/// flag so the repo's `pull.rebase` config decides.
fn build_pull_args(opts: &PullOptions) -> Vec<String> {
    let mut args: Vec<String> = NO_AUTO_MAINTENANCE.iter().map(|s| s.to_string()).collect();
    args.push("pull".into());
    args.push("--progress".into());
    match opts.strategy {
        PullStrategy::Default => {}
        PullStrategy::Rebase => args.push("--rebase".into()),
        PullStrategy::Merge => args.push("--no-rebase".into()),
        PullStrategy::FfOnly => args.push("--ff-only".into()),
    }
    args
}

/// Build the argument vector for `git push`. The remote and branch are always
/// passed explicitly so the push doesn't depend on `push.default`.
fn build_push_args(opts: &PushOptions) -> Vec<String> {
    let mut args: Vec<String> = vec!["push".into(), "--progress".into()];
    if let Some(mode) = opts.recurse_submodules {
        args.push(match mode {
            PushRecurseMode::Check => "--recurse-submodules=check".into(),
            PushRecurseMode::OnDemand => "--recurse-submodules=on-demand".into(),
        });
    }
    if opts.force_with_lease {
        args.push("--force-with-lease".into());
    }
    if opts.set_upstream {
        args.push("--set-upstream".into());
    }
    args.push(opts.remote.clone());
    args.push(opts.branch.clone());
    args
}

/// Build the argument vector for `git remote set-url`, adding `--push` to target
/// the push URL instead of the fetch URL.
fn build_set_url_args<'a>(name: &'a str, url: &'a str, push: bool) -> Vec<&'a str> {
    let mut args = vec!["remote", "set-url"];
    if push {
        args.push("--push");
    }
    args.push(name);
    args.push(url);
    args
}

/// Classify the repo's files into the Files tree from three `-z` (NUL-separated)
/// `git ls-files` outputs: `cached` (tracked), `others` (untracked, not
/// ignored), and `ignored` (empty when the caller didn't request ignored
/// files). The three sets are disjoint by git's definition, so no overlap
/// resolution is needed. Result is de-duplicated and sorted by path so the
/// tree order is stable regardless of git's listing order. Pure so the
/// classification rule is unit-tested.
fn classify_repo_files(cached: &str, others: &str, ignored: &str) -> Vec<RepoFileEntry> {
    let mut entries: Vec<RepoFileEntry> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    // Order matters only for the disjoint-set guarantee: tracked wins if a path
    // somehow appears twice. The final sort makes the visible order stable.
    for (stdout, kind) in [
        (cached, RepoFileKind::Tracked),
        (others, RepoFileKind::Untracked),
        (ignored, RepoFileKind::Ignored),
    ] {
        for path in stdout.split('\0').filter(|p| !p.is_empty()) {
            if seen.insert(path.to_string()) {
                entries.push(RepoFileEntry { path: PathBuf::from(path), kind });
            }
        }
    }
    entries.sort_by(|a, b| a.path.cmp(&b.path));
    entries
}

/// Whether a file's bytes hold MIXED (CRLF + bare-LF) line endings:
/// `Some(true)` mixed, `Some(false)` uniform (incl. no newlines at all),
/// `None` binary (NUL in the leading 512 bytes - git's heuristic). The LF of
/// a CRLF pair never counts as a bare LF, and old-Mac lone CRs count as
/// neither. Pure sibling of `classify_line_endings`; backs the
/// mixed-endings warning.
pub fn mixed_endings_in_bytes(bytes: &[u8]) -> Option<bool> {
    let probe = &bytes[..bytes.len().min(512)];
    if probe.contains(&0u8) {
        return None;
    }
    let mut has_crlf = false;
    let mut has_lf_only = false;
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] == b'\r' && i + 1 < bytes.len() && bytes[i + 1] == b'\n' {
            has_crlf = true;
            i += 2;
        } else if bytes[i] == b'\n' {
            has_lf_only = true;
            i += 1;
        } else {
            i += 1;
        }
        if has_crlf && has_lf_only {
            return Some(true);
        }
    }
    Some(false)
}

/// Classify the line-ending style of some text (the Diff/File View/Blame
/// indicator). Binary is detected by a NUL byte in the leading window (git's
/// heuristic). Pure so it's unit-tested. Backs `repo_line_ending_kind`.
pub fn classify_line_endings(text: &str) -> LineEndingKind {
    let bytes = text.as_bytes();
    if bytes.iter().take(BINARY_SNIFF_WINDOW).any(|&b| b == 0) {
        return LineEndingKind::Binary;
    }
    let (mut crlf, mut lf, mut cr) = (false, false, false);
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'\r' if i + 1 < bytes.len() && bytes[i + 1] == b'\n' => {
                crlf = true;
                i += 2;
            }
            b'\r' => {
                cr = true;
                i += 1;
            }
            b'\n' => {
                lf = true;
                i += 1;
            }
            _ => i += 1,
        }
    }
    match (crlf, lf, cr) {
        (false, false, false) => LineEndingKind::None,
        (true, false, false) => LineEndingKind::Crlf,
        (false, true, false) => LineEndingKind::Lf,
        (false, false, true) => LineEndingKind::Cr,
        _ => LineEndingKind::Mixed,
    }
}

/// Case-insensitive substring filter over `git ls-files -z` output, capped at
/// `max` entries. Pure so the matching rule is unit-tested.
fn filter_paths(ls_files_stdout: &str, query: &str, max: usize) -> Vec<PathBuf> {
    let needle = query.to_lowercase();
    ls_files_stdout
        .split('\0')
        .filter(|p| !p.is_empty() && p.to_lowercase().contains(&needle))
        .take(max)
        .map(PathBuf::from)
        .collect()
}

/// Decide whether a `git stash push` actually created an entry, given the
/// `refs/stash` tip before and after the push. `git stash push` exits **0**
/// with "No local changes to save" (on stdout) for a clean tree, so neither
/// the exit code nor stderr can tell — only a moved tip can. Returns the
/// created entry's SHA. In particular, an unchanged tip with a pre-existing
/// stash must return `None`, or a later restore would touch the user's own
/// stash.
/// The SHA of the entry OUR just-run `stash push -m <marker>` created, or
/// `None` when the tree was clean. Diffs the full stash list (`--format=%H %s`
/// stdout, newest first) instead of the tip, and requires the new entry's
/// subject to carry our marker message: an entry created concurrently by
/// another process must never be adopted as ours - the auto-stash flows POP
/// or DROP the detected entry, so adopting a foreign one moves someone
/// else's data. Tip-compare (`stash_created`) remains correct where only
/// "did anything get stashed" is needed and nothing is popped.
/// The list format `find_created_stash` consumes: one entry per line,
/// `<sha> <subject>`, newest first (kept next to its parser per convention).
const STASH_LIST_SUBJECT_ARGS: &[&str] = &["stash", "list", "--format=%H %s"];

fn find_created_stash(before_list: &str, after_list: &str, marker: &str) -> Option<String> {
    let before: std::collections::HashSet<&str> = before_list
        .lines()
        .filter_map(|l| l.trim().split(' ').next())
        .filter(|s| !s.is_empty())
        .collect();
    for line in after_list.lines() {
        let line = line.trim();
        let Some((sha, subject)) = line.split_once(' ') else {
            continue;
        };
        if !before.contains(sha) && subject.contains(marker) {
            return Some(sha.to_string());
        }
    }
    None
}

fn stash_created(tip_before: Option<&str>, tip_after: Option<&str>) -> Option<String> {
    match tip_after {
        Some(after) if tip_before != Some(after) => Some(after.to_string()),
        _ => None,
    }
}

/// Find a stash entry's current reflog selector in the output of
/// `git stash list --format=%H %gd`, by the entry's commit SHA.
fn find_stash_selector(list_stdout: &str, stash_sha: &str) -> Option<String> {
    for line in list_stdout.lines() {
        if let Some((sha, selector)) = line.trim().split_once(' ') {
            if sha == stash_sha {
                return Some(selector.trim().to_string());
            }
        }
    }
    None
}

/// Split a remote-tracking ref (either `origin/x` or the full
/// `refs/remotes/origin/x`) into the short form git commands take and the
/// derived local branch name (the ref minus the remote-name segment).
fn remote_ref_names(remote_ref: &str) -> (&str, &str) {
    let short = remote_ref
        .strip_prefix("refs/remotes/")
        .unwrap_or(remote_ref);
    let local = short.split_once('/').map(|(_, b)| b).unwrap_or(short);
    (short, local)
}

/// Map a failed `git switch`/`checkout` to a specific `GitError`: the
/// dirty-tree refusal ("your local changes … would be overwritten") →
/// `WouldOverwriteLocalChanges`, an unknown ref → `RefNotFound`, everything
/// else → `CommandFailed`.
fn classify_switch_error(exit_code: i32, stderr: &str) -> GitError {
    let lc = stderr.to_lowercase();
    if lc.contains("would be overwritten by")
        || lc.contains("commit your changes or stash them")
    {
        return GitError::WouldOverwriteLocalChanges(stderr.trim().to_string());
    }
    if lc.contains("invalid reference") {
        return GitError::RefNotFound(stderr.trim().to_string());
    }
    GitError::CommandFailed {
        exit_code,
        stderr: stderr.trim().to_string(),
    }
}

/// `git merge` argument list. Non-squash merges pass `--no-edit` explicitly:
/// the runner hardens with `GIT_EDITOR=false`, and without `--no-edit` a
/// merge-commit path that decides to open an editor would fail outright.
fn merge_args(target: &str, opts: MergeOptions) -> Vec<String> {
    let mut args: Vec<String> = vec!["merge".into()];
    if opts.squash {
        args.push("--squash".into());
    } else {
        match opts.ff {
            FfMode::Auto => {}
            FfMode::NoFf => args.push("--no-ff".into()),
            FfMode::FfOnly => args.push("--ff-only".into()),
        }
        args.push("--no-edit".into());
    }
    args.push(target.into());
    args
}

/// Env override for `merge/rebase --continue` (and `rebase --skip`): their
/// commit step consults the editor, and the runner's hardened base env sets
/// `GIT_EDITOR=false`, which fails it ("There was a problem with the editor
/// 'false'"). A `-c core.editor=…` cannot fix this - the `GIT_EDITOR` env var
/// outranks all config - so the env itself is overridden per invocation.
/// `true` exits 0 without touching the file: the prepared message is accepted
/// unchanged. Verified against real git in `tests/git_flows.rs`.
const EDITOR_ACCEPT_ENV: &[(&str, &str)] = &[("GIT_EDITOR", "true")];

/// Continue/abort argument lists (run with `EDITOR_ACCEPT_ENV`).
const MERGE_CONTINUE_ARGS: [&str; 2] = ["merge", "--continue"];
const MERGE_ABORT_ARGS: [&str; 2] = ["merge", "--abort"];

/// `git rebase` always runs with `--autostash` so a dirty tree does not block
/// it; a conflicted stash reapply after completion is its own outcome.
fn rebase_args(onto: &str) -> Vec<String> {
    vec!["rebase".into(), "--autostash".into(), onto.into()]
}

const REBASE_CONTINUE_ARGS: [&str; 2] = ["rebase", "--continue"];
const REBASE_SKIP_ARGS: [&str; 2] = ["rebase", "--skip"];
const REBASE_ABORT_ARGS: [&str; 2] = ["rebase", "--abort"];

/// Sequencer (cherry-pick/revert) continue/skip/abort argument lists.
/// Continue and skip run with `EDITOR_ACCEPT_ENV` — concluding creates a
/// commit whose message git opens an editor for.
const CHERRY_PICK_CONTINUE_ARGS: [&str; 2] = ["cherry-pick", "--continue"];
const CHERRY_PICK_SKIP_ARGS: [&str; 2] = ["cherry-pick", "--skip"];
const CHERRY_PICK_ABORT_ARGS: [&str; 2] = ["cherry-pick", "--abort"];
const REVERT_CONTINUE_ARGS: [&str; 2] = ["revert", "--continue"];
const REVERT_SKIP_ARGS: [&str; 2] = ["revert", "--skip"];
const REVERT_ABORT_ARGS: [&str; 2] = ["revert", "--abort"];

/// Compose a user-facing message from a command's streams (stdout carries
/// git's conflict summary, stderr the hints).
fn compose_output(stdout: &str, stderr: &str) -> String {
    let mut msg = stdout.trim().to_string();
    let err = stderr.trim();
    if !err.is_empty() {
        if !msg.is_empty() {
            msg.push('\n');
        }
        msg.push_str(err);
    }
    msg
}

/// True when a failed `stash apply`/`pop` indicates the stash WAS applied but
/// left conflicts (git keeps the entry; guidance is "resolve, then drop"), as
/// opposed to a failure where nothing was applied at all. Keyed to git's
/// actual phrases - the merge machinery's `CONFLICT (...)` lines, the index
/// `needs merge` state, and the untracked-collision message. A bare token
/// match ("conflict") would misfire on pathnames and on would-be-overwritten
/// failures. Encoded in tests, validated against the real binary in
/// `git_flows.rs`.
fn stash_apply_left_conflicts(stdout: &str, stderr: &str) -> bool {
    let combined = format!("{stdout}\n{stderr}");
    combined.contains("CONFLICT (")
        || combined.contains("needs merge")
        || combined.contains("could not restore untracked files from stash")
}

/// Split `git merge`'s exit-1 ambiguity: conflicts are an OUTCOME (merge in
/// progress), everything else an error. Encoded in tests, not comments.
fn classify_merge_output(
    exit_code: i32,
    stdout: &str,
    stderr: &str,
    squash: bool,
) -> Result<MergeOutcome, GitError> {
    let out_lc = stdout.to_lowercase();
    let err_lc = stderr.to_lowercase();
    if exit_code == 0 {
        if out_lc.contains("already up to date") {
            return Ok(MergeOutcome::AlreadyUpToDate);
        }
        if squash {
            return Ok(MergeOutcome::Squashed);
        }
        // "Fast-forward" appears on its own line under "Updating a..b".
        if out_lc.lines().any(|l| l.trim() == "fast-forward") {
            return Ok(MergeOutcome::FastForwarded);
        }
        return Ok(MergeOutcome::Merged);
    }
    if out_lc.contains("automatic merge failed")
        || out_lc.contains("conflict")
        || err_lc.contains("you have unmerged files")
        || err_lc.contains("not possible because you have unmerged files")
    {
        return Ok(MergeOutcome::Conflicts {
            message: compose_output(stdout, stderr),
        });
    }
    if err_lc.contains("would be overwritten by") {
        return Err(GitError::WouldOverwriteLocalChanges(stderr.trim().to_string()));
    }
    if err_lc.contains("not something we can merge") || err_lc.contains("unknown revision") {
        return Err(GitError::RefNotFound(stderr.trim().to_string()));
    }
    Err(GitError::CommandFailed {
        exit_code,
        stderr: compose_output(stdout, stderr),
    })
}

/// Split `git rebase`'s exit codes the same way. On exit 0 the autostash may
/// still have conflicted ("Applying autostash resulted in conflicts"); the
/// rebase itself succeeded, so that is a distinct success-flavored outcome.
fn classify_rebase_output(
    exit_code: i32,
    stdout: &str,
    stderr: &str,
) -> Result<RebaseOutcome, GitError> {
    let out_lc = stdout.to_lowercase();
    let err_lc = stderr.to_lowercase();
    let stash_conflict = out_lc.contains("applying autostash resulted in conflicts")
        || err_lc.contains("applying autostash resulted in conflicts");
    if exit_code == 0 {
        if stash_conflict {
            return Ok(RebaseOutcome::CompletedWithStashConflicts {
                message: compose_output(stdout, stderr),
            });
        }
        if out_lc.contains("is up to date") || err_lc.contains("is up to date") {
            return Ok(RebaseOutcome::AlreadyUpToDate);
        }
        return Ok(RebaseOutcome::Completed);
    }
    if err_lc.contains("could not apply")
        || out_lc.contains("conflict")
        || err_lc.contains("conflict")
        || err_lc.contains("you have unmerged files")
    {
        return Ok(RebaseOutcome::Conflicts {
            message: compose_output(stdout, stderr),
        });
    }
    if err_lc.contains("would be overwritten by") {
        return Err(GitError::WouldOverwriteLocalChanges(stderr.trim().to_string()));
    }
    if err_lc.contains("invalid upstream") || err_lc.contains("unknown revision") {
        return Err(GitError::RefNotFound(stderr.trim().to_string()));
    }
    Err(GitError::CommandFailed {
        exit_code,
        stderr: compose_output(stdout, stderr),
    })
}

/// Build the printf format string for an interactive-rebase todo (lines
/// `pick <sha>` / `squash <sha>` / `fixup <sha>` / `drop <sha>`, `\n`
/// separated as printf escapes). Validates the plan up front:
/// - non-empty, with at least one kept (non-drop) step;
/// - the first kept step must be a `pick` (squash/fixup meld into a
///   predecessor that wouldn't exist);
/// - every sha must be plain hex — the todo is interpolated into a
///   single-quoted, shell-interpreted editor string, so anything else is
///   rejected outright rather than escaped.
fn build_rebase_todo(plan: &[RebaseStep]) -> Result<String, GitError> {
    if plan.is_empty() {
        return Err(GitError::Internal("interactive rebase plan is empty".into()));
    }
    let mut first_kept = true;
    let mut todo = String::new();
    for step in plan {
        let sha = step.sha().as_str();
        if sha.is_empty() || !sha.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(GitError::Internal(format!(
                "interactive rebase plan contains a non-hex sha: {sha:?}"
            )));
        }
        let keyword = match step {
            RebaseStep::Pick { .. } => "pick",
            RebaseStep::Squash { .. } => "squash",
            RebaseStep::Fixup { .. } => "fixup",
            RebaseStep::Drop { .. } => "drop",
        };
        if matches!(step, RebaseStep::Squash { .. } | RebaseStep::Fixup { .. }) && first_kept {
            return Err(GitError::Internal(
                "interactive rebase plan starts with squash/fixup (nothing to meld into)".into(),
            ));
        }
        if !matches!(step, RebaseStep::Drop { .. }) {
            first_kept = false;
        }
        todo.push_str(keyword);
        todo.push(' ');
        todo.push_str(sha);
        todo.push_str("\\n");
    }
    if first_kept {
        return Err(GitError::Internal(
            "interactive rebase plan drops every commit".into(),
        ));
    }
    Ok(todo)
}

/// Split the sequencer's (revert/cherry-pick) exit-1 ambiguity the same way
/// as merge/rebase: a paused sequencer — conflicts, or a pick whose
/// resolution turned out empty ("is now empty" / "nothing to commit") — is
/// an OUTCOME the user concludes via continue/skip/abort; real failures stay
/// errors. Encoded in tests, not comments.
fn classify_sequence_output(
    exit_code: i32,
    stdout: &str,
    stderr: &str,
) -> Result<SequenceOutcome, GitError> {
    let out_lc = stdout.to_lowercase();
    let err_lc = stderr.to_lowercase();
    if exit_code == 0 {
        return Ok(SequenceOutcome::Completed);
    }
    if err_lc.contains("could not apply")
        || err_lc.contains("could not revert")
        || out_lc.contains("conflict")
        || err_lc.contains("conflict")
        || err_lc.contains("you have unmerged files")
        || err_lc.contains("is now empty")
        || err_lc.contains("nothing to commit")
    {
        return Ok(SequenceOutcome::Conflicts {
            message: compose_output(stdout, stderr),
        });
    }
    if err_lc.contains("would be overwritten by") {
        return Err(GitError::WouldOverwriteLocalChanges(stderr.trim().to_string()));
    }
    if err_lc.contains("bad revision") || err_lc.contains("unknown revision") {
        return Err(GitError::RefNotFound(stderr.trim().to_string()));
    }
    Err(GitError::CommandFailed {
        exit_code,
        stderr: compose_output(stdout, stderr),
    })
}

/// `git checkout --ours/--theirs` fails when the chosen side has no stage
/// entry (a delete-conflict where that side deleted the file); taking that
/// side then means deleting the path (`git rm -f`).
fn take_side_means_delete(stderr: &str) -> bool {
    let lc = stderr.to_lowercase();
    lc.contains("does not have our version") || lc.contains("does not have their version")
}

/// Append a follow-up note to an error without losing its kind (used when a
/// best-effort recovery step after the primary failure also failed and the
/// user must be told both facts).
fn append_error_note(e: GitError, note: &str) -> GitError {
    match e {
        GitError::CommandFailed { exit_code, stderr } => GitError::CommandFailed {
            exit_code,
            stderr: format!("{stderr}\n\n{note}"),
        },
        GitError::WouldOverwriteLocalChanges(msg) => {
            GitError::WouldOverwriteLocalChanges(format!("{msg}\n\n{note}"))
        }
        GitError::RefNotFound(msg) => GitError::RefNotFound(format!("{msg}\n\n{note}")),
        other => GitError::Internal(format!("{other}\n\n{note}")),
    }
}

/// Map a failed remote op's stderr to a specific `GitError`: authentication
/// problems → `AuthFailed`, non-fast-forward/rejected pushes → `PushRejected`,
/// everything else → `CommandFailed`. Public so session-less callers (e.g. the
/// `git clone` command) can classify failures the same way.
pub fn classify_remote_error(exit_code: i32, stderr: &str) -> GitError {
    let lc = stderr.to_lowercase();
    const AUTH: [&str; 6] = [
        "authentication failed",
        "permission denied (publickey)",
        "could not read username",
        "could not read password",
        "terminal prompts disabled",
        "access denied",
    ];
    if AUTH.iter().any(|p| lc.contains(p)) {
        return GitError::AuthFailed(stderr.trim().to_string());
    }
    // A checkout/merge inside the operation refusing to overwrite local
    // changes (e.g. `submodule update --remote` on a dirty submodule, or a
    // pull into a dirty tree). Classified so the UI can say "commit, stash,
    // or discard first" instead of dumping raw stderr.
    if lc.contains("would be overwritten by") {
        return GitError::WouldOverwriteLocalChanges(stderr.trim().to_string());
    }
    // `push --recurse-submodules=check|on-demand` refusing to publish a
    // superproject whose gitlinks reference commits on no submodule remote.
    // MUST precede the generic rejection check: the same stderr can also
    // contain "failed to push some refs".
    if lc.contains("submodule paths contain changes") || lc.contains("process for submodule") {
        return GitError::UnpushedSubmodules {
            stderr: stderr.trim().to_string(),
        };
    }
    const REJECTED: [&str; 5] = [
        "[rejected]",
        "non-fast-forward",
        "fetch first",
        "stale info",
        "failed to push some refs",
    ];
    if REJECTED.iter().any(|p| lc.contains(p)) {
        return GitError::PushRejected {
            stderr: stderr.trim().to_string(),
        };
    }
    GitError::CommandFailed {
        exit_code,
        stderr: stderr.trim().to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- auto-stash: did the push create an entry? -------------------------
    // Regression tests for the clean-tree bug: `git stash push` exits 0 with
    // "No local changes to save", so detection must come from the stash tip.

    #[test]
    fn stash_created_clean_tree_no_prior_stash() {
        assert_eq!(stash_created(None, None), None);
    }

    #[test]
    fn stash_created_clean_tree_with_prior_stash_is_none() {
        // THE data-loss case: unchanged tip + pre-existing stash must be None,
        // or the restore step would pop the user's own stash.
        assert_eq!(stash_created(Some("abc"), Some("abc")), None);
    }

    #[test]
    fn stash_created_dirty_tree_no_prior_stash() {
        assert_eq!(stash_created(None, Some("new")), Some("new".into()));
    }

    #[test]
    fn stash_created_dirty_tree_with_prior_stash() {
        assert_eq!(stash_created(Some("old"), Some("new")), Some("new".into()));
    }

    // --- auto-stash: which entry did OUR push create? ------------------------
    // Set-diff over the full stash list plus a marker-message match, so an
    // entry created concurrently by another process is never adopted (and
    // later popped/dropped) as ours - the tip alone cannot tell them apart.

    const MARKER: &str = "legit: auto-stash before switching to feature";

    #[test]
    fn find_created_stash_clean_tree_is_none() {
        let list = "aaa On main: WIP\n";
        assert_eq!(find_created_stash(list, list, MARKER), None);
    }

    #[test]
    fn find_created_stash_picks_the_new_marker_entry() {
        let before = "aaa On main: WIP\n";
        let after = format!("bbb On main: {MARKER}\naaa On main: WIP\n");
        assert_eq!(find_created_stash(before, &after, MARKER), Some("bbb".into()));
    }

    #[test]
    fn find_created_stash_ignores_a_concurrent_foreign_entry() {
        // Another process stashed between our push and the list read: its
        // entry is the tip, ours sits below. Tip-compare would adopt "ccc"
        // and pop someone else's stash; the marker match must pick "bbb".
        let before = "aaa On main: WIP\n";
        let after = format!("ccc On main: WIP other\nbbb On main: {MARKER}\naaa On main: WIP\n");
        assert_eq!(find_created_stash(before, &after, MARKER), Some("bbb".into()));
    }

    #[test]
    fn find_created_stash_foreign_entry_only_is_none() {
        // Clean tree for US (push saved nothing), but a foreign stash
        // appeared concurrently: nothing of ours to pop.
        let before = "aaa On main: WIP\n";
        let after = "ccc On main: WIP other\naaa On main: WIP\n";
        assert_eq!(find_created_stash(before, after, MARKER), None);
    }

    #[test]
    fn find_created_stash_pre_existing_marker_entry_is_not_adopted() {
        // A leftover auto-stash from an earlier crash carries the marker but
        // predates our push: it is in `before`, so it must not be adopted.
        let list = format!("bbb On main: {MARKER}\naaa On main: WIP\n");
        assert_eq!(find_created_stash(&list, &list, MARKER), None);
    }

    #[test]
    fn find_created_stash_empty_before_list() {
        let after = format!("bbb On main: {MARKER}\n");
        assert_eq!(find_created_stash("", &after, MARKER), Some("bbb".into()));
    }

    // --- sequencer (cherry-pick / revert) output classification --------------
    // The exit-1 ambiguity: a paused sequencer (conflicts) is an OUTCOME, a
    // bad revision or dirty tree is an error. Same treatment as the tested
    // merge/rebase siblings.

    #[test]
    fn sequence_exit_zero_is_completed() {
        let r = classify_sequence_output(0, "[main abc] applied\n", "");
        assert_eq!(r.unwrap(), SequenceOutcome::Completed);
    }

    #[test]
    fn sequence_conflict_phrases_are_the_conflicts_outcome() {
        for stderr in [
            "error: could not apply abc123... subject",
            "error: could not revert abc123... subject",
            "CONFLICT (content): Merge conflict in a.txt",
            "error: you have unmerged files",
            "The previous cherry-pick is now empty, possibly due to conflict resolution.",
        ] {
            let r = classify_sequence_output(1, "", stderr);
            assert!(
                matches!(r, Ok(SequenceOutcome::Conflicts { .. })),
                "{stderr:?} -> {r:?}"
            );
        }
    }

    #[test]
    fn sequence_overwrite_and_bad_rev_classify_as_errors() {
        let r = classify_sequence_output(
            1,
            "",
            "error: Your local changes to the following files would be overwritten by merge:",
        );
        assert!(matches!(r, Err(GitError::WouldOverwriteLocalChanges(_))), "{r:?}");
        let r = classify_sequence_output(128, "", "fatal: bad revision 'nope'");
        assert!(matches!(r, Err(GitError::RefNotFound(_))), "{r:?}");
        let r = classify_sequence_output(128, "", "fatal: something else entirely");
        assert!(matches!(r, Err(GitError::CommandFailed { exit_code: 128, .. })), "{r:?}");
    }

    // --- interactive rebase todo validation ----------------------------------

    #[test]
    fn rebase_todo_renders_keywords_in_order() {
        let plan = vec![
            RebaseStep::Pick { sha: CommitId::new("aaa111") },
            RebaseStep::Squash { sha: CommitId::new("bbb222") },
            RebaseStep::Fixup { sha: CommitId::new("ccc333") },
            RebaseStep::Drop { sha: CommitId::new("ddd444") },
        ];
        let todo = build_rebase_todo(&plan).unwrap();
        // LITERAL backslash-n separators, not newlines: the todo is injected
        // through `GIT_SEQUENCE_EDITOR="printf '%s' ... >"`-style shell
        // expansion, where printf expands the \n escapes into real newlines.
        assert_eq!(todo, r"pick aaa111\nsquash bbb222\nfixup ccc333\ndrop ddd444\n");
    }

    #[test]
    fn rebase_todo_rejects_bad_plans() {
        assert!(build_rebase_todo(&[]).is_err(), "empty plan");
        assert!(
            build_rebase_todo(&[RebaseStep::Squash { sha: CommitId::new("aaa111") }]).is_err(),
            "leading squash has nothing to meld into"
        );
        // A leading DROP does not count as the first kept step.
        assert!(
            build_rebase_todo(&[
                RebaseStep::Drop { sha: CommitId::new("aaa111") },
                RebaseStep::Fixup { sha: CommitId::new("bbb222") },
            ])
            .is_err(),
            "fixup after only drops still has nothing to meld into"
        );
        assert!(
            build_rebase_todo(&[RebaseStep::Pick { sha: CommitId::new("not-hex!") }]).is_err(),
            "non-hex sha must be rejected (it would be injected into the todo file)"
        );
    }

    // --- stash apply/pop: conflict vs plain failure --------------------------

    #[test]
    fn stash_apply_conflict_marker_lines_classify_as_conflicts() {
        assert!(stash_apply_left_conflicts(
            "Auto-merging a.txt\nCONFLICT (content): Merge conflict in a.txt\n",
            ""
        ));
        assert!(stash_apply_left_conflicts("", "a.txt: needs merge\n"));
        assert!(stash_apply_left_conflicts(
            "",
            "error: could not restore untracked files from stash\n"
        ));
    }

    #[test]
    fn stash_apply_conflicty_pathname_is_not_a_conflict() {
        // "conflict" appearing only inside a pathname (or the would-be-
        // overwritten failure, where NOTHING was applied) must stay an error:
        // the guidance for real conflicts is "resolve, then drop", which
        // would be wrong here.
        assert!(!stash_apply_left_conflicts(
            "",
            "error: Your local changes to the following files would be overwritten by merge:\n\tconflicts.md\nPlease commit your changes or stash them before you merge.\n"
        ));
        assert!(!stash_apply_left_conflicts("", "fatal: ambiguous argument 'stash@{9}'\n"));
    }

    // --- mixed line-ending detection ------------------------------------------

    #[test]
    fn mixed_endings_pure_and_mixed() {
        assert_eq!(mixed_endings_in_bytes(b"a\r\nb\r\n"), Some(false));
        assert_eq!(mixed_endings_in_bytes(b"a\nb\n"), Some(false));
        assert_eq!(mixed_endings_in_bytes(b"a\r\nb\n"), Some(true));
        assert_eq!(mixed_endings_in_bytes(b""), Some(false));
        assert_eq!(mixed_endings_in_bytes(b"no newline at all"), Some(false));
    }

    #[test]
    fn mixed_endings_lone_cr_is_not_lf() {
        // Old-Mac CR endings are neither CRLF nor LF: a CR+LF file mix still
        // reports mixed, but CR alone does not create a false LF sighting.
        assert_eq!(mixed_endings_in_bytes(b"a\rb\r"), Some(false));
        assert_eq!(mixed_endings_in_bytes(b"a\r\nb\rc\r\n"), Some(false));
    }

    #[test]
    fn mixed_endings_binary_is_none() {
        assert_eq!(mixed_endings_in_bytes(b"ab\0cd\r\nx\n"), None);
    }

    #[test]
    fn mixed_endings_crlf_never_counts_as_lf() {
        // The LF in a CRLF pair must not read as a bare LF.
        assert_eq!(mixed_endings_in_bytes(b"\r\n\r\n\r\n"), Some(false));
    }

    // --- line-ending classification -----------------------------------------

    #[test]
    fn classify_line_endings_pure_kinds() {
        assert_eq!(classify_line_endings("a\nb\nc\n"), LineEndingKind::Lf);
        assert_eq!(classify_line_endings("a\r\nb\r\n"), LineEndingKind::Crlf);
        assert_eq!(classify_line_endings("a\rb\r"), LineEndingKind::Cr);
    }

    #[test]
    fn classify_line_endings_mixed_and_edge_cases() {
        assert_eq!(classify_line_endings("a\r\nb\nc\n"), LineEndingKind::Mixed);
        assert_eq!(classify_line_endings("lone line, no break"), LineEndingKind::None);
        assert_eq!(classify_line_endings(""), LineEndingKind::None);
        // A lone CR mixed with CRLF is still mixed.
        assert_eq!(classify_line_endings("a\r\nb\rc"), LineEndingKind::Mixed);
    }

    #[test]
    fn classify_line_endings_binary_wins() {
        assert_eq!(classify_line_endings("a\0b\r\n"), LineEndingKind::Binary);
    }

    // --- repo-wide file classification (Files tree) -------------------------

    fn entry(path: &str, kind: RepoFileKind) -> RepoFileEntry {
        RepoFileEntry { path: PathBuf::from(path), kind }
    }

    #[test]
    fn classify_repo_files_tags_each_class() {
        let cached = "src/main.rs\0README.md\0";
        let others = "notes.txt\0";
        let ignored = "target/debug\0";
        assert_eq!(
            classify_repo_files(cached, others, ignored),
            vec![
                entry("README.md", RepoFileKind::Tracked),
                entry("notes.txt", RepoFileKind::Untracked),
                entry("src/main.rs", RepoFileKind::Tracked),
                entry("target/debug", RepoFileKind::Ignored),
            ]
        );
    }

    #[test]
    fn classify_repo_files_empty_ignored_when_not_requested() {
        let cached = "a.txt\0";
        let others = "b.txt\0";
        assert_eq!(
            classify_repo_files(cached, others, ""),
            vec![
                entry("a.txt", RepoFileKind::Tracked),
                entry("b.txt", RepoFileKind::Untracked),
            ]
        );
    }

    #[test]
    fn classify_repo_files_ignores_blank_segments_and_dedups() {
        // Trailing NUL yields a final empty segment; a path must never appear
        // twice even if git somehow lists it in two streams.
        let cached = "dup.txt\0\0";
        let others = "dup.txt\0";
        assert_eq!(
            classify_repo_files(cached, others, ""),
            vec![entry("dup.txt", RepoFileKind::Tracked)]
        );
    }

    // --- stash SHA → selector resolution ------------------------------------

    #[test]
    fn stash_selector_found_by_sha() {
        let out = "aaa111 stash@{0}\nbbb222 stash@{1}\nccc333 stash@{2}\n";
        assert_eq!(find_stash_selector(out, "bbb222"), Some("stash@{1}".into()));
    }

    #[test]
    fn stash_selector_missing_sha_is_none() {
        let out = "aaa111 stash@{0}\n";
        assert_eq!(find_stash_selector(out, "zzz999"), None);
        assert_eq!(find_stash_selector("", "zzz999"), None);
    }

    // --- remote ref normalization -------------------------------------------

    #[test]
    fn remote_ref_short_form() {
        assert_eq!(remote_ref_names("origin/feature-x"), ("origin/feature-x", "feature-x"));
    }

    #[test]
    fn remote_ref_full_form() {
        assert_eq!(
            remote_ref_names("refs/remotes/origin/feature-x"),
            ("origin/feature-x", "feature-x")
        );
    }

    #[test]
    fn remote_ref_branch_name_with_slashes() {
        assert_eq!(
            remote_ref_names("refs/remotes/origin/feat/nested"),
            ("origin/feat/nested", "feat/nested")
        );
    }

    // --- stash injection into the log ---------------------------------------

    use crate::Signature;

    fn sig(ts: i64) -> Signature {
        Signature {
            name: "t".into(),
            email: "t@t".into(),
            timestamp: ts,
            tz_offset_minutes: 0,
        }
    }

    /// A commit whose author and committer timestamps can differ (rebase /
    /// cherry-pick keep the author date but get a fresh commit date).
    fn commit(id: &str, author_ts: i64, committer_ts: i64) -> Commit {
        Commit {
            id: CommitId(id.into()),
            parents: vec![],
            author: sig(author_ts),
            committer: sig(committer_ts),
            message: id.into(),
            timestamp: author_ts,
            signature: None,
            decorations: vec![],
        }
    }

    fn stash_entry(sha: &str, ts: i64) -> StashEntry {
        StashEntry {
            index: 0,
            selector: "stash@{0}".into(),
            message: "wip".into(),
            stash_sha: CommitId(sha.into()),
            base_sha: CommitId("base".into()),
            author: sig(ts),
            timestamp: ts,
        }
    }

    fn ids(commits: &[Commit]) -> Vec<&str> {
        commits.iter().map(|c| c.id.0.as_str()).collect()
    }

    #[test]
    fn stash_interleaves_by_committer_date() {
        let mut commits = vec![commit("c3", 300, 300), commit("c2", 200, 200), commit("c1", 100, 100)];
        inject_stashes(&mut commits, vec![stash_entry("s", 250)]);
        assert_eq!(ids(&commits), vec!["c3", "s", "c2", "c1"]);
    }

    #[test]
    fn stash_placement_ignores_rebased_author_dates() {
        // Regression: the list is ordered by *commit* date; a rebased commit
        // keeps an old author date. Comparing author dates would misplace the
        // stash above/below rebased commits.
        // c2 was rebased: author ts 100 (old), committer ts 400 (new).
        let mut commits = vec![commit("c2", 100, 400), commit("c1", 150, 150)];
        // Stash from t=300: newer than c1, older than c2's *commit* date.
        inject_stashes(&mut commits, vec![stash_entry("s", 300)]);
        assert_eq!(ids(&commits), vec!["c2", "s", "c1"]);
    }

    #[test]
    fn stash_older_than_window_appends_at_end() {
        let mut commits = vec![commit("c2", 200, 200), commit("c1", 100, 100)];
        inject_stashes(&mut commits, vec![stash_entry("s", 50)]);
        assert_eq!(ids(&commits), vec!["c2", "c1", "s"]);
    }

    #[test]
    fn newer_stash_stays_above_older_on_equal_timestamps() {
        // `git stash list` is most-recent first; equal timestamps must keep
        // stash@{0} highest.
        let mut commits = vec![commit("c1", 100, 100)];
        inject_stashes(
            &mut commits,
            vec![stash_entry("s0", 200), stash_entry("s1", 200)],
        );
        assert_eq!(ids(&commits), vec!["s0", "s1", "c1"]);
    }

    #[test]
    fn switch_error_dirty_tree_is_classified() {
        let stderr = "error: Your local changes to the following files would be overwritten by checkout:\n\tsrc/main.rs\nPlease commit your changes or stash them before you switch branches.\nAborting";
        match classify_switch_error(1, stderr) {
            GitError::WouldOverwriteLocalChanges(msg) => {
                assert!(msg.contains("would be overwritten"));
            }
            other => panic!("expected WouldOverwriteLocalChanges, got {other:?}"),
        }
    }

    #[test]
    fn switch_error_unknown_ref_is_ref_not_found() {
        let stderr = "fatal: invalid reference: no-such-branch";
        assert!(matches!(
            classify_switch_error(128, stderr),
            GitError::RefNotFound(_)
        ));
    }

    #[test]
    fn switch_error_other_is_command_failed() {
        let stderr = "fatal: a branch named 'x' already exists";
        assert!(matches!(
            classify_switch_error(128, stderr),
            GitError::CommandFailed { exit_code: 128, .. }
        ));
    }

    #[test]
    fn append_note_preserves_kind_and_both_messages() {
        let e = GitError::CommandFailed {
            exit_code: 1,
            stderr: "switch failed".into(),
        };
        match append_error_note(e, "note about the stash") {
            GitError::CommandFailed { exit_code, stderr } => {
                assert_eq!(exit_code, 1);
                assert!(stderr.contains("switch failed"));
                assert!(stderr.contains("note about the stash"));
            }
            other => panic!("kind changed: {other:?}"),
        }
    }

    fn push_opts(set_upstream: bool, force_with_lease: bool) -> PushOptions {
        PushOptions {
            remote: "origin".into(),
            branch: "main".into(),
            set_upstream,
            force_with_lease,
            recurse_submodules: None,
        }
    }

    #[test]
    fn push_args_carry_recurse_submodules_mode() {
        let mut opts = push_opts(false, false);
        opts.recurse_submodules = Some(PushRecurseMode::Check);
        assert!(build_push_args(&opts).contains(&"--recurse-submodules=check".to_string()));
        opts.recurse_submodules = Some(PushRecurseMode::OnDemand);
        assert!(build_push_args(&opts).contains(&"--recurse-submodules=on-demand".to_string()));
        opts.recurse_submodules = None;
        assert!(!build_push_args(&opts)
            .iter()
            .any(|a| a.starts_with("--recurse-submodules")));
    }

    #[test]
    fn classify_detects_unpushed_submodules() {
        // git's advice text for --recurse-submodules=check (exit 128).
        let stderr = "The following submodule paths contain changes that can\nnot be found on any remote:\n  lib\n";
        assert!(matches!(
            classify_remote_error(128, stderr),
            GitError::UnpushedSubmodules { .. }
        ));
    }

    #[test]
    fn push_args_plain() {
        assert_eq!(
            build_push_args(&push_opts(false, false)),
            vec!["push", "--progress", "origin", "main"]
        );
    }

    #[test]
    fn push_args_set_upstream() {
        assert_eq!(
            build_push_args(&push_opts(true, false)),
            vec!["push", "--progress", "--set-upstream", "origin", "main"]
        );
    }

    #[test]
    fn push_args_force_with_lease_then_upstream() {
        assert_eq!(
            build_push_args(&push_opts(true, true)),
            vec!["push", "--progress", "--force-with-lease", "--set-upstream", "origin", "main"]
        );
    }

    #[test]
    fn classify_auth_failure() {
        let e = classify_remote_error(128, "fatal: Authentication failed for 'https://x/y'");
        assert!(matches!(e, GitError::AuthFailed(_)));
    }

    #[test]
    fn classify_publickey_denied() {
        let e = classify_remote_error(128, "git@github.com: Permission denied (publickey).");
        assert!(matches!(e, GitError::AuthFailed(_)));
    }

    #[test]
    fn classify_non_fast_forward() {
        let e = classify_remote_error(
            1,
            " ! [rejected]        main -> main (non-fast-forward)\nerror: failed to push some refs",
        );
        assert!(matches!(e, GitError::PushRejected { .. }));
    }

    #[test]
    fn classify_other_failure() {
        let e = classify_remote_error(1, "fatal: could not create work tree dir");
        assert!(matches!(e, GitError::CommandFailed { exit_code: 1, .. }));
    }

    #[test]
    fn set_url_args_fetch() {
        assert_eq!(
            build_set_url_args("origin", "https://x/y.git", false),
            vec!["remote", "set-url", "origin", "https://x/y.git"]
        );
    }

    #[test]
    fn set_url_args_push() {
        assert_eq!(
            build_set_url_args("origin", "git@x:y.git", true),
            vec!["remote", "set-url", "--push", "origin", "git@x:y.git"]
        );
    }

    // --- commit / tag / fetch / pull argument construction ---

    #[test]
    fn commit_args_plain_default_sign() {
        let args = build_commit_args(&CommitOptions {
            message: "msg".into(),
            ..Default::default()
        });
        assert_eq!(args, vec!["commit", "-m", "msg"]);
    }

    #[test]
    fn commit_args_amend_allow_empty_no_sign() {
        let args = build_commit_args(&CommitOptions {
            message: "msg".into(),
            sign: SignMode::None,
            allow_empty: true,
            amend: true,
        });
        assert_eq!(
            args,
            vec!["commit", "-m", "msg", "--amend", "--allow-empty", "--no-gpg-sign"]
        );
    }

    #[test]
    fn commit_args_with_key_uses_inline_s() {
        let args = build_commit_args(&CommitOptions {
            message: "msg".into(),
            sign: SignMode::WithKey(crate::types::KeyId("ABC123".into())),
            ..Default::default()
        });
        assert_eq!(args, vec!["commit", "-m", "msg", "-SABC123"]);
    }

    #[test]
    fn tag_args_lightweight() {
        assert_eq!(build_tag_args("v1", None, None), vec!["tag", "v1"]);
    }

    #[test]
    fn tag_args_blank_message_stays_lightweight() {
        // The UI sends the annotation input verbatim; whitespace-only must not
        // create an annotated tag with an empty message.
        assert_eq!(build_tag_args("v1", None, Some("   ")), vec!["tag", "v1"]);
    }

    #[test]
    fn tag_args_annotated_with_target() {
        assert_eq!(
            build_tag_args("v1", Some("abc123"), Some("release")),
            vec!["tag", "-a", "v1", "-m", "release", "abc123"]
        );
    }

    #[test]
    fn tag_args_lightweight_with_target() {
        assert_eq!(
            build_tag_args("v1", Some("abc123"), None),
            vec!["tag", "v1", "abc123"]
        );
    }

    /// The auto-maintenance suppression both transfer commands must carry
    /// (post-fetch `gc --auto` churn re-triggered the watcher for seconds).
    const NO_MAINT: [&str; 4] = ["-c", "gc.auto=0", "-c", "maintenance.auto=false"];

    fn with_no_maint(rest: &[&str]) -> Vec<String> {
        NO_MAINT.iter().chain(rest).map(|s| s.to_string()).collect()
    }

    #[test]
    fn fetch_args_variants() {
        assert_eq!(
            build_fetch_args(&FetchOptions { all: false, prune: false, remote: None }),
            with_no_maint(&["fetch", "--progress"])
        );
        assert_eq!(
            build_fetch_args(&FetchOptions {
                all: false,
                prune: true,
                remote: Some("origin".into())
            }),
            with_no_maint(&["fetch", "--progress", "--prune", "origin"])
        );
        // --all wins over a named remote; empty remote name means default.
        assert_eq!(
            build_fetch_args(&FetchOptions {
                all: true,
                prune: false,
                remote: Some("origin".into())
            }),
            with_no_maint(&["fetch", "--progress", "--all"])
        );
        assert_eq!(
            build_fetch_args(&FetchOptions { all: false, prune: false, remote: Some("".into()) }),
            with_no_maint(&["fetch", "--progress"])
        );
    }

    #[test]
    fn pull_args_variants() {
        let mk = |strategy| build_pull_args(&PullOptions { strategy });
        assert_eq!(mk(PullStrategy::Default), with_no_maint(&["pull", "--progress"]));
        assert_eq!(mk(PullStrategy::Rebase), with_no_maint(&["pull", "--progress", "--rebase"]));
        assert_eq!(mk(PullStrategy::Merge), with_no_maint(&["pull", "--progress", "--no-rebase"]));
        assert_eq!(mk(PullStrategy::FfOnly), with_no_maint(&["pull", "--progress", "--ff-only"]));
    }

    // --- merge/rebase argument construction ---

    #[test]
    fn merge_args_pass_no_edit_for_commit_merges() {
        // GIT_EDITOR=false hardening: a merge that decides to open an editor
        // would fail, so every non-squash merge must carry --no-edit.
        for ff in [FfMode::Auto, FfMode::NoFf, FfMode::FfOnly] {
            let args = merge_args("dev", MergeOptions { ff, squash: false });
            assert!(args.contains(&"--no-edit".to_string()), "{args:?}");
            assert_eq!(args.last().unwrap(), "dev");
        }
        assert!(merge_args("dev", MergeOptions { ff: FfMode::NoFf, squash: false })
            .contains(&"--no-ff".to_string()));
        assert!(merge_args("dev", MergeOptions { ff: FfMode::FfOnly, squash: false })
            .contains(&"--ff-only".to_string()));
    }

    #[test]
    fn squash_merge_ignores_ff_and_skips_no_edit() {
        let args = merge_args("dev", MergeOptions { ff: FfMode::NoFf, squash: true });
        assert_eq!(args, vec!["merge", "--squash", "dev"]);
    }

    #[test]
    fn continue_commands_neutralize_the_editor_via_env() {
        // Regression: `-c core.editor=true` was used before, but the runner's
        // GIT_EDITOR=false env var outranks config, so continuing a conflicted
        // merge/rebase always failed. The env must be overridden instead.
        assert_eq!(EDITOR_ACCEPT_ENV, &[("GIT_EDITOR", "true")]);
        assert_eq!(MERGE_CONTINUE_ARGS, ["merge", "--continue"]);
        assert_eq!(REBASE_CONTINUE_ARGS, ["rebase", "--continue"]);
        assert_eq!(REBASE_SKIP_ARGS, ["rebase", "--skip"]);
    }

    #[test]
    fn rebase_always_autostashes() {
        assert_eq!(rebase_args("main"), vec!["rebase", "--autostash", "main"]);
    }

    // --- merge output classification (exit-1 ambiguity) ---

    #[test]
    fn merge_conflict_is_outcome_not_error() {
        let out = classify_merge_output(
            1,
            "Auto-merging a.txt\nCONFLICT (content): Merge conflict in a.txt\nAutomatic merge failed; fix conflicts and then commit the result.\n",
            "",
            false,
        );
        assert!(matches!(out, Ok(MergeOutcome::Conflicts { .. })));
    }

    #[test]
    fn merge_success_variants() {
        assert_eq!(
            classify_merge_output(0, "Already up to date.\n", "", false).unwrap(),
            MergeOutcome::AlreadyUpToDate
        );
        assert_eq!(
            classify_merge_output(0, "Updating 1a2b..3c4d\nFast-forward\n a.txt | 1 +\n", "", false)
                .unwrap(),
            MergeOutcome::FastForwarded
        );
        assert_eq!(
            classify_merge_output(0, "Merge made by the 'ort' strategy.\n", "", false).unwrap(),
            MergeOutcome::Merged
        );
        assert_eq!(
            classify_merge_output(0, "Squash commit -- not updating HEAD\n", "", true).unwrap(),
            MergeOutcome::Squashed
        );
    }

    #[test]
    fn merge_real_failures_stay_errors() {
        assert!(matches!(
            classify_merge_output(
                1,
                "",
                "error: Your local changes to the following files would be overwritten by merge:\n\ta.txt\n",
                false
            ),
            Err(GitError::WouldOverwriteLocalChanges(_))
        ));
        assert!(matches!(
            classify_merge_output(1, "", "merge: nosuch - not something we can merge\n", false),
            Err(GitError::RefNotFound(_))
        ));
        assert!(matches!(
            classify_merge_output(128, "", "fatal: refusing to merge unrelated histories\n", false),
            Err(GitError::CommandFailed { .. })
        ));
        // ff-only refusal is a plain failure with git's own message.
        assert!(matches!(
            classify_merge_output(128, "", "fatal: Not possible to fast-forward, aborting.\n", false),
            Err(GitError::CommandFailed { .. })
        ));
    }

    // --- rebase output classification ---

    #[test]
    fn rebase_conflict_is_outcome_not_error() {
        let out = classify_rebase_output(
            1,
            "Auto-merging a.txt\nCONFLICT (content): Merge conflict in a.txt\n",
            "error: could not apply 1a2b3c4... subject\n",
        );
        assert!(matches!(out, Ok(RebaseOutcome::Conflicts { .. })));
    }

    #[test]
    fn rebase_success_variants() {
        assert_eq!(
            classify_rebase_output(0, "", "Successfully rebased and updated refs/heads/feature.\n")
                .unwrap(),
            RebaseOutcome::Completed
        );
        assert_eq!(
            classify_rebase_output(0, "Current branch feature is up to date.\n", "").unwrap(),
            RebaseOutcome::AlreadyUpToDate
        );
        assert!(matches!(
            classify_rebase_output(
                0,
                "Applying autostash resulted in conflicts.\nYour changes are safe in the stash.\n",
                "Successfully rebased and updated refs/heads/feature.\n"
            )
            .unwrap(),
            RebaseOutcome::CompletedWithStashConflicts { .. }
        ));
    }

    #[test]
    fn rebase_real_failures_stay_errors() {
        assert!(matches!(
            classify_rebase_output(128, "", "fatal: invalid upstream 'nosuch'\n"),
            Err(GitError::RefNotFound(_))
        ));
    }

    // --- take-side delete detection ---

    #[test]
    fn take_side_delete_conflict_detection() {
        assert!(take_side_means_delete("error: path 'a.txt' does not have their version\n"));
        assert!(take_side_means_delete("error: path 'a.txt' does not have our version\n"));
        assert!(!take_side_means_delete("error: pathspec 'a.txt' did not match any files\n"));
    }
}
