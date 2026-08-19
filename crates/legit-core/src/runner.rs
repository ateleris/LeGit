//! `GitRunner` — the single chokepoint that invokes `git`.
//!
//! Execution only. Never parses. See DESIGN.md §3.1, §3.2.
//!
//! Every Git operation in LeGit (Console included) goes through this
//! struct. Each invocation:
//!
//! - sets a hardened base environment (`GIT_EDITOR=false`,
//!   `GIT_TERMINAL_PROMPT=0`, `LANG=C.UTF-8`) so subprocesses can't hang
//!   waiting for prompts and ASCII parsers stay deterministic;
//! - is logged via `tracing` with args, working dir, duration, exit code;
//! - is cancellable through an `OperationId` recorded in the runner's
//!   `running` map (the only thing the runner ever shares between callers).

use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Instant;
use thiserror::Error;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::{mpsc, oneshot};
use tracing::{debug, info, instrument, warn};
use uuid::Uuid;

/// Minimum supported `git` version (DESIGN.md §7.6 — set for SSH signing).
pub const MIN_SUPPORTED_GIT_VERSION: (u32, u32, u32) = (2, 34, 0);

/// Stable identifier for an in-flight `git` invocation. Used for cancellation
/// and for keying progress events emitted to the UI.
#[derive(Debug, Clone, Hash, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(transparent)]
pub struct OperationId(pub String);

impl OperationId {
    pub fn new() -> Self {
        Self(Uuid::new_v4().to_string())
    }
}

impl Default for OperationId {
    fn default() -> Self {
        Self::new()
    }
}

impl std::fmt::Display for OperationId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// Raw output from a one-shot `git` invocation.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct RunOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub success: bool,
    pub duration_ms: u64,
}

/// Like `RunOutput`, but with raw stdout bytes - for commands whose output
/// is byte-size framed (`cat-file --batch`), where the lossy UTF-8
/// conversion of `RunOutput.stdout` would corrupt the declared byte counts.
#[derive(Debug, Clone)]
pub struct RunOutputBytes {
    pub stdout: Vec<u8>,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub success: bool,
    pub duration_ms: u64,
}

/// A completed `git` invocation, reported to the process-wide observer (the app
/// forwards these to the UI as a git command log). Excludes stdout (often large)
/// but keeps stderr so failures are diagnosable.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct GitInvocation {
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub exit_code: Option<i32>,
    pub success: bool,
    pub duration_ms: u64,
    pub stderr: String,
}

type InvocationObserver = std::sync::Arc<dyn Fn(GitInvocation) + Send + Sync>;
static INVOCATION_OBSERVER: std::sync::OnceLock<InvocationObserver> = std::sync::OnceLock::new();

/// Install a process-wide observer notified after every `git` invocation. Set
/// once at startup; the app uses it to forward a git command log to the UI.
pub fn set_invocation_observer(observer: InvocationObserver) {
    let _ = INVOCATION_OBSERVER.set(observer);
}

fn report_invocation(inv: GitInvocation) {
    if let Some(obs) = INVOCATION_OBSERVER.get() {
        obs(inv);
    }
}

type ProgressObserver =
    std::sync::Arc<dyn Fn(&OperationId, crate::progress::RemoteProgress) + Send + Sync>;
static PROGRESS_OBSERVER: std::sync::OnceLock<ProgressObserver> = std::sync::OnceLock::new();

/// Install a process-wide observer notified with parsed `--progress` meter
/// updates from invocations run via `run_with_op_progress`, keyed by their
/// `OperationId`. Set once at startup; the app forwards these to the UI.
pub fn set_progress_observer(observer: ProgressObserver) {
    let _ = PROGRESS_OBSERVER.set(observer);
}

fn report_progress(op_id: &OperationId, progress: crate::progress::RemoteProgress) {
    if let Some(obs) = PROGRESS_OBSERVER.get() {
        obs(op_id, progress);
    }
}

static GLOBAL_BASE_ENV: std::sync::OnceLock<Vec<(String, String)>> = std::sync::OnceLock::new();

/// Install process-wide extra base-environment variables appended to the
/// hardened base env of every `GitRunner` constructed afterwards (per-runner
/// snapshot, like the rest of the base env). Set once at startup, before any
/// runner exists - the app uses it to point git's credential machinery at
/// the in-app credential broker (`GIT_CONFIG_*` + the broker's endpoint).
/// Applied after `default_base_env`, so it may override hardened defaults.
pub fn set_global_base_env(vars: Vec<(String, String)>) {
    let _ = GLOBAL_BASE_ENV.set(vars);
}

/// The hardened defaults plus any registered process-wide extras.
fn base_env_with_globals() -> Vec<(String, String)> {
    let mut env = default_base_env();
    if let Some(extra) = GLOBAL_BASE_ENV.get() {
        env.extend(extra.iter().cloned());
    }
    env
}

/// Streaming event emitted while a `git` invocation is in flight.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RunnerEvent {
    Stdout { line: String },
    Stderr { line: String },
    Finished {
        exit_code: Option<i32>,
        success: bool,
        duration_ms: u64,
    },
}

