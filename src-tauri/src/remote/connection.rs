//! WSL host connection lifecycle: ensure-connected (deploy → spawn →
//! handshake), sinks wiring (invocation log, progress, credential relay),
//! death detection, and reconnect-with-backoff.
//!
//! One agent per distro; repos multiplex over its connection. Sessions hold
//! the `RemoteHost` whose `HostConn` a reconnect swaps in place — repo ids
//! and open tabs survive an agent death (`wsl --shutdown`, distro restart).

use std::collections::HashMap;
use std::sync::Arc;

use legit_host::{AgentConnection, HostConnectOpts, HostId, HostSinks, RemoteHost};
use serde::Serialize;
use specta::Type;
use tauri::{Emitter, Manager as _};
use tokio::sync::oneshot;

use crate::error::AppError;
use crate::remote::RepoLocator;
use crate::state::AppState;

/// Event carrying host connectivity changes to the frontend.
pub const REMOTE_HOST_STATUS_EVENT: &str = "legit://remote-host-status";

pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Debug, Clone, Serialize, Type)]
pub struct RemoteHostStatusPayload {
    pub distro: String,
    /// "connecting" | "connected" | "disconnected"
    pub status: String,
}

fn emit_status(app: &tauri::AppHandle, distro: &str, status: &str) {
    let _ = app.emit(
        REMOTE_HOST_STATUS_EVENT,
        RemoteHostStatusPayload {
            distro: distro.to_string(),
            status: status.to_string(),
        },
    );
}

/// Live WSL host registry (one entry per connected distro).
#[derive(Default)]
pub struct WslHosts {
    entries: tokio::sync::Mutex<HashMap<String, WslEntry>>,
}

struct WslEntry {
    host: Arc<RemoteHost>,
    /// The wsl.exe bridge process. Kept so dropping the entry kills it
    /// (`kill_on_drop`); the agent also exits on stdin EOF.
    child: tokio::process::Child,
}

/// Resolve the Linux agent binary to deploy: the `LEGIT_AGENT_BIN` dev
/// override (point a dev app at a locally built agent), else the bundled
/// resource (`agent/legit-agent-<arch>` under the app's resource dir).
async fn agent_binary(app: &tauri::AppHandle, arch: &str) -> Result<Vec<u8>, AppError> {
    if let Ok(dev) = std::env::var("LEGIT_AGENT_BIN") {
        return tokio::fs::read(&dev)
            .await
            .map_err(|e| AppError::Io(format!("LEGIT_AGENT_BIN {dev}: {e}")));
    }
    let resources = app
        .path()
        .resource_dir()
        .map_err(|e| AppError::Io(format!("resource dir: {e}")))?;
    let path = resources.join("agent").join(format!("legit-agent-{arch}"));
    tokio::fs::read(&path).await.map_err(|e| {
        AppError::Io(format!(
            "bundled agent binary missing ({}): {e}",
            path.display()
        ))
    })
}

/// Get (or establish) the live host for `distro`. Deploys the agent when the
/// version-keyed install is missing, spawns it through a login shell, and
/// handshakes. Reconnects reuse the SAME `RemoteHost` (sessions recover in
/// place).
pub async fn ensure_wsl_host(
    app: &tauri::AppHandle,
    state: &AppState,
    distro: &str,
) -> Result<Arc<RemoteHost>, AppError> {
    let mut entries = state.wsl_hosts.entries.lock().await;
    if let Some(entry) = entries.get(distro) {
        if entry.host.is_alive() {
            return Ok(entry.host.clone());
        }
    }
    emit_status(app, distro, "connecting");
    let result = connect_locked(app, state, distro, &mut entries).await;
    match &result {
        Ok(_) => emit_status(app, distro, "connected"),
        Err(_) => emit_status(app, distro, "disconnected"),
    }
    result
}

