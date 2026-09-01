//! WHICH machine a global-settings git-config command reads and writes.
//!
//! Global Settings has two completely separate git surfaces: the app machine's
//! git configuration and, per WSL distribution, that distro's own. They must
//! never touch each other - a WSL edit reaching the Windows `~/.gitconfig`
//! (or the reverse) is the exact bug this seam exists to make impossible.
//!
//! The design is FAIL-CLOSED: `SettingsHost::Local` is named only here and in
//! the `global_*` commands. The `wsl_*` commands (`commands/wsl_config.rs`)
//! never construct it and never read `state.git_path`, so they have no local
//! branch to fall into - not even when a distro name arrives empty. An
//! optional `host` parameter on the `global_*` commands would have been
//! fail-OPEN instead (a missing argument silently means "this machine").
//!
//! Two invariants ride along, both encoded in `config_util`:
//! - reads use `--global` / `--system` only. An UNBOUND executor inherits its
//!   process's cwd, and for the agent that cwd is the translated Windows
//!   directory - possibly inside some repo under `/mnt/c`, whose local config
//!   a scope-less read would leak into a "global" view.
//! - writes always carry `--global`, for the same reason on the write side.

use std::sync::Arc;

use crate::error::AppError;
use crate::state::AppState;
use legit_core::{GitExecutor, HostPath};
use legit_host::{Host, HostId};

/// The machine a global-settings config command operates on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SettingsHost {
    /// The app machine: the git config of the user running LeGit.
    Local,
    /// A WSL distribution's OWN git config, reached through its agent.
    Wsl { distro: String },
}

impl SettingsHost {
    /// A WSL settings host. Rejects a blank distro so a stray empty string can
    /// never degrade into "the app machine". Pure.
    pub fn wsl(distro: &str) -> Result<Self, AppError> {
        let distro = distro.trim();
        if distro.is_empty() {
            return Err(AppError::ParseArgs(
                "a WSL distribution name is required".into(),
            ));
        }
        Ok(SettingsHost::Wsl {
            distro: distro.to_string(),
        })
    }

    /// The host registry key this settings host resolves to - the testable
    /// form of "a WSL settings command never resolves to the local runner".
    /// Pure.
    pub fn host_id(&self) -> HostId {
        match self {
            SettingsHost::Local => HostId::Local,
            SettingsHost::Wsl { distro } => HostId::Wsl {
                distro: distro.clone(),
            },
        }
    }

}

/// An UNBOUND executor for `host` (no cwd: these commands run outside any
/// repo). Local resolves through `LocalHost` with the app's resolved git;
/// WSL resolves the distro's git (host override, else the agent's PATH `git`)
/// and CONNECTS - starting the distro if it is stopped - so every caller must
/// be a user action, never a mount effect.
pub async fn settings_executor(
    app: &tauri::AppHandle,
    state: &AppState,
    host: &SettingsHost,
) -> Result<Arc<dyn GitExecutor>, AppError> {
    // Dispatch on the host REGISTRY key, so `host_id`'s unit tests pin the
    // actual resolution rather than a parallel description of it.
    match host.host_id() {
        HostId::Local => {
            let git_path = state.git_path.read().await.clone();
            Ok(state
                .local_host()
                .executor_for(&HostPath::from_path(&git_path), None))
        }
        HostId::Wsl { distro } => {
            let git = state
                .host_git_override(&distro)
                .await
                .unwrap_or_else(|| "git".to_string());
            let remote = crate::remote::connection::ensure_wsl_host(app, state, &distro).await?;
            Ok(remote.executor_for(&HostPath(git), None))
        }
    }
}

/// The host filesystem to inspect for host-side tooling (credential helpers
/// living next to git's exec-path). Same fail-closed split as
/// `settings_executor`, and the same connect-on-demand semantics.
pub async fn settings_fs(
    app: &tauri::AppHandle,
    state: &AppState,
    host: &SettingsHost,
) -> Result<Arc<dyn legit_core::RepoFs>, AppError> {
    match host.host_id() {
        HostId::Local => Ok(state.local_host().fs()),
        HostId::Wsl { distro } => {
            let remote = crate::remote::connection::ensure_wsl_host(app, state, &distro).await?;
            Ok(remote.fs())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // The whole point of the seam: a WSL settings host can never resolve to
    // the local host, and vice versa. `settings_executor` has exactly one
    // match on this enum, so pinning it here pins the resolution.
    #[test]
    fn host_id_never_crosses_hosts() {
        assert_eq!(SettingsHost::Local.host_id(), HostId::Local);
        assert_eq!(
            SettingsHost::wsl("Ubuntu").unwrap().host_id(),
            HostId::Wsl {
                distro: "Ubuntu".into()
            }
        );
        assert_ne!(SettingsHost::wsl("Ubuntu").unwrap().host_id(), HostId::Local);
    }

    // A blank distro must be an error, not a silent fallback to the app
    // machine: that is precisely how a WSL edit would land in the Windows
    // ~/.gitconfig.
    #[test]
    fn blank_distro_is_rejected() {
        assert!(SettingsHost::wsl("").is_err());
        assert!(SettingsHost::wsl("   ").is_err());
        assert!(SettingsHost::wsl("\t\n").is_err());
    }

    #[test]
    fn distro_name_is_trimmed() {
        assert_eq!(
            SettingsHost::wsl("  Ubuntu  ").unwrap(),
            SettingsHost::Wsl {
                distro: "Ubuntu".into()
            }
        );
    }
}
