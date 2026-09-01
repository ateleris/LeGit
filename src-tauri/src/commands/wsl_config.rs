//! Git configuration INSIDE a WSL distribution — the `Git (WSL)` half of
//! Global Settings.
//!
//! Deliberately a parallel command surface to the `global_*` commands rather
//! than an optional `host` argument on them: these commands never construct
//! `SettingsHost::Local` and never read `state.git_path`, so a WSL edit has
//! no path by which it could reach the app machine's `~/.gitconfig`. See
//! `commands/settings_host.rs` for the reasoning.
//!
//! All the view/write logic is shared with the local commands — only the
//! executor differs, and it is resolved once in `settings_executor`. Each
//! command CONNECTS to the distro (starting it if stopped), so the frontend
//! calls them on explicit user action, never on mount.

use crate::commands::credential_helper::{
    list_helpers_for_host, write_credential_helper_global, AvailableHelper, CredentialHelperView,
};
use crate::commands::identity::{write_identity_global, IdentityView};
use crate::commands::line_endings::{write_line_endings_global, LineEndingsView};
use crate::commands::settings_host::{settings_executor, SettingsHost};
use crate::commands::signing::{write_signing_global, SigningView};
use crate::error::AppError;
use crate::state::AppState;

/// `user.name` / `user.email` in the distro's global git config.
#[tauri::command]
#[specta::specta]
pub async fn wsl_identity_view(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    distro: String,
) -> Result<IdentityView, AppError> {
    let host = SettingsHost::wsl(&distro)?;
    let runner = settings_executor(&app, &state, &host).await?;
    Ok(crate::commands::identity::build_global_view(runner.as_ref()).await)
}

#[tauri::command]
#[specta::specta]
pub async fn wsl_write_identity(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    distro: String,
    name: Option<String>,
    email: Option<String>,
) -> Result<IdentityView, AppError> {
    let host = SettingsHost::wsl(&distro)?;
    let runner = settings_executor(&app, &state, &host).await?;
    write_identity_global(runner.as_ref(), name.as_deref(), email.as_deref()).await
}

/// Commit-signing config in the distro's global git config.
#[tauri::command]
#[specta::specta]
pub async fn wsl_signing_config(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    distro: String,
) -> Result<SigningView, AppError> {
    let host = SettingsHost::wsl(&distro)?;
    let runner = settings_executor(&app, &state, &host).await?;
    Ok(crate::commands::signing::read_signing_view_global(runner.as_ref()).await)
}

#[tauri::command]
#[specta::specta]
pub async fn wsl_write_signing(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    distro: String,
    gpgsign: Option<String>,
    format: Option<String>,
    signing_key: Option<String>,
    allowed_signers: Option<String>,
) -> Result<SigningView, AppError> {
    let host = SettingsHost::wsl(&distro)?;
    let runner = settings_executor(&app, &state, &host).await?;
    write_signing_global(
        runner.as_ref(),
        gpgsign.as_deref(),
        format.as_deref(),
        signing_key.as_deref(),
        allowed_signers.as_deref(),
    )
    .await
}

/// `credential.helper` in the distro's global git config. Note that LeGit
/// always adds its own relay helper to every git run inside the distro (as
/// command-line-scope config), and helpers accumulate: a helper configured
/// here is consulted BEFORE LeGit's relay.
#[tauri::command]
#[specta::specta]
pub async fn wsl_credential_helper_view(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    distro: String,
) -> Result<CredentialHelperView, AppError> {
    let host = SettingsHost::wsl(&distro)?;
    let runner = settings_executor(&app, &state, &host).await?;
    Ok(crate::commands::credential_helper::build_view(runner.as_ref()).await)
}

#[tauri::command]
#[specta::specta]
pub async fn wsl_write_credential_helper(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    distro: String,
    helper: Option<String>,
) -> Result<CredentialHelperView, AppError> {
    let host = SettingsHost::wsl(&distro)?;
    let runner = settings_executor(&app, &state, &host).await?;
    write_credential_helper_global(runner.as_ref(), helper.as_deref()).await
}

/// The credential helpers actually installed inside the distro (so the picker
/// never offers Windows' `manager` / `wincred` for a Linux git).
#[tauri::command]
#[specta::specta]
pub async fn wsl_available_credential_helpers(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    distro: String,
) -> Result<Vec<AvailableHelper>, AppError> {
    let host = SettingsHost::wsl(&distro)?;
    list_helpers_for_host(&app, &state, &host).await
}

/// `core.autocrlf` / `core.eol` in the distro's global git config.
#[tauri::command]
#[specta::specta]
pub async fn wsl_line_endings_view(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    distro: String,
) -> Result<LineEndingsView, AppError> {
    let host = SettingsHost::wsl(&distro)?;
    let runner = settings_executor(&app, &state, &host).await?;
    Ok(crate::commands::line_endings::build_global_line_endings_view(runner.as_ref()).await)
}

/// Writing line endings changes how git PRESENTS the working tree, so every
/// open repo on this distro is refreshed afterwards.
#[tauri::command]
#[specta::specta]
pub async fn wsl_write_line_endings(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    distro: String,
    autocrlf: Option<String>,
    eol: Option<String>,
) -> Result<LineEndingsView, AppError> {
    let host = SettingsHost::wsl(&distro)?;
    let runner = settings_executor(&app, &state, &host).await?;
    let view =
        write_line_endings_global(runner.as_ref(), autocrlf.as_deref(), eol.as_deref()).await?;
    crate::remote::invalidate_host_repos(&app, &state, &distro).await;
    Ok(view)
}