#[derive(Debug, Error)]
pub enum RunnerError {
    #[error("failed to spawn git: {0}")]
    Spawn(#[source] std::io::Error),

    #[error("git io error: {0}")]
    Io(#[source] std::io::Error),

    #[error("git executable not found at {0}")]
    GitNotFound(PathBuf),

    #[error("operation id {0} is already in flight")]
    DuplicateOperation(OperationId),
}

/// In-flight operation handle stored in the runner's cancellation map.
struct RunningOp {
    /// One-shot signal that asks the spawn task to kill the child.
    kill: oneshot::Sender<()>,
}

/// `GitRunner` is bound to a working directory (typically a repo's working
/// tree). The same runner type is also used for the unbound startup check —
/// see `check_version`.
#[derive(Clone)]
pub struct GitRunner {
    git_path: PathBuf,
    cwd: Option<PathBuf>,
    base_env: Arc<Vec<(String, String)>>,
    running: Arc<Mutex<HashMap<OperationId, RunningOp>>>,
}

impl GitRunner {
    /// Build a runner for a specific repository working tree.
    pub fn for_repo(git_path: impl Into<PathBuf>, cwd: impl Into<PathBuf>) -> Self {
        Self {
            git_path: git_path.into(),
            cwd: Some(cwd.into()),
            base_env: Arc::new(base_env_with_globals()),
            running: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Build a runner without a working directory — used for `git --version`
    /// and other invocations that should not be bound to a repo.
    pub fn unbound(git_path: impl Into<PathBuf>) -> Self {
        Self {
            git_path: git_path.into(),
            cwd: None,
            base_env: Arc::new(base_env_with_globals()),
            running: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn git_path(&self) -> &Path {
        &self.git_path
    }

    pub fn cwd(&self) -> Option<&Path> {
        self.cwd.as_deref()
    }

    /// Run a one-shot `git` invocation and collect the full output.
    #[instrument(level = "info", skip(self), fields(cwd = ?self.cwd, args = ?args))]
    pub async fn run(&self, args: &[&str]) -> Result<RunOutput, RunnerError> {
        self.run_inner(args, &[], OperationId::new(), &[]).await
    }

    /// Like `run`, but the caller declares non-zero exit codes that are
    /// EXPECTED outcomes - `config --get` exits 1 for "key unset",
    /// `--unset` 5 for "was already absent", `merge-base` 1 for "no common
    /// ancestor". The invocation log (and the Git Log panel it feeds) records
    /// those exits as OK instead of failed; the returned `RunOutput` is
    /// unchanged (`success` stays `exit == 0`), so callers still branch on
    /// the exit code themselves.
    pub async fn run_expecting(
        &self,
        args: &[&str],
        ok_exit_codes: &[i32],
    ) -> Result<RunOutput, RunnerError> {
        self.run_inner(args, &[], OperationId::new(), ok_exit_codes).await
    }

    /// Run a one-shot `git` invocation under a caller-supplied operation id,
    /// so the caller can cancel it.
    pub async fn run_with_op(
        &self,
        args: &[&str],
        op_id: OperationId,
    ) -> Result<RunOutput, RunnerError> {
        self.run_inner(args, &[], op_id, &[]).await
    }

    /// Run with per-invocation environment overrides, applied *after* the
    /// hardened base env so they win. Needed where a single command must relax
    /// one hardening default - e.g. `merge/rebase --continue` conclude with a
    /// commit whose message step consults `GIT_EDITOR`; the base
    /// `GIT_EDITOR=false` would fail it (and env beats any `-c core.editor=…`),
    /// so those pass `GIT_EDITOR=true` to accept the prepared message.
    pub async fn run_with_env(
        &self,
        args: &[&str],
        extra_env: &[(&str, &str)],
    ) -> Result<RunOutput, RunnerError> {
        self.run_inner(args, extra_env, OperationId::new(), &[]).await
    }

    async fn run_inner(
        &self,
        args: &[&str],
        extra_env: &[(&str, &str)],
        op_id: OperationId,
        ok_exit_codes: &[i32],
    ) -> Result<RunOutput, RunnerError> {
        let started = Instant::now();
        let mut cmd = self.build_command_with_env(args, extra_env);
        cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

        let mut child = self.spawn_child(&mut cmd)?;

        let (kill_tx, kill_rx) = oneshot::channel();
        self.try_insert_running(op_id.clone(), kill_tx)?;

        let stdout = child.stdout.take().expect("stdout piped");
        let stderr = child.stderr.take().expect("stderr piped");

        let stdout_task = tokio::spawn(read_to_string(stdout));
        let stderr_task = tokio::spawn(read_to_string(stderr));

        let exit_code = tokio::select! {
            _ = kill_rx => {
                warn!(op_id = %op_id, "git invocation cancelled — killing child");
                let status = terminate_tree(&mut child).await.map_err(RunnerError::Io)?;
                self.remove_running(&op_id);
                // Do NOT wait for pipe EOF here: a descendant that survived
                // the kill (Git for Windows' `cmd\git.exe` shim wraps the
                // real git) still holds the write ends, and EOF would arrive
                // only after its ENTIRE remaining output - the clone cancel
                // button that "did nothing". Abort the readers instead;
                // dropping our read ends kills such an orphan on its next
                // write (broken pipe). Same fix as `stream`'s cancel arm.
                stdout_task.abort();
                stderr_task.abort();
                let stdout = stdout_task.await.unwrap_or_default();
                let stderr = stderr_task.await.unwrap_or_default();
                log_invocation(self.cwd.as_deref(), args, started, status.code(), false, &stderr);
                return Ok(RunOutput {
                    stdout,
                    stderr,
                    exit_code: status.code(),
                    success: false,
                    duration_ms: started.elapsed().as_millis() as u64,
                });
            }
            status = child.wait() => {
                status.map_err(RunnerError::Io)?
            }
        };

        self.remove_running(&op_id);

        let stdout = stdout_task.await.unwrap_or_default();
        let stderr = stderr_task.await.unwrap_or_default();

        log_invocation(
            self.cwd.as_deref(),
            args,
            started,
            exit_code.code(),
            logged_ok(exit_code.success(), exit_code.code(), ok_exit_codes),
            &stderr,
        );

        Ok(RunOutput {
            stdout,
            stderr,
            exit_code: exit_code.code(),
            success: exit_code.success(),
            duration_ms: started.elapsed().as_millis() as u64,
        })
    }

    /// Like `run_with_op`, but reads stderr incrementally and reports parsed
    /// `--progress` meter updates to the process-wide progress observer,
    /// keyed by `op_id`. Git delimits meter updates with `\r` (not `\n`), so
    /// stderr is split on both. Recognized meter segments are *excluded* from
    /// the returned/logged stderr (they are high-volume redraw noise); every
    /// other stderr line is kept, so error classification is unaffected.
    /// Callers must pass `--progress` themselves — stderr is a pipe, and git
    /// suppresses the meter on non-TTYs otherwise.
    pub async fn run_with_op_progress(
        &self,
        args: &[&str],
        op_id: OperationId,
    ) -> Result<RunOutput, RunnerError> {
        use tokio::io::AsyncReadExt;

        let started = Instant::now();
        let mut cmd = self.build_command(args);
        cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

        let mut child = self.spawn_child(&mut cmd)?;

        let (kill_tx, kill_rx) = oneshot::channel();
        self.try_insert_running(op_id.clone(), kill_tx)?;

        let stdout = child.stdout.take().expect("stdout piped");
        let mut stderr = child.stderr.take().expect("stderr piped");

        let stdout_task = tokio::spawn(read_to_string(stdout));
        let op_for_reader = op_id.clone();
        let stderr_task = tokio::spawn(async move {
            let mut splitter = crate::progress::SegmentSplitter::default();
            let mut kept = String::new();
            let mut on_segment = |seg: &str| match crate::progress::parse_progress(seg) {
                Some(p) => report_progress(&op_for_reader, p),
                None => {
                    if !kept.is_empty() {
                        kept.push('\n');
                    }
                    kept.push_str(seg);
                }
            };
            let mut chunk = [0u8; 4096];
            loop {
                match stderr.read(&mut chunk).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => splitter.feed(&chunk[..n], &mut on_segment),
                }
            }
            splitter.finish(&mut on_segment);
            kept
        });

        let exit_code = tokio::select! {
            _ = kill_rx => {
                warn!(op_id = %op_id, "git invocation cancelled — killing child");
                let status = terminate_tree(&mut child).await.map_err(RunnerError::Io)?;
                self.remove_running(&op_id);
                // Do NOT wait for pipe EOF here: a descendant that survived
                // the kill (Git for Windows' `cmd\git.exe` shim wraps the
                // real git) still holds the write ends, and EOF would arrive
                // only after its ENTIRE remaining output - the clone cancel
                // button that "did nothing". Abort the readers instead;
                // dropping our read ends kills such an orphan on its next
                // write (broken pipe). Same fix as `stream`'s cancel arm.
                stdout_task.abort();
                stderr_task.abort();
                let stdout = stdout_task.await.unwrap_or_default();
                let stderr = stderr_task.await.unwrap_or_default();
                log_invocation(self.cwd.as_deref(), args, started, status.code(), false, &stderr);
                return Ok(RunOutput {
                    stdout,
                    stderr,
                    exit_code: status.code(),
                    success: false,
                    duration_ms: started.elapsed().as_millis() as u64,
                });
            }
            status = child.wait() => {
                status.map_err(RunnerError::Io)?
            }
        };

        self.remove_running(&op_id);

        let stdout = stdout_task.await.unwrap_or_default();
        let stderr = stderr_task.await.unwrap_or_default();

        log_invocation(self.cwd.as_deref(), args, started, exit_code.code(), exit_code.success(), &stderr);

        Ok(RunOutput {
            stdout,
            stderr,
            exit_code: exit_code.code(),
            success: exit_code.success(),
            duration_ms: started.elapsed().as_millis() as u64,
        })
    }

    /// Run a one-shot `git` invocation, feeding `stdin_data` to its standard
    /// input (used by `git apply`, which reads the patch from stdin). Readers
    /// are spawned before the write so a large patch can't deadlock against a
    /// child that starts emitting output before consuming all of its input.
    pub async fn run_with_stdin(
        &self,
        args: &[&str],
        stdin_data: &str,
    ) -> Result<RunOutput, RunnerError> {
        use tokio::io::AsyncWriteExt;

        let started = Instant::now();
        let mut cmd = self.build_command(args);
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = self.spawn_child(&mut cmd)?;

        let mut stdin = child.stdin.take().expect("stdin piped");
        let stdout = child.stdout.take().expect("stdout piped");
        let stderr = child.stderr.take().expect("stderr piped");

        let stdout_task = tokio::spawn(read_to_string(stdout));
        let stderr_task = tokio::spawn(read_to_string(stderr));

        stdin
            .write_all(stdin_data.as_bytes())
            .await
            .map_err(RunnerError::Io)?;
        // Close stdin so git sees EOF and proceeds.
        drop(stdin);

        let status = child.wait().await.map_err(RunnerError::Io)?;
        let stdout = stdout_task.await.unwrap_or_default();
        let stderr = stderr_task.await.unwrap_or_default();

        log_invocation(self.cwd.as_deref(), args, started, status.code(), status.success(), &stderr);

        Ok(RunOutput {
            stdout,
            stderr,
            exit_code: status.code(),
            success: status.success(),
            duration_ms: started.elapsed().as_millis() as u64,
        })
    }

    /// `run_with_stdin` with RAW stdout bytes (see `RunOutputBytes`). Used by
    /// `cat-file --batch`, whose output frames blob contents by byte count.
    pub async fn run_with_stdin_bytes(
        &self,
        args: &[&str],
        stdin_data: &str,
    ) -> Result<RunOutputBytes, RunnerError> {
        use tokio::io::AsyncWriteExt;

        let started = Instant::now();
        let mut cmd = self.build_command(args);
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = self.spawn_child(&mut cmd)?;

        let mut stdin = child.stdin.take().expect("stdin piped");
        let stdout = child.stdout.take().expect("stdout piped");
        let stderr = child.stderr.take().expect("stderr piped");

        let stdout_task = tokio::spawn(async move {
            use tokio::io::AsyncReadExt;
            let mut buf = Vec::new();
            let mut reader = stdout;
            let _ = reader.read_to_end(&mut buf).await;
            buf
        });
        let stderr_task = tokio::spawn(read_to_string(stderr));

        stdin
            .write_all(stdin_data.as_bytes())
            .await
            .map_err(RunnerError::Io)?;
        // Close stdin so git sees EOF and proceeds.
        drop(stdin);

        let status = child.wait().await.map_err(RunnerError::Io)?;
        let stdout = stdout_task.await.unwrap_or_default();
        let stderr = stderr_task.await.unwrap_or_default();

        log_invocation(self.cwd.as_deref(), args, started, status.code(), status.success(), &stderr);

        Ok(RunOutputBytes {
            stdout,
            stderr,
            exit_code: status.code(),
            success: status.success(),
            duration_ms: started.elapsed().as_millis() as u64,
        })
    }

    /// Stream stdout/stderr line-by-line through `events_tx`.
    ///
    /// Sends `RunnerEvent::Finished` exactly once before returning.
    ///
    /// The channel is BOUNDED (capacity chosen by the caller): when the
    /// receiver stops consuming, the reader tasks block on `send`, the OS
    /// pipe fills, and git itself blocks on write - the same backpressure a
    /// pager applies. The Git Console's paging (`-- More --`) is built on
    /// this; a consumer that always drains promptly is unaffected.
    pub async fn stream(
        &self,
        args: &[&str],
        op_id: OperationId,
        events_tx: mpsc::Sender<RunnerEvent>,
    ) -> Result<i32, RunnerError> {
        let started = Instant::now();
        let mut cmd = self.build_command(args);
        cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

        let mut child = self.spawn_child(&mut cmd)?;

        let (kill_tx, kill_rx) = oneshot::channel();
        self.try_insert_running(op_id.clone(), kill_tx)?;

        let stdout = child.stdout.take().expect("stdout piped");
        let stderr = child.stderr.take().expect("stderr piped");

        let stdout_tx = events_tx.clone();
        let stdout_task = tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if stdout_tx.send(RunnerEvent::Stdout { line }).await.is_err() {
                    break;
                }
            }
        });

        let stderr_tx = events_tx.clone();
        let stderr_task = tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if stderr_tx.send(RunnerEvent::Stderr { line }).await.is_err() {
                    break;
                }
            }
        });

