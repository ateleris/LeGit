//! Trusting SSH commit signers and managing allowed-signers files
//! (design/2026-11-19-trusted-ssh-signers.md).
//!
//! Repo-bound commands delegate to the session backend (so the flow is
//! covered by legit-core's flow tests + the real-git harness); the
//! settings-side list/remove take an explicit host + file path, because the
//! settings view enumerates files itself (host-global config values plus
//! profile-referenced files).

use crate::commands::settings_host::{settings_executor, settings_fs, SettingsHost};
use crate::error::AppError;
use crate::state::AppState;
use legit_core::signers::{self, AllowedSignersView, SignerTrustInfo, TrustSignerOutcome};
use legit_core::types::CommitId;

fn host_of(distro: Option<String>) -> Result<SettingsHost, AppError> {
    match distro {
        None => Ok(SettingsHost::Local),
        Some(d) => SettingsHost::wsl(&d),
    }
}

/// A settings host has no repository to resolve a relative value against
/// (git resolves such values per repo); refuse instead of touching a path
/// relative to the app's cwd.
fn require_absolute(path: &str) -> Result<(), AppError> {
    if signers::is_absolute_host_path(path) {
        return Ok(());
    }
    Err(AppError::ParseArgs(format!(
        "the allowed-signers path {path:?} is relative; it resolves per repository and cannot be managed here"
    )))
}

#[tauri::command]
#[specta::specta]
pub async fn signer_trust_info(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    commit_id: String,
) -> Result<SignerTrustInfo, AppError> {
    let session = state.get_session(&repo_id).await?;
    session
        .backend
        .signer_trust_info(&CommitId::new(commit_id))
        .await
        .map_err(AppError::Git)
}

#[tauri::command]
#[specta::specta]
pub async fn trust_commit_signer(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    principal: String,
    key_type: String,
    key_b64: String,
    bootstrap: bool,
) -> Result<TrustSignerOutcome, AppError> {
    let session = state.get_session(&repo_id).await?;
    session
        .backend
        .trust_signer(&principal, &key_type, &key_b64, bootstrap)
        .await
        .map_err(AppError::Git)
}

/// List one allowed-signers file on a settings host. `path` may be
/// tilde-prefixed; it is expanded by git on that host.
#[tauri::command]
#[specta::specta]
pub async fn list_trusted_signers(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    distro: Option<String>,
    path: String,
) -> Result<AllowedSignersView, AppError> {
    let host = host_of(distro)?;
    let exec = settings_executor(&app, &state, &host).await?;
    let fs = settings_fs(&app, &state, &host).await?;
    let expanded = signers::expand_config_path(exec.as_ref(), &path).await?;
    require_absolute(&expanded)?;
    Ok(signers::list_signers(fs.as_ref(), &expanded).await?)
}

/// Remove one listed entry (addressed by line + principal + key, which
/// guards against concurrent edits) and return the refreshed view.
#[tauri::command]
#[specta::specta]
pub async fn remove_trusted_signer(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    distro: Option<String>,
    path: String,
    line_index: u32,
    expected_principal: String,
    expected_key_b64: String,
) -> Result<AllowedSignersView, AppError> {
    let host = host_of(distro)?;
    let exec = settings_executor(&app, &state, &host).await?;
    let fs = settings_fs(&app, &state, &host).await?;
    let expanded = signers::expand_config_path(exec.as_ref(), &path).await?;
    require_absolute(&expanded)?;
    signers::remove_signer(
        fs.as_ref(),
        &expanded,
        line_index,
        &expected_principal,
        &expected_key_b64,
    )
    .await?;
    Ok(signers::list_signers(fs.as_ref(), &expanded).await?)
}
