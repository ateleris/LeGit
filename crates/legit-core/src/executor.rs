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
//! It also carries the Console's needs — `stream` and `cancel` — so a
//! session can hold `Arc<dyn GitExecutor>` and be backed by something other
//! than a local process (a remote agent). Both have defaults that are
//! correct for scripted fakes. `run_with_op_progress` behaves exactly like
//! `run_with_op` for the caller (full output at the end), progress reporting
//! being a side channel through the runner's process-wide observer - so the
//! default implementation just delegates and scripted fakes need no changes.

use crate::runner::{GitRunner, OperationId, RunOutput, RunOutputBytes, RunnerError, RunnerEvent};
use async_trait::async_trait;
use tokio::sync::mpsc;

#[async_trait]
pub trait GitExecutor: Send + Sync + 'static {
    /// Run a one-shot `git` invocation and collect the full output.
    async fn run(&self, args: &[&str]) -> Result<RunOutput, RunnerError>;

    /// `run` with caller-declared EXPECTED non-zero exit codes: the result is
    /// identical, but the invocation log (Git Log panel) records those exits
    /// as OK instead of failed (`config --get` exits 1 for "key unset" - an
    /// answer, not a failure). The default delegates to `run`, which is
    /// correct for scripted fakes: they do no logging, and sequence contracts
    /// are unaffected.
    async fn run_expecting(
        &self,
        args: &[&str],
        ok_exit_codes: &[i32],
    ) -> Result<RunOutput, RunnerError> {
        let _ = ok_exit_codes;
        self.run(args).await
    }

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

    /// Line-streamed run (the Console's path). The BOUNDED `events_tx` is the
    /// backpressure contract: when the receiver stops draining, the producer
    /// must eventually block so git itself blocks (pager semantics). The
    /// default degrades to `run_with_op` and replays the collected output as
    /// events — sequence-correct for scripted fakes; `GitRunner` overrides it
    /// with true incremental streaming.
    async fn stream(
        &self,
        args: &[&str],
        op_id: OperationId,
        events_tx: mpsc::Sender<RunnerEvent>,
    ) -> Result<i32, RunnerError> {
        let out = self.run_with_op(args, op_id).await?;
        for line in out.stdout.lines() {
            if events_tx
                .send(RunnerEvent::Stdout { line: line.to_string() })
                .await
                .is_err()
            {
                break;
            }
        }
        for line in out.stderr.lines() {
            if events_tx
                .send(RunnerEvent::Stderr { line: line.to_string() })
                .await
                .is_err()
            {
                break;
            }
        }
        let _ = events_tx
            .send(RunnerEvent::Finished {
                exit_code: out.exit_code,
                success: out.success,
                duration_ms: out.duration_ms,
            })
            .await;
        Ok(out.exit_code.unwrap_or(-1))
    }

    /// Cancel an in-flight operation by id. Returns `true` if the id was
    /// found. The default (not found) is correct for scripted fakes, whose
    /// runs complete synchronously.
    fn cancel(&self, op_id: &OperationId) -> bool {
        let _ = op_id;
        false
    }
}

#[async_trait]
impl GitExecutor for GitRunner {
    async fn run(&self, args: &[&str]) -> Result<RunOutput, RunnerError> {
        GitRunner::run(self, args).await
    }

    async fn run_expecting(
        &self,
        args: &[&str],
        ok_exit_codes: &[i32],
    ) -> Result<RunOutput, RunnerError> {
        GitRunner::run_expecting(self, args, ok_exit_codes).await
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

    async fn stream(
        &self,
        args: &[&str],
        op_id: OperationId,
        events_tx: mpsc::Sender<RunnerEvent>,
    ) -> Result<i32, RunnerError> {
        GitRunner::stream(self, args, op_id, events_tx).await
    }

    fn cancel(&self, op_id: &OperationId) -> bool {
        GitRunner::cancel(self, op_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Minimal executor relying on every defaulted method — pins the default
    /// `stream` contract: stdout lines, then stderr lines, then exactly one
    /// Finished carrying the run's exit metadata.
    struct CannedExecutor(RunOutput);

    #[async_trait]
    impl GitExecutor for CannedExecutor {
        async fn run(&self, _args: &[&str]) -> Result<RunOutput, RunnerError> {
            Ok(self.0.clone())
        }
        async fn run_with_op(
            &self,
            _args: &[&str],
            _op_id: OperationId,
        ) -> Result<RunOutput, RunnerError> {
            Ok(self.0.clone())
        }
        async fn run_with_stdin(
            &self,
            _args: &[&str],
            _stdin_data: &str,
        ) -> Result<RunOutput, RunnerError> {
            Ok(self.0.clone())
        }
        async fn run_with_env(
            &self,
            _args: &[&str],
            _extra_env: &[(&str, &str)],
        ) -> Result<RunOutput, RunnerError> {
            Ok(self.0.clone())
        }
    }

    #[tokio::test]
    async fn default_stream_replays_output_then_finished_once() {
        let exec = CannedExecutor(RunOutput {
            stdout: "a\nb\n".into(),
            stderr: "warn\n".into(),
            exit_code: Some(3),
            success: false,
            duration_ms: 7,
        });
        let (tx, mut rx) = mpsc::channel(16);
        let exit = exec
            .stream(&["status"], OperationId::new(), tx)
            .await
            .expect("stream ok");
        assert_eq!(exit, 3);

        let mut events = Vec::new();
        while let Some(ev) = rx.recv().await {
            events.push(ev);
        }
        assert_eq!(events.len(), 4);
        assert!(matches!(&events[0], RunnerEvent::Stdout { line } if line == "a"));
        assert!(matches!(&events[1], RunnerEvent::Stdout { line } if line == "b"));
        assert!(matches!(&events[2], RunnerEvent::Stderr { line } if line == "warn"));
        assert!(matches!(
            &events[3],
            RunnerEvent::Finished { exit_code: Some(3), success: false, duration_ms: 7 }
        ));
    }

    #[tokio::test]
    async fn default_cancel_reports_not_found() {
        let exec = CannedExecutor(RunOutput {
            stdout: String::new(),
            stderr: String::new(),
            exit_code: Some(0),
            success: true,
            duration_ms: 0,
        });
        assert!(!exec.cancel(&OperationId::new()));
    }
}