        let status = tokio::select! {
            _ = kill_rx => {
                warn!(op_id = %op_id, "streaming git invocation cancelled — killing child");
                let status = terminate_tree(&mut child).await.map_err(RunnerError::Io)?;
                // The kill hits only the direct child, but git spawns its
                // own children that inherit the pipes (Git for Windows'
                // `cmd\git.exe` shim wraps the real git; git forks helpers
                // like pack-objects). Waiting for pipe EOF would wait for
                // an orphan's ENTIRE remaining output — seconds after a
                // cancel. Abort the readers instead: dropping our read
                // ends kills an orphaned writer on its next write (broken
                // pipe), exactly like quitting a pager does.
                stdout_task.abort();
                stderr_task.abort();
                status
            }
            status = child.wait() => {
                status.map_err(RunnerError::Io)?
            }
        };

        self.remove_running(&op_id);

        // Drain reader tasks (resolve immediately when aborted above).
        let _ = stdout_task.await;
        let _ = stderr_task.await;

        let exit_code = status.code();
        log_invocation(self.cwd.as_deref(), args, started, exit_code, status.success(), "<streamed>");

        let _ = events_tx
            .send(RunnerEvent::Finished {
                exit_code,
                success: status.success(),
                duration_ms: started.elapsed().as_millis() as u64,
            })
            .await;

