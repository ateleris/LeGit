//! Submodule flows for `GitCliBackend`.
//!
//! The `GitBackend` trait impl in `mod.rs` delegates every submodule method
//! to the same-named inherent methods here (a trait impl cannot span files).

use crate::error::GitError;
use crate::executor::GitExecutor;
use crate::runner::OperationId;
use crate::types::{
    CommitId, GitmodulesFinding, LfsStubs, SubmoduleAutoUpdateResult, SubmoduleAutoUpdateStatus,
    SubmoduleGitdirInfo, SubmoduleInfo, SubmoduleLog, SubmoduleUpdateOptions,
    SubmoduleUpdateStrategy, SwitchDirtyBehavior,
};
use std::path::{Path, PathBuf};

use super::{
    append_error_note, find_created_stash, find_stash_selector, lfs_stubs_from_stderr, parsers,
    safe_ref, GitCliBackend,
};

/// Target of a per-submodule move (see `update_one_submodule`).
#[derive(Debug, Clone, Copy)]
enum SubmoduleMove {
    /// Check out the SHA recorded in the superproject index.
    Recorded,
    /// Fetch and integrate the tracked remote branch (`update --remote`).
    Remote(SubmoduleUpdateStrategy),
}

impl<E: GitExecutor> GitCliBackend<E> {
    /// Move ONE submodule: to the recorded SHA (`submodule update`) or to its
    /// tracked remote branch (`submodule update --remote` + strategy, which
    /// fetches - run as a cancellable remote op). A success reports any LFS
    /// pointer stubs the checkout left behind inside the submodule.
    async fn move_submodule(
        &self,
        p: &str,
        mv: SubmoduleMove,
        op_id: Option<&OperationId>,
    ) -> Result<Option<LfsStubs>, GitError> {
        match mv {
            SubmoduleMove::Recorded => {
                let runner = self.runner().await;
                let out = runner.run(&["submodule", "update", "--", p]).await?;
                Self::ensure_success(&out)?;
                Ok(lfs_stubs_from_stderr(&out.stderr))
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
                let out = self.run_remote_output(&runner, &args, op).await?;
                Ok(lfs_stubs_from_stderr(&out.stderr))
            }
        }
    }

    /// Best-effort: attach submodule `p`'s detached HEAD to a branch whose
    /// tip is exactly the current commit (configured branch first, else a
    /// unique local match - `choose_attach_branch`). The checkout is a
    /// content no-op (tip == HEAD), so this can never touch the worktree.
    /// Never fails the surrounding update: the update is already complete
    /// and a failed attach only leaves the correct detached state, so every
    /// error path is a warn + return.
    async fn attach_submodule_branch(&self, p: &str, configured: Option<&str>) {
        let runner = self.runner().await;
        // Attached already (e.g. `--remote --merge` on a branch): done.
        // Detached HEAD makes symbolic-ref exit 1 - expected, not a failure.
        match runner
            .run_expecting(&["-C", p, "symbolic-ref", "-q", "--short", "HEAD"], &[1])
            .await
        {
            Ok(o) if !o.success => {}
            Ok(_) => return,
            Err(e) => {
                tracing::warn!(path = p, error = %e, "branch-attach detach probe failed");
                return;
            }
        }
        let matching: Vec<String> = match runner
            .run(&["-C", p, "for-each-ref", "refs/heads", "--points-at", "HEAD", "--format=%(refname:short)"])
            .await
        {
            Ok(o) if o.success => o
                .stdout
                .lines()
                .map(|l| l.trim().to_string())
                .filter(|l| !l.is_empty())
                .collect(),
            Ok(o) => {
                tracing::warn!(path = p, stderr = %o.stderr, "branch-attach for-each-ref failed");
                return;
            }
            Err(e) => {
                tracing::warn!(path = p, error = %e, "branch-attach for-each-ref failed");
                return;
            }
        };
        drop(runner);
        let Some(branch) = choose_attach_branch(configured, &matching) else {
            return;
        };
        let branch = match safe_ref("branch", &branch) {
            Ok(b) => b,
            Err(e) => {
                tracing::warn!(path = p, error = %e, "refusing to attach branch");
                return;
            }
        };
        if let Err(e) = self.run_simple(&["-C", p, "checkout", branch]).await {
            tracing::warn!(
                path = p, branch = %branch, error = %e,
                "branch attach failed; the submodule stays detached"
            );
        }
    }

