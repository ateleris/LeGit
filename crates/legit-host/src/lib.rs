//! The `Host` abstraction: WHERE a repository lives and how to act there.
//!
//! Everything repo-side — spawning git, touching files in the working tree or
//! git dir, watching the filesystem, launching a helper process — must go
//! through the repo's `Host` so a repository on a remote machine (WSL distro,
//! later SSH) behaves identically to a local one. `LocalHost` is the
//! app-machine implementation; the remote implementation drives the
//! `legit-agent` protocol and lands with the remote transport.
//!
//! Session-less needs go through a host too: the open-flow `rev-parse` probe,
//! `git init`/`clone`, and global-git-config commands all call
//! `executor_for` on the host resolved from the repo locator (the local host
//! for app-global settings).

use std::sync::Arc;

pub mod remote;
mod spawn;
pub use remote::{
    AgentConnection, AgentPipes, HostConn, HostConnectOpts, HostSinks,
    PingOpts, RemoteExecutor, RemoteFs, RemoteHost, WatchReattach, PING_DEFAULTS,
};

use async_trait::async_trait;
use legit_core::{
    FsError, GitExecutor, GitRunner, GitVersion, HostPath, LocalFs, RepoFs,
};
use legit_watch::{WatchSink, WatcherCore};
use thiserror::Error;

/// Identity of a host, used as the registry key and UI label.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum HostId {
    Local,
    Wsl { distro: String },
}

impl HostId {
    pub fn label(&self) -> String {
        match self {
            HostId::Local => "local".to_string(),
            HostId::Wsl { distro } => distro.clone(),
        }
    }
}

#[derive(Debug, Error)]
pub enum HostError {
    #[error("{0}")]
    Fs(#[from] FsError),

    #[error("failed to start watcher: {0}")]
    Watch(String),

    #[error("failed to spawn {program}: {message}")]
    Spawn { program: String, message: String },

    #[error("{0} was not found on PATH")]
    ProgramNotFound(String),

    #[error("git probe failed: {0}")]
    GitProbe(String),

    /// The agent refused the handshake over its proto/app version. The
    /// install presence check is keyed by app version alone, so a stale
    /// binary with the SAME package version (dev/PR builds, a proto bump)
    /// passes it - the deployer must react to this by redeploying.
    #[error("agent version mismatch: {0}")]
    VersionMismatch(String),

    #[error("host connection lost: {0}")]
    HostGone(String),
}

/// Keeps a repo watch alive; dropping it stops the watch (and, for remote
/// hosts, unregisters it on the agent).
pub struct WatchHandle {
    _inner: Box<dyn Send + Sync>,
}

impl WatchHandle {
    pub fn new(inner: impl Send + Sync + 'static) -> Self {
        Self {
            _inner: Box::new(inner),
        }
    }
}

#[async_trait]
pub trait Host: Send + Sync + 'static {
    fn id(&self) -> HostId;

    /// The host's repo-side filesystem.
    fn fs(&self) -> Arc<dyn RepoFs>;

    /// An executor bound to `cwd` on this host (`None` = unbound, for global
    /// config commands and version probes). Cheap — constructs a handle, no
    /// I/O.
    fn executor_for(&self, git_path: &HostPath, cwd: Option<&HostPath>) -> Arc<dyn GitExecutor>;

    /// Start a repo watcher; classified batches go to `sink`. Dropping the
    /// handle stops it.
    async fn watch(
        &self,
        worktree: &HostPath,
        git_dir: &HostPath,
        sink: WatchSink,
    ) -> Result<WatchHandle, HostError>;

    /// Fire-and-forget host-side process (reveal in file manager, external
    /// editor launch). Semantics are per host.
    async fn spawn_detached(
        &self,
        program: &str,
        args: &[String],
        cwd: Option<&HostPath>,
    ) -> Result<(), HostError>;

    /// Run a helper program on the host to completion and return its captured
    /// output (`ssh-keygen`, the `ssh -T` probe). Remote hosts append their
    /// askpass/credential relay env after `env`, so prompts reach the app.
    /// Not for git - that is `executor_for`'s job.
    async fn run_captured(
        &self,
        program: &str,
        args: &[String],
        cwd: Option<&HostPath>,
        env: &[(String, String)],
        timeout_secs: u64,
    ) -> Result<CapturedRun, HostError>;

    /// The host user's home directory (local: the process env; remote: from
    /// the agent handshake). `None` = the host did not report one.
    fn home_dir(&self) -> Option<HostPath>;

    /// The host's git version at `git_path` (per-host minimum-version check).
    async fn probe_git(&self, git_path: &HostPath) -> Result<GitVersion, HostError>;
}