async fn connect_locked(
    app: &tauri::AppHandle,
    state: &AppState,
    distro: &str,
    entries: &mut HashMap<String, WslEntry>,
) -> Result<Arc<RemoteHost>, AppError> {
    // Deploy when the version-keyed path is absent (first run or upgrade).
    // Under the `LEGIT_AGENT_BIN` dev override ALWAYS deploy: a rebuilt dev
    // agent keeps the same version key, so the presence check would keep
    // running the stale binary forever.
    let dev_override = std::env::var_os("LEGIT_AGENT_BIN").is_some();
    if dev_override || !super::wsl::agent_installed(distro, APP_VERSION).await? {
        let arch = super::wsl::distro_arch(distro).await?;
        let bytes = agent_binary(app, &arch).await?;
        super::wsl::deploy_agent(distro, APP_VERSION, &bytes).await?;
        tracing::info!(distro, version = APP_VERSION, dev_override, "agent deployed");
        // Old version-keyed installs are useless after an upgrade — prune
        // them (best-effort; scoped to the agent dir).
        if let Err(e) = super::wsl::prune_stale_agents(distro, APP_VERSION).await {
            tracing::warn!(distro, err = %e, "stale agent prune failed");
        }
    }

    // Refresh the `legit .` launcher + host-exe pointer on every connect
    // (self-heals a moved app). Best-effort: the connection matters more.
    if let Err(e) = super::wsl::install_launcher(distro).await {
        tracing::warn!(distro, err = %e, "launcher install failed");
    }

    let (pipes, child) = super::wsl::spawn_agent(distro, APP_VERSION)?;
    let sinks = build_sinks(app.clone(), distro.to_string());
    let conn = AgentConnection::establish(
        pipes,
        &HostConnectOpts {
            app_version: APP_VERSION.to_string(),
            base_env_extra: Vec::new(),
            enable_cred_relay: true,
        },
        sinks,
    )
    .await
    .map_err(|e| AppError::Io(format!("agent connection to '{distro}': {e}")))?;

    let host = match entries.get_mut(distro) {
        // Reconnect: swap the connection into the existing host so sessions
        // recover in place, and re-establish its watches.
        Some(entry) => {
            entry
                .host
                .reattach(conn)
                .await
                .map_err(|e| AppError::Io(format!("reattach to '{distro}': {e}")))?;
            entry.child = child;
            entry.host.clone()
        }
        None => {
            let host = Arc::new(RemoteHost::new(
                HostId::Wsl {
                    distro: distro.to_string(),
                },
                conn,
            ));
            entries.insert(
                distro.to_string(),
                WslEntry {
                    host: host.clone(),
                    child,
                },
            );
            state
                .hosts
                .lock()
                .expect("hosts map poisoned")
                .insert(
                    HostId::Wsl {
                        distro: distro.to_string(),
                    },
                    host.clone(),
                );
            host
        }
    };
    Ok(host)
}

/// Drop a distro's host (last repo tab closed): the entry drop kills the
/// wsl.exe bridge, the agent exits on stdin EOF, and the WSL VM may idle out.
pub async fn release_wsl_host(state: &AppState, distro: &str) {
    let removed = state.wsl_hosts.entries.lock().await.remove(distro);
    if removed.is_some() {
        state
            .hosts
            .lock()
            .expect("hosts map poisoned")
            .remove(&HostId::Wsl {
                distro: distro.to_string(),
            });
        tracing::info!(distro, "wsl host released");
    }
}

/// Sinks binding an agent connection to the app: invocation log + progress
/// events (host-tagged), the credential relay, and death handling.
fn build_sinks(app: tauri::AppHandle, distro: String) -> HostSinks {
    // Pending relayed prompts, so a `cred.cancel` (git died) can abort the
    // matching UI prompt via its hangup future.
    let cancels: Arc<std::sync::Mutex<HashMap<u64, oneshot::Sender<()>>>> = Arc::default();

    let inv_app = app.clone();
    let inv_distro = distro.clone();
    let prog_app = app.clone();
    let cred_cancels = cancels.clone();
    let cancel_reg = cancels.clone();
    let dc_app = app.clone();
    let dc_distro = distro.clone();
    let cred_distro = distro.clone();

    HostSinks {
        on_invocation: Box::new(move |mut inv| {
            inv.host = Some(inv_distro.clone());
            let _ = inv_app.emit("git_invocation", inv);
        }),
        on_progress: Box::new(move |op_id, progress| {
            let _ = prog_app.emit(
                crate::REMOTE_PROGRESS_EVENT,
                crate::RemoteProgressPayload {
                    op_id: op_id.0.clone(),
                    progress,
                },
            );
        }),
        on_cred_request: Box::new(move |params| {
            let (hang_tx, hang_rx) = oneshot::channel::<()>();
            cred_cancels
                .lock()
                .expect("cred cancels poisoned")
                .insert(params.cred_id, hang_tx);
            let cancels = cred_cancels.clone();
            let distro = cred_distro.clone();
            tokio::spawn(async move {
                // Attribution: the prompt shows where the request came from —
                // prefix the distro so a WSL repo's prompt is recognizable.
                let cwd = params.cwd.map(|c| format!("[{distro}] {c}"));
                let answer = crate::credentials::answer_relayed_request(
                    params.op,
                    params.fields,
                    cwd,
                    async {
                        let _ = hang_rx.await;
                    },
                )
                .await;
                cancels
                    .lock()
                    .expect("cred cancels poisoned")
                    .remove(&params.cred_id);
                answer
            })
        }),
        on_cred_cancel: Box::new(move |cred_id| {
            if let Some(tx) = cancel_reg
                .lock()
                .expect("cred cancels poisoned")
                .remove(&cred_id)
            {
                let _ = tx.send(());
            }
        }),
        on_disconnect: Box::new(move || {
            emit_status(&dc_app, &dc_distro, "disconnected");
            let app = dc_app.clone();
            let distro = dc_distro.clone();
            tokio::spawn(async move {
                reconnect_with_backoff(app, distro).await;
            });
        }),
    }
}