    /// Update ONE submodule (to `mv`'s target), handling dirtiness per
    /// `behavior`. `old` is the pre-move HEAD, the rollback anchor. Never
    /// returns Err: every failure becomes a status so the caller's batch
    /// continues (per-submodule atomicity). Shared by the post-switch/pull
    /// auto-update (Recorded) and "Pull latest" (Remote). Alongside the
    /// status: any LFS pointer stubs a successful move left inside the
    /// submodule (only while it actually sits at the new commit).
    async fn update_one_submodule(
        &self,
        s: &SubmoduleInfo,
        old: &str,
        behavior: SwitchDirtyBehavior,
        mv: SubmoduleMove,
        op_id: Option<&OperationId>,
    ) -> (SubmoduleAutoUpdateStatus, Option<LfsStubs>) {
        let p = s.path.to_string_lossy().into_owned();
        let skip = |msg: String| (SubmoduleAutoUpdateStatus::Skipped { message: msg }, None);

        if s.state.conflicted {
            return skip("the submodule is in a merge conflict".into());
        }
        let dirty = s.state.dirty_tracked || s.state.dirty_untracked;

        // Clean: just move (`submodule update` fetches on demand, unlike a
        // raw checkout).
        if !dirty {
            return match self.move_submodule(&p, mv, op_id).await {
                Ok(stubs) => (SubmoduleAutoUpdateStatus::Updated, stubs),
                Err(e) => skip(e.to_string()),
            };
        }

        match behavior {
            // Let git decide: the move's internal checkout carries a
            // non-conflicting dirty tree over and refuses a conflicting one
            // (the submodule stays untouched).
            SwitchDirtyBehavior::TryDirectly => {
                match self.move_submodule(&p, mv, op_id).await {
                    Ok(stubs) => (SubmoduleAutoUpdateStatus::ChangesCarried, stubs),
                    Err(e) => skip(format!("local changes could not be carried over: {e}")),
                }
            }
            SwitchDirtyBehavior::AutoStash | SwitchDirtyBehavior::StashAndKeep => {
                // Stash inside the submodule, verified by a marker-matched
                // stash-list diff (never by exit code: `stash push` exits 0
                // on a clean tree; never by the tip alone: a concurrently
                // created entry must not be adopted and later popped).
                const SUB_MARKER: &str = "legit: auto-stash before submodule update";
                // A failed list read must be LOUD, never treated as an empty
                // list: an empty "before" could adopt a leftover marker entry
                // from an earlier crash, and an empty "after" would take the
                // clean-tree branch below - the submodule would move, report a
                // plain Updated, and the user's changes would sit silently in
                // the submodule's stash (best-effort failure must never be
                // silent; house rule).
                let sub_list =
                    |o: Result<crate::runner::RunOutput, crate::runner::RunnerError>| -> Result<String, String> {
                        match o {
                            Ok(out) if out.success => Ok(out.stdout),
                            Ok(out) => {
                                let msg = out.stderr.trim().to_string();
                                Err(if msg.is_empty() {
                                    format!("git stash list exited with {:?}", out.exit_code)
                                } else {
                                    msg
                                })
                            }
                            Err(e) => Err(e.to_string()),
                        }
                    };
                let runner = self.runner().await;
                let before = match sub_list(
                    runner
                        .run(&["-C", &p, "stash", "list", "--format=%H %s"])
                        .await,
                ) {
                    Ok(list) => list,
                    // Nothing has been touched yet: abort this submodule's
                    // update instead of risking adopting (and later popping)
                    // a stash entry we did not create.
                    Err(e) => {
                        return skip(format!(
                            "could not read the submodule's stash list before auto-stashing ({e}); the submodule was left untouched"
                        ));
                    }
                };
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
                let after = match sub_list(
                    runner
                        .run(&["-C", &p, "stash", "list", "--format=%H %s"])
                        .await,
                ) {
                    Ok(list) => list,
                    // The stash push already ran: the changes MAY be parked in
                    // the submodule's stash, but without the list we cannot
                    // verify it (nor pop by SHA). Stop here - do NOT move the
                    // submodule - and say so prominently.
                    Err(e) => {
                        return (
                            SubmoduleAutoUpdateStatus::ChangesInStash {
                                message: format!(
                                    "your local changes may have been auto-stashed, but reading the submodule's stash list to verify failed ({e}); the submodule was left at its previous commit - check `git stash list` inside the submodule"
                                ),
                            },
                            None,
                        );
                    }
                };
                drop(runner);
                let Some(stash_sha) = find_created_stash(&before, &after, SUB_MARKER) else {
                    // Race: tree turned out clean - just move.
                    return match self.move_submodule(&p, mv, op_id).await {
                        Ok(stubs) => (SubmoduleAutoUpdateStatus::Updated, stubs),
                        Err(e) => skip(e.to_string()),
                    };
                };

                // Move to the target (tree is clean now).
                let move_stubs = match self.move_submodule(&p, mv, op_id).await {
                    Ok(stubs) => stubs,
                    Err(e) => {
                        // Restore: pop the stash we just made, back on `old`.
                        return match self.pop_submodule_stash(&p, &stash_sha).await {
                            Ok(()) => skip(format!("update failed; local changes restored: {e}")),
                            Err(pop_e) => (
                                SubmoduleAutoUpdateStatus::ChangesInStash {
                                    message: format!(
                                        "update failed ({e}) AND restoring failed ({pop_e}) - your changes are in the submodule's stash"
                                    ),
                                },
                                None,
                            ),
                        };
                    }
                };

                if matches!(behavior, SwitchDirtyBehavior::StashAndKeep) {
                    return (SubmoduleAutoUpdateStatus::ChangesStashed, move_stubs);
                }

                // AutoStash: pop onto the NEW commit.
                match self.pop_submodule_stash(&p, &stash_sha).await {
                    Ok(()) => (SubmoduleAutoUpdateStatus::ChangesCarried, move_stubs),
                    Err(pop_err) => {
                        // Conflicted/failed pop: ROLL BACK. `reset --hard`
                        // discards the marker-ridden application and clears
                        // unmerged index entries - the stash itself survived
                        // (git keeps it when a pop conflicts).
                        if let Err(e) = self.run_simple(&["-C", &p, "reset", "--hard", old]).await {
                            return (
                                SubmoduleAutoUpdateStatus::ChangesInStash {
                                    message: format!(
                                        "pop conflicted ({pop_err}) AND rollback failed ({e}) - your changes are in the submodule's stash"
                                    ),
                                },
                                move_stubs,
                            );
                        }
                        match self.pop_submodule_stash(&p, &stash_sha).await {
                            Ok(()) => (
                                SubmoduleAutoUpdateStatus::RolledBack {
                                    message: format!(
                                        "local changes conflict with the new submodule commit; the submodule was left at its previous commit with your changes intact ({pop_err})"
                                    ),
                                },
                                None,
                            ),
                            Err(e) => (
                                SubmoduleAutoUpdateStatus::ChangesInStash {
                                    message: format!(
                                        "pop conflicted ({pop_err}) AND reapplying on the original commit failed ({e}) - your changes are in the submodule's stash"
                                    ),
                                },
                                None,
                            ),
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
        let modules = PathBuf::from(out.stdout.trim()).join("modules");
        let gitdir = modules.join(name_path);
        // `is_dir` follows symlinks, and this path is deleted wholesale: resolve
        // it and require that it still sits under `modules/`, so a link planted
        // in the git dir cannot redirect the deletion outside it.
        match std::fs::symlink_metadata(&gitdir) {
            Ok(meta) if meta.is_dir() => {}
            Ok(meta) if meta.is_symlink() => {
                return Err(GitError::Internal(format!(
                    "the gitdir of submodule '{name}' is a symlink - refusing to report or delete it"
                )))
            }
            _ => return Ok(None),
        }
        let (Ok(real), Ok(real_modules)) = (gitdir.canonicalize(), modules.canonicalize()) else {
            return Err(GitError::Internal(format!(
                "could not resolve the gitdir of submodule '{name}'"
            )));
        };
        if !real.starts_with(&real_modules) {
            return Err(GitError::Internal(format!(
                "the gitdir of submodule '{name}' resolves outside {}",
                real_modules.display()
            )));
        }
        Ok(Some(gitdir))
    }

    pub(super) async fn submodules(&self) -> Result<Vec<SubmoduleInfo>, GitError> {
        use parsers::submodules as sub;
        let runner = self.runner().await;

        let ls = runner
            .run(&sub::LS_FILES_STAGE_ARGS)
            .await?;
        Self::ensure_success(&ls)?;
        let gitlinks = sub::parse_gitlinks(&ls.stdout);

        // No gitlinks -> no rows, guaranteed: `assemble_submodules` iterates
        // gitlinks only (config-only entries never surface). Skip the three
        // follow-up reads entirely - in a repo without submodules the two
        // config `--get-regexp` calls exit 1 ("no matches"), which painted
        // the Git Log panel red on every derived refetch, and all three are
        // wasted spawns for a known-empty answer.
        if gitlinks.is_empty() {
            return Ok(Vec::new());
        }

        // Both config reads exit 1 for "no matches / no file" - that is a
        // normal state (e.g. declared-but-uninitialized submodules), never an
        // error, so it must not log as a failed call either.
        let gitmodules = match runner.run_expecting(&sub::GITMODULES_CONFIG_ARGS, &[1]).await {
            Ok(o) if o.success => sub::parse_submodule_config(&o.stdout),
            _ => Default::default(),
        };
        let local = match runner.run_expecting(&sub::LOCAL_SUBMODULE_CONFIG_ARGS, &[1]).await {
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

    pub(super) async fn submodule_log(
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
        match runner.run_expecting(&["-C", &p, "cat-file", "-e", &probe], &[1]).await {
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

    pub(super) async fn submodule_update(
        &self,
        opts: SubmoduleUpdateOptions,
        op_id: OperationId,
    ) -> Result<Option<LfsStubs>, GitError> {
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
        let out = self.run_remote_output(&runner, &args, op_id).await?;
        let lfs_stubs = lfs_stubs_from_stderr(&out.stderr);
        drop(runner);

        if opts.attach_branch {
            // Best-effort attach pass over the updated (top-level) submodules;
            // an enumeration failure must not turn the successful update into
            // an error. `head_branch.is_some()` skips already-attached ones
            // (the helper's own probe re-checks; it has callers without this
            // pre-filter).
            match self.submodules().await {
                Ok(subs) => {
                    for s in subs {
                        if !s.state.populated || !s.state.initialized {
                            continue;
                        }
                        if !opts.paths.is_empty() && !opts.paths.contains(&s.path) {
                            continue;
                        }
                        if s.head_branch.is_some() {
                            continue;
                        }
                        let p = s.path.to_string_lossy().into_owned();
                        self.attach_submodule_branch(&p, s.branch.as_deref()).await;
                    }
                }
                Err(e) => tracing::warn!(error = %e, "branch-attach enumeration failed"),
            }
        }
        Ok(lfs_stubs)
    }

    pub(super) async fn submodule_sync(&self, paths: &[PathBuf], recursive: bool) -> Result<(), GitError> {
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

    pub(super) async fn submodule_fetch(&self, path: &Path, op_id: OperationId) -> Result<(), GitError> {
        let runner = self.runner().await;
        let args: Vec<String> = vec![
            "-C".into(),
            path.to_string_lossy().into_owned(),
            "fetch".into(),
        ];
        self.run_remote(&runner, &args, op_id).await
    }

    pub(super) async fn superproject_path(&self) -> Result<Option<PathBuf>, GitError> {
        let runner = self.runner().await;
        let out = runner
            .run(&["rev-parse", "--show-superproject-working-tree"])
            .await?;
        Self::ensure_success(&out)?;
        let path = out.stdout.trim();
        Ok(if path.is_empty() { None } else { Some(PathBuf::from(path)) })
    }

    pub(super) async fn submodule_add(
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

    pub(super) async fn submodule_set_url(&self, path: &Path, url: &str) -> Result<(), GitError> {
        let p = path.to_string_lossy().into_owned();
        self.run_simple(&["submodule", "set-url", "--", &p, url]).await?;
        // set-url edits .gitmodules only; sync propagates to .git/config and
        // the submodule's origin (spec: set-url auto-syncs).
        self.run_simple(&["submodule", "sync", "--", &p]).await
    }

    pub(super) async fn submodule_set_branch(&self, path: &Path, branch: Option<&str>) -> Result<(), GitError> {
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

    pub(super) async fn submodule_update_remote(
        &self,
        paths: &[PathBuf],
        strategy: SubmoduleUpdateStrategy,
        behavior: SwitchDirtyBehavior,
        attach_branch: bool,
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
            let (status, lfs_stubs) = self
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
            let moved = matches!(
                status,
                SubmoduleAutoUpdateStatus::Updated
                    | SubmoduleAutoUpdateStatus::ChangesCarried
                    | SubmoduleAutoUpdateStatus::ChangesStashed
            );
            if moved {
                if attach_branch {
                    let p = s.path.to_string_lossy().into_owned();
                    self.attach_submodule_branch(&p, s.branch.as_deref()).await;
                }
                to_stage.push(s.path.clone());
            }
            results.push(SubmoduleAutoUpdateResult { path: s.path, status, lfs_stubs });
        }
        if !to_stage.is_empty() {
            self.run_pathspec(&["add", "--"], &to_stage).await?;
        }
        Ok(results)
    }

    pub(super) async fn gitmodules_consistency(&self) -> Result<Vec<GitmodulesFinding>, GitError> {
        let runner = self.runner().await;
        // Gate: one cheap staged diff. Failure (e.g. unborn HEAD on some git
        // versions) falls through to the full check - the gate is an
        // optimization and must neither error out nor silently skip.
        let gate = runner.run(&parsers::submodules::STAGED_RAW_DIFF_ARGS).await?;
        if gate.success
            && !parsers::submodules::staged_touches_submodule_config(&gate.stdout)
        {
            return Ok(Vec::new());
        }
        // The STAGED blob (`:.gitmodules`), not the worktree file: the check
        // is about what the commit will record. Non-zero exit = no staged
        // .gitmodules / no sections - an empty entry set, not an error.
        let cfg = runner
            .run(&parsers::submodules::STAGED_GITMODULES_CONFIG_ARGS)
            .await?;
        let entries = if cfg.success {
            parsers::submodules::parse_submodule_config(&cfg.stdout)
        } else {
            std::collections::HashMap::new()
        };
        let ls = runner.run(&parsers::submodules::LS_FILES_STAGE_ARGS).await?;
        Self::ensure_success(&ls)?;
        let gitlinks = parsers::submodules::parse_gitlinks(&ls.stdout);
        Ok(parsers::submodules::check_gitmodules_consistency(&entries, &gitlinks))
    }

    pub(super) async fn submodule_remove(&self, path: &Path) -> Result<(), GitError> {
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

    pub(super) async fn submodule_move(&self, from: &Path, to: &Path) -> Result<(), GitError> {
        // Reject anything that could escape the worktree (same rule as
        // `submodule_gitdir_path`): relative, normal components only.
        for p in [from, to] {
            if p.as_os_str().is_empty()
                || p.is_absolute()
                || p.components().any(|c| !matches!(c, std::path::Component::Normal(_)))
            {
                return Err(GitError::Internal(format!(
                    "invalid submodule path '{}'",
                    p.display()
                )));
            }
        }
        let runner = self.runner().await;
        let out = runner.run(&["rev-parse", "--show-toplevel"]).await?;
        Self::ensure_success(&out)?;
        drop(runner);
        let root = PathBuf::from(out.stdout.trim());
        let abs_to = root.join(to);
        if abs_to.exists() {
            return Err(GitError::Internal(format!(
                "target path '{}' already exists",
                to.display()
            )));
        }
        // `git mv` refuses "destination directory does not exist": create the
        // missing parents, remembering the topmost one we created so a failed
        // move can clean up after itself.
        let mut created: Option<PathBuf> = None;
        if let Some(parent) = abs_to.parent() {
            if !parent.exists() {
                let mut probe = parent.to_path_buf();
                while let Some(up) = probe.parent() {
                    if up.exists() {
                        break;
                    }
                    probe = up.to_path_buf();
                }
                std::fs::create_dir_all(parent).map_err(|e| {
                    GitError::Internal(format!(
                        "could not create '{}': {e}",
                        parent.display()
                    ))
                })?;
                created = Some(probe);
            }
        }
        let f = from.to_string_lossy().into_owned();
        let t = to.to_string_lossy().into_owned();
        match self.run_simple(&["mv", "--", &f, &t]).await {
            Ok(()) => Ok(()),
            Err(e) => {
                // Best-effort: remove the empty directories we just created;
                // a failed cleanup must not be silent (house rule).
                if let Some(dir) = created {
                    if let Err(rm) = std::fs::remove_dir_all(&dir) {
                        return Err(append_error_note(
                            e,
                            &format!(
                                "note: cleanup of created directory '{}' also failed: {rm}",
                                dir.display()
                            ),
                        ));
                    }
                }
                Err(e)
            }
        }
    }

    pub(super) async fn submodule_gitdir_info(
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

    pub(super) async fn submodule_delete_gitdir(&self, name: &str) -> Result<(), GitError> {
        let Some(gitdir) = self.submodule_gitdir_path(name).await? else {
            return Err(GitError::Internal(format!(
                "no retained gitdir for submodule '{name}'"
            )));
        };
        std::fs::remove_dir_all(&gitdir)
            .map_err(|e| GitError::Internal(format!("could not delete {}: {e}", gitdir.display())))
    }

    pub(super) async fn submodule_create_branch(&self, path: &Path, name: &str) -> Result<(), GitError> {
        let p = path.to_string_lossy().into_owned();
        self.run_simple(&["-C", &p, "switch", "-c", safe_ref("branch name", name)?])
            .await
    }

    pub(super) async fn submodule_auto_update(
        &self,
        behavior: SwitchDirtyBehavior,
        attach_branch: bool,
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
            let (status, lfs_stubs) = self
                .update_one_submodule(&s, old.as_str(), behavior, SubmoduleMove::Recorded, None)
                .await;
            if attach_branch
                && matches!(
                    status,
                    SubmoduleAutoUpdateStatus::Updated
                        | SubmoduleAutoUpdateStatus::ChangesCarried
                        | SubmoduleAutoUpdateStatus::ChangesStashed
                )
            {
                let p = s.path.to_string_lossy().into_owned();
                self.attach_submodule_branch(&p, s.branch.as_deref()).await;
            }
            results.push(SubmoduleAutoUpdateResult { path: s.path, status, lfs_stubs });
        }
        Ok(results)
    }
}

/// Pick the branch to attach a submodule's detached HEAD to, given the
/// configured `.gitmodules` branch (if any) and the local branches whose
/// tips equal the checked-out commit (`for-each-ref --points-at HEAD`).
/// The configured branch wins when it matches; otherwise only an
/// unambiguous single candidate attaches - 2+ candidates stay detached.
fn choose_attach_branch(configured: Option<&str>, matching: &[String]) -> Option<String> {
    if let Some(c) = configured {
        if matching.iter().any(|b| b == c) {
            return Some(c.to_string());
        }
    }
    match matching {
        [only] => Some(only.clone()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- submodule branch attach: which branch (if any) to check out ---------
    // Configured branch wins when its tip is at the commit; otherwise only an
    // unambiguous single candidate attaches (2+ stay detached).

    #[test]
    fn choose_attach_branch_configured_match_wins() {
        let matching = vec!["dev".to_string(), "main".to_string()];
        assert_eq!(
            choose_attach_branch(Some("main"), &matching),
            Some("main".to_string())
        );
    }

    #[test]
    fn choose_attach_branch_unique_match_attaches() {
        let matching = vec!["feature".to_string()];
        assert_eq!(choose_attach_branch(None, &matching), Some("feature".to_string()));
        // Configured branch NOT at this commit: the unique rule still applies.
        assert_eq!(
            choose_attach_branch(Some("main"), &matching),
            Some("feature".to_string())
        );
    }

    #[test]
    fn choose_attach_branch_ambiguous_stays_detached() {
        let matching = vec!["a".to_string(), "b".to_string()];
        assert_eq!(choose_attach_branch(None, &matching), None);
    }

    #[test]
    fn choose_attach_branch_no_candidates_stays_detached() {
        assert_eq!(choose_attach_branch(Some("main"), &[]), None);
        assert_eq!(choose_attach_branch(None, &[]), None);
    }
}
