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
    BlameHunk, BlobBytes, Branch, BranchMergeAnalysis, Commit, CommitDetails, CommitFileChange, CommitId, CommitOptions,
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
    SwitchDirtyBehavior, SwitchOutcome, SwitchResult, TagInfo, TrackingStatus,
};

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
mod line_endings;
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

        // For a rename/copy, pass BOTH paths with rename detection so git pairs
        // them: a modified rename yields real content hunks, a pure rename yields
        // an empty diff. Every option goes in BEFORE the revs below, because
        // `--end-of-options` must be the last one - after it git reads a flag
        // as a rev/pathspec.
        let old_str = old_path.map(|p| p.to_string_lossy().into_owned());
        if old_str.as_deref().is_some_and(|o| o != path_str) {
            args.push("--find-renames".into());
        }
        match source {
            DiffSource::WorkingUnstaged => {}
            DiffSource::WorkingStaged => args.push("--cached".into()),
            DiffSource::Commit { commit_id } => {
                let sha = safe_ref("revision", commit_id.as_str())?;
                let from = self.first_parent(&runner, sha).await?;
                args.push("--end-of-options".into());
                args.push(from);
                args.push(sha.to_string());
            }
            DiffSource::CommitRange { from, to } => {
                args.push("--end-of-options".into());
                args.push(safe_ref("revision", from.as_str())?.to_string());
                args.push(safe_ref("revision", to.as_str())?.to_string());
            }
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

    /// The submodule change `git add` would record for an untracked nested
    /// repo, or `None` when `path` is not one. The status parser strips the
    /// trailing slash from git's collapsed `dir/` untracked form, so the
    /// request path carries no directory marker - probe unconditionally: on
    /// a plain file `-C` fails instantly and the diff stays empty.
    /// `--show-prefix` guards against git walking up from a plain directory
    /// into the superproject (a repo root reports an empty prefix); any
    /// probe failure (e.g. unborn HEAD) means "not presentable", never an
    /// error.
    async fn untracked_repo_dir_change(
        &self,
        path: &Path,
    ) -> Result<Option<SubmoduleChange>, GitError> {
        let path_str = path.to_string_lossy();
        let dir = path_str.trim_end_matches('/');
        if dir.is_empty() {
            return Ok(None);
        }
        let runner = self.runner().await;
        let out = match runner
            .run(&["-C", dir, "rev-parse", "--show-prefix", "HEAD"])
            .await
        {
            Ok(o) if o.success => o,
            _ => return Ok(None),
        };
        let mut lines = out.stdout.lines();
        let prefix = lines.next().unwrap_or("").trim();
        let sha = lines.next().unwrap_or("").trim();
        if !prefix.is_empty() || sha.is_empty() {
            return Ok(None);
        }
        Ok(Some(SubmoduleChange {
            path: PathBuf::from(dir),
            old_sha: None,
            new_sha: Some(CommitId::new(sha)),
            dirty: false,
        }))
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
        args.push("--end-of-options");
        args.push(safe_ref("revision", from)?);
        args.push(safe_ref("revision", to)?);
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
            .run_expecting(&["rev-parse", "-q", "--verify", "refs/stash"], &[1])
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
    /// Run a switch/checkout command; a failure classifies, a success
    /// reports any LFS pointer stubs the checkout left behind (git can exit
    /// 0 with failed LFS downloads under `lfs.skipdownloaderrors` / a
    /// non-required filter).
    async fn run_switch(&self, args: &[&str]) -> Result<Option<LfsStubs>, GitError> {
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
        Ok(lfs_stubs_from_stderr(&output.stderr))
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
    ) -> Result<SwitchResult, GitError> {
        if behavior == SwitchDirtyBehavior::TryDirectly {
            let lfs_stubs = self.run_switch(switch_args).await?;
            return Ok(SwitchResult { outcome: SwitchOutcome::Clean, lfs_stubs });
        }

        let target = switch_args.last().copied().unwrap_or("?");
        let msg = format!("legit: auto-stash before switching to {}", target);
        let list_before = self.run_checked(STASH_LIST_SUBJECT_ARGS).await?;
        self.run_simple(&["stash", "push", "--include-untracked", "-m", &msg])
            .await?;
        let list_after = self.run_checked(STASH_LIST_SUBJECT_ARGS).await?;
        // The SHA of the entry *we* created; `None` when the tree was clean.
        let created = find_created_stash(&list_before, &list_after, &msg);

        let lfs_stubs = match self.run_switch(switch_args).await {
            Ok(stubs) => stubs,
            Err(switch_err) => {
                // Roll back: restore the auto-stash onto the original branch.
                // It was created from exactly this state, so it applies
                // cleanly in practice — but a failure here must not be
                // silent: the user's changes would sit invisibly in the stash
                // while the tree looks clean, with only the switch failure
                // reported.
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
        };
        let done = |outcome: SwitchOutcome| SwitchResult { outcome, lfs_stubs: lfs_stubs.clone() };

        let Some(sha) = created else {
            // Clean tree — nothing was stashed, nothing to restore.
            return Ok(done(SwitchOutcome::Clean));
        };
        if behavior == SwitchDirtyBehavior::StashAndKeep {
            // Deliberately leave the entry parked: the target branch starts
            // clean and the WIP is retrievable from the stash list.
            return Ok(done(SwitchOutcome::ChangesStashed));
        }
        match self.pop_stash_sha(&sha).await {
            Ok(StashApplyOutcome::Clean) => Ok(done(SwitchOutcome::Clean)),
            Ok(StashApplyOutcome::Conflicts { message }) => {
                Ok(done(SwitchOutcome::StashPopConflicts { message }))
            }
            Err(e) => Ok(done(SwitchOutcome::StashPopFailed {
                message: e.to_string(),
            })),
        }
    }
}

#[async_trait]
impl<E: GitExecutor + ?Sized> GitBackend for GitCliBackend<E> {
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
        let author_arg = opts
            .author
            .as_deref()
            .filter(|a| !a.is_empty())
            .map(|a| format!("--author={a}"));

        // --date-order = the default commit-timestamp order PLUS the
        // guarantee that no parent lists before all of its children. The
        // default order lacks that guarantee: a parent discovered via one
        // child can win a committer-timestamp tie against another child and
        // list first, which breaks the commit graph's child->parent lane
        // edges (regression: log_lists_children_before_parents_on_equal_
        // timestamps in tests/git_flows.rs).
        let mut args = vec!["log", &fmt_arg, &max_count_arg, "--date-order"];
        if skip > 0 {
            args.push(&skip_arg);
        }
        // Author filter: fixed-string + case-insensitive so a plain email or
        // name matches literally (no accidental regex metacharacters).
        if let Some(author) = &author_arg {
            args.push("--fixed-strings");
            args.push("--regexp-ignore-case");
            args.push(author);
        }

        // Every OPTION goes in before the revisions: with `--end-of-options`
        // below, anything after it is a revision, and git rejects a trailing
        // `--decorate=full` outright ("must come before non-option
        // arguments" - caught by tests/git_flows.rs, not by the fake).
        args.push("--decorate=full");

        // An explicit revision range (e.g. `base..HEAD` for the interactive
        // rebase plan) wins over the ref selector.
        if let Some(range) = opts.revision_range.as_deref().filter(|r| !r.is_empty()) {
            // `git log --output=<file>` writes to a file, so an option-like
            // range is a file write, not just a bad walk (see `safe_ref`).
            args.push("--end-of-options");
            args.push(safe_ref("revision range", range)?);
        } else {
            // An unborn HEAD (fresh `git init`, no commits yet) makes the
            // explicit HEAD rev a fatal "ambiguous argument 'HEAD'";
            // --ignore-missing drops the unresolvable rev so a fresh repo
            // yields an empty log instead of an error (pinned in
            // tests/git_flows.rs). Deliberately NOT applied to the explicit
            // revision_range above - a bad range must still surface.
            args.push("--ignore-missing");
            match opts.refs {
                RefSelector::AllLocalBranches => {
                    // Always include HEAD so a detached HEAD commit appears even
                    // when it isn't reachable from any local branch.
                    args.push("HEAD");
                    args.push("--branches");
                }
                RefSelector::AllBranchesAndRemotes => {
                    args.push("HEAD");
                    args.push("--branches");
                    args.push("--remotes");
                }
                // Explicit HEAD (identical to bare `git log` once HEAD is
                // born) so --ignore-missing can drop it on an unborn HEAD;
                // the bare default would fail the walk instead.
                RefSelector::Head => args.push("HEAD"),
            }
        }

        let output = runner
            .run(&args)
            .await?;

        Self::ensure_success(&output)?;

        let mut commits = parsers::log::parse_log(&output.stdout).map_err(GitError::from)?;

        // NOTE: the list deliberately does NOT carry signature data - not
        // even presence. Presence is a separate, pay-per-view pass
        // (`signature_presence`, fetched only while the Signed column is
        // visible), and verification stays on-demand in `commit_details`.
        // LOG_FORMAT must never grow %G? (it spawns a verifier per commit).

        // Inject stashes as synthetic nodes so they appear in the graph. For
        // the full-graph view always; for a range walk only when the caller
        // opted in (`include_stashes`, the branch filter) and then only
        // stashes whose base commit is inside the walked window - others
        // couldn't hang off anything. Never for an author filter (a stash
        // isn't "a commit by this author"). Best-effort: a stash-list failure
        // must never break the commit log itself.
        let full_graph = matches!(
            opts.refs,
            RefSelector::AllLocalBranches | RefSelector::AllBranchesAndRemotes
        );
        if opts.author.is_none() && (full_graph || opts.include_stashes) {
            if let Ok(mut stashes) = self.stashes().await {
                if !full_graph {
                    let ids: std::collections::HashSet<&str> =
                        commits.iter().map(|c| c.id.as_str()).collect();
                    stashes.retain(|s| ids.contains(s.base_sha.as_str()));
                }
                inject_stashes(&mut commits, stashes);
            }
        }

        Ok(commits)
    }

    async fn signature_presence(&self, ids: &[CommitId]) -> Result<Vec<CommitId>, GitError> {
        // One `cat-file --batch` over the not-yet-seen SHAs (byte-safe: the
        // output frames objects by byte count and may contain non-UTF-8
        // identities), then answer everything from the per-SHA cache -
        // presence is immutable, so a repeat query for the same page costs
        // zero subprocesses.
        let unknown: Vec<String> = {
            let cache = self.sig_presence.lock().unwrap();
            ids.iter()
                .filter(|id| !cache.contains_key(id.as_str()))
                .map(|id| id.as_str().to_string())
                .collect()
        };
        if !unknown.is_empty() {
            let runner = self.runner().await;
            let stdin = unknown.join("\n") + "\n";
            let out = runner.run_with_stdin_bytes(&["cat-file", "--batch"], &stdin).await?;
            if !out.success {
                return Err(GitError::CommandFailed {
                    exit_code: out.exit_code.unwrap_or(-1),
                    stderr: out.stderr.trim().to_string(),
                });
            }
            let signed = parsers::commit::parse_batch_signature_presence(&out.stdout);
            let mut cache = self.sig_presence.lock().unwrap();
            for sha in unknown {
                let is_signed = signed.contains(&sha);
                cache.insert(sha, is_signed);
            }
        }
        let cache = self.sig_presence.lock().unwrap();
        Ok(ids
            .iter()
            .filter(|id| cache.get(id.as_str()).copied().unwrap_or(false))
            .cloned()
            .collect())
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
        // No `--end-of-options`: `git blame` rejects it outright (usage
        // error), so the dash guard is the only layer here.
        let rev = rev.map(|r| safe_ref("revision", r)).transpose()?;
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
            .run_expecting(
                &[
                    "merge-base",
                    "--end-of-options",
                    safe_ref("revision", a)?,
                    safe_ref("revision", b)?,
                ],
                &[1],
            )
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
        // --ignore-missing tolerates an unborn HEAD (fresh repo, no
        // commits): the search returns empty instead of a fatal.
        args.push("--ignore-missing");
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

    async fn resolve_commit(&self, rev: &str) -> Result<CommitId, GitError> {
        let runner = self.runner().await;
        // `^{commit}` peels tags to the tagged commit and rejects non-commit
        // objects; `--end-of-options` guards against dash-leading user input.
        let spec = format!("{rev}^{{commit}}");
        let output = runner
            .run(&["rev-parse", "--verify", "--quiet", "--end-of-options", &spec])
            .await?;
        Self::ensure_success(&output)?;
        let sha = output.stdout.trim();
        if sha.is_empty() {
            return Err(GitError::CommandFailed {
                exit_code: 1,
                stderr: format!("'{rev}' does not name a commit"),
            });
        }
        Ok(CommitId::new(sha.to_string()))
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
        // `--stage` for the tracked set: the mode column is the only way to
        // tell a gitlink (160000, a submodule) from a blob in ls-files output.
        let cached = run(&["ls-files", "-z", "--stage"]).await?;
        let others = run(&["ls-files", "-z", "--others", "--exclude-standard"]).await?;
        let ignored = if show_ignored {
            run(&["ls-files", "-z", "--others", "--ignored", "--exclude-standard"]).await?
        } else {
            String::new()
        };
        Ok(classify_repo_files(&cached, &others, &ignored))
    }

    async fn list_files_at_revision(&self, rev: &str) -> Result<Vec<RepoFileEntry>, GitError> {
        let runner = self.runner().await;
        // Full ls-tree records (not --name-only): the object type is the only
        // way to tell a gitlink (`commit`) from a blob at a revision.
        let output = runner
            .run(&["ls-tree", "-r", "-z", "--end-of-options", safe_ref("revision", rev)?])
            .await?;
        Self::ensure_success(&output)?;
        Ok(parse_ls_tree_files(&output.stdout))
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
        // An untracked nested repo yields an empty diff (`git diff` ignores
        // untracked paths and `--no-index` refuses directories), which would
        // read as "no changes". Present what staging would record instead: a
        // submodule add at the nested repo's HEAD.
        if raw.trim().is_empty() && matches!(source, DiffSource::WorkingUnstaged) {
            if let Some(sub) = self.untracked_repo_dir_change(path).await? {
                return Ok(DiffEntry::Submodule(sub));
            }
        }
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

    async fn renormalize_preview(&self) -> Result<Vec<String>, GitError> {
        // Simulate on a throwaway index (see parsers::renormalize): snapshot
        // the real index as a tree, rebuild it under GIT_INDEX_FILE, run the
        // renormalize there, and diff against the snapshot. The real index
        // is never touched; the temp file is cleaned up by the caller.
        let runner = self.runner().await;

        let out = runner.run(&["write-tree"]).await?;
        Self::ensure_success(&out)?;
        let tree = out.stdout.trim().to_string();

        let out = runner.run(&["rev-parse", "--git-path", "index"]).await?;
        Self::ensure_success(&out)?;
        let temp_index = format!(
            "{}{}",
            out.stdout.trim(),
            parsers::renormalize::RENORMALIZE_PREVIEW_INDEX_SUFFIX
        );
        let env: [(&str, &str); 1] = [("GIT_INDEX_FILE", temp_index.as_str())];

        let out = runner.run_with_env(&["read-tree", &tree], &env).await?;
        Self::ensure_success(&out)?;
        let out = runner
            .run_with_env(&parsers::renormalize::RENORMALIZE_ARGS, &env)
            .await?;
        Self::ensure_success(&out)?;

        let mut args: Vec<&str> = parsers::renormalize::DIFF_INDEX_NAME_ONLY_Z.to_vec();
        args.push(&tree);
        let out = runner.run_with_env(&args, &env).await?;
        Self::ensure_success(&out)?;
        Ok(parsers::renormalize::parse_name_only_z(&out.stdout))
    }

    async fn renormalize(&self) -> Result<RenormalizeOutcome, GitError> {
        // Bracket the real run with write-tree + diff-index so the outcome
        // reports exactly the index entries the renormalize changed.
        let runner = self.runner().await;

        let out = runner.run(&["write-tree"]).await?;
        Self::ensure_success(&out)?;
        let tree = out.stdout.trim().to_string();

        let out = runner.run(&parsers::renormalize::RENORMALIZE_ARGS).await?;
        Self::ensure_success(&out)?;

        let mut args: Vec<&str> = parsers::renormalize::DIFF_INDEX_NAME_ONLY_Z.to_vec();
        args.push(&tree);
        let out = runner.run(&args).await?;
        Self::ensure_success(&out)?;
        Ok(RenormalizeOutcome {
            restaged: parsers::renormalize::parse_name_only_z(&out.stdout),
        })
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
        let spec = format!("{}:{}", safe_ref("revision", rev)?, path.to_string_lossy());
        let output = runner
            .run(&["show", "--end-of-options", &spec])
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

    async fn blob_bytes(&self, spec: &str, cap: u64) -> Result<BlobBytes, GitError> {
        let runner = self.runner().await;
        let stdin = format!("{spec}\n");
        let out = runner.run_with_stdin_bytes(&["cat-file", "--batch"], &stdin).await?;
        if !out.success {
            return Err(GitError::CommandFailed {
                exit_code: out.exit_code.unwrap_or(-1),
                stderr: out.stderr.trim().to_string(),
            });
        }
        let entries = parse_cat_file_batch(&out.stdout)
            .ok_or_else(|| GitError::Internal("malformed cat-file --batch output".to_string()))?;
        match entries.into_iter().next().flatten() {
            None => Ok(BlobBytes::Missing),
            Some(bytes) if bytes.len() as u64 > cap => {
                Ok(BlobBytes::TooLarge { size: bytes.len() as u64 })
            }
            Some(bytes) => Ok(BlobBytes::Bytes(bytes)),
        }
    }

    async fn restore_file_at_revision(&self, rev: &str, path: &Path) -> Result<(), GitError> {
        // A pathspec checkout touches index + worktree and never refuses on
        // local changes - the destructive-confirm gate lives in the UI.
        let source = self.resolve_file_content_source(rev, path).await?;
        // No `--end-of-options`: `git checkout` takes it as a PATHSPEC, not
        // as a guard (verified in tests/git_flows.rs), so the dash guard on
        // the source rev is the only layer here.
        let source = safe_ref("revision", &source)?;
        self.run_pathspec(&["checkout", source, "--"], std::slice::from_ref(&path.to_path_buf()))
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
        start_rev: Option<&str>,
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
        // Walk from an explicit rev (browse-at-commit mode) instead of HEAD.
        if let Some(rev) = start_rev {
            args.push(rev);
        }
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
        let runner = self.runner().await;
        // `:(glob)**/.gitattributes` matches the root file and nested ones
        // (a leading `**/` matches zero or more directories). git grep
        // searches tracked files, which is the right scope: `git lfs track`
        // always writes .gitattributes, and LFS rules are committed.
        // Exit 1 = "no hits" - an answer (run_expecting logs it as OK).
        let grep = runner
            .run_expecting(
                &["grep", "-l", "-e", "filter=lfs", "--", ":(glob)**/.gitattributes"],
                &[1],
            )
            .await?;
        let uses_lfs = match grep.exit_code {
            Some(0) => true,
            Some(1) => false,
            _ => {
                Self::ensure_success(&grep)?;
                false
            }
        };
        if !uses_lfs {
            return Ok(LfsStatus {
                uses_lfs: false,
                installed: false,
                version: None,
                initialized: false,
            });
        }
        // A missing git-lfs makes this exit non-zero ("git: 'lfs' is not a
        // git command") - that IS the probe result, never an error.
        let ver = runner.run(&["lfs", "version"]).await?;
        let installed = ver.success;
        let version = if installed {
            ver.stdout
                .lines()
                .next()
                .map(|l| l.trim().to_string())
                .filter(|l| !l.is_empty())
        } else {
            None
        };
        // Unset key exits 1 (expected). Set + non-empty = `git lfs install`
        // has registered the smudge filter for this repo's context.
        let cfg = runner
            .run_expecting(&["config", "--get", "filter.lfs.smudge"], &[1])
            .await?;
        let initialized = cfg.success && !cfg.stdout.trim().is_empty();
        Ok(LfsStatus { uses_lfs, installed, version, initialized })
    }

    async fn lfs_tracked_subset(&self, paths: &[String]) -> Result<Vec<String>, GitError> {
        if paths.is_empty() {
            return Ok(vec![]);
        }
        let runner = self.runner().await;
        let stdin: String = paths.iter().map(|p| format!("{p}\0")).collect();
        let out = runner
            .run_with_stdin(&["check-attr", "-z", "--stdin", "filter"], &stdin)
            .await?;
        Self::ensure_success(&out)?;
        let lfs = parse_check_attr_filter_lfs(&out.stdout);
        Ok(paths.iter().filter(|p| lfs.contains(p.as_str())).cloned().collect())
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
        let args = build_fetch_args(&opts)?;
        let runner = self.runner().await;
        self.run_remote(&runner, &args, op_id).await
    }

    async fn pull(&self, opts: PullOptions, op_id: OperationId) -> Result<PullOutcome, GitError> {
        let runner = self.runner().await;
        let args = build_pull_args(&opts);
        let out = self.run_remote_output(&runner, &args, op_id).await?;
        Ok(PullOutcome { lfs_stubs: lfs_stubs_from_stderr(&out.stderr) })
    }

    async fn push(&self, opts: PushOptions, op_id: OperationId) -> Result<(), GitError> {
        let args = build_push_args(&opts)?;
        let runner = self.runner().await;
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
        self.run_simple(&["remote", "add", safe_ref("remote", name)?, url]).await
    }

    async fn remove_remote(&self, name: &str) -> Result<(), GitError> {
        self.run_simple(&["remote", "remove", safe_ref("remote", name)?]).await
    }

    async fn rename_remote(&self, old: &str, new: &str) -> Result<(), GitError> {
        self.run_simple(&[
            "remote",
            "rename",
            safe_ref("remote", old)?,
            safe_ref("remote", new)?,
        ])
        .await
    }

    async fn set_remote_url(&self, name: &str, url: &str, push: bool) -> Result<(), GitError> {
        let name = safe_ref("remote", name)?;
        self.run_simple(&build_set_url_args(name, url, push)).await
    }

    async fn prune_remote(&self, name: &str, op_id: OperationId) -> Result<(), GitError> {
        // Network op (contacts the remote) → cancellable + remote-error mapping.
        let args = vec![
            "remote".to_string(),
            "prune".to_string(),
            safe_ref_owned("remote", name)?,
        ];
        let runner = self.runner().await;
        self.run_remote(&runner, &args, op_id).await
    }

    async fn create_branch(&self, name: &str, start_point: Option<&str>) -> Result<(), GitError> {
        let mut args = vec!["branch", "--end-of-options", safe_ref("branch name", name)?];
        if let Some(sp) = start_point {
            args.push(safe_ref("start point", sp)?);
        }
        self.run_simple(&args).await
    }

    async fn switch_branch(&self, name: &str, behavior: SwitchDirtyBehavior) -> Result<SwitchResult, GitError> {
        let name = safe_ref("branch", name)?;
        self.run_with_auto_stash(behavior, &["switch", "--end-of-options", name])
            .await
    }

    async fn checkout_commit(&self, sha: &str, behavior: SwitchDirtyBehavior) -> Result<SwitchResult, GitError> {
        let sha = safe_ref("revision", sha)?;
        self.run_with_auto_stash(behavior, &["switch", "--detach", "--end-of-options", sha])
            .await
    }

    async fn checkout_remote_branch(
        &self,
        remote_ref: &str,
        behavior: SwitchDirtyBehavior,
        fast_forward: bool,
    ) -> Result<RemoteCheckoutOutcome, GitError> {
        let (short, local) = remote_ref_names(remote_ref);
        // Both names come from the repository (a fetched remote ref), so both
        // pass the dash guard before they reach an argv slot.
        let short = safe_ref("remote branch", short)?;
        let local = safe_ref("branch", local)?;
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
            &["switch", "--end-of-options", local]
        } else {
            &["switch", "--track", "--end-of-options", short]
        };
        let switch_result = self.run_with_auto_stash(behavior, args).await?;
        let ff = if !fast_forward {
            FastForwardResult::NotAttempted
        } else if !local_exists {
            // `switch --track` created the branch AT the remote tip - a merge
            // afterwards is pointless.
            FastForwardResult::UpToDate
        } else {
            // LOCAL ff-only merge against the already-fetched remote-tracking
            // ref - deliberately not a pull: a double-click must never cause
            // network I/O or auth prompts. Its failure modes are outcomes,
            // never errors: the switch above already succeeded.
            let out = self
                .run_classified(&["merge", "--ff-only", "--no-edit", "--end-of-options", short])
                .await?;
            classify_fast_forward(out.0, &out.1, &out.2)
        };
        Ok(RemoteCheckoutOutcome {
            local_branch: local.to_string(),
            switch: switch_result.outcome,
            fast_forward: ff,
            lfs_stubs: switch_result.lfs_stubs,
        })
    }

    async fn delete_branch(&self, name: &str, force: bool) -> Result<(), GitError> {
        let flag = if force { "-D" } else { "-d" };
        let runner = self.runner().await;
        let out = runner
            .run(&["branch", flag, "--end-of-options", safe_ref("branch", name)?])
            .await?;
        if out.success {
            return Ok(());
        }
        Err(classify_branch_delete_error(
            out.exit_code.unwrap_or(-1),
            &out.stderr,
            name,
        ))
    }

    async fn branch_merge_analysis(&self, name: &str) -> Result<BranchMergeAnalysis, GitError> {
        let runner = self.runner().await;
        let head_ref = format!("refs/heads/{name}");
        let tip = {
            let out = runner.run(&["rev-parse", "--verify", &head_ref]).await?;
            Self::ensure_success(&out)?;
            out.stdout.trim().to_string()
        };
        let merged_into = {
            let out = runner
                .run(&[
                    "for-each-ref",
                    "--contains",
                    &tip,
                    "--format=%(refname:short)",
                    "refs/heads",
                    "refs/remotes",
                ])
                .await?;
            Self::ensure_success(&out)?;
            filter_containing_refs(&out.stdout, name)
        };

        // Baseline for the patch-id check: the preferred remote's default
        // branch. The HEAD symref exists only in clones (exit 1/128 when
        // unset), so probe <remote>/main, then <remote>/master as fallbacks.
        let remotes_out = runner.run(&["remote"]).await?;
        Self::ensure_success(&remotes_out)?;
        let remotes: Vec<&str> = remotes_out
            .stdout
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .collect();
        let remote = remotes
            .iter()
            .find(|r| **r == "origin")
            .or_else(|| remotes.first());
        let mut baseline: Option<String> = None;
        if let Some(remote) = remote {
            let symref = format!("refs/remotes/{remote}/HEAD");
            let out = runner
                .run_expecting(&["symbolic-ref", "--short", &symref], &[1, 128])
                .await?;
            if out.success {
                let short = out.stdout.trim();
                if !short.is_empty() {
                    baseline = Some(short.to_string());
                }
            } else {
                for candidate in ["main", "master"] {
                    let full = format!("refs/remotes/{remote}/{candidate}");
                    let probe = runner
                        .run_expecting(&["rev-parse", "--verify", "--quiet", &full], &[1])
                        .await?;
                    if probe.success {
                        baseline = Some(format!("{remote}/{candidate}"));
                        break;
                    }
                }
            }
        }

        let mut equivalent_in = None;
        if let Some(b) = baseline {
            let out = runner.run(&["cherry", &b, &head_ref]).await?;
            Self::ensure_success(&out)?;
            if cherry_all_equivalent(&out.stdout) {
                equivalent_in = Some(b);
            }
        }
        Ok(BranchMergeAnalysis { merged_into, equivalent_in })
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
            safe_ref_owned("remote", remote)?,
            "--delete".to_string(),
            format!("refs/heads/{name}"),
        ];
        self.run_remote(&runner, &args, op_id).await
    }

    async fn rename_branch(&self, old_name: &str, new_name: &str) -> Result<(), GitError> {
        self.run_simple(&[
            "branch",
            "-m",
            "--end-of-options",
            safe_ref("branch", old_name)?,
            safe_ref("new branch name", new_name)?,
        ])
        .await
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
        self.run_simple(&["tag", "-d", "--end-of-options", safe_ref("tag", name)?])
            .await
    }

    async fn push_tag(&self, remote: &str, name: &str, op_id: OperationId) -> Result<(), GitError> {
        let runner = self.runner().await;
        // The full refspec avoids any ambiguity with a same-named branch.
        let args = vec![
            "push".to_string(),
            safe_ref_owned("remote", remote)?,
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
            safe_ref_owned("remote", remote)?,
            "--delete".to_string(),
            format!("refs/tags/{name}"),
        ];
        self.run_remote(&runner, &args, op_id).await
    }

    async fn remote_tags(&self, remote: &str, op_id: OperationId) -> Result<Vec<RemoteTag>, GitError> {
        let runner = self.runner().await;
        let output = runner
            .run_with_op(
                &["ls-remote", "--tags", "--end-of-options", safe_ref("remote", remote)?],
                op_id,
            )
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
        let branch = safe_ref("branch", branch)?;
        match upstream {
            Some(up) => {
                let arg = format!("--set-upstream-to={up}");
                self.run_simple(&["branch", &arg, "--end-of-options", branch])
                    .await
            }
            None => {
                self.run_simple(&["branch", "--unset-upstream", "--end-of-options", branch])
                    .await
            }
        }
    }

    async fn stash_branch(&self, stash_sha: &str, branch_name: &str) -> Result<(), GitError> {
        let selector = self.resolve_stash_selector(stash_sha).await?;
        // `stash branch` is checkout -b at the stash base + apply + drop; its
        // failure mode is the checkout's, so classify like a switch.
        self.run_switch(&[
            "stash",
            "branch",
            "--end-of-options",
            safe_ref("branch name", branch_name)?,
            &selector,
        ])
        .await
        .map(|_| ())
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
        let args = merge_args(safe_ref("merge target", target)?, opts);
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
        let args = rebase_args(safe_ref("rebase target", onto)?);
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
        // The dash guard runs FIRST, before the plan checks and before any
        // git: an option-like base must never reach a `rebase` argv (see
        // `safe_ref` - `--exec=<cmd>` runs <cmd>).
        let base = safe_ref("revision", base)?;
        validate_rebase_plan(plan)?;
        // The injected todo REPLACES git's generated one, and git silently
        // drops any base..HEAD commit missing from the todo (the default
        // rebase.missingCommitsCheck is "ignore" - verified against real git
        // in tests/git_flows.rs). A stale or truncated plan would lose
        // history without a word, so refuse any plan whose sha set is not
        // exactly `rev-list base..HEAD` - and refuse merge commits outright
        // (a `pick <merge>` wedges the rebase mid-flight: "is a merge but no
        // -m option was given").
        let range = format!("{base}..HEAD");
        let listed = self.run_checked(&["rev-list", "--parents", &range]).await?;
        verify_plan_covers_range(plan, &listed)?;
        // Message carriers for reword steps: an unreferenced commit with the
        // ORIGINAL's tree and the original as parent (empty diff, applies
        // anywhere in a reordered plan) holding the new message + the
        // original author. `fixup -C` then takes message and author from it
        // without opening an editor - git's own non-interactive reword lane
        // (what `commit --fixup=reword:` compiles down to; git >= 2.32).
        // The message travels as a plain argv argument: the runner spawns
        // without a shell, so it is byte-safe and may be multi-line.
        let runner = self.runner().await;
        let mut carriers: HashMap<String, String> = HashMap::new();
        for step in plan {
            if step.action != RebaseAction::Reword {
                continue;
            }
            let sha = step.sha.as_str();
            let author = self
                .run_checked(&["log", "-1", "--format=%an%x00%ae%x00%aD", sha])
                .await?;
            let (name, email, date) = parse_author_fields(&author).ok_or_else(|| {
                GitError::Internal(format!("unexpected author format for {sha}: {author:?}"))
            })?;
            let tree = format!("{sha}^{{tree}}");
            let message = step.message.as_deref().unwrap_or_default();
            let out = runner
                .run_with_env(
                    &["commit-tree", &tree, "-p", sha, "-m", message],
                    &[
                        ("GIT_AUTHOR_NAME", &name),
                        ("GIT_AUTHOR_EMAIL", &email),
                        ("GIT_AUTHOR_DATE", &date),
                    ],
                )
                .await?;
            if !out.success {
                return Err(GitError::CommandFailed {
                    exit_code: out.exit_code.unwrap_or(-1),
                    stderr: out.stderr.trim().to_string(),
                });
            }
            carriers.insert(sha.to_string(), out.stdout.trim().to_string());
        }
        let todo = build_rebase_todo(plan, &carriers)?;
        // No temp script: sh completes `printf '<todo>' >` with the todo path
        // git appends, writing the plan straight into git's own todo file.
        // Safe to interpolate: the plan validation rejects non-hex shas (and
        // build_rebase_todo re-checks the carriers), so the single-quoted
        // printf format can never be broken out of.
        let editor = format!("printf '{todo}' >");
        let env = [("GIT_SEQUENCE_EDITOR", editor.as_str()), EDITOR_ACCEPT_ENV[0]];
        let (code, stdout, stderr) = self
            .run_classified_env(
                &[
                    "rebase",
                    "-i",
                    "--autostash",
                    "--end-of-options",
                    base,
                ],
                &env,
            )
            .await?;
        // Older git rejects the `fixup -C` todo line at parse time ("invalid
        // line ...: fixup -C <sha>"); name the floor so the error is
        // actionable rather than cryptic. Only for plans that actually
        // reword, and only when the failure mentions the fixup line.
        match classify_rebase_output(code, &stdout, &stderr) {
            Err(e) if !carriers.is_empty() && stderr.to_lowercase().contains("fixup") => {
                Err(append_error_note(
                    e,
                    "note: rewording via interactive rebase needs git 2.32 or newer (the `fixup -C` todo command)",
                ))
            }
            other => other,
        }
    }

    async fn rebase_range_info(&self, base: &str) -> Result<RebaseRangeInfo, GitError> {
        let runner = self.runner().await;
        // Range commits NOT reachable from the upstream. Exit 128 = HEAD has
        // no upstream: no pushed-warning is possible - an answer, not an
        // error.
        let base = safe_ref("revision", base)?;
        let range = format!("{base}..HEAD");
        let up = runner
            .run_expecting(&["rev-list", &range, "--not", "@{upstream}"], &[128])
            .await?;
        let unpushed = if up.success {
            Some(up.stdout.lines().map(str::to_string).collect())
        } else if up.exit_code == Some(128) {
            None
        } else {
            return Err(GitError::CommandFailed {
                exit_code: up.exit_code.unwrap_or(-1),
                stderr: up.stderr.trim().to_string(),
            });
        };
        // Exit 0 = base IS an ancestor of HEAD (plain history edit); exit 1
        // = it is not (the rebase RELOCATES the range onto the base). Any
        // other exit is a real failure.
        let anc = runner
            .run_expecting(
                &["merge-base", "--is-ancestor", "--end-of-options", base, "HEAD"],
                &[1],
            )
            .await?;
        let transplant = match anc.exit_code {
            Some(0) => false,
            Some(1) => true,
            _ => {
                return Err(GitError::CommandFailed {
                    exit_code: anc.exit_code.unwrap_or(-1),
                    stderr: anc.stderr.trim().to_string(),
                });
            }
        };
        Ok(RebaseRangeInfo { unpushed, transplant })
    }

    async fn reset(&self, target: &str, mode: ResetMode) -> Result<(), GitError> {
        let flag = match mode {
            ResetMode::Soft => "--soft",
            ResetMode::Mixed => "--mixed",
            ResetMode::Hard => "--hard",
        };
        // No `--end-of-options`: `git reset` rejects it ("option
        // '--end-of-options' must come before non-option arguments"), so the
        // dash guard is the only layer for this command.
        self.run_simple(&["reset", flag, safe_ref("revision", target)?])
            .await
    }

    async fn revert(&self, shas: &[String], mainline: Option<u32>) -> Result<SequenceOutcome, GitError> {
        // --no-edit: the runner hardens GIT_EDITOR=false, so a revert that
        // opened an editor for its message would fail outright.
        let args = sequencer_args(&["revert", "--no-edit"], mainline, shas)?;
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        let (code, stdout, stderr) = self.run_classified(&refs).await?;
        classify_sequence_output(code, &stdout, &stderr)
    }

    async fn cherry_pick(&self, shas: &[String], mainline: Option<u32>) -> Result<SequenceOutcome, GitError> {
        let args = sequencer_args(&["cherry-pick"], mainline, shas)?;
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        let (code, stdout, stderr) = self.run_classified(&refs).await?;
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

        // One batched probe for every candidate file — op_state is polled on
        // each status refresh, so the whole disk walk must stay a single
        // round trip on a remote host. Probe files are tiny; the cap only
        // guards against pathological files.
        const OP_STATE_CAP: u64 = 64 * 1024;
        let merge_head = HostPath(lines[0].to_string());
        let merge_msg = HostPath(lines[1].to_string());
        let rebase_merge = HostPath(lines[2].to_string());
        let rebase_apply = HostPath(lines[3].to_string());
        let cherry = HostPath(lines[4].to_string());
        let revert = HostPath(lines[5].to_string());

        let paths = [
            merge_head,                      // 0: existence only
            merge_msg,                       // 1
            rebase_merge.clone(),            // 2: dir existence gates 3..=6
            rebase_merge.join("head-name"),  // 3
            rebase_merge.join("onto"),       // 4
            rebase_merge.join("msgnum"),     // 5
            rebase_merge.join("end"),        // 6
            rebase_apply.clone(),            // 7: dir existence gates 8..=10
            rebase_apply.join("next"),       // 8
            rebase_apply.join("last"),       // 9
            rebase_apply.join("head-name"),  // 10
            cherry,                          // 11
            revert,                          // 12
        ];
        let mut probes = self
            .fs
            .probe_many(&paths, OP_STATE_CAP)
            .await
            .map_err(fs_internal)?;
        if probes.len() != paths.len() {
            return Err(GitError::Internal(format!(
                "probe_many returned {} entries for {} paths",
                probes.len(),
                paths.len()
            )));
        }
        let mut take = |i: usize| std::mem::replace(&mut probes[i], crate::fs::FsProbe::Missing);

        let probe = parsers::op_state::OpStateProbe {
            merge_head: take(0).exists(),
            merge_msg: take(1).into_utf8(),
            rebase_merge: if take(2).exists() {
                Some(parsers::op_state::RebaseMergeFiles {
                    head_name: take(3).into_utf8(),
                    onto: take(4).into_utf8(),
                    msgnum: take(5).into_utf8(),
                    end: take(6).into_utf8(),
                })
            } else {
                None
            },
            rebase_apply: if take(7).exists() {
                Some(parsers::op_state::RebaseApplyFiles {
                    next: take(8).into_utf8(),
                    last: take(9).into_utf8(),
                    head_name: take(10).into_utf8(),
                })
            } else {
                None
            },
            cherry_pick_head: take(11).into_utf8(),
            revert_head: take(12).into_utf8(),
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
        has_signature: false,
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

/// Build the argument vector for `git tag`. A non-blank message makes the tag
/// annotated (`-a -m`); a blank/whitespace-only message is treated as absent
/// so the UI's empty input never creates an annotated tag with an empty
/// annotation. The target (when given) is always the trailing argument.
///
/// `--end-of-options` guards the positional name/target (see `safe_ref`);
/// the `-m` message is an option VALUE, which git never re-parses as a flag.
fn build_tag_args<'a>(
    name: &'a str,
    target: Option<&'a str>,
    message: Option<&'a str>,
) -> Vec<&'a str> {
    let mut args = vec!["tag"];
    if let Some(msg) = message.filter(|m| !m.trim().is_empty()) {
        args.push("-a");
        // `-m <msg>` moves BEFORE the name: `--end-of-options` must be the
        // last option, and everything after it is positional.
        args.push("-m");
        args.push(msg);
    }
    args.push("--end-of-options");
    args.push(name);
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
fn build_fetch_args(opts: &FetchOptions) -> Result<Vec<String>, GitError> {
    let mut args: Vec<String> = NO_AUTO_MAINTENANCE.iter().map(|s| s.to_string()).collect();
    args.push("fetch".into());
    args.push("--progress".into());
    if opts.prune {
        args.push("--prune".into());
    }
    if opts.all {
        args.push("--all".into());
    } else if let Some(remote) = opts.remote.as_deref().filter(|r| !r.is_empty()) {
        // `git fetch --upload-pack=<cmd>` runs <cmd> for path/ssh transports.
        args.push(safe_ref_owned("remote", remote)?);
    }
    Ok(args)
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
/// passed explicitly so the push doesn't depend on `push.default`, and the
/// branch as the full `refs/heads/` refspec: a bare name is ambiguous the
/// moment a tag shares it ("src refspec matches more than one") - the branch
/// context menu pushes branches that are not checked out, where that clash is
/// easy to hit. `--set-upstream` still applies (the refspec source resolves
/// to the local branch).
fn build_push_args(opts: &PushOptions) -> Result<Vec<String>, GitError> {
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
    // `git push --receive-pack=<cmd>` is the push-side counterpart of
    // `fetch --upload-pack` (see `safe_ref`).
    args.push(safe_ref_owned("remote", &opts.remote)?);
    args.push(format!("refs/heads/{}", opts.branch));
    Ok(args)
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
/// `git ls-files` outputs: `cached` (tracked, in `--stage` format so gitlinks
/// are identifiable by mode 160000), `others` (untracked, not ignored), and
/// `ignored` (empty when the caller didn't request ignored files). The three
/// sets are disjoint by git's definition, so no overlap resolution is needed.
/// Result is de-duplicated and sorted by path so the tree order is stable
/// regardless of git's listing order. Pure so the classification rule is
/// unit-tested.
fn classify_repo_files(cached: &str, others: &str, ignored: &str) -> Vec<RepoFileEntry> {
    let mut entries: Vec<RepoFileEntry> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut push = |path: &str, kind: RepoFileKind, submodule: bool| {
        if !path.is_empty() && seen.insert(path.to_string()) {
            entries.push(RepoFileEntry { path: PathBuf::from(path), kind, submodule });
        }
    };

    // Tracked: `--stage` records are `<mode> <sha> <stage>\t<path>`.
    // Mode 160000 marks a gitlink (submodule pointer).
    for record in cached.split('\0').filter(|r| !r.is_empty()) {
        let Some((meta, path)) = record.split_once('\t') else { continue };
        let submodule = meta.starts_with("160000 ");
        push(path, RepoFileKind::Tracked, submodule);
    }

    // Untracked / ignored: plain path records. `ls-files --others` lists an
    // untracked nested git repo as `dir/` (trailing slash) - it doesn't
    // descend into foreign work trees. Trim it (an empty-named child would
    // corrupt the tree) and keep the fact as the submodule flag.
    for (stdout, kind) in [
        (others, RepoFileKind::Untracked),
        (ignored, RepoFileKind::Ignored),
    ] {
        for path in stdout.split('\0').filter(|p| !p.is_empty()) {
            let trimmed = path.trim_end_matches('/');
            push(trimmed, kind, trimmed.len() != path.len());
        }
    }
    entries.sort_by(|a, b| a.path.cmp(&b.path));
    entries
}

/// Parse full `git ls-tree -r -z <rev>` records
/// (`<mode> <type> <sha>\t<path>`) into Files-tree entries: everything at a
/// revision is tracked content; type `commit` marks a gitlink (submodule).
/// Re-sorted with `PathBuf` ordering so browse-at-commit lists order exactly
/// like `classify_repo_files`. Pure so the parse rule is unit-tested.
fn parse_ls_tree_files(stdout: &str) -> Vec<RepoFileEntry> {
    let mut entries: Vec<RepoFileEntry> = stdout
        .split('\0')
        .filter_map(|record| {
            let (meta, path) = record.split_once('\t')?;
            if path.is_empty() {
                return None;
            }
            let submodule = meta.split(' ').nth(1) == Some("commit");
            Some(RepoFileEntry {
                path: PathBuf::from(path),
                kind: RepoFileKind::Tracked,
                submodule,
            })
        })
        .collect();
    entries.sort_by(|a, b| a.path.cmp(&b.path));
    entries
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
    if let Some(f) = parse_lfs_download_failure(stderr) {
        return GitError::LfsDownloadFailed {
            files: f.files,
            missing_on_remote: f.missing_on_remote,
            stderr: stderr.trim().to_string(),
        };
    }
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

/// Map a failed non-force `git branch -d` to a specific `GitError`: the
/// "not fully merged" refusal → `BranchNotFullyMerged` (so the UI can offer
/// a guided force delete), everything else → `CommandFailed`.
fn classify_branch_delete_error(exit_code: i32, stderr: &str, branch: &str) -> GitError {
    if stderr.to_lowercase().contains("not fully merged") {
        return GitError::BranchNotFullyMerged {
            branch: branch.to_string(),
            stderr: stderr.trim().to_string(),
        };
    }
    GitError::CommandFailed {
        exit_code,
        stderr: stderr.trim().to_string(),
    }
}

/// Filter `for-each-ref --contains <tip> --format=%(refname:short)` output
/// down to the refs that make a branch "already merged": the branch itself,
/// its remote counterparts (`<remote>/<branch>`), and symbolic `*/HEAD`
/// entries are excluded — they contain the tip trivially.
fn filter_containing_refs(stdout: &str, branch: &str) -> Vec<String> {
    stdout
        .lines()
        .map(str::trim)
        .filter(|r| {
            !r.is_empty()
                && *r != branch
                && !r.ends_with(&format!("/{branch}"))
                && !r.ends_with("/HEAD")
        })
        .map(str::to_string)
        .collect()
}

/// Whether `git cherry <baseline> <branch>` output says every commit unique
/// to the branch has a patch-id equivalent in the baseline (all lines `-`,
/// at least one line): the squash/rebase-merge signature.
fn cherry_all_equivalent(stdout: &str) -> bool {
    let mut any = false;
    for line in stdout.lines().map(str::trim).filter(|l| !l.is_empty()) {
        if !line.starts_with('-') {
            return false;
        }
        any = true;
    }
    any
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
    // Positional ref: `--end-of-options` keeps a dash-leading name from being
    // parsed as a flag (see `safe_ref`).
    args.push("--end-of-options".into());
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
/// `--end-of-options` is load-bearing here, not cosmetic: `git rebase` has
/// `--exec=<cmd>`, so a dash-leading `onto` is arbitrary command execution
/// (see `safe_ref`).
fn rebase_args(onto: &str) -> Vec<String> {
    vec![
        "rebase".into(),
        "--autostash".into(),
        "--end-of-options".into(),
        onto.into(),
    ]
}

/// cherry-pick / revert argument list: the base command, `-m <N>` when a
/// mainline parent is given (merge commits), then the shas in the given
/// order (git's sequencer applies them left to right). Each sha passes the
/// `safe_ref` dash guard even behind `--end-of-options` - belt and braces,
/// and a clearer message than git's.
fn sequencer_args(base: &[&str], mainline: Option<u32>, shas: &[String]) -> Result<Vec<String>, GitError> {
    let mut args: Vec<String> = base.iter().map(|s| s.to_string()).collect();
    if let Some(n) = mainline {
        args.push("-m".into());
        args.push(n.to_string());
    }
    args.push("--end-of-options".into());
    for sha in shas {
        args.push(safe_ref_owned("revision", sha)?);
    }
    Ok(args)
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

/// Classify the local `merge --ff-only <remote-ref>` step of
/// `checkout_remote_branch`. Exit 0 leaves only two possibilities (a merge
/// commit cannot happen under `--ff-only`): already up to date, or a
/// fast-forward. The divergence refusal is an OUTCOME (`Diverged`) - the
/// checkout it follows already succeeded - and any other failure carries
/// git's own message (`Failed`), never an `Err`. Validated against the real
/// binary in `tests/git_flows.rs`.
fn classify_fast_forward(exit_code: i32, stdout: &str, stderr: &str) -> FastForwardResult {
    if exit_code == 0 {
        if stdout.to_lowercase().contains("already up to date") {
            return FastForwardResult::UpToDate;
        }
        return FastForwardResult::FastForwarded;
    }
    if stderr.to_lowercase().contains("not possible to fast-forward") {
        return FastForwardResult::Diverged;
    }
    FastForwardResult::Failed {
        message: compose_output(stdout, stderr),
    }
}

/// Split `git rebase`'s exit codes the same way. On exit 0 the autostash may
/// still have conflicted; the rebase itself succeeded, so that is a distinct
/// success-flavored outcome. Git reworded that message in 2.55 (sequencer.c):
/// up to 2.54 it prints "Applying autostash resulted in conflicts.", from
/// 2.55 "Your local changes are stashed, however applying them\nresulted in
/// conflicts. ..." - both wordings must classify as the stash-conflict
/// outcome (missing one silently reports Completed while the working tree
/// holds conflict markers; caught by CI's newer git 2026-08-21).
fn classify_rebase_output(
    exit_code: i32,
    stdout: &str,
    stderr: &str,
) -> Result<RebaseOutcome, GitError> {
    let out_lc = stdout.to_lowercase();
    let err_lc = stderr.to_lowercase();
    let has = |needle: &str| out_lc.contains(needle) || err_lc.contains(needle);
    let stash_conflict = has("applying autostash resulted in conflicts")
        || has("your local changes are stashed, however applying them");
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
    // "conflict (" is the merge machinery's `CONFLICT (...)` marker, not a
    // bare token: a bare match would misfire on pathnames (e.g. a blocking
    // `conflicts.md` in a would-be-overwritten file list) - same lesson as
    // `stash_apply_left_conflicts`.
    if err_lc.contains("could not apply")
        || out_lc.contains("conflict (")
        || err_lc.contains("conflict (")
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

/// Plan-validity rules, checked BEFORE anything runs (also mirrored for UX
/// by `planError` in `planModel.ts` - keep in sync):
/// - non-empty; not everything dropped;
/// - the first kept step must be a pick OR reword (squash/fixup meld into
///   a predecessor that would not exist);
/// - shas are plain hex (the todo is interpolated into a single-quoted,
///   shell-interpreted editor string, so anything else is rejected
///   outright rather than escaped);
/// - reword steps carry a non-blank message, non-reword steps carry none.
fn validate_rebase_plan(plan: &[RebaseStep]) -> Result<(), GitError> {
    if plan.is_empty() {
        return Err(GitError::Internal("interactive rebase plan is empty".into()));
    }
    let mut first_kept = true;
    for step in plan {
        let sha = step.sha.as_str();
        if sha.is_empty() || !sha.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(GitError::Internal(format!(
                "interactive rebase plan contains a non-hex sha: {sha:?}"
            )));
        }
        if matches!(step.action, RebaseAction::Squash | RebaseAction::Fixup) && first_kept {
            return Err(GitError::Internal(
                "interactive rebase plan starts with squash/fixup (nothing to meld into)".into(),
            ));
        }
        if step.action != RebaseAction::Drop {
            first_kept = false;
        }
        match (step.action, &step.message) {
            (RebaseAction::Reword, Some(m)) if !m.trim().is_empty() => {}
            (RebaseAction::Reword, _) => {
                return Err(GitError::Internal(
                    "a reword step needs a non-empty message".into(),
                ));
            }
            (_, Some(_)) => {
                return Err(GitError::Internal(
                    "only reword steps may carry a message".into(),
                ));
            }
            (_, None) => {}
        }
    }
    if first_kept {
        return Err(GitError::Internal(
            "interactive rebase plan drops every commit".into(),
        ));
    }
    Ok(())
}

/// Build the printf format string for the injected todo (`\n` separated as
/// printf escapes). Assumes `validate_rebase_plan` passed; `carriers` maps
/// each reword step's sha to its message-carrier commit (created by
/// `rebase_interactive`). A reword emits `pick <sha>` + `fixup -C <carrier>`
/// - fixup -C takes message AND author from the carrier without opening an
/// editor (git >= 2.32).
fn build_rebase_todo(
    plan: &[RebaseStep],
    carriers: &HashMap<String, String>,
) -> Result<String, GitError> {
    let mut todo = String::new();
    for step in plan {
        let sha = step.sha.as_str();
        todo.push_str(step.action.keyword());
        todo.push(' ');
        todo.push_str(sha);
        todo.push_str("\\n");
        if step.action == RebaseAction::Reword {
            let carrier = carriers.get(sha).ok_or_else(|| {
                GitError::Internal(format!("no message carrier for reword {sha}"))
            })?;
            if carrier.is_empty() || !carrier.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Err(GitError::Internal(format!(
                    "carrier commit id is not hex: {carrier:?}"
                )));
            }
            todo.push_str("fixup -C ");
            todo.push_str(carrier);
            todo.push_str("\\n");
        }
    }
    Ok(todo)
}

/// Parse `git log -1 --format=%an%x00%ae%x00%aD` output into
/// (name, email, date). NUL-separated: names/emails may contain anything
/// printable, dates contain spaces.
fn parse_author_fields(s: &str) -> Option<(String, String, String)> {
    let mut it = s.trim_end_matches('\n').splitn(3, '\0');
    match (it.next(), it.next(), it.next()) {
        (Some(n), Some(e), Some(d)) if !n.is_empty() && !d.is_empty() => {
            Some((n.to_string(), e.to_string(), d.to_string()))
        }
        _ => None,
    }
}

/// Check an interactive-rebase plan against `git rev-list --parents
/// base..HEAD` output before the todo is injected. The injected todo fully
/// replaces git's generated one and missing lines mean silently DROPPED
/// commits, so the plan's sha set must equal the range's sha set exactly:
/// a truncated plan (UI listing cap) or a stale one (a commit landed after
/// the plan was built) is refused instead of losing history. Merge commits
/// are refused too - `pick <merge>` stops the rebase mid-flight with "is a
/// merge but no -m option was given" and plain continue re-hits it.
fn verify_plan_covers_range(plan: &[RebaseStep], rev_list_parents: &str) -> Result<(), GitError> {
    let mut range: HashSet<&str> = HashSet::new();
    for line in rev_list_parents.lines() {
        let mut fields = line.split_whitespace();
        let Some(sha) = fields.next() else { continue };
        if fields.count() > 1 {
            return Err(GitError::Internal(format!(
                "the range contains a merge commit ({}); interactive rebase across merges is not supported",
                &sha[..sha.len().min(8)]
            )));
        }
        range.insert(sha);
    }
    let planned: HashSet<&str> = plan.iter().map(|s| s.sha.as_str()).collect();
    if planned != range || plan.len() != range.len() {
        return Err(GitError::Internal(
            "the plan no longer matches the commits after the base (the repository changed since \
             the plan was built); reload the plan and try again"
                .into(),
        ));
    }
    Ok(())
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
    // "conflict (" instead of a bare token for the same pathname-misfire
    // reason as classify_rebase_output / stash_apply_left_conflicts.
    if err_lc.contains("could not apply")
        || err_lc.contains("could not revert")
        || out_lc.contains("conflict (")
        || err_lc.contains("conflict (")
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
/// What a git-lfs download failure in some operation's stderr amounts to.
/// Produced by `parse_lfs_download_failure`; pure data.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LfsDownloadFailure {
    /// Worktree paths whose LFS content could not be downloaded.
    pub files: Vec<String>,
    /// The cause is "object absent on the server" (missing upload), not a
    /// network/auth problem.
    pub missing_on_remote: bool,
}

/// Detect a git-lfs smudge/download failure in an operation's stderr and
/// extract the affected paths. Matches the two stable line shapes git-lfs
/// emits (validated against the real binary):
/// `Error downloading object: <path> (<short-oid>): ...` (also present when
/// the operation still exits 0, e.g. under `lfs.skipdownloaderrors`) and
/// `fatal: <path>: smudge filter lfs failed` (the loud, non-zero case).
/// Returns `None` when the stderr shows no LFS involvement.
pub(crate) fn parse_lfs_download_failure(stderr: &str) -> Option<LfsDownloadFailure> {
    let mut files: Vec<String> = Vec::new();
    let mut push = |f: &str| {
        let f = f.trim();
        if !f.is_empty() && !files.iter().any(|k| k == f) {
            files.push(f.to_string());
        }
    };
    let mut involved = false;
    for line in stderr.lines().map(str::trim) {
        if let Some(rest) = line.strip_prefix("Error downloading object: ") {
            involved = true;
            push(rest.split(" (").next().unwrap_or(""));
        } else if let Some(prefix) = line.strip_suffix(": smudge filter lfs failed") {
            involved = true;
            push(prefix.strip_prefix("fatal: ").unwrap_or(prefix));
        }
    }
    if !involved {
        return None;
    }
    let lc = stderr.to_lowercase();
    let missing_on_remote = lc.contains("remote missing object")
        || lc.contains("does not exist on the server")
        || lc.contains("[404]");
    Some(LfsDownloadFailure { files, missing_on_remote })
}

/// The `LfsStubs` an exit-0 operation left behind, from its stderr; `None`
/// when the stderr shows no LFS involvement. Public for the command layer's
/// own git invocations (clone runs outside `GitBackend`).
pub fn lfs_stubs_from_stderr(stderr: &str) -> Option<LfsStubs> {
    parse_lfs_download_failure(stderr).map(|f| LfsStubs {
        files: f.files,
        missing_on_remote: f.missing_on_remote,
    })
}

pub fn classify_remote_error(exit_code: i32, stderr: &str) -> GitError {
    // Remote errors are the ones that quote the URL back at us ("fatal:
    // Authentication failed for 'https://user:token@host/r.git/'"), and this
    // text is what the toast and the panels show - so it is redacted here,
    // the single place remote failures become a `GitError`.
    let stderr = &crate::runner::redact_url_credentials(stderr);
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
    // An LFS smudge/download failure inside the operation (pull's merge
    // phase, clone's checkout, submodule update). After AUTH: a broken
    // credential setup stays an auth problem even when LFS reports it.
    if let Some(f) = parse_lfs_download_failure(stderr) {
        return GitError::LfsDownloadFailed {
            files: f.files,
            missing_on_remote: f.missing_on_remote,
            stderr: stderr.trim().to_string(),
        };
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
    fn sequence_overwrite_with_conflictish_pathname_is_not_conflicts() {
        // The dirty-tree refusal lists the blocking paths; a path containing
        // the word "conflict" must not steal the classification from
        // WouldOverwriteLocalChanges (pre-fix: bare token match misfired).
        let r = classify_sequence_output(
            1,
            "",
            "error: Your local changes to the following files would be overwritten by merge:\n\
             \tdocs/conflicts.md\n\
             Please commit your changes or stash them before you merge.\n\
             Aborting\n",
        );
        assert!(matches!(r, Err(GitError::WouldOverwriteLocalChanges(_))), "{r:?}");
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
            RebaseStep::new(RebaseAction::Pick, "aaa111"),
            RebaseStep::new(RebaseAction::Squash, "bbb222"),
            RebaseStep::new(RebaseAction::Fixup, "ccc333"),
            RebaseStep::new(RebaseAction::Drop, "ddd444"),
        ];
        let todo = build_rebase_todo(&plan, &HashMap::new()).unwrap();
        // LITERAL backslash-n separators, not newlines: the todo is injected
        // through `GIT_SEQUENCE_EDITOR="printf '%s' ... >"`-style shell
        // expansion, where printf expands the \n escapes into real newlines.
        assert_eq!(todo, r"pick aaa111\nsquash bbb222\nfixup ccc333\ndrop ddd444\n");
    }

    #[test]
    fn build_rebase_todo_expands_rewords() {
        let carriers = HashMap::from([("bbb222".to_string(), "ccc333".to_string())]);
        let todo = build_rebase_todo(
            &[
                RebaseStep::new(RebaseAction::Pick, "aaa111"),
                RebaseStep::reword("bbb222", "new message"),
            ],
            &carriers,
        )
        .expect("todo");
        assert_eq!(todo, r"pick aaa111\npick bbb222\nfixup -C ccc333\n");
        // A reword without its carrier is a programmer error, not a git run.
        assert!(build_rebase_todo(&[RebaseStep::reword("bbb222", "m")], &HashMap::new()).is_err());
        // A non-hex carrier must never reach the shell-interpolated todo.
        let bad = HashMap::from([("bbb222".to_string(), "evil'".to_string())]);
        assert!(build_rebase_todo(&[RebaseStep::reword("bbb222", "m")], &bad).is_err());
    }

    #[test]
    fn validate_rebase_plan_rules() {
        assert!(validate_rebase_plan(&[]).is_err(), "empty plan");
        assert!(
            validate_rebase_plan(&[RebaseStep::new(RebaseAction::Squash, "aaa111")]).is_err(),
            "leading squash has nothing to meld into"
        );
        // A leading DROP does not count as the first kept step.
        assert!(
            validate_rebase_plan(&[
                RebaseStep::new(RebaseAction::Drop, "aaa111"),
                RebaseStep::new(RebaseAction::Fixup, "bbb222"),
            ])
            .is_err(),
            "fixup after only drops still has nothing to meld into"
        );
        assert!(
            validate_rebase_plan(&[RebaseStep::new(RebaseAction::Pick, "not-hex!")]).is_err(),
            "non-hex sha must be rejected (it would be injected into the todo file)"
        );
        assert!(
            validate_rebase_plan(&[RebaseStep::new(RebaseAction::Drop, "aaa111")]).is_err(),
            "all-dropped plan"
        );
        // Reword counts as a kept first step.
        assert!(validate_rebase_plan(&[RebaseStep::reword("aaa111", "msg")]).is_ok());
        // Blank / missing reword message refused.
        assert!(validate_rebase_plan(&[RebaseStep::reword("aaa111", "  \n")]).is_err());
        let mut no_msg = RebaseStep::new(RebaseAction::Reword, "aaa111");
        no_msg.message = None;
        assert!(validate_rebase_plan(&[no_msg]).is_err());
        // A message on a non-reword step would silently do nothing: refused.
        let mut pick_msg = RebaseStep::new(RebaseAction::Pick, "aaa111");
        pick_msg.message = Some("m".into());
        assert!(validate_rebase_plan(&[pick_msg]).is_err());
    }

    #[test]
    fn parses_author_fields() {
        assert_eq!(
            parse_author_fields("Ada\0ada@example.com\0Mon, 1 Jan 2024 10:00:00 +0100\n"),
            Some((
                "Ada".into(),
                "ada@example.com".into(),
                "Mon, 1 Jan 2024 10:00:00 +0100".into()
            ))
        );
        assert_eq!(parse_author_fields("no separators"), None);
    }

    // --- interactive rebase plan-vs-range guard -------------------------------

    #[test]
    fn rebase_plan_must_cover_the_range_exactly() {
        let plan = vec![
            RebaseStep::new(RebaseAction::Pick, "aaa111"),
            RebaseStep::new(RebaseAction::Drop, "bbb222"),
        ];
        // Exact set match (rev-list order is irrelevant; each line is
        // "<sha> <parent>").
        let listed = "bbb222 aaa111\naaa111 base00\n";
        assert!(verify_plan_covers_range(&plan, listed).is_ok());

        // A range commit missing from the plan would be SILENTLY DROPPED by
        // git (missing todo lines are drops) - refuse. This is the truncated
        // or stale-plan case (regression test for the data-loss scenario).
        let listed = "ccc333 bbb222\nbbb222 aaa111\naaa111 base00\n";
        assert!(verify_plan_covers_range(&plan, listed).is_err(), "missing range commit");

        // A plan sha outside the range is equally refused.
        let listed = "aaa111 base00\n";
        assert!(verify_plan_covers_range(&plan, listed).is_err(), "foreign plan sha");

        // A merge commit in the range (two parents on the rev-list line)
        // cannot be picked ("is a merge but no -m option was given").
        let plan = vec![
            RebaseStep::new(RebaseAction::Pick, "aaa111"),
            RebaseStep::new(RebaseAction::Pick, "eee555"),
        ];
        let listed = "eee555 aaa111 fff666\naaa111 base00\n";
        assert!(verify_plan_covers_range(&plan, listed).is_err(), "merge commit in range");

        // Duplicate plan entries can never satisfy the set+length check.
        let plan = vec![
            RebaseStep::new(RebaseAction::Pick, "aaa111"),
            RebaseStep::new(RebaseAction::Pick, "aaa111"),
        ];
        let listed = "bbb222 aaa111\naaa111 base00\n";
        assert!(verify_plan_covers_range(&plan, listed).is_err(), "duplicate plan sha");
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

    // --- repo-wide file classification (Files tree) -------------------------

    fn entry(path: &str, kind: RepoFileKind) -> RepoFileEntry {
        RepoFileEntry { path: PathBuf::from(path), kind, submodule: false }
    }

    fn sub_entry(path: &str, kind: RepoFileKind) -> RepoFileEntry {
        RepoFileEntry { path: PathBuf::from(path), kind, submodule: true }
    }

    /// One `ls-files --stage` record for a regular blob.
    fn stage(path: &str) -> String {
        format!("100644 aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111 0\t{path}\0")
    }

    #[test]
    fn classify_repo_files_marks_gitlinks_as_submodules() {
        // Mode 160000 in the --stage record = gitlink (submodule pointer).
        let cached = format!(
            "{}160000 bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222 0\tsubs/attach-configured\0",
            stage("a.txt"),
        );
        assert_eq!(
            classify_repo_files(&cached, "", ""),
            vec![
                entry("a.txt", RepoFileKind::Tracked),
                sub_entry("subs/attach-configured", RepoFileKind::Tracked),
            ]
        );
    }

    #[test]
    fn classify_repo_files_trims_nested_repo_trailing_slash() {
        // `ls-files --others` reports an untracked nested git repo as `dir/`;
        // the raw form would render as a folder with an empty-named child in
        // the Files tree. The trim is kept as the submodule flag, and a
        // tracked gitlink of the same path wins the dedup.
        assert_eq!(
            classify_repo_files("", "subs/dort/\0", ""),
            vec![sub_entry("subs/dort", RepoFileKind::Untracked)]
        );
        assert_eq!(
            classify_repo_files(
                "160000 bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222 0\tsubs/dort\0",
                "subs/dort/\0",
                ""
            ),
            vec![sub_entry("subs/dort", RepoFileKind::Tracked)]
        );
    }

    #[test]
    fn classify_repo_files_tags_each_class() {
        let cached = format!("{}{}", stage("src/main.rs"), stage("README.md"));
        let others = "notes.txt\0";
        let ignored = "target/debug\0";
        assert_eq!(
            classify_repo_files(&cached, others, ignored),
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
        let cached = stage("a.txt");
        let others = "b.txt\0";
        assert_eq!(
            classify_repo_files(&cached, others, ""),
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
        let cached = format!("{}\0", stage("dup.txt"));
        let others = "dup.txt\0";
        assert_eq!(
            classify_repo_files(&cached, others, ""),
            vec![entry("dup.txt", RepoFileKind::Tracked)]
        );
    }

    #[test]
    fn parse_ls_tree_files_types_and_resorts() {
        // PathBuf ordering is component-wise: the directory component "a"
        // sorts before the file "a.txt", matching classify_repo_files' sort.
        // Type `commit` = gitlink (submodule).
        let out = "100644 blob aaaa1111\ta.txt\0\
                   100644 blob aaaa1111\ta/b.txt\0\
                   160000 commit bbbb2222\tsubs/dort\0";
        assert_eq!(
            parse_ls_tree_files(out),
            vec![
                entry("a/b.txt", RepoFileKind::Tracked),
                entry("a.txt", RepoFileKind::Tracked),
                sub_entry("subs/dort", RepoFileKind::Tracked),
            ]
        );
        assert_eq!(parse_ls_tree_files(""), vec![]);
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
            has_signature: false,
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
    fn branch_delete_not_fully_merged_is_classified() {
        let stderr = "error: The branch 'feature' is not fully merged.\nhint: If you are sure you want to delete it, run 'git branch -D feature'.\n";
        match classify_branch_delete_error(1, stderr, "feature") {
            GitError::BranchNotFullyMerged { branch, stderr: s } => {
                assert_eq!(branch, "feature");
                assert!(s.contains("not fully merged"));
            }
            other => panic!("expected BranchNotFullyMerged, got {other:?}"),
        }
    }

    #[test]
    fn branch_delete_other_failure_is_command_failed() {
        let stderr = "error: branch 'nope' not found.";
        assert!(matches!(
            classify_branch_delete_error(1, stderr, "nope"),
            GitError::CommandFailed { exit_code: 1, .. }
        ));
    }

    #[test]
    fn containing_refs_exclude_self_remote_counterparts_and_head() {
        let stdout = "feature\nmain\norigin/feature\norigin/HEAD\norigin/main\n";
        assert_eq!(
            filter_containing_refs(stdout, "feature"),
            vec!["main".to_string(), "origin/main".to_string()]
        );
    }

    #[test]
    fn containing_refs_empty_when_only_self_contains() {
        assert!(filter_containing_refs("feature\norigin/feature\n", "feature").is_empty());
    }

    #[test]
    fn cherry_all_equivalent_requires_nonempty_all_minus() {
        assert!(cherry_all_equivalent("- 7a5e5f\n- 9b2c1d\n"));
        assert!(!cherry_all_equivalent("+ 7a5e5f\n- 9b2c1d\n"));
        assert!(!cherry_all_equivalent(""));
    }

    // --- LFS download-failure detection ---------------------------------
    // Stderr shapes captured from real git-lfs 3.7.1 (file:// standalone
    // transfer); the [404] variant mirrors the HTTPS wording.

    const LFS_LOUD_PULL_STDERR: &str = "\
 * branch            main       -> FETCH_HEAD
Downloading big.bin (2.0 KB)
Error downloading object: big.bin (8f786a0): Smudge error: Error downloading big.bin (8f786a0717ae6c4d70b78d003300b3d340fe84fb131c5be1ef028d0fdcbe7f6d): error transferring \"8f786a0717ae6c4d70b78d003300b3d340fe84fb131c5be1ef028d0fdcbe7f6d\": [0] remote missing object 8f786a0717ae6c4d70b78d003300b3d340fe84fb131c5be1ef028d0fdcbe7f6d

Errors logged to 'C:\\repo\\.git\\lfs\\logs\\20260901T161311.log'.
Use `git lfs logs last` to view the log.
error: external filter 'git-lfs filter-process' failed
fatal: big.bin: smudge filter lfs failed
";

    #[test]
    fn lfs_failure_parses_files_and_missing_cause() {
        let f = parse_lfs_download_failure(LFS_LOUD_PULL_STDERR).unwrap();
        assert_eq!(f.files, vec!["big.bin".to_string()]);
        assert!(f.missing_on_remote);
    }

    #[test]
    fn lfs_failure_exit_zero_shape_has_no_fatal_line() {
        // Under lfs.skipdownloaderrors the operation exits 0 and only the
        // "Error downloading object" lines appear.
        let stderr = "Downloading big.bin (2.0 KB)\n\
Error downloading object: big.bin (8f786a0): Smudge error: [404] Object does not exist on the server: https://host/info/lfs\n\
Errors logged to '/r/.git/lfs/logs/x.log'.\n";
        let f = parse_lfs_download_failure(stderr).unwrap();
        assert_eq!(f.files, vec!["big.bin".to_string()]);
        assert!(f.missing_on_remote);
    }

    #[test]
    fn lfs_failure_dedupes_files_and_flags_non_missing_causes() {
        let stderr = "\
Error downloading object: a.bin (1111111): Smudge error: [401] Authentication required\n\
Error downloading object: b.bin (2222222): Smudge error: connection refused\n\
fatal: a.bin: smudge filter lfs failed\n";
        let f = parse_lfs_download_failure(stderr).unwrap();
        assert_eq!(f.files, vec!["a.bin".to_string(), "b.bin".to_string()]);
        assert!(!f.missing_on_remote);
    }

    #[test]
    fn lfs_failure_none_for_unrelated_stderr() {
        assert_eq!(parse_lfs_download_failure("fatal: repository not found\n"), None);
        assert_eq!(parse_lfs_download_failure(""), None);
    }

    #[test]
    fn remote_error_lfs_failure_is_classified() {
        match classify_remote_error(128, LFS_LOUD_PULL_STDERR) {
            GitError::LfsDownloadFailed { files, missing_on_remote, .. } => {
                assert_eq!(files, vec!["big.bin".to_string()]);
                assert!(missing_on_remote);
            }
            other => panic!("expected LfsDownloadFailed, got {other:?}"),
        }
    }

    #[test]
    fn switch_error_lfs_failure_is_classified() {
        let stderr = "\
Error downloading object: feat.bin (d686331): Smudge error: [404] Object does not exist on the server\n\
error: external filter 'git-lfs filter-process' failed\n\
fatal: feat.bin: smudge filter lfs failed\n";
        match classify_switch_error(128, stderr) {
            GitError::LfsDownloadFailed { files, missing_on_remote, .. } => {
                assert_eq!(files, vec!["feat.bin".to_string()]);
                assert!(missing_on_remote);
            }
            other => panic!("expected LfsDownloadFailed, got {other:?}"),
        }
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
        assert!(build_push_args(&opts).unwrap().contains(&"--recurse-submodules=check".to_string()));
        opts.recurse_submodules = Some(PushRecurseMode::OnDemand);
        assert!(build_push_args(&opts).unwrap().contains(&"--recurse-submodules=on-demand".to_string()));
        opts.recurse_submodules = None;
        assert!(!build_push_args(&opts)
            .unwrap()
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

    // The refspec is the full `refs/heads/<name>`: a bare name is ambiguous
    // the moment a tag shares it ("src refspec matches more than one").
    #[test]
    fn push_args_plain() {
        assert_eq!(
            build_push_args(&push_opts(false, false)).unwrap(),
            vec!["push", "--progress", "origin", "refs/heads/main"]
        );
    }

    #[test]
    fn push_args_set_upstream() {
        assert_eq!(
            build_push_args(&push_opts(true, false)).unwrap(),
            vec!["push", "--progress", "--set-upstream", "origin", "refs/heads/main"]
        );
    }

    #[test]
    fn push_args_force_with_lease_then_upstream() {
        assert_eq!(
            build_push_args(&push_opts(true, true)).unwrap(),
            vec!["push", "--progress", "--force-with-lease", "--set-upstream", "origin", "refs/heads/main"]
        );
    }

    #[test]
    fn classify_auth_failure() {
        let e = classify_remote_error(128, "fatal: Authentication failed for 'https://x/y'");
        assert!(matches!(e, GitError::AuthFailed(_)));
    }

    /// git quotes the failing URL back at us, credentials included, and that
    /// text becomes the error the UI shows. The token must not survive the
    /// classification.
    #[test]
    fn classify_auth_failure_redacts_the_url_credentials() {
        let e = classify_remote_error(
            128,
            "fatal: Authentication failed for 'https://simon:ghp_SECRET@github.com/o/r.git/'",
        );
        let GitError::AuthFailed(msg) = e else {
            panic!("expected AuthFailed, got {e:?}")
        };
        assert!(!msg.contains("ghp_SECRET"), "secret survived: {msg}");
        assert!(msg.contains("simon:***@github.com"), "{msg}");
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
        assert_eq!(
            build_tag_args("v1", None, None),
            vec!["tag", "--end-of-options", "v1"]
        );
    }

    #[test]
    fn tag_args_blank_message_stays_lightweight() {
        // The UI sends the annotation input verbatim; whitespace-only must not
        // create an annotated tag with an empty message.
        assert_eq!(
            build_tag_args("v1", None, Some("   ")),
            vec!["tag", "--end-of-options", "v1"]
        );
    }

    #[test]
    fn tag_args_annotated_with_target() {
        assert_eq!(
            build_tag_args("v1", Some("abc123"), Some("release")),
            vec!["tag", "-a", "-m", "release", "--end-of-options", "v1", "abc123"]
        );
    }

    #[test]
    fn tag_args_lightweight_with_target() {
        assert_eq!(
            build_tag_args("v1", Some("abc123"), None),
            vec!["tag", "--end-of-options", "v1", "abc123"]
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
            build_fetch_args(&FetchOptions { all: false, prune: false, remote: None }).unwrap(),
            with_no_maint(&["fetch", "--progress"])
        );
        assert_eq!(
            build_fetch_args(&FetchOptions {
                all: false,
                prune: true,
                remote: Some("origin".into())
            })
            .unwrap(),
            with_no_maint(&["fetch", "--progress", "--prune", "origin"])
        );
        // --all wins over a named remote; empty remote name means default.
        assert_eq!(
            build_fetch_args(&FetchOptions {
                all: true,
                prune: false,
                remote: Some("origin".into())
            })
            .unwrap(),
            with_no_maint(&["fetch", "--progress", "--all"])
        );
        assert_eq!(
            build_fetch_args(&FetchOptions { all: false, prune: false, remote: Some("".into()) }).unwrap(),
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
        assert_eq!(args, vec!["merge", "--squash", "--end-of-options", "dev"]);
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
        assert_eq!(
            rebase_args("main"),
            vec!["rebase", "--autostash", "--end-of-options", "main"]
        );
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

    // --- fast-forward step classification (checkout_remote_branch) ---

    #[test]
    fn fast_forward_success_without_up_to_date_marker_is_fast_forwarded() {
        // `--ff-only` exit 0 leaves only two possibilities: already up to
        // date, or an actual fast-forward - no merge commit can happen.
        let r = classify_fast_forward(
            0,
            "Updating abc123..def456\nFast-forward\n a.txt | 1 +\n",
            "",
        );
        assert_eq!(r, FastForwardResult::FastForwarded);
    }

    #[test]
    fn fast_forward_already_up_to_date_is_up_to_date() {
        let r = classify_fast_forward(0, "Already up to date.\n", "");
        assert_eq!(r, FastForwardResult::UpToDate);
    }

    #[test]
    fn fast_forward_refusal_is_diverged() {
        let r = classify_fast_forward(128, "", "fatal: Not possible to fast-forward, aborting.\n");
        assert_eq!(r, FastForwardResult::Diverged);
    }

    #[test]
    fn fast_forward_other_failure_carries_gits_message() {
        let r = classify_fast_forward(
            1,
            "",
            "error: Your local changes to the following files would be overwritten by merge:\n\ta.txt\n",
        );
        match r {
            FastForwardResult::Failed { message } => {
                assert!(message.contains("would be overwritten"), "{message}");
            }
            other => panic!("expected Failed, got {other:?}"),
        }
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
    fn rebase_overwrite_with_conflictish_pathname_is_not_conflicts() {
        // Same misfire class as the sequencer sibling: a blocking path named
        // "conflicts.md" in the refusal's file list must not classify as the
        // Conflicts outcome ("resolve, then continue" - nothing is running).
        let r = classify_rebase_output(
            1,
            "",
            "error: The following untracked working tree files would be overwritten by checkout:\n\
             \tdocs/conflicts.md\n\
             Please move or remove them before you switch branches.\n\
             Aborting\n",
        );
        assert!(matches!(r, Err(GitError::WouldOverwriteLocalChanges(_))), "{r:?}");
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
        // git >= 2.55 reworded the autostash-conflict message and prints it
        // on stderr (sequencer.c). Regression: the old wording alone was
        // matched, so new gits reported Completed with conflict markers in
        // the tree (CI failure 2026-08-21).
        assert!(matches!(
            classify_rebase_output(
                0,
                "",
                "Successfully rebased and updated refs/heads/feature.\n\
                 Your local changes are stashed, however applying them\n\
                 resulted in conflicts.  You can either resolve the conflicts\n\
                 and then discard the stash with \"git stash drop\", or, if you\n\
                 do not want to resolve them now, run \"git reset --hard\" and\n\
                 apply the local changes later by running \"git stash pop\".\n"
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