/// Whether auto-reconnect should keep trying: only while at least one open
/// repo session lives on that distro. A host connected for SETTINGS only
/// (the `Git (WSL)` group probes a distro without any repo open on it) is
/// never released — `release_wsl_host` runs from `close_repo` alone — so
/// without this check the loop would restart the distro every 15s forever
/// after a `wsl --shutdown`, silently keeping a WSL VM alive the user
/// deliberately stopped. Settings-only hosts instead show "disconnected" and
/// wait for the user's explicit Reconnect. Pure; unit-tested.
pub(crate) fn should_keep_reconnecting(distro: &str, sessions: &[RepoLocator]) -> bool {
    sessions
        .iter()
        .any(|l| matches!(l, RepoLocator::Wsl { distro: d, .. } if d == distro))
}

/// Try to bring a dead host back: 1s, 2s, 5s, then every 15s — for as long as
/// the host is still registered AND repos are open on it.
/// `wsl --shutdown` mid-session ends here: the next attempt restarts the
/// distro, respawns the agent, reattaches sessions, and re-registers watches.
async fn reconnect_with_backoff(app: tauri::AppHandle, distro: String) {
    let delays = [1u64, 2, 5];
    let mut attempt = 0usize;
    loop {
        let delay = delays.get(attempt).copied().unwrap_or(15);
        tokio::time::sleep(std::time::Duration::from_secs(delay)).await;
        attempt += 1;

        let state = app.state::<AppState>();
        // Stop when the host was released (or never existed).
        if !state
            .wsl_hosts
            .entries
            .lock()
            .await
            .contains_key(&distro)
        {
            return;
        }
        // Stop for a settings-only host: nothing depends on it being live.
        let locators: Vec<RepoLocator> = state
            .repos
            .read()
            .await
            .values()
            .map(|s| s.locator.clone())
            .collect();
        if !should_keep_reconnecting(&distro, &locators) {
            tracing::debug!(distro, "no repos open on this distro - not reconnecting");
            return;
        }
        match ensure_wsl_host(&app, &state, &distro).await {
            Ok(host) if host.is_alive() => {
                tracing::info!(distro, "wsl host reconnected");
                // Data may have changed while disconnected: refresh every
                // domain of every repo on this host.
                crate::remote::invalidate_host_repos(&app, &state, &distro).await;
                return;
            }
            Ok(_) => {}
            Err(e) => {
                tracing::debug!(distro, err = %e, attempt, "wsl reconnect attempt failed");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use legit_core::HostPath;
    use std::path::PathBuf;

    fn wsl(distro: &str) -> RepoLocator {
        RepoLocator::Wsl {
            distro: distro.into(),
            path: HostPath("/home/u/repo".into()),
        }
    }

    #[test]
    fn reconnects_while_a_repo_lives_on_the_distro() {
        assert!(should_keep_reconnecting("Ubuntu", &[wsl("Ubuntu")]));
        assert!(should_keep_reconnecting(
            "Ubuntu",
            &[wsl("Debian"), wsl("Ubuntu")]
        ));
    }

    // A settings-only connection (the Git (WSL) group probed a distro with no
    // repo open on it) must NOT keep restarting the distro.
    #[test]
    fn settings_only_host_is_not_reconnected() {
        assert!(!should_keep_reconnecting("Ubuntu", &[]));
        assert!(!should_keep_reconnecting("Ubuntu", &[wsl("Debian")]));
        assert!(!should_keep_reconnecting(
            "Ubuntu",
            &[RepoLocator::Local {
                path: PathBuf::from("/home/u/local")
            }]
        ));
    }
}
