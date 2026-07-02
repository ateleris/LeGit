//! `GitCliBackend` — the CLI-backed `GitBackend` implementation.
//!
//! Per DESIGN-v0.3.md, `log()` and `commit_details()` are implemented here.
//! Other trait methods remain as `NotYet` stubs until their respective panels
//! are built.

use crate::backend::GitBackend;
use crate::error::GitError;
use crate::runner::{GitRunner, OperationId};
use crate::types::{
    Branch, Commit, CommitDetails, CommitFileChange, CommitId, CommitOptions, Diff, DiffEntry,
    DiffSource, FetchOptions, FileState, FileStatus, HunkOp, LogOptions, PullOptions, PullStrategy,
    PushOptions, RefDecoration, RefSelector, Remote, RemoteTag, SignMode, StashApplyOutcome,
    StashEntry, StashOutcome, SubmoduleInfo, SwitchDirtyBehavior, SwitchOutcome, TagInfo,
    TrackingStatus,
};

/// Git's well-known empty-tree object id, used as the "before" side when
/// diffing a root commit (which has no parent).
const EMPTY_TREE_OID: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
use async_trait::async_trait;
use std::path::{Path, PathBuf};
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
            .await
            .map_err(|e| GitError::Internal(e.to_string()))?;
        if !output.success {
            return Err(GitError::CommandFailed {
                exit_code: output.exit_code.unwrap_or(-1),
                stderr: output.stderr,
            });
        }
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
        // own deterministic unified output for the parser.
        let mut args: Vec<String> = vec![
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
            .await
            .map_err(|e| GitError::Internal(e.to_string()))?;
        if !output.success {
            return Err(GitError::CommandFailed {
                exit_code: output.exit_code.unwrap_or(-1),
                stderr: output.stderr,
            });
        }
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
    async fn is_untracked(&self, runner: &GitRunner, path: &str) -> Result<bool, GitError> {
        let out = runner
            .run(&["ls-files", "-z", "--", path])
            .await
            .map_err(|e| GitError::Internal(e.to_string()))?;
        Ok(out.stdout.is_empty())
    }

    /// Diff an untracked file against the empty side (all lines added).
    /// `git diff --no-index` exits 1 when the inputs differ — success for us.
    async fn diff_no_index(
        &self,
        runner: &GitRunner,
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
            .await
            .map_err(|e| GitError::Internal(e.to_string()))?;
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
        runner: &GitRunner,
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
            .await
            .map_err(|e| GitError::Internal(e.to_string()))?;
        if !out.success {
            return Err(GitError::CommandFailed {
                exit_code: out.exit_code.unwrap_or(-1),
                stderr: out.stderr,
            });
        }
        Ok(out.stdout)
    }

    /// Resolve a commit's first parent for diffing, falling back to git's
    /// empty-tree object for a root commit. Mirrors `commit_files`.
    async fn first_parent(
        &self,
        runner: &GitRunner,
        sha: &str,
    ) -> Result<String, GitError> {
        let rev = runner
            .run(&["rev-list", "--parents", "-n", "1", sha])
            .await
            .map_err(|e| GitError::Internal(e.to_string()))?;
        if !rev.success {
            return Err(GitError::CommandFailed {
                exit_code: rev.exit_code.unwrap_or(-1),
                stderr: rev.stderr,
            });
        }
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
        runner: &GitRunner,
        sha: &str,
    ) -> Result<Option<String>, GitError> {
        let rev = runner
            .run(&["rev-list", "--parents", "-n", "1", sha])
            .await
            .map_err(|e| GitError::Internal(e.to_string()))?;
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
            .await
            .map_err(|e| GitError::Internal(e.to_string()))?;
        if !list.success {
            return Ok(None);
        }
        let is_stash = list.stdout.lines().any(|l| l.trim() == sha);
        Ok(is_stash.then_some(untracked))
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
            .await
            .map_err(|e| GitError::Internal(e.to_string()))?;
        if !output.success {
            return Err(GitError::CommandFailed {
                exit_code: output.exit_code.unwrap_or(-1),
                stderr: output.stderr,
            });
        }
        Ok(())
    }

    /// Run a cancellable remote operation (fetch/pull/push) and map a non-zero
    /// exit through `classify_remote_error` so auth/rejection failures surface as
    /// specific `GitError` variants. A user-cancelled op also returns a non-zero
    /// `RunOutput` (the frontend, which initiated the cancel, suppresses its toast).
    async fn run_remote(
        &self,
        runner: &GitRunner,
        args: &[String],
        op_id: OperationId,
    ) -> Result<(), GitError> {
        let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
        let output = runner
            .run_with_op(&arg_refs, op_id)
            .await
            .map_err(|e| GitError::Internal(e.to_string()))?;
        if !output.success {
            return Err(classify_remote_error(
                output.exit_code.unwrap_or(-1),
                &output.stderr,
            ));
        }
        Ok(())
    }

    /// Run a non-network git invocation and map a non-zero exit to
    /// `CommandFailed` (used by the remote-management mutations).
    async fn run_simple(&self, args: &[&str]) -> Result<(), GitError> {
        let runner = self.runner().await;
        let output = runner
            .run(args)
            .await
            .map_err(|e| GitError::Internal(e.to_string()))?;
        if !output.success {
            return Err(GitError::CommandFailed {
                exit_code: output.exit_code.unwrap_or(-1),
                stderr: output.stderr,
            });
        }
        Ok(())
    }

    /// Run a `git stash apply`/`pop`, mapping a merge conflict (non-zero exit
    /// whose output mentions a conflict) to `Conflicts` rather than `Err` — the
    /// apply partially succeeded and the user must resolve the working tree. Any
    /// other failure (e.g. a bad selector) is a real `CommandFailed`.
    async fn run_stash_apply(&self, args: &[&str]) -> Result<StashApplyOutcome, GitError> {
        let runner = self.runner().await;
        let output = runner
            .run(args)
            .await
            .map_err(|e| GitError::Internal(e.to_string()))?;
        if output.success {
            return Ok(StashApplyOutcome::Clean);
        }
        let combined = format!("{}\n{}", output.stdout, output.stderr);
        if combined.to_lowercase().contains("conflict") {
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
            .await
            .map_err(|e| GitError::Internal(e.to_string()))?;
        if !output.success {
            return Err(GitError::CommandFailed {
                exit_code: output.exit_code.unwrap_or(-1),
                stderr: output.stderr,
            });
        }
        find_stash_selector(&output.stdout, stash_sha).ok_or_else(|| {
            GitError::RefNotFound(format!(
                "{stash_sha} is not (or no longer) a stash entry — the stash list may have changed"
            ))
        })
    }

    /// The current `refs/stash` tip, or `None` when there are no stash entries.
    /// This is how the auto-stash logic decides whether a `stash push` actually
    /// created an entry: `git stash push` exits **0** with "No local changes to
    /// save" (on stdout) for a clean tree, so neither the exit code nor stderr
    /// can tell — only a changed stash tip can.
    async fn stash_tip(&self) -> Result<Option<String>, GitError> {
        let runner = self.runner().await;
        let output = runner
            .run(&["rev-parse", "-q", "--verify", "refs/stash"])
            .await
            .map_err(|e| GitError::Internal(e.to_string()))?;
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
            .await
            .map_err(|e| GitError::Internal(e.to_string()))?;
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
    /// by comparing the `refs/stash` tip before and after the push (see
    /// `stash_tip`), and the created entry is addressed *by its SHA* — never a
    /// bare `stash pop`, which would pop an unrelated pre-existing stash when
    /// nothing was auto-stashed or when the list shifted in between. The two
    /// modes differ only after a successful switch: `AutoStash` pops the entry
    /// (changes travel along), `StashAndKeep` leaves it parked.
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
        let tip_before = self.stash_tip().await?;
        self.run_simple(&["stash", "push", "--include-untracked", "-m", &msg])
            .await?;
        let tip_after = self.stash_tip().await?;
        // The SHA of the entry *we* created; `None` when the tree was clean.
        let created = stash_created(tip_before.as_deref(), tip_after.as_deref());

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
impl GitBackend for GitCliBackend {
    async fn status(&self) -> Result<Vec<FileStatus>, GitError> {
        let runner = self.runner().await;

        let output = runner
            .run(&parsers::status::STATUS_ARGS)
            .await
            .map_err(|e| GitError::Internal(e.to_string()))?;

        if !output.success {
            return Err(GitError::CommandFailed {
                exit_code: output.exit_code.unwrap_or(-1),
                stderr: output.stderr,
            });
        }

        Ok(parsers::status::parse_status(&output.stdout))
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

        match opts.refs {
            RefSelector::AllLocalBranches => {
                // Always include HEAD so a detached HEAD commit appears even
                // when it isn't reachable from any local branch.
                args.push("HEAD");
                args.push("--branches");
            }
            RefSelector::Head => {}
        }
        args.push("--decorate=full");

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

    async fn commit_files(&self, id: &CommitId) -> Result<Vec<CommitFileChange>, GitError> {
        let runner = self.runner().await;

        // Resolve the first parent. `rev-list --parents -n 1 <sha>` prints
        // `<sha> <parent1> <parent2> …`; a root commit prints only `<sha>`, so
        // we diff against the empty tree. Using an explicit `<from> <to>` pair
        // (rather than a bare commit) makes the diff first-parent for merges
        // and avoids diff-tree's empty default output for merge commits.
        let from = self.first_parent(&runner, id.as_str()).await?;
        let to = id.as_str().to_string();

        let flags = parsers::commit_files::DIFF_TREE_FLAGS;

        // diff-tree <from> <to> for a given output kind (--name-status / --numstat).
        let run_diff = |from: String, to: String, kind: &'static str| {
            let runner = runner.clone();
            async move {
                let mut args = vec!["diff-tree"];
                args.extend_from_slice(&flags);
                args.push(kind);
                args.push(&from);
                args.push(&to);
                let out = runner
                    .run(&args)
                    .await
                    .map_err(|e| GitError::Internal(e.to_string()))?;
                if !out.success {
                    return Err(GitError::CommandFailed {
                        exit_code: out.exit_code.unwrap_or(-1),
                        stderr: out.stderr,
                    });
                }
                Ok::<String, GitError>(out.stdout)
            }
        };

        let mut name_status = run_diff(from.clone(), to.clone(), "--name-status").await?;
        let mut numstat = run_diff(from, to.clone(), "--numstat").await?;

        // A stash created with --include-untracked keeps its untracked files in a
        // separate 3rd-parent commit, NOT in the stash commit's own tree — so the
        // diff above misses them entirely. Append them as additions (empty tree →
        // untracked parent) so the stash's full contents show. Ordinary commits
        // and octopus merges have no untracked parent and are unaffected.
        if let Some(untracked) = self.stash_untracked_parent(&runner, &to).await? {
            let u_from = EMPTY_TREE_OID.to_string();
            name_status.push_str(&run_diff(u_from.clone(), untracked.clone(), "--name-status").await?);
            numstat.push_str(&run_diff(u_from, untracked, "--numstat").await?);
        }

        Ok(parsers::commit_files::parse_commit_files(
            &name_status,
            &numstat,
        ))
    }

    async fn branches(&self) -> Result<Vec<Branch>, GitError> {
        let runner = self.runner().await;
        let fmt_arg = format!("--format={}", parsers::branches::BRANCH_FORMAT);

        let output = runner
            .run(&["for-each-ref", &fmt_arg, "refs/heads", "refs/remotes"])
            .await
            .map_err(|e| GitError::Internal(e.to_string()))?;

        if !output.success {
            return Err(GitError::CommandFailed {
                exit_code: output.exit_code.unwrap_or(-1),
                stderr: output.stderr,
            });
        }

        Ok(parsers::branches::parse_branches(&output.stdout))
    }

    async fn diff(&self, _from: &CommitId, _to: &CommitId) -> Result<Diff, GitError> {
        Err(GitError::NotYet)
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

        let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
        let output = runner
            .run(&arg_refs)
            .await
            .map_err(|e| GitError::Internal(e.to_string()))?;
        if !output.success {
            return Err(GitError::CommandFailed {
                exit_code: output.exit_code.unwrap_or(-1),
                stderr: output.stderr,
            });
        }

        // Resolve the resulting commit id.
        let head = runner
            .run(&["rev-parse", "HEAD"])
            .await
            .map_err(|e| GitError::Internal(e.to_string()))?;
        if !head.success {
            return Err(GitError::CommandFailed {
                exit_code: head.exit_code.unwrap_or(-1),
                stderr: head.stderr,
            });
        }
        Ok(CommitId::new(head.stdout.trim().to_string()))
    }

    async fn reword_commit(&self, id: &CommitId, message: &str) -> Result<CommitId, GitError> {
        let runner = self.runner().await;

        // v1 rewords HEAD only — resolve the tip and reject anything else.
        let head = runner
            .run(&["rev-parse", "HEAD"])
            .await
            .map_err(|e| GitError::Internal(e.to_string()))?;
        if !head.success {
            return Err(GitError::CommandFailed {
                exit_code: head.exit_code.unwrap_or(-1),
                stderr: head.stderr,
            });
        }
        if head.stdout.trim() != id.0 {
            return Err(GitError::RewordNotHead);
        }

        // Hard-block rewording published history. `rev-list -n 1 <id> --not
        // --remotes` prints the sha iff it is NOT reachable from any
        // remote-tracking ref; empty output means the commit is already pushed.
        let pushed = runner
            .run(&["rev-list", "-n", "1", &id.0, "--not", "--remotes"])
            .await
            .map_err(|e| GitError::Internal(e.to_string()))?;
        if !pushed.success {
            return Err(GitError::CommandFailed {
                exit_code: pushed.exit_code.unwrap_or(-1),
                stderr: pushed.stderr,
            });
        }
        if pushed.stdout.trim().is_empty() {
            return Err(GitError::RewordPushed);
        }

        // `--amend --only` with no pathspec rewrites HEAD's message without
        // folding any staged changes, preserving the original author.
        let output = runner
            .run(&["commit", "--amend", "--only", "-m", message])
            .await
            .map_err(|e| GitError::Internal(e.to_string()))?;
        if !output.success {
            return Err(GitError::CommandFailed {
                exit_code: output.exit_code.unwrap_or(-1),
                stderr: output.stderr,
            });
        }

        // Resolve the rewritten commit's new id.
        let new_head = runner
            .run(&["rev-parse", "HEAD"])
            .await
            .map_err(|e| GitError::Internal(e.to_string()))?;
        if !new_head.success {
            return Err(GitError::CommandFailed {
                exit_code: new_head.exit_code.unwrap_or(-1),
                stderr: new_head.stderr,
            });
        }
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
        // Classify paths: untracked ones must be removed with `clean`, tracked
        // ones reverted with `restore --worktree` (restore errors on untracked).
        let status = self.status().await?;
        let untracked: std::collections::HashSet<&std::path::Path> = status
            .iter()
            .filter(|f| f.state == FileState::Untracked)
            .map(|f| f.path.as_path())
            .collect();

        let (untracked_paths, tracked_paths): (Vec<PathBuf>, Vec<PathBuf>) = paths
            .iter()
            .cloned()
            .partition(|p| untracked.contains(p.as_path()));

        if !tracked_paths.is_empty() {
            self.run_pathspec(&["restore", "--worktree", "--"], &tracked_paths)
                .await?;
        }
        if !untracked_paths.is_empty() {
            self.run_pathspec(&["clean", "-f", "--"], &untracked_paths)
                .await?;
        }
        Ok(())
    }

    async fn submodules(&self) -> Result<Vec<SubmoduleInfo>, GitError> {
        Err(GitError::NotYet)
    }

    async fn fetch(&self, opts: FetchOptions, op_id: OperationId) -> Result<(), GitError> {
        let runner = self.runner().await;
        let mut args: Vec<String> = vec!["fetch".into()];
        if opts.prune {
            args.push("--prune".into());
        }
        if opts.all {
            args.push("--all".into());
        } else if let Some(remote) = opts.remote.as_deref().filter(|r| !r.is_empty()) {
            args.push(remote.to_string());
        }
        self.run_remote(&runner, &args, op_id).await
    }

    async fn pull(&self, opts: PullOptions, op_id: OperationId) -> Result<(), GitError> {
        let runner = self.runner().await;
        let mut args: Vec<String> = vec!["pull".into()];
        match opts.strategy {
            PullStrategy::Default => {}
            PullStrategy::Rebase => args.push("--rebase".into()),
            PullStrategy::Merge => args.push("--no-rebase".into()),
            PullStrategy::FfOnly => args.push("--ff-only".into()),
        }
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
            .await
            .map_err(|e| GitError::Internal(e.to_string()))?;
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
            .await
            .map_err(|e| GitError::Internal(e.to_string()))?;
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
            .await
            .map_err(|e| GitError::Internal(e.to_string()))?;
        if !counts.success {
            return Err(GitError::CommandFailed {
                exit_code: counts.exit_code.unwrap_or(-1),
                stderr: counts.stderr,
            });
        }
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
            .await
            .map_err(|e| GitError::Internal(e.to_string()))?;
        if !output.success {
            return Err(GitError::CommandFailed {
                exit_code: output.exit_code.unwrap_or(-1),
                stderr: output.stderr,
            });
        }
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
            .await
            .map_err(|e| GitError::Internal(e.to_string()))?
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

    async fn rename_branch(&self, old_name: &str, new_name: &str) -> Result<(), GitError> {
        self.run_simple(&["branch", "-m", old_name, new_name]).await
    }

    async fn tags(&self) -> Result<Vec<TagInfo>, GitError> {
        let runner = self.runner().await;
        let fmt_arg = format!("--format={}", parsers::tags::TAGS_FORMAT);
        let output = runner
            .run(&["for-each-ref", &fmt_arg, "refs/tags"])
            .await
            .map_err(|e| GitError::Internal(e.to_string()))?;
        if !output.success {
            return Err(GitError::CommandFailed {
                exit_code: output.exit_code.unwrap_or(-1),
                stderr: output.stderr,
            });
        }
        Ok(parsers::tags::parse_tags(&output.stdout))
    }

    async fn create_tag(
        &self,
        name: &str,
        target: Option<&str>,
        message: Option<&str>,
    ) -> Result<(), GitError> {
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
        self.run_simple(&args).await
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
            .await
            .map_err(|e| GitError::Internal(e.to_string()))?;
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
            .await
            .map_err(|e| GitError::Internal(e.to_string()))?;

        if !output.success {
            return Err(GitError::CommandFailed {
                exit_code: output.exit_code.unwrap_or(-1),
                stderr: output.stderr,
            });
        }

        Ok(parsers::stash::parse_stashes(&output.stdout))
    }

    async fn create_stash(
        &self,
        message: Option<&str>,
        include_untracked: bool,
    ) -> Result<StashOutcome, GitError> {
        let mut args = vec!["stash", "push"];
        if include_untracked {
            args.push("--include-untracked");
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

    async fn rename_stash(&self, stash_sha: &str, new_message: &str) -> Result<(), GitError> {
        let selector = self.resolve_stash_selector(stash_sha).await?;
        // Drop the old entry, then re-store the same commit (we already hold its
        // SHA, so the content survives even if the store step fails — it stays
        // reachable via fsck). `git stash store` prepends, so the renamed stash
        // lands at stash@{0}.
        self.run_simple(&["stash", "drop", &selector]).await?;
        self.run_simple(&["stash", "store", "-m", new_message, stash_sha]).await
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

/// Build the argument vector for `git push`. The remote and branch are always
/// passed explicitly so the push doesn't depend on `push.default`.
fn build_push_args(opts: &PushOptions) -> Vec<String> {
    let mut args: Vec<String> = vec!["push".into()];
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

/// Decide whether a `git stash push` actually created an entry, given the
/// `refs/stash` tip before and after the push. `git stash push` exits **0**
/// with "No local changes to save" (on stdout) for a clean tree, so neither
/// the exit code nor stderr can tell — only a moved tip can. Returns the
/// created entry's SHA. In particular, an unchanged tip with a pre-existing
/// stash must return `None`, or a later restore would touch the user's own
/// stash.
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
        }
    }

    #[test]
    fn push_args_plain() {
        assert_eq!(
            build_push_args(&push_opts(false, false)),
            vec!["push", "origin", "main"]
        );
    }

    #[test]
    fn push_args_set_upstream() {
        assert_eq!(
            build_push_args(&push_opts(true, false)),
            vec!["push", "--set-upstream", "origin", "main"]
        );
    }

    #[test]
    fn push_args_force_with_lease_then_upstream() {
        assert_eq!(
            build_push_args(&push_opts(true, true)),
            vec!["push", "--force-with-lease", "--set-upstream", "origin", "main"]
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
}
