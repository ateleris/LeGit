//! Stash operation commands.
//! See DESIGN-v0.2.md §D.3 for repo-scoped command patterns.

use crate::{error::AppError, state::AppState};
use legit_core::{StashApplyOutcome, StashEntry, StashOutcome};

#[tauri::command]
#[specta::specta]
pub async fn repo_stashes(
    state: tauri::State<'_, AppState>,
    repo_id: String,
) -> Result<Vec<StashEntry>, AppError> {
    let session = state.get_session(&repo_id).await?;
    session.backend.stashes().await.map_err(AppError::Git)
}

#[tauri::command]
#[specta::specta]
pub async fn repo_create_stash(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    message: Option<String>,
    include_untracked: bool,
) -> Result<StashOutcome, AppError> {
    let session = state.get_session(&repo_id).await?;
    session
        .backend
        .create_stash(message.as_deref(), include_untracked)
        .await
        .map_err(AppError::Git)
}

#[tauri::command]
#[specta::specta]
pub async fn repo_apply_stash(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    selector: String,
) -> Result<StashApplyOutcome, AppError> {
    let session = state.get_session(&repo_id).await?;
    session
        .backend
        .apply_stash(&selector)
        .await
        .map_err(AppError::Git)
}

#[tauri::command]
#[specta::specta]
pub async fn repo_pop_stash(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    selector: String,
) -> Result<StashApplyOutcome, AppError> {
    let session = state.get_session(&repo_id).await?;
    session
        .backend
        .pop_stash(&selector)
        .await
        .map_err(AppError::Git)
}

#[tauri::command]
#[specta::specta]
pub async fn repo_drop_stash(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    selector: String,
) -> Result<(), AppError> {
    let session = state.get_session(&repo_id).await?;
    session
        .backend
        .drop_stash(&selector)
        .await
        .map_err(AppError::Git)
}

#[tauri::command]
#[specta::specta]
pub async fn repo_rename_stash(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    selector: String,
    message: String,
) -> Result<(), AppError> {
    let session = state.get_session(&repo_id).await?;
    session
        .backend
        .rename_stash(&selector, &message)
        .await
        .map_err(AppError::Git)
}