        Ok(exit_code.unwrap_or(-1))
    }

    /// Cancel an in-flight operation. Returns `true` if the id was found.
    pub fn cancel(&self, op_id: &OperationId) -> bool {
        let removed = self
            .running
            .lock()
            .expect("running map poisoned")
            .remove(op_id);
        if let Some(op) = removed {
            let _ = op.kill.send(());
            true
        } else {
            false
        }
    }

    fn build_command(&self, args: &[&str]) -> Command {
        self.build_command_with_env(args, &[])
    }

    fn build_command_with_env(&self, args: &[&str], extra_env: &[(&str, &str)]) -> Command {
        let mut cmd = Command::new(&self.git_path);
        cmd.args(args);
        if let Some(cwd) = &self.cwd {
            cmd.current_dir(cwd);
        }
        // Inherit the OS environment, scrub the variables that would harm
        // determinism or correctness, then force our hardened overrides. We do
        // NOT nuke the whole environment: Git for Windows' HTTPS transport needs
        // OS vars such as `SystemRoot`/`WINDIR` to initialize winsock — without
        // them libcurl can't spawn its resolver thread and fails with
        // "getaddrinfo() thread failed to start". Inheriting also lets proxy
        // config (`http_proxy`, …) and ssh-agent (`SSH_AUTH_SOCK`) work.
        //
        // Scrubbed: every `GIT_*` var (so a stray inherited `GIT_DIR`/`GIT_CONFIG`/
        // `GIT_SSH_COMMAND`/… can't override the repo we target or change git's
        // behavior) and the locale vars (`LANG`/`LANGUAGE`/`LC_*`), which we pin
        // to `C.UTF-8` below for deterministic, ASCII-parseable output.
        cmd.env_clear();
        for (k, v) in std::env::vars_os() {
            let upper = k.to_string_lossy().to_ascii_uppercase();
            if upper.starts_with("GIT_")
                || upper == "LANG"
                || upper == "LANGUAGE"
                || upper.starts_with("LC_")
            {
                continue;
            }
            cmd.env(&k, &v);
        }
        // Hardened overrides: no prompts/editor, deterministic locale. These win
        // over anything inherited above (GIT_* were already scrubbed).
        for (k, v) in self.base_env.iter() {
            cmd.env(k, v);
        }
        // Per-invocation overrides win over the base env (applied last).
        for (k, v) in extra_env {
            cmd.env(k, v);
        }
        cmd.kill_on_drop(true);
        // Each git leads its own process group so cancellation can kill the
        // whole tree: git forks helpers (remote-https, index-pack, ...) that
        // inherit our pipes and do the real work, and killing only the
        // direct child leaves them running (see `kill_tree`).
        #[cfg(unix)]
        cmd.process_group(0);
        // Linux: spawned gits must not outlive the app. If the LeGit process
        // dies (crash included) the kernel SIGKILLs the direct child; its
        // helpers then exit on broken pipes. Runs in the child between fork
        // and exec. The Windows counterpart is the `app_job` job object.
        #[cfg(target_os = "linux")]
        unsafe {
            cmd.pre_exec(|| {
                libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL);
                Ok(())
            });
        }
        // Release builds are a GUI app (`windows_subsystem = "windows"`), so the
        // spawned git.exe has no console to inherit and Windows creates a fresh
        // one per invocation — a visible flash on every git call. CREATE_NO_WINDOW
        // suppresses that. Dev builds never flashed only because they run
        // attached to the dev terminal, which children inherit.
        #[cfg(windows)]
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        cmd
    }

    /// Record an in-flight operation, rejecting an id that is already in
    /// flight. A plain `insert` would EVICT the earlier entry: dropping its
    /// kill sender closes the channel, which completes the earlier
    /// invocation's cancel arm and kills that child. Ids are minted as UUIDs,
    /// so a collision is always a caller bug - fail the new invocation, never
    /// the running one. (Checked-and-inserted under one lock; the colliding
    /// caller's just-spawned child is killed via `kill_on_drop` on the error
    /// return.)
    fn try_insert_running(
        &self,
        op_id: OperationId,
        kill: oneshot::Sender<()>,
    ) -> Result<(), RunnerError> {
        match self
            .running
            .lock()
            .expect("running map poisoned")
            .entry(op_id.clone())
        {
            std::collections::hash_map::Entry::Occupied(_) => {
                warn!(op_id = %op_id, "duplicate operation id - rejecting new invocation");
                Err(RunnerError::DuplicateOperation(op_id))
            }
            std::collections::hash_map::Entry::Vacant(v) => {
                v.insert(RunningOp { kill });
                Ok(())
            }
        }
    }

    fn remove_running(&self, op_id: &OperationId) {
        self.running
            .lock()
            .expect("running map poisoned")
            .remove(op_id);
    }

    /// Spawn `cmd`, mapping a not-found binary to `GitNotFound`, and enroll
    /// the child in the app-lifetime process-tree controls (the Windows job
    /// object; the Unix side is configured pre-spawn in
    /// `build_command_with_env`). Every spawn in the runner must go through
    /// here.
    fn spawn_child(&self, cmd: &mut Command) -> Result<tokio::process::Child, RunnerError> {
        let child = cmd.spawn().map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                RunnerError::GitNotFound(self.git_path.clone())
            } else {
                RunnerError::Spawn(e)
            }
        })?;
        #[cfg(windows)]
        app_job::assign(&child);
        Ok(child)
    }
}

