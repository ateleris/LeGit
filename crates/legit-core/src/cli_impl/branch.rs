//! Local branches: list, create, switch (with auto-stash), checkout, delete, rename, upstream, merge analysis.

use super::*;

impl<E: GitExecutor + ?Sized> GitCliBackend<E> {
    pub(super) async fn branches(&self) -> Result<Vec<Branch>, GitError> {
        let runner = self.runner().await;
        let fmt_arg = format!("--format={}", parsers::branches::BRANCH_FORMAT);

        let output = runner
            .run(&["for-each-ref", &fmt_arg, "refs/heads", "refs/remotes"])
            .await?;

        Self::ensure_success(&output)?;

        Ok(parsers::branches::parse_branches(&output.stdout))
    }

    pub(super) async fn create_branch(&self, name: &str, start_point: Option<&str>) -> Result<(), GitError> {
        let mut args = vec!["branch", "--end-of-options", safe_ref("branch name", name)?];
        if let Some(sp) = start_point {
            args.push(safe_ref("start point", sp)?);
        }
        self.run_simple(&args).await
    }

    pub(super) async fn switch_branch(&self, name: &str, behavior: SwitchDirtyBehavior) -> Result<SwitchResult, GitError> {
        let name = safe_ref("branch", name)?;
        self.run_with_auto_stash(behavior, &["switch", "--end-of-options", name])
            .await
    }

    pub(super) async fn checkout_commit(&self, sha: &str, behavior: SwitchDirtyBehavior) -> Result<SwitchResult, GitError> {
        let sha = safe_ref("revision", sha)?;
        self.run_with_auto_stash(behavior, &["switch", "--detach", "--end-of-options", sha])
            .await
    }

    pub(super) async fn checkout_remote_branch(
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
        // `switch --track` refuses when the local branch already exists - the
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

    pub(super) async fn delete_branch(&self, name: &str, force: bool) -> Result<(), GitError> {
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

    pub(super) async fn branch_merge_analysis(&self, name: &str) -> Result<BranchMergeAnalysis, GitError> {
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

    pub(super) async fn rename_branch(&self, old_name: &str, new_name: &str) -> Result<(), GitError> {
        self.run_simple(&[
            "branch",
            "-m",
            "--end-of-options",
            safe_ref("branch", old_name)?,
            safe_ref("new branch name", new_name)?,
        ])
        .await
    }

    pub(super) async fn set_upstream(&self, branch: &str, upstream: Option<&str>) -> Result<(), GitError> {
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

    /// Run a `git switch`/`checkout` invocation, classifying the well-known
    /// "your local changes would be overwritten" failure into
    /// `WouldOverwriteLocalChanges` so the UI can respond specifically.
    /// Run a switch/checkout command; a failure classifies, a success
    /// reports any LFS pointer stubs the checkout left behind (git can exit
    /// 0 with failed LFS downloads under `lfs.skipdownloaderrors` / a
    /// non-required filter).
    pub(super) async fn run_switch(&self, args: &[&str]) -> Result<Option<LfsStubs>, GitError> {
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
    /// is addressed *by its SHA* - never a bare `stash pop`, which would pop
    /// an unrelated pre-existing stash when nothing was auto-stashed or when
    /// the list shifted in between. The two modes differ only after a
    /// successful switch: `AutoStash` pops the entry (changes travel along),
    /// `StashAndKeep` leaves it parked.
    pub(super) async fn run_with_auto_stash(
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
        // The SHA of the entry *we* created; `None` when the tree was clean.
        let created = match self.auto_stash_push(None, &msg).await {
            Ok(AutoStash::Created(sha)) => Some(sha),
            Ok(AutoStash::Nothing) => None,
            Err(AutoStashFailure::ListUnreadable(e) | AutoStashFailure::PushFailed(e)) => return Err(e),
            Err(AutoStashFailure::Unverified(e)) => {
                return Err(append_error_note(
                    e,
                    "Your uncommitted changes may have been auto-stashed (the stash list could \
                     not be read to confirm it); the switch did not run - check the stash list \
                     before retrying.",
                ));
            }
        };

        let lfs_stubs = match self.run_switch(switch_args).await {
            Ok(stubs) => stubs,
            Err(switch_err) => {
                // Roll back: restore the auto-stash onto the original branch.
                // It was created from exactly this state, so it applies
                // cleanly in practice - but a failure here must not be
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
                                 conflicts - resolve them in the working tree (the stash entry \
                                 was kept).",
                            ));
                        }
                        Err(pop_err) => {
                            return Err(append_error_note(
                                switch_err,
                                &format!(
                                    "Additionally, your uncommitted changes were auto-stashed and \
                                     could not be restored automatically ({pop_err}) - they are \
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
            // Clean tree - nothing was stashed, nothing to restore.
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

/// Split a remote-tracking ref (either `origin/x` or the full
/// `refs/remotes/origin/x`) into the short form git commands take and the
/// derived local branch name (the ref minus the remote-name segment).
pub(super) fn remote_ref_names(remote_ref: &str) -> (&str, &str) {
    let short = remote_ref
        .strip_prefix("refs/remotes/")
        .unwrap_or(remote_ref);
    let local = short.split_once('/').map(|(_, b)| b).unwrap_or(short);
    (short, local)
}

/// Filter `for-each-ref --contains <tip> --format=%(refname:short)` output
/// down to the refs that make a branch "already merged": the branch itself,
/// its remote counterparts (`<remote>/<branch>`), and symbolic `*/HEAD`
/// entries are excluded - they contain the tip trivially.
pub(super) fn filter_containing_refs(stdout: &str, branch: &str) -> Vec<String> {
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
pub(super) fn cherry_all_equivalent(stdout: &str) -> bool {
    let mut any = false;
    for line in stdout.lines().map(str::trim).filter(|l| !l.is_empty()) {
        if !line.starts_with('-') {
            return false;
        }
        any = true;
    }
    any
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
