//! Remotes and network operations: fetch, pull, push, tracking, remote branches and tags.

use super::*;

impl<E: GitExecutor + ?Sized> GitCliBackend<E> {
    pub(super) async fn fetch(&self, opts: FetchOptions, op_id: OperationId) -> Result<(), GitError> {
        let args = build_fetch_args(&opts)?;
        let runner = self.runner().await;
        self.run_remote(&runner, &args, op_id).await
    }

    pub(super) async fn pull(&self, opts: PullOptions, op_id: OperationId) -> Result<PullOutcome, GitError> {
        let runner = self.runner().await;
        let args = build_pull_args(&opts);
        let out = self.run_remote_output(&runner, &args, op_id).await?;
        Ok(PullOutcome { lfs_stubs: lfs_stubs_from_stderr(&out.stderr) })
    }

    pub(super) async fn push(&self, opts: PushOptions, op_id: OperationId) -> Result<(), GitError> {
        let args = build_push_args(&opts)?;
        let runner = self.runner().await;
        self.run_remote(&runner, &args, op_id).await
    }

    pub(super) async fn tracking_status(&self) -> Result<Option<TrackingStatus>, GitError> {
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

    pub(super) async fn list_remotes(&self) -> Result<Vec<Remote>, GitError> {
        let runner = self.runner().await;
        let output = runner
            .run(&parsers::remotes::REMOTE_LIST_ARGS)
            .await?;
        Self::ensure_success(&output)?;
        Ok(parsers::remotes::parse_remotes(&output.stdout))
    }

    pub(super) async fn add_remote(&self, name: &str, url: &str) -> Result<(), GitError> {
        self.run_simple(&["remote", "add", safe_ref("remote", name)?, url]).await
    }

    pub(super) async fn remove_remote(&self, name: &str) -> Result<(), GitError> {
        self.run_simple(&["remote", "remove", safe_ref("remote", name)?]).await
    }

    pub(super) async fn rename_remote(&self, old: &str, new: &str) -> Result<(), GitError> {
        self.run_simple(&[
            "remote",
            "rename",
            safe_ref("remote", old)?,
            safe_ref("remote", new)?,
        ])
        .await
    }

    pub(super) async fn set_remote_url(&self, name: &str, url: &str, push: bool) -> Result<(), GitError> {
        let name = safe_ref("remote", name)?;
        self.run_simple(&build_set_url_args(name, url, push)).await
    }

    pub(super) async fn prune_remote(&self, name: &str, op_id: OperationId) -> Result<(), GitError> {
        // Network op (contacts the remote) → cancellable + remote-error mapping.
        let args = vec![
            "remote".to_string(),
            "prune".to_string(),
            safe_ref_owned("remote", name)?,
        ];
        let runner = self.runner().await;
        self.run_remote(&runner, &args, op_id).await
    }

    pub(super) async fn delete_remote_branch(
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

    pub(super) async fn push_tag(&self, remote: &str, name: &str, op_id: OperationId) -> Result<(), GitError> {
        let runner = self.runner().await;
        // The full refspec avoids any ambiguity with a same-named branch.
        let args = vec![
            "push".to_string(),
            safe_ref_owned("remote", remote)?,
            format!("refs/tags/{name}"),
        ];
        self.run_remote(&runner, &args, op_id).await
    }

    pub(super) async fn delete_remote_tag(
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

    pub(super) async fn remote_tags(&self, remote: &str, op_id: OperationId) -> Result<Vec<RemoteTag>, GitError> {
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
}

/// Config overrides prepended to fetch/pull: suppress git's post-transfer
/// auto-maintenance (`gc --auto`). On a large repo that gc keeps repacking
/// refs in the background for seconds after the command returns; every write
/// batch trips the filesystem watcher and re-invalidates the log, so the
/// Commits panel kept refetching long after a fetch. LeGit never needs the
/// side effect - the user's own git usage still runs maintenance normally.
pub(super) const NO_AUTO_MAINTENANCE: [&str; 4] = ["-c", "gc.auto=0", "-c", "maintenance.auto=false"];

/// Build the argument vector for `git fetch`. `--all` wins over a named
/// remote; an empty remote name means "default remote" (no positional arg).
/// `--progress` forces the transfer meter onto our (non-TTY) pipe;
/// `run_with_op_progress` parses and strips it.
pub(super) fn build_fetch_args(opts: &FetchOptions) -> Result<Vec<String>, GitError> {
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
pub(super) fn build_pull_args(opts: &PullOptions) -> Vec<String> {
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
pub(super) fn build_push_args(opts: &PushOptions) -> Result<Vec<String>, GitError> {
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
pub(super) fn build_set_url_args<'a>(name: &'a str, url: &'a str, push: bool) -> Vec<&'a str> {
    let mut args = vec!["remote", "set-url"];
    if push {
        args.push("--push");
    }
    args.push(name);
    args.push(url);
    args
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
}