/// Terminate a cancelled invocation's whole process tree, not just the
/// direct child. git forks helpers (remote-https, index-pack, ...) that
/// inherit our pipes and do the real work, so killing only the direct child
/// can leave the operation effectively running (on Git for Windows even the
/// real git itself: `cmd\git.exe` is a shim around it).
///
/// Unix: the child leads its own process group (see `build_command_with_env`),
/// so one group signal reaches every descendant - and the termination is
/// gentle first: SIGTERM lets git run its own cleanup handlers (a terminated
/// clone removes its partial target, lockfiles get released) before any hard
/// kill. The group is swept with SIGKILL afterwards for stragglers.
///
/// Windows: there is no group signal here; only the direct child is killed,
/// survivors die on broken pipe once the reader tasks are aborted, and the
/// app-lifetime job object (`app_job`) reaps any straggler at exit.
/// How long a SIGTERMed git gets to run its cleanup handlers before the hard
/// SIGKILL. Long enough for normal junk removal and lock release, short
/// enough that a cancel of a signal-ignoring process still feels immediate.
#[cfg(unix)]
const TERM_GRACE: std::time::Duration = std::time::Duration::from_secs(2);

async fn terminate_tree(
    child: &mut tokio::process::Child,
) -> std::io::Result<std::process::ExitStatus> {
    #[cfg(unix)]
    if let Some(pid) = child.id() {
        // Negative pid: signal the whole process group the child leads.
        let pgid = -(pid as i32);
        unsafe {
            libc::kill(pgid, libc::SIGTERM);
        }
        let status = match tokio::time::timeout(TERM_GRACE, child.wait()).await {
            Ok(status) => status?,
            Err(_elapsed) => {
                warn!("cancelled git ignored SIGTERM - escalating to SIGKILL");
                unsafe {
                    libc::kill(pgid, libc::SIGKILL);
                }
                child.wait().await?
            }
        };
        // Sweep the group for stragglers that outlived the direct child.
        // (Daemons git means to leave behind, e.g. fsmonitor--daemon, have
        // detached into their own session and are not hit by this.)
        unsafe {
            libc::kill(pgid, libc::SIGKILL);
        }
        return Ok(status);
    }
    let _ = child.start_kill();
    child.wait().await
}

/// Windows: an app-lifetime job object with `KILL_ON_JOB_CLOSE`. Every git we
/// spawn is assigned to it, and processes a git spawns inherit the membership.
/// When the LeGit process ends - cleanly or by crash - the OS closes the
/// handle and terminates everything still inside the job, so no git we
/// started (nor any of its children) can outlive the app. The Unix
/// counterpart is `PR_SET_PDEATHSIG` in `build_command_with_env`.
#[cfg(windows)]
mod app_job {
    use std::sync::OnceLock;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    /// The raw handle, stored as `usize` so the static is `Send + Sync`. It
    /// is deliberately never closed: closing it would kill every running git.
    static JOB: OnceLock<Option<usize>> = OnceLock::new();

    fn handle() -> Option<HANDLE> {
        JOB.get_or_init(|| unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return None;
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ) == 0
            {
                CloseHandle(job);
                return None;
            }
            Some(job as usize)
        })
        .map(|raw| raw as HANDLE)
    }

    /// Best-effort enrolment right after spawn. On failure the child simply
    /// is not tied to the app's lifetime, which is the pre-existing behavior.
    /// (A child that spawns its own process in the instant before assignment
    /// would escape the job; in practice assignment runs before the newly
    /// created process gets scheduled.)
    pub(super) fn assign(child: &tokio::process::Child) {
        let (Some(job), Some(raw)) = (handle(), child.raw_handle()) else {
            return;
        };
        unsafe {
            AssignProcessToJobObject(job, raw as HANDLE);
        }
    }
}

/// Default base environment applied to every `git` invocation (DESIGN.md §3.2).
fn default_base_env() -> Vec<(String, String)> {
    vec![
        ("GIT_EDITOR".to_string(), "false".to_string()),
        ("GIT_TERMINAL_PROMPT".to_string(), "0".to_string()),
        ("GIT_ASKPASS".to_string(), "echo".to_string()),
        ("LANG".to_string(), "C.UTF-8".to_string()),
        ("LC_ALL".to_string(), "C.UTF-8".to_string()),
        // Don't take *optional* index locks. Read-mostly commands (`status`,
        // `log`, …) otherwise grab `.git/index.lock` just to refresh the stat
        // cache. Because LeGit runs many git invocations concurrently (React
        // Query + the filesystem watcher), such a refresh can race a real
        // mutation (`stash`/`commit`/`add`) for the index lock — and on
        // Windows-backed filesystems (WSL `/mnt/c`, v9fs/DrvFs, where an open
        // handle blocks rename-over) the mutation fails with "Unable to create
        // index.lock" or "could not write index". Disabling optional locks makes
        // readers lock-free; commands that *require* an index write still take
        // the lock normally, so correctness is unaffected.
        ("GIT_OPTIONAL_LOCKS".to_string(), "0".to_string()),
    ]
}

/// Collect a child stream as text. Git's output is not guaranteed UTF-8
/// (diff/show/blame emit raw file bytes; paths and author names follow the
/// repo, not us), so decode lossily - a strict read would either error or,
/// worse, silently yield an EMPTY string for a whole non-UTF-8 stream,
/// making a real diff look like "no changes".
async fn read_to_string<R: tokio::io::AsyncRead + Unpin>(reader: R) -> String {
    use tokio::io::AsyncReadExt;
    let mut buf = Vec::new();
    let mut reader = reader;
    let _ = reader.read_to_end(&mut buf).await;
    String::from_utf8_lossy(&buf).into_owned()
}

