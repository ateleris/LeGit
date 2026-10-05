//! Creating and rewriting commits on the current branch: commit, reword, reset.

use super::*;

impl<E: GitExecutor + ?Sized> GitCliBackend<E> {
    pub(super) async fn commit(&self, opts: CommitOptions) -> Result<CommitId, GitError> {
        let runner = self.runner().await;

        let args = build_commit_args(&opts);
        let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
        let output = runner
            .run(&arg_refs)
            .await?;
        if !output.success {
            // A rejecting hook is invisible in git's output, so blame is
            // decided by elimination (`classify_commit_failure`) over which
            // bypassable hooks are installed. With --no-verify none ran, so
            // none can be to blame and the probe is skipped.
            let hooks = if opts.no_verify {
                Vec::new()
            } else {
                self.installed_commit_hooks().await
            };
            return Err(classify_commit_failure(
                output.exit_code.unwrap_or(-1),
                &output.stdout,
                &output.stderr,
                &hooks,
            ));
        }

        // Resolve the resulting commit id.
        let head = runner
            .run(&["rev-parse", "HEAD"])
            .await?;
        Self::ensure_success(&head)?;
        Ok(CommitId::new(head.stdout.trim().to_string()))
    }

    pub(super) async fn reword_commit(&self, id: &CommitId, message: &str) -> Result<CommitId, GitError> {
        let runner = self.runner().await;

        // v1 rewords HEAD only - resolve the tip and reject anything else.
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

    /// Which bypassable commit hooks are installed. Best-effort on the
    /// error path: any resolution/probe failure reports "none installed" so
    /// an unrelated commit failure is never blamed on a hook.
    async fn installed_commit_hooks(&self) -> Vec<String> {
        let runner = self.runner().await;
        // --git-path honors core.hooksPath (absolute or repo-relative).
        let Ok(out) = runner
            .run(&["rev-parse", "--path-format=absolute", "--git-path", "hooks"])
            .await
        else {
            return Vec::new();
        };
        let dir = out.stdout.trim();
        if !out.success || dir.is_empty() {
            return Vec::new();
        }
        let dir = HostPath(dir.to_string());
        let mut installed = Vec::new();
        for hook in BYPASSABLE_COMMIT_HOOKS {
            if matches!(self.fs.stat(&dir.join(hook)).await, Ok(Some(stat)) if !stat.is_dir) {
                installed.push(hook.to_string());
            }
        }
        installed
    }

    pub(super) async fn reset(&self, target: &str, mode: ResetMode) -> Result<(), GitError> {
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
}

/// The hooks `git commit` runs that `--no-verify` skips. post-commit cannot
/// fail the commit; prepare-commit-msg can but is not bypassable, so listing
/// it would promise a retry that cannot help.
const BYPASSABLE_COMMIT_HOOKS: [&str; 2] = ["pre-commit", "commit-msg"];

/// Build the argument vector for `git commit`. `SignMode::None` passes
/// `--no-gpg-sign` explicitly so a repo-level `commit.gpgsign=true` cannot
/// re-enable signing; `Default` passes nothing and inherits config.
pub(super) fn build_commit_args(opts: &CommitOptions) -> Vec<String> {
    let mut args: Vec<String> = vec!["commit".into(), "-m".into(), opts.message.clone()];
    if opts.amend {
        args.push("--amend".into());
    }
    if opts.allow_empty {
        args.push("--allow-empty".into());
    }
    if opts.no_verify {
        args.push("--no-verify".into());
    }
    match &opts.sign {
        SignMode::None => args.push("--no-gpg-sign".into()),
        SignMode::WithKey(key) => args.push(format!("-S{}", key.0)),
        SignMode::Default => {}
    }
    args
}

#[cfg(test)]
mod tests {
    use super::*;

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
            ..Default::default()
        });
        assert_eq!(
            args,
            vec!["commit", "-m", "msg", "--amend", "--allow-empty", "--no-gpg-sign"]
        );
    }

    #[test]
    fn commit_args_no_verify() {
        let args = build_commit_args(&CommitOptions {
            message: "msg".into(),
            no_verify: true,
            ..Default::default()
        });
        assert_eq!(args, vec!["commit", "-m", "msg", "--no-verify"]);
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
}
