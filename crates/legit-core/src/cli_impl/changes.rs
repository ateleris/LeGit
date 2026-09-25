//! Working changes and file content: status, staging, discard, diffs, hunk/line apply, renormalize, files at a revision.

use super::*;

impl<E: GitExecutor + ?Sized> GitCliBackend<E> {
    pub(super) async fn status(&self) -> Result<Vec<FileStatus>, GitError> {
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

    pub(super) async fn list_repo_files(
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

    pub(super) async fn list_files_at_revision(&self, rev: &str) -> Result<Vec<RepoFileEntry>, GitError> {
        let runner = self.runner().await;
        // Full ls-tree records (not --name-only): the object type is the only
        // way to tell a gitlink (`commit`) from a blob at a revision.
        let output = runner
            .run(&["ls-tree", "-r", "-z", "--end-of-options", safe_ref("revision", rev)?])
            .await?;
        Self::ensure_success(&output)?;
        Ok(parse_ls_tree_files(&output.stdout))
    }

    pub(super) async fn rm_cached(&self, paths: &[PathBuf]) -> Result<(), GitError> {
        self.run_pathspec(&["rm", "--cached", "--"], paths).await
    }

    pub(super) async fn diff_files(&self, from: &str, to: &str) -> Result<Vec<CommitFileChange>, GitError> {
        let raw = self.diff_tree(from, to, "--raw").await?;
        let numstat = self.diff_tree(from, to, "--numstat").await?;
        Ok(parsers::commit_files::parse_commit_files(&raw, &numstat))
    }

    pub(super) async fn file_diff(
        &self,
        source: &DiffSource,
        path: &Path,
        old_path: Option<&Path>,
        context: u32,
    ) -> Result<DiffEntry, GitError> {
        let raw = self.run_diff_text(source, path, old_path, context).await?;
        // Cap what reaches the webview: rendering a multi-MB diff moves
        // several copies of the content through IPC, JSON and the editor
        // (which crashed WebView2 with renderer OOM on minified multi-MB
        // SVGs - single giant lines are the worst case). Applies to every
        // source, the untracked `--no-index` fallback included.
        if raw.len() > MAX_DIFF_TEXT_BYTES {
            return Ok(DiffEntry::TooLarge { bytes: raw.len() as u64 });
        }
        // An untracked nested repo yields an empty diff (`git diff` ignores
        // untracked paths and `--no-index` refuses directories), which would
        // read as "no changes". Present what staging would record instead: a
        // submodule add at the nested repo's HEAD. A rename request is exempt:
        // its empty diff means "pure rename", never an untracked repo.
        if raw.trim().is_empty()
            && old_path.is_none()
            && matches!(source, DiffSource::WorkingUnstaged)
        {
            if let Some(sub) = self.untracked_repo_dir_change(path).await? {
                return Ok(DiffEntry::Submodule(sub));
            }
        }
        Ok(parsers::diff::parse_file_diff(&raw))
    }

    pub(super) async fn apply_hunk(
        &self,
        path: &Path,
        hunk_index: usize,
        op: HunkOp,
    ) -> Result<(), GitError> {
        // Always 3 lines of context - the panel's whole-file view doesn't change
        // which hunk an index refers to.
        let raw = self
            .run_diff_text(&Self::source_for_op(op), path, None, 3)
            .await?;
        let patch = parsers::diff::build_hunk_patch(&raw, hunk_index).ok_or_else(|| {
            GitError::Internal(format!("no hunk at index {hunk_index} for {}", path.display()))
        })?;
        self.apply_op_patch(op, &patch).await
    }

    pub(super) async fn apply_lines(
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

    pub(super) async fn stage(&self, paths: &[PathBuf]) -> Result<(), GitError> {
        if paths.is_empty() {
            return Ok(());
        }
        self.run_pathspec(&["add", "--"], paths).await
    }

    pub(super) async fn unstage(&self, paths: &[PathBuf]) -> Result<(), GitError> {
        if paths.is_empty() {
            return Ok(());
        }
        self.run_pathspec(&["restore", "--staged", "--"], paths).await
    }

    pub(super) async fn renormalize_preview(&self) -> Result<Vec<String>, GitError> {
        // Simulate on a throwaway index (see parsers::renormalize): snapshot
        // the real index as a tree, rebuild it under GIT_INDEX_FILE, run the
        // renormalize there, and diff against the snapshot. The real index
        // is never touched; the temp file is cleaned up by the caller.
        let runner = self.runner().await;

        let out = runner.run(&["write-tree"]).await?;
        Self::ensure_success(&out)?;
        let tree = out.stdout.trim().to_string();

        let out = runner
            .run(&["rev-parse", "--path-format=absolute", "--git-path", "index"])
            .await?;
        Self::ensure_success(&out)?;
        let temp_index = format!(
            "{}{}",
            out.stdout.trim(),
            parsers::renormalize::RENORMALIZE_PREVIEW_INDEX_SUFFIX
        );
        // A preview killed mid-run leaves the temp index and its `.lock`
        // behind, and a stale lock fails every later preview.
        self.remove_preview_index(&temp_index).await;
        let result = self.renormalize_preview_on(&tree, &temp_index).await;
        self.remove_preview_index(&temp_index).await;
        result
    }

    async fn remove_preview_index(&self, temp_index: &str) {
        let lock = HostPath(format!("{temp_index}.lock"));
        let _ = self.fs.remove_file(&lock).await;
        let _ = self.fs.remove_file(&HostPath(temp_index.to_string())).await;
    }

    async fn renormalize_preview_on(&self, tree: &str, temp_index: &str) -> Result<Vec<String>, GitError> {
        let runner = self.runner().await;
        let env: [(&str, &str); 1] = [("GIT_INDEX_FILE", temp_index)];

        let out = runner.run_with_env(&["read-tree", tree], &env).await?;
        Self::ensure_success(&out)?;
        let out = runner
            .run_with_env(&parsers::renormalize::RENORMALIZE_ARGS, &env)
            .await?;
        Self::ensure_success(&out)?;

        let mut args: Vec<&str> = parsers::renormalize::DIFF_INDEX_NAME_ONLY_Z.to_vec();
        args.push(tree);
        let out = runner.run_with_env(&args, &env).await?;
        Self::ensure_success(&out)?;
        Ok(parsers::renormalize::parse_name_only_z(&out.stdout))
    }

    pub(super) async fn renormalize(&self) -> Result<RenormalizeOutcome, GitError> {
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

    pub(super) async fn discard(&self, paths: &[PathBuf]) -> Result<(), GitError> {
        if paths.is_empty() {
            return Ok(());
        }
        // Classify paths: untracked ones must be removed with `clean`, moved
        // submodule pointers reset via `submodule update` (restore does not
        // touch gitlink worktrees), the rest reverted with `restore
        // --worktree` (restore errors on untracked). Raw entries suffice - no
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

    pub(super) async fn file_at_revision(&self, rev: &str, path: &Path) -> Result<FileAtRevision, GitError> {
        let runner = self.runner().await;
        let spec = format!("{}:{}", safe_ref("revision", rev)?, path.to_string_lossy());
        let output = runner
            .run(&["show", "--end-of-options", &spec])
            .await?;
        if !output.success {
            return Err(command_failed(output.exit_code.unwrap_or(-1), &output.stderr));
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
            return Err(command_failed(size.exit_code.unwrap_or(-1), &size.stderr));
        }
        let size_bytes = size.stdout.trim().parse::<u64>().map_err(|_| {
            GitError::Internal(format!("unexpected `cat-file -s` output: {:?}", size.stdout))
        })?;
        Ok(FileAtRevision::Binary { size_bytes })
    }

    pub(super) async fn blob_bytes(&self, spec: &str, cap: u64) -> Result<BlobBytes, GitError> {
        let runner = self.runner().await;
        let stdin = format!("{spec}\n");
        let out = runner.run_with_stdin_bytes(&["cat-file", "--batch"], &stdin).await?;
        if !out.success {
            return Err(command_failed(out.exit_code.unwrap_or(-1), &out.stderr));
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

    pub(super) async fn restore_file_at_revision(&self, rev: &str, path: &Path) -> Result<(), GitError> {
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

    /// `git status` parsed, without line counts - the cheap form for internal
    /// flows (e.g. `discard`) that only need path classification. The trait's
    /// `status()` enriches this with numstat counts for the UI.
    pub(super) async fn status_entries(&self) -> Result<Vec<FileStatus>, GitError> {
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
    pub(super) async fn run_pathspec(&self, prefix: &[&str], paths: &[PathBuf]) -> Result<(), GitError> {
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
    pub(super) async fn run_diff_text(
        &self,
        source: &DiffSource,
        path: &Path,
        old_path: Option<&Path>,
        context: u32,
    ) -> Result<String, GitError> {
        let runner = self.runner().await;
        let unified = format!("-U{context}");
        let path_str = path.to_string_lossy().into_owned();

        // Common flags: no color/ANSI, no external diff drivers - we need git's
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
        let paired_rename = old_str.as_deref().is_some_and(|o| o != path_str);
        if paired_rename {
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
        // diffing it against the empty side instead. A request that carries a
        // rename source is exempt: its empty output means "pure rename" (the
        // rename notice), and the untracked probe would misfire on a case-only
        // rename (`ls-files` matches case-sensitively, the drifted file is
        // tracked under the other spelling). Two cases produce this:
        if output.stdout.trim().is_empty() && !paired_rename {
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
    pub(super) async fn is_untracked(&self, runner: &E, path: &str) -> Result<bool, GitError> {
        let out = runner
            .run(&["ls-files", "-z", "--", path])
            .await?;
        Self::ensure_success(&out)?;
        Ok(out.stdout.is_empty())
    }

    /// Diff an untracked file against the empty side (all lines added).
    /// `git diff --no-index` exits 1 when the inputs differ - success for us.
    pub(super) async fn diff_no_index(
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
        // "no diff" rather than a hard error - this is a best-effort fallback.
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
    pub(super) async fn untracked_repo_dir_change(
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
    pub(super) async fn diff_tree_file(
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
    pub(super) async fn first_parent(
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
    pub(super) async fn stash_untracked_parent(
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

        let list = runner.run(super::stash::STASH_LIST_SHA_ARGS).await?;
        if !list.success {
            return Ok(None);
        }
        let is_stash = list.stdout.lines().any(|l| l.trim() == sha);
        Ok(is_stash.then_some(untracked))
    }

    /// Run `diff-tree <DIFF_TREE_FLAGS> <kind> <from> <to>` and return its
    /// stdout - the one primitive behind `commit_files` and `diff_files`.
    pub(super) async fn diff_tree(&self, from: &str, to: &str, kind: &str) -> Result<String, GitError> {
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
    pub(super) async fn is_stash_commit(&self, sha: &str) -> Result<bool, GitError> {
        let list = self.run_checked(super::stash::STASH_LIST_SHA_ARGS).await?;
        Ok(list.lines().any(|l| l.trim() == sha))
    }

    /// Which diff a working-tree operation reads from: staging/discarding act on
    /// the unstaged diff (index → worktree), unstaging on the staged diff.
    pub(super) fn source_for_op(op: HunkOp) -> DiffSource {
        match op {
            HunkOp::Stage | HunkOp::Discard => DiffSource::WorkingUnstaged,
            HunkOp::Unstage => DiffSource::WorkingStaged,
        }
    }

    /// Apply a prepared patch to the index/worktree per `op`. `--recount` lets a
    /// sliced/edited patch apply despite its untouched `@@` header counts.
    pub(super) async fn apply_op_patch(&self, op: HunkOp, patch: &str) -> Result<(), GitError> {
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

    /// The revision that actually holds `path`'s content for a per-file
    /// restore/apply: `rev` itself, or - when the path is absent there and
    /// `rev` is an untracked-bearing stash - the stash's third parent
    /// (files stashed from UNTRACKED state live only in that tree, which is
    /// why a plain checkout at the stash SHA fails on them; the stash's
    /// file list already includes them, so acting on them must work too).
    /// Falls back to `rev` when neither has the path, so the caller's git
    /// command reports the proper "does not exist at revision" error.
    pub(super) async fn resolve_file_content_source(
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
}

/// Classify the repo's files into the Files tree from three `-z` (NUL-separated)
/// `git ls-files` outputs: `cached` (tracked, in `--stage` format so gitlinks
/// are identifiable by mode 160000), `others` (untracked, not ignored), and
/// `ignored` (empty when the caller didn't request ignored files). The three
/// sets are disjoint by git's definition, so no overlap resolution is needed.
/// Result is de-duplicated and sorted by path so the tree order is stable
/// regardless of git's listing order. Pure so the classification rule is
/// unit-tested.
pub(super) fn classify_repo_files(cached: &str, others: &str, ignored: &str) -> Vec<RepoFileEntry> {
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
pub(super) fn parse_ls_tree_files(stdout: &str) -> Vec<RepoFileEntry> {
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
pub(super) fn filter_paths(ls_files_stdout: &str, query: &str, max: usize) -> Vec<PathBuf> {
    let needle = query.to_lowercase();
    ls_files_stdout
        .split('\0')
        .filter(|p| !p.is_empty() && p.to_lowercase().contains(&needle))
        .take(max)
        .map(PathBuf::from)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
