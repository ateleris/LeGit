//! `GitCliBackend` — the CLI-backed `GitBackend` implementation.
//!
//! Per DESIGN-v0.3.md, `log()` and `commit_details()` are implemented here.
//! Other trait methods remain as `NotYet` stubs until their respective panels
//! are built.

use crate::backend::GitBackend;
use crate::error::GitError;
use crate::runner::GitRunner;
use crate::types::{
    Branch, Commit, CommitDetails, CommitFileChange, CommitId, CommitOptions, Diff, DiffEntry,
    DiffSource, FileState, FileStatus, HunkOp, LogOptions, RefSelector, SignMode, SubmoduleInfo,
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
        args.push(path_str);

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
        Ok(output.stdout)
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
}