/// Whether an invocation should be LOGGED as ok: a zero exit, or a non-zero
/// exit the caller declared expected (`run_expecting`) - e.g. `config --get`'s
/// 1 for "key unset" is an answer, not a failure, and must not paint the Git
/// Log panel red. Affects logging only; `RunOutput.success` stays `exit == 0`.
/// Pure; unit-tested.
fn logged_ok(success: bool, exit_code: Option<i32>, ok_exit_codes: &[i32]) -> bool {
    success || exit_code.is_some_and(|c| ok_exit_codes.contains(&c))
}

fn log_invocation(
    cwd: Option<&Path>,
    args: &[&str],
    started: Instant,
    exit_code: Option<i32>,
    success: bool,
    stderr: &str,
) {
    let duration_ms = started.elapsed().as_millis() as u64;
    // Log at debug for both outcomes — the runner doesn't know whether a
    // non-zero exit code is expected (e.g. `git config --get` returning 1 for
    // "key not found"). Callers that consider a non-zero result an actual error
    // are responsible for logging at the appropriate level.
    let snippet: String = stderr.lines().take(5).collect::<Vec<_>>().join(" | ");
    debug!(
        duration_ms,
        exit_code = exit_code.unwrap_or(-1),
        success,
        args = ?args,
        stderr = %snippet,
        "git invocation complete",
    );
    // Keep a higher-level info log only for successful long-running ops so
    // progress is visible without enabling full debug output.
    if success {
        info!(duration_ms, args = ?args, "git ok");
    }
    // Forward to the UI command log (if an observer is installed).
    report_invocation(GitInvocation {
        args: args.iter().map(|s| (*s).to_string()).collect(),
        cwd: cwd.map(|p| p.to_string_lossy().into_owned()),
        exit_code,
        success,
        duration_ms,
        stderr: stderr.to_string(),
    });
}

/// Parsed `git --version` output.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct GitVersion {
    pub raw: String,
    pub major: u32,
    pub minor: u32,
    pub patch: u32,
}

impl GitVersion {
    pub fn tuple(&self) -> (u32, u32, u32) {
        (self.major, self.minor, self.patch)
    }

    pub fn meets_minimum(&self) -> bool {
        self.tuple() >= MIN_SUPPORTED_GIT_VERSION
    }

    pub fn parse(raw: &str) -> Option<Self> {
        // `git version 2.43.0 (Apple Git-... )` or `git version 2.43.0.windows.1`.
        let after = raw.split_whitespace().nth(2)?;
        let core = after.split(|c: char| !c.is_ascii_digit() && c != '.').next()?;
        let mut parts = core.split('.').map(|p| p.parse::<u32>().ok());
        let major = parts.next().flatten()?;
        let minor = parts.next().flatten()?;
        let patch = parts.next().flatten().unwrap_or(0);
        Some(Self {
            raw: raw.trim().to_string(),
            major,
            minor,
            patch,
        })
    }
}

