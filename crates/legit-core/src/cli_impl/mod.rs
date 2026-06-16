//! `GitCliBackend` — the CLI-backed `GitBackend` implementation.
//!
//! Per DESIGN-v0.3.md, `log()` and `commit_details()` are implemented here.
//! Other trait methods remain as `NotYet` stubs until their respective panels
//! are built.

use crate::backend::GitBackend;
use crate::error::GitError;
use crate::runner::GitRunner;
use crate::types::{
    Branch, Commit, CommitDetails, CommitFileChange, CommitId, CommitOptions, Diff, FileStatus,
    LogOptions, RefSelector, SubmoduleInfo,
};

/// Git's well-known empty-tree object id, used as the "before" side when
/// diffing a root commit (which has no parent).
const EMPTY_TREE_OID: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
use async_trait::async_trait;
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

    async fn commit(&self, _opts: CommitOptions) -> Result<CommitId, GitError> {
        Err(GitError::NotYet)
    }

    async fn submodules(&self) -> Result<Vec<SubmoduleInfo>, GitError> {
        Err(GitError::NotYet)
    }
}
