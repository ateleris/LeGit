//! Git-hooks inspection for the repo settings panel.

use crate::commands::files::wsl_unc_path;
use crate::error::AppError;
use crate::os_open::{os_open, OpenTarget};
use crate::state::AppState;
use legit_core::types::HooksReport;

/// The repo's installed git hooks: resolved hooks directory (honoring
/// `core.hooksPath`) and its listing.
#[tauri::command]
#[specta::specta]
pub async fn repo_hooks_report(
    state: tauri::State<'_, AppState>,
    repo_id: String,
) -> Result<HooksReport, AppError> {
    let session = state.get_session(&repo_id).await?;
    session.backend.hooks_report().await.map_err(AppError::Git)
}

/// Open the repo's resolved hooks directory in the OS file manager (WSL repos
/// through the `\\wsl.localhost\` share). Resolved via the backend so
/// `core.hooksPath` and relocated gitdirs (worktrees, submodules) are honored.
#[tauri::command]
#[specta::specta]
pub async fn repo_open_hooks_folder(
    state: tauri::State<'_, AppState>,
    repo_id: String,
) -> Result<(), AppError> {
    let session = state.get_session(&repo_id).await?;
    let report = session.backend.hooks_report().await.map_err(AppError::Git)?;
    if let crate::remote::RepoLocator::Wsl { distro, .. } = &session.locator {
        let unc = wsl_unc_path(distro, &report.dir);
        return os_open(OpenTarget::Folder(std::path::Path::new(&unc)), "open hooks folder");
    }
    let local = legit_core::HostPath(report.dir).as_local();
    os_open(OpenTarget::Folder(&local), "open hooks folder")
}

/// Delete an installed hook from the default hooks directory (refused for a
/// `core.hooksPath`-redirected setup). Destructive - the confirmation gate
/// lives in the UI.
#[tauri::command]
#[specta::specta]
pub async fn repo_remove_hook(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    name: String,
) -> Result<(), AppError> {
    let session = state.get_session(&repo_id).await?;
    session.backend.remove_hook(&name).await.map_err(AppError::Git)
}
