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
pub use remote::{
    AgentConnection, AgentPipes, AgentTransport, HostConn, HostConnectOpts, HostSinks,
    RemoteExecutor, RemoteFs, RemoteHost,
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

    #[error("git probe failed: {0}")]
    GitProbe(String),

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

    /// The host's git version at `git_path` (per-host minimum-version check).
    async fn probe_git(&self, git_path: &HostPath) -> Result<GitVersion, HostError>;
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
        let mut cmd = std::process::Command::new(program);
        cmd.args(args);
        if let Some(cwd) = cwd {
            cmd.current_dir(cwd.as_local());
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        cmd.spawn()
            .map(|_| ())
            .map_err(|e| HostError::Spawn {
                program: program.to_string(),
                message: e.to_string(),
            })
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
