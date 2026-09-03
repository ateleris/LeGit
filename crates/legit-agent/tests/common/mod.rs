//! Shared loopback plumbing: spawn THIS crate's `legit-agent` binary as a
//! direct child and connect `legit-host`'s client machinery to its stdio —
//! everything the WSL transport does except `wsl.exe` itself.

use std::sync::Arc;

use legit_host::{AgentConnection, AgentPipes, HostConnectOpts, HostSinks};

/// Keeps the agent child alive for the backend's lifetime; kills it on drop.
pub struct AgentGuard {
    child: tokio::process::Child,
}

impl Drop for AgentGuard {
    fn drop(&mut self) {
        let _ = self.child.start_kill();
    }
}

pub fn spawn_agent() -> (AgentPipes, AgentGuard) {
    let mut child = tokio::process::Command::new(env!("CARGO_BIN_EXE_legit-agent"))
        .arg("--stdio")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .expect("spawn legit-agent");
    let pipes = AgentPipes {
        writer: Box::new(child.stdin.take().expect("agent stdin")),
        reader: Box::new(child.stdout.take().expect("agent stdout")),
    };
    (pipes, AgentGuard { child })
}

pub async fn connect_agent_with(sinks: HostSinks) -> (Arc<AgentConnection>, AgentGuard) {
    let (pipes, guard) = spawn_agent();
    let conn = AgentConnection::establish(
        pipes,
        &HostConnectOpts {
            app_version: env!("CARGO_PKG_VERSION").to_string(),
            base_env_extra: Vec::new(),
            ..Default::default()
        },
        sinks,
    )
    .await
    .expect("agent handshake");
    (conn, guard)
}

pub async fn connect_agent() -> (Arc<AgentConnection>, AgentGuard) {
    connect_agent_with(HostSinks::ignore()).await
}