/// A `run_captured` result: lossy-UTF-8 output (remote hosts truncate it; see
/// `legit_proto::HOST_RUN_OUTPUT_CAP`).
#[derive(Debug, Clone)]
pub struct CapturedRun {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub success: bool,
    /// True when the run was killed at `timeout_secs`.
    pub timed_out: bool,
}

/// The app machine itself.
pub struct LocalHost;

#[async_trait]
impl Host for LocalHost {
    fn id(&self) -> HostId {
        HostId::Local
    }

    fn fs(&self) -> Arc<dyn RepoFs> {
        Arc::new(LocalFs)
    }

    fn executor_for(&self, git_path: &HostPath, cwd: Option<&HostPath>) -> Arc<dyn GitExecutor> {
        match cwd {
            Some(cwd) => Arc::new(GitRunner::for_repo(git_path.as_local(), cwd.as_local())),
            None => Arc::new(GitRunner::unbound(git_path.as_local())),
        }
    }

    async fn watch(
        &self,
        worktree: &HostPath,
        git_dir: &HostPath,
        sink: WatchSink,
    ) -> Result<WatchHandle, HostError> {
        let core = WatcherCore::start(worktree.as_local(), git_dir.as_local(), sink)
            .map_err(|e| HostError::Watch(e.to_string()))?;
        Ok(WatchHandle::new(core))
    }

    async fn spawn_detached(
        &self,
        program: &str,
        args: &[String],
        cwd: Option<&HostPath>,
    ) -> Result<(), HostError> {
        spawn::spawn_detached(program, args, cwd.map(HostPath::as_local).as_deref())
    }

    async fn run_captured(
        &self,
        program: &str,
        args: &[String],
        cwd: Option<&HostPath>,
        env: &[(String, String)],
        timeout_secs: u64,
    ) -> Result<CapturedRun, HostError> {
        let mut cmd = tokio::process::Command::new(program);
        cmd.args(args);
        cmd.stdin(std::process::Stdio::null());
        #[cfg(target_os = "windows")]
        {
            // CREATE_NO_WINDOW: no console flash.
            cmd.creation_flags(0x0800_0000);
        }
        if let Some(cwd) = cwd {
            cmd.current_dir(cwd.as_local());
        }
        for (k, v) in env {
            cmd.env(k, v);
        }
        cmd.kill_on_drop(true);
        let timeout = std::time::Duration::from_secs(timeout_secs.clamp(1, 600));
        match tokio::time::timeout(timeout, cmd.output()).await {
            Err(_) => Ok(CapturedRun {
                stdout: String::new(),
                stderr: String::new(),
                exit_code: None,
                success: false,
                timed_out: true,
            }),
            Ok(Err(e)) => Err(HostError::Spawn {
                program: program.to_string(),
                message: e.to_string(),
            }),
            Ok(Ok(out)) => Ok(CapturedRun {
                stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
                stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
                exit_code: out.status.code(),
                success: out.status.success(),
                timed_out: false,
            }),
        }
    }

    fn home_dir(&self) -> Option<HostPath> {
        #[cfg(target_os = "windows")]
        let var = "USERPROFILE";
        #[cfg(not(target_os = "windows"))]
        let var = "HOME";
        std::env::var(var).ok().filter(|h| !h.is_empty()).map(HostPath)
    }

    async fn probe_git(&self, git_path: &HostPath) -> Result<GitVersion, HostError> {
        let exec = self.executor_for(git_path, None);
        let out = exec
            .run(&["--version"])
            .await
            .map_err(|e| HostError::GitProbe(e.to_string()))?;
        if !out.success {
            return Err(HostError::GitProbe(out.stderr.trim().to_string()));
        }
        GitVersion::parse(&out.stdout)
            .ok_or_else(|| HostError::GitProbe(format!("unparseable version: {}", out.stdout.trim())))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn local_host_watch_delivers_batches() {
        // End-to-end sanity of the Host::watch seam over the extracted core:
        // a write inside a watched tree must produce at least one batch.
        let dir = tempfile::tempdir().unwrap();
        let wt = dir.path().to_path_buf();
        std::fs::create_dir_all(wt.join(".git")).unwrap();
        let (tx, rx) = std::sync::mpsc::channel::<legit_watch::WatchBatch>();
        let handle = LocalHost
            .watch(
                &HostPath::from_path(&wt),
                &HostPath::from_path(&wt.join(".git")),
                Box::new(move |b| {
                    let _ = tx.send(b);
                }),
            )
            .await
            .expect("watch starts");
        std::fs::write(wt.join("file.txt"), "x").unwrap();
        let batch = rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("a batch arrives");
        assert!(batch.domains.contains(&legit_watch::ChangeDomain::Status));
        drop(handle);
    }

    #[tokio::test]
    async fn local_executor_for_runs_git() {
        let exec = LocalHost.executor_for(&HostPath("git".into()), None);
        let out = exec.run(&["--version"]).await.expect("git runs");
        assert!(out.success);
    }
}
