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
    PushOptions, RefSelector, SignMode, SubmoduleInfo, TrackingStatus,
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
        // working-tree diff of one would read as "no changes". Show the whole
        // file as added by diffing it against the empty side instead.
        if output.stdout.trim().is_empty()
            && matches!(source, DiffSource::WorkingUnstaged)
            && self.is_untracked(&runner, &path_str).await?
        {
            return self.diff_no_index(&runner, &path_str, context).await;
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

        let refs_flag;
        match opts.refs {
            RefSelector::AllLocalBranches => {
                refs_flag = "--branches";
                args.push(refs_flag);
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

    async fn commit_files(&self, id: &CommitId) -> Result<Vec<CommitFileChange>, GitError> {
        let runner = self.runner().await;

        // Resolve the first parent. `rev-list --parents -n 1 <sha>` prints
        // `<sha> <parent1> <parent2> …`; a root commit prints only `<sha>`, so
        // we diff against the empty tree. Using an explicit `<from> <to>` pair
        // (rather than a bare commit) makes the diff first-parent for merges
        // and avoids diff-tree's empty default output for merge commits.
        let rev = runner
            .run(&["rev-list", "--parents", "-n", "1", id.as_str()])
            .await
            .map_err(|e| GitError::Internal(e.to_string()))?;
        if !rev.success {
            return Err(GitError::CommandFailed {
                exit_code: rev.exit_code.unwrap_or(-1),
                stderr: rev.stderr,
            });
        }
        let from = rev
            .stdout
            .split_whitespace()
            .nth(1)
            .unwrap_or(EMPTY_TREE_OID)
            .to_string();

        let flags = parsers::commit_files::DIFF_TREE_FLAGS;
        let to = id.as_str();

        let run_diff = |kind: &'static str| {
            let runner = runner.clone();
            let from = from.clone();
            let to = to.to_string();
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

        let name_status = run_diff("--name-status").await?;
        let numstat = run_diff("--numstat").await?;

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

/// Map a failed remote op's stderr to a specific `GitError`: authentication
/// problems → `AuthFailed`, non-fast-forward/rejected pushes → `PushRejected`,
/// everything else → `CommandFailed`.
fn classify_remote_error(exit_code: i32, stderr: &str) -> GitError {
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
}