impl GitRunner {
    /// Run `git --version` and parse the result. Returns `Err(GitNotFound)`
    /// if the executable cannot be spawned.
    pub async fn check_version(&self) -> Result<GitVersion, RunnerError> {
        let output = self.run(&["--version"]).await?;
        let parsed = GitVersion::parse(output.stdout.trim()).ok_or_else(|| {
            RunnerError::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("could not parse `git --version` output: {:?}", output.stdout),
            ))
        })?;
        info!(version = %parsed.raw, "resolved git");
        Ok(parsed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_standard_version_string() {
        let v = GitVersion::parse("git version 2.43.0").unwrap();
        assert_eq!(v.tuple(), (2, 43, 0));
        assert!(v.meets_minimum());
    }

    #[test]
    fn parses_apple_git_suffix() {
        let v = GitVersion::parse("git version 2.39.3 (Apple Git-145)").unwrap();
        assert_eq!(v.tuple(), (2, 39, 3));
    }

    #[test]
    fn parses_windows_suffix() {
        let v = GitVersion::parse("git version 2.45.0.windows.1").unwrap();
        assert_eq!(v.tuple(), (2, 45, 0));
    }

    #[test]
    fn rejects_below_minimum() {
        let v = GitVersion::parse("git version 2.33.0").unwrap();
        assert!(!v.meets_minimum());
    }

    #[test]
    fn rejects_junk() {
        assert!(GitVersion::parse("hello").is_none());
        assert!(GitVersion::parse("git version xyz").is_none());
    }

    /// The runner must inherit OS environment variables (e.g. Windows'
    /// `SystemRoot`, needed for libcurl to start its DNS-resolver thread) while
    /// scrubbing `GIT_*` and locale vars and forcing the hardened locale.
    /// Regression test for "getaddrinfo() thread failed to start".
    #[test]
    fn build_command_inherits_os_env_but_scrubs_git_and_locale() {
        // Unique stand-in for an OS var like SystemRoot, plus vars that must be
        // scrubbed regardless of what the parent process has set.
        std::env::set_var("LEGIT_TEST_OS_VAR", "os-value");
        std::env::set_var("GIT_DIR", "/should/be/scrubbed");
        std::env::set_var("LC_ALL", "de_DE.UTF-8");

        let runner = GitRunner::unbound("git");
        let cmd = runner.build_command(&["status"]);
        let envs: std::collections::HashMap<String, String> = cmd
            .as_std()
            .get_envs()
            .filter_map(|(k, v)| {
                v.map(|v| (k.to_string_lossy().into_owned(), v.to_string_lossy().into_owned()))
            })
            .collect();

        // Arbitrary OS var is preserved (the actual fix).
        assert_eq!(envs.get("LEGIT_TEST_OS_VAR").map(String::as_str), Some("os-value"));
        // GIT_* scrubbed so it can't override the repo / behavior.
        assert!(!envs.contains_key("GIT_DIR"));
        // Locale forced to C.UTF-8 regardless of the inherited value.
        assert_eq!(envs.get("LC_ALL").map(String::as_str), Some("C.UTF-8"));
        // Hardening present.
        assert_eq!(envs.get("GIT_TERMINAL_PROMPT").map(String::as_str), Some("0"));
        // Optional index locks disabled so concurrent readers don't race a
        // mutation for `.git/index.lock` (see default_base_env).
        assert_eq!(envs.get("GIT_OPTIONAL_LOCKS").map(String::as_str), Some("0"));

        std::env::remove_var("LEGIT_TEST_OS_VAR");
        std::env::remove_var("GIT_DIR");
        std::env::remove_var("LC_ALL");
    }

    /// A second invocation under an already-in-flight `OperationId` must be
    /// rejected - NOT silently replace the map entry. The old `HashMap::insert`
    /// evicted the first op's `RunningOp`, dropping its kill sender; the closed
    /// channel completed the first invocation's cancel arm and killed its child.
    #[tokio::test]
    async fn duplicate_operation_id_is_rejected_and_does_not_kill_the_first() {
        let runner = GitRunner::unbound("git");
        let id = OperationId::new();

        // Simulate an in-flight operation holding the id.
        let (kill_tx, mut kill_rx) = oneshot::channel();
        runner
            .try_insert_running(id.clone(), kill_tx)
            .expect("first insert must succeed");

        // A second invocation under the same id is rejected up front...
        let err = runner
            .run_with_op(&["--version"], id.clone())
            .await
            .expect_err("colliding op id must be rejected");
        assert!(matches!(err, RunnerError::DuplicateOperation(_)));

        // ...and the first op's kill channel is untouched (still open, unfired).
        assert!(matches!(
            kill_rx.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        ));

        // Cancellation still reaches the ORIGINAL operation.
        assert!(runner.cancel(&id));
        assert!(kill_rx.try_recv().is_ok());

        // Once released, the id is usable again.
        let out = runner.run_with_op(&["--version"], id).await.unwrap();
        assert!(out.success);
    }

    /// Cancelling a stream must return promptly even when the killed child
    /// left behind children that inherited the pipes (Git for Windows'
    /// `cmd\git.exe` shim wraps the real git; git forks helpers). Waiting
    /// for pipe EOF would wait for the orphan's whole remaining output -
    /// the "q takes a second" console bug. The runner aborts its readers on
    /// cancel instead, which also kills the orphan via broken pipe. Modeled
    /// with `sh`: the direct child is killed, a backgrounded subshell keeps
    /// the pipe open for 5s.
    #[cfg(unix)]
    #[tokio::test]
    async fn stream_cancel_returns_promptly_despite_orphaned_pipe_holders() {
        let dir = tempfile::tempdir().unwrap();
        let runner = GitRunner::for_repo("sh", dir.path());
        let (tx, mut rx) = mpsc::channel(16);
        let op = OperationId::new();
        let op_for_cancel = op.clone();

        let runner_for_stream = runner.clone();
        let stream = tokio::spawn(async move {
            runner_for_stream
                .stream(
                    &["-c", "(sleep 5; echo orphan) & echo started; sleep 5"],
                    op,
                    tx,
                )
                .await
        });

        // Wait until the child is demonstrably running.
        loop {
            match rx.recv().await.expect("stream ended before start marker") {
                RunnerEvent::Stdout { line } if line == "started" => break,
                _ => {}
            }
        }

        let started = Instant::now();
        assert!(runner.cancel(&op_for_cancel));
        loop {
            match rx.recv().await {
                Some(RunnerEvent::Finished { .. }) | None => break,
                Some(_) => {}
            }
        }
        assert!(
            started.elapsed() < std::time::Duration::from_secs(2),
            "cancel waited on the orphaned pipe holder ({} ms)",
            started.elapsed().as_millis()
        );
        let _ = stream.await;
    }

    /// Wait for a marker file the scripted child creates once it is
    /// demonstrably running (the one-shot runners expose no mid-run output
    /// to synchronize on, unlike `stream`).
    #[cfg(unix)]
    async fn wait_for_marker(path: &std::path::Path) {
        let deadline = Instant::now() + std::time::Duration::from_secs(5);
        while !path.exists() {
            assert!(Instant::now() < deadline, "child never signalled start");
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    }

    /// Cancelling `run_with_op` must return promptly even when a descendant
    /// that escaped the kill still holds the pipes (the Git for Windows
    /// `cmd\git.exe` shim scenario: killing the direct child leaves the real
    /// git running and writing). Modeled with `setsid` so the orphan escapes
    /// the child's process group: without aborting the reader tasks, the
    /// cancel arm waits for pipe EOF - here 5 seconds away.
    #[cfg(unix)]
    #[tokio::test]
    async fn run_with_op_cancel_returns_promptly_despite_orphaned_pipe_holders() {
        let dir = tempfile::tempdir().unwrap();
        let runner = GitRunner::for_repo("sh", dir.path());
        let op = OperationId::new();
        let op_for_cancel = op.clone();

        let runner_for_run = runner.clone();
        let run = tokio::spawn(async move {
            runner_for_run
                .run_with_op(
                    &["-c", "setsid sh -c 'sleep 5; echo orphan' & touch started; sleep 5"],
                    op,
                )
                .await
        });

        wait_for_marker(&dir.path().join("started")).await;

        let started = Instant::now();
        assert!(runner.cancel(&op_for_cancel));
        let out = tokio::time::timeout(std::time::Duration::from_secs(4), run)
            .await
            .expect("cancel waited on the orphaned pipe holder")
            .unwrap()
            .unwrap();
        assert!(!out.success);
        assert!(
            started.elapsed() < std::time::Duration::from_secs(2),
            "cancel took {} ms",
            started.elapsed().as_millis()
        );
    }

    /// Same orphaned-pipe-holder guarantee for `run_with_op_progress` - the
    /// method `repo_clone` runs on. This is the "Cancel clone button does not
    /// react" bug: the cancel arm awaited stderr EOF, which a surviving
    /// descendant held open for the rest of the clone.
    #[cfg(unix)]
    #[tokio::test]
    async fn run_with_op_progress_cancel_returns_promptly_despite_orphaned_pipe_holders() {
        let dir = tempfile::tempdir().unwrap();
        let runner = GitRunner::for_repo("sh", dir.path());
        let op = OperationId::new();
        let op_for_cancel = op.clone();

        let runner_for_run = runner.clone();
        let run = tokio::spawn(async move {
            runner_for_run
                .run_with_op_progress(
                    &["-c", "setsid sh -c 'sleep 5; echo orphan' & touch started; sleep 5"],
                    op,
                )
                .await
        });

        wait_for_marker(&dir.path().join("started")).await;

        let started = Instant::now();
        assert!(runner.cancel(&op_for_cancel));
        let out = tokio::time::timeout(std::time::Duration::from_secs(4), run)
            .await
            .expect("cancel waited on the orphaned pipe holder")
            .unwrap()
            .unwrap();
        assert!(!out.success);
        assert!(
            started.elapsed() < std::time::Duration::from_secs(2),
            "cancel took {} ms",
            started.elapsed().as_millis()
        );
    }

    /// Cancelling must kill the invocation's whole process tree, not just the
    /// direct child: git forks helpers (remote-https, index-pack, ...) that
    /// would otherwise keep doing the real work after a "cancel". The child
    /// leads its own process group, and the cancel path signals the group.
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn cancel_kills_the_whole_process_tree() {
        let dir = tempfile::tempdir().unwrap();
        let runner = GitRunner::for_repo("sh", dir.path());
        let op = OperationId::new();
        let op_for_cancel = op.clone();

        let runner_for_run = runner.clone();
        let run = tokio::spawn(async move {
            runner_for_run
                .run_with_op(
                    &["-c", "sleep 30 & echo $! > helper.pid; touch started; sleep 30"],
                    op,
                )
                .await
        });

        wait_for_marker(&dir.path().join("started")).await;
        let helper_pid: u32 = std::fs::read_to_string(dir.path().join("helper.pid"))
            .unwrap()
            .trim()
            .parse()
            .unwrap();

        assert!(runner.cancel(&op_for_cancel));
        tokio::time::timeout(std::time::Duration::from_secs(4), run)
            .await
            .expect("cancelled run did not return")
            .unwrap()
            .unwrap();

        // The backgrounded helper must die with the group (poll briefly: the
        // reparented process disappears from /proc once init reaps it).
        let deadline = Instant::now() + std::time::Duration::from_secs(2);
        let proc_entry = std::path::PathBuf::from(format!("/proc/{helper_pid}"));
        while proc_entry.exists() {
            assert!(
                Instant::now() < deadline,
                "helper process {helper_pid} survived the cancel"
            );
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    }

    /// A cancel must be gentle first: SIGTERM (to the group), so git's own
    /// signal handlers run - a terminated clone removes its partial target,
    /// lockfiles get released - before any hard kill. Modeled with a TERM
    /// trap that leaves a marker: an immediate SIGKILL never writes it.
    #[cfg(unix)]
    #[tokio::test]
    async fn cancel_lets_a_term_handler_run_before_the_kill() {
        let dir = tempfile::tempdir().unwrap();
        let runner = GitRunner::for_repo("sh", dir.path());
        let op = OperationId::new();
        let op_for_cancel = op.clone();

        let runner_for_run = runner.clone();
        let run = tokio::spawn(async move {
            runner_for_run
                .run_with_op(
                    &["-c", "trap 'touch cleaned; exit 0' TERM; touch started; sleep 30"],
                    op,
                )
                .await
        });

        wait_for_marker(&dir.path().join("started")).await;

        assert!(runner.cancel(&op_for_cancel));
        let out = tokio::time::timeout(std::time::Duration::from_secs(5), run)
            .await
            .expect("cancelled run did not return")
            .unwrap()
            .unwrap();
        // Cancellation is always reported as non-success, whatever exit
        // status the trap produced.
        assert!(!out.success);
        assert!(
            dir.path().join("cleaned").exists(),
            "the child's TERM handler never ran - it was killed hard"
        );
    }

    /// The gentle SIGTERM must escalate: a child that ignores it still dies
    /// within the grace period, and the cancel still returns. The `while`
    /// loop matters - the group TERM kills the foreground `sleep`, so a
    /// straight-line script would exit on its own and never need the kill.
    #[cfg(unix)]
    #[tokio::test]
    async fn cancel_escalates_to_sigkill_when_term_is_ignored() {
        let dir = tempfile::tempdir().unwrap();
        let runner = GitRunner::for_repo("sh", dir.path());
        let op = OperationId::new();
        let op_for_cancel = op.clone();

        let runner_for_run = runner.clone();
        let run = tokio::spawn(async move {
            runner_for_run
                .run_with_op(
                    &["-c", "trap '' TERM; touch started; while :; do sleep 30; done"],
                    op,
                )
                .await
        });

        wait_for_marker(&dir.path().join("started")).await;

        let started = Instant::now();
        assert!(runner.cancel(&op_for_cancel));
        let out = tokio::time::timeout(std::time::Duration::from_secs(6), run)
            .await
            .expect("cancel never escalated - a TERM-ignoring child hung it")
            .unwrap()
            .unwrap();
        assert!(!out.success);
        // Grace period plus a scheduling margin.
        assert!(
            started.elapsed() < TERM_GRACE + std::time::Duration::from_secs(2),
            "escalation took {} ms",
            started.elapsed().as_millis()
        );
    }

    /// Per-invocation env overrides must be applied AFTER the hardened base
    /// env, so a caller can relax a single default for one command (e.g.
    /// `GIT_EDITOR=true` for `merge/rebase --continue` - the env var beats any
    /// `-c core.editor=…`, so overriding the env is the only way).
    #[test]
    fn build_command_extra_env_wins_over_base_env() {
        let runner = GitRunner::unbound("git");
        let cmd = runner.build_command_with_env(&["merge", "--continue"], &[("GIT_EDITOR", "true")]);
        let envs: std::collections::HashMap<String, String> = cmd
            .as_std()
            .get_envs()
            .filter_map(|(k, v)| {
                v.map(|v| (k.to_string_lossy().into_owned(), v.to_string_lossy().into_owned()))
            })
            .collect();
        assert_eq!(envs.get("GIT_EDITOR").map(String::as_str), Some("true"));
        // The rest of the hardening is untouched.
        assert_eq!(envs.get("GIT_TERMINAL_PROMPT").map(String::as_str), Some("0"));
    }

    #[test]
    fn logged_ok_accepts_declared_expected_exit_codes() {
        // Zero always logs ok; a declared code logs ok; anything else fails.
        assert!(logged_ok(true, Some(0), &[]));
        assert!(logged_ok(false, Some(1), &[1]));
        assert!(logged_ok(false, Some(5), &[1, 5]));
        assert!(!logged_ok(false, Some(128), &[1, 5]));
        assert!(!logged_ok(false, Some(1), &[]));
        // Killed by signal (no exit code) is never "expected".
        assert!(!logged_ok(false, None, &[1]));
    }
}
