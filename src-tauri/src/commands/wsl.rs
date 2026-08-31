//! WSL remote-repository commands: distro enumeration and per-host (per
//! distro) git binary configuration.

use crate::commands::git_setup::GitStatus;
use crate::error::AppError;
use crate::remote::wsl::WslDistro;
use crate::state::{AppState, HostSettings};
use legit_core::{HostPath, MIN_SUPPORTED_GIT_VERSION};
use legit_host::Host;

/// Enumerate installed WSL distributions for the open-repo picker. Empty on
/// non-Windows builds — the frontend hides the WSL entry then.
#[tauri::command]
#[specta::specta]
pub async fn wsl_list_distros() -> Result<Vec<WslDistro>, AppError> {
    if !cfg!(windows) {
        return Ok(Vec::new());
    }
    crate::remote::wsl::list_distros().await
}

/// The persisted git override for a WSL host, without connecting (cheap —
/// used to prefill the settings UI; probing is a separate, explicit action
/// because it starts the distro).
#[tauri::command]
#[specta::specta]
pub async fn wsl_host_git_override(
    state: tauri::State<'_, AppState>,
    distro: String,
) -> Result<Option<String>, AppError> {
    Ok(state.host_git_override(&distro).await)
}

/// Probe the effective git binary of a WSL host (host override, else the
/// agent's PATH `git`) THROUGH its agent. Connects — and thereby starts —
/// the distro on demand, so the UI calls this on user action, not on mount.
#[tauri::command]
#[specta::specta]
pub async fn wsl_host_git_status(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    distro: String,
) -> Result<GitStatus, AppError> {
    let user_override = state.host_git_override(&distro).await;
    let host = crate::remote::connection::ensure_wsl_host(&app, &state, &distro).await?;
    Ok(probe_host(host.as_ref(), user_override).await)
}

/// Set (or clear, with `None`) the git binary override for a WSL host. A new
/// override must probe OK on the host before it is persisted; clearing
/// always succeeds. Hot-swaps the runners of open sessions on that distro.
#[tauri::command]
#[specta::specta]
pub async fn set_wsl_host_git_path(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    distro: String,
    path: Option<String>,
) -> Result<GitStatus, AppError> {
    let path = path.and_then(|p| {
        let t = p.trim().to_string();
        (!t.is_empty()).then_some(t)
    });
    let host = crate::remote::connection::ensure_wsl_host(&app, &state, &distro).await?;
    let status = probe_host(host.as_ref(), path.clone()).await;
    if path.is_some() && !status.meets_minimum {
        return Err(AppError::Git(legit_core::GitError::GitUnavailable(
            status.error.clone().unwrap_or_else(|| {
                format!(
                    "{} does not meet the minimum required version",
                    status.resolved_path
                )
            }),
        )));
    }
    state
        .set_host_settings(
            &distro,
            HostSettings {
                git_path_override: path.clone(),
            },
        )
        .await?;

    // Hot-swap the runner of every open session on this distro, so the
    // change takes effect without reopening tabs. Sessions with a per-repo
    // override keep their own binary.
    let effective = path.unwrap_or_else(|| "git".into());
    let sessions: Vec<_> = state.repos.read().await.values().cloned().collect();
    for session in sessions {
        let crate::remote::RepoLocator::Wsl { distro: d, .. } = &session.locator else {
            continue;
        };
        if d != &distro {
            continue;
        }
        let repo_override = session
            .settings
            .read()
            .await
            .git_path_override
            .as_deref()
            .is_some_and(|s| !s.trim().is_empty());
        if repo_override {
            continue;
        }
        *session.runner.write().await = session.host.executor_for(
            &HostPath(effective.clone()),
            Some(&HostPath::from_path(&session.path)),
        );
    }
    Ok(status)
}

async fn probe_host(host: &dyn Host, user_override: Option<String>) -> GitStatus {
    let effective = user_override.clone().unwrap_or_else(|| "git".into());
    match host.probe_git(&HostPath(effective.clone())).await {
        Ok(v) => GitStatus {
            resolved_path: effective,
            meets_minimum: v.meets_minimum(),
            version: Some(v),
            minimum_required: MIN_SUPPORTED_GIT_VERSION,
            user_override,
            error: None,
        },
        Err(e) => GitStatus {
            resolved_path: effective,
            version: None,
            meets_minimum: false,
            minimum_required: MIN_SUPPORTED_GIT_VERSION,
            user_override,
            error: Some(e.to_string()),
        },
    }
}
