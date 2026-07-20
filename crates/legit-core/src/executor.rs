//! `GitExecutor` - the seam between `GitCliBackend` and process execution.
//!
//! `GitCliBackend`'s composed flows (auto-stash sequencing, conflict
//! resolution, tag/commit argument assembly, ...) encode assumptions about
//! which git commands run in which order and how their outputs are reacted
//! to. Those assumptions must be testable without spawning a real `git`
//! binary, so the backend is generic over this trait: production uses
//! `GitRunner` (the only implementation that spawns processes), tests inject
//! a scripted fake that asserts the exact command sequence and returns
//! canned `RunOutput`s.
//!
//! The trait deliberately mirrors the subset of `GitRunner`'s API the
//! backend uses: one-shot runs, cancellable runs, and stdin-fed runs.
//! Free-form output streaming stays on `GitRunner` itself - the Console
//! drives it directly, not through `GitBackend`. The one structured
//! exception is `run_with_op_progress`: to the backend it behaves exactly
//! like `run_with_op` (full output at the end), progress reporting being a
//! side channel through the runner's process-wide observer - so the default
//! implementation just delegates and scripted fakes need no changes.

use crate::runner::{GitRunner, OperationId, RunOutput, RunOutputBytes, RunnerError};
use async_trait::async_trait;

#[async_trait]
pub trait GitExecutor: Send + Sync + 'static {
    /// Run a one-shot `git` invocation and collect the full output.
    async fn run(&self, args: &[&str]) -> Result<RunOutput, RunnerError>;

    /// Run under a caller-supplied operation id so the caller can cancel it.
    async fn run_with_op(
        &self,
        args: &[&str],
        op_id: OperationId,
    ) -> Result<RunOutput, RunnerError>;

    /// Run with `stdin_data` fed to standard input (`git apply` reads the
    /// patch from stdin).
    async fn run_with_stdin(
        &self,
        args: &[&str],
        stdin_data: &str,
    ) -> Result<RunOutput, RunnerError>;

    /// `run_with_stdin` with RAW stdout bytes, for byte-size-framed output
    /// (`cat-file --batch`) where a lossy UTF-8 conversion would corrupt the
    /// declared byte counts. The default delegates to `run_with_stdin` (fine
    /// for scripted fakes, whose canned output is valid UTF-8); `GitRunner`
    /// overrides it with the truly byte-safe path.
    async fn run_with_stdin_bytes(
        &self,
        args: &[&str],
        stdin_data: &str,
    ) -> Result<RunOutputBytes, RunnerError> {
        let out = self.run_with_stdin(args, stdin_data).await?;
        Ok(RunOutputBytes {
            stdout: out.stdout.into_bytes(),
            stderr: out.stderr,
            exit_code: out.exit_code,
            success: out.success,
            duration_ms: out.duration_ms,
        })
    }

    /// Run with per-invocation environment overrides that win over the
    /// hardened base env (e.g. `GIT_EDITOR=true` for `merge/rebase
    /// --continue`, whose commit step would otherwise fail on the base
    /// `GIT_EDITOR=false`).
    async fn run_with_env(
        &self,
        args: &[&str],
        extra_env: &[(&str, &str)],
    ) -> Result<RunOutput, RunnerError>;

    /// Cancellable run that additionally streams parsed `--progress` meter
    /// updates to the runner's process-wide progress observer. Semantically
    /// identical to `run_with_op` for the caller; the default implementation
    /// simply delegates (no progress reporting).
    async fn run_with_op_progress(
        &self,
        args: &[&str],
        op_id: OperationId,
    ) -> Result<RunOutput, RunnerError> {
        self.run_with_op(args, op_id).await
    }
}

#[async_trait]
impl GitExecutor for GitRunner {
    async fn run(&self, args: &[&str]) -> Result<RunOutput, RunnerError> {
        GitRunner::run(self, args).await
    }

    async fn run_with_op(
        &self,
        args: &[&str],
        op_id: OperationId,
    ) -> Result<RunOutput, RunnerError> {
        GitRunner::run_with_op(self, args, op_id).await
    }

    async fn run_with_stdin(
        &self,
        args: &[&str],
        stdin_data: &str,
    ) -> Result<RunOutput, RunnerError> {
        GitRunner::run_with_stdin(self, args, stdin_data).await
    }

    async fn run_with_stdin_bytes(
        &self,
        args: &[&str],
        stdin_data: &str,
    ) -> Result<RunOutputBytes, RunnerError> {
        GitRunner::run_with_stdin_bytes(self, args, stdin_data).await
    }

    async fn run_with_env(
        &self,
        args: &[&str],
        extra_env: &[(&str, &str)],
    ) -> Result<RunOutput, RunnerError> {
        GitRunner::run_with_env(self, args, extra_env).await
    }

    async fn run_with_op_progress(
        &self,
        args: &[&str],
        op_id: OperationId,
    ) -> Result<RunOutput, RunnerError> {
        GitRunner::run_with_op_progress(self, args, op_id).await
    }
}
