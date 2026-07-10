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
    keep_index: bool,
) -> Result<StashOutcome, AppError> {
    let session = state.get_session(&repo_id).await?;
    session
        .backend
        .create_stash(message.as_deref(), include_untracked, keep_index)
        .await
        .map_err(AppError::Git)
}

#[tauri::command]
#[specta::specta]
pub async fn repo_create_stash_paths(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    message: Option<String>,
    paths: Vec<String>,
) -> Result<StashOutcome, AppError> {
    let session = state.get_session(&repo_id).await?;
    let paths: Vec<std::path::PathBuf> = paths.into_iter().map(Into::into).collect();
    session
        .backend
        .create_stash_paths(message.as_deref(), &paths)
        .await
        .map_err(AppError::Git)
}

#[tauri::command]
#[specta::specta]
pub async fn repo_apply_stash_file(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    stash_sha: String,
    path: String,
) -> Result<(), AppError> {
    let session = state.get_session(&repo_id).await?;
    session
        .backend
        .apply_stash_file(&stash_sha, std::path::Path::new(&path))
        .await
        .map_err(AppError::Git)
}

#[tauri::command]
#[specta::specta]
pub async fn repo_apply_stash(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    stash_sha: String,
) -> Result<StashApplyOutcome, AppError> {
    let session = state.get_session(&repo_id).await?;
    session
        .backend
        .apply_stash(&stash_sha)
        .await
        .map_err(AppError::Git)
}

#[tauri::command]
#[specta::specta]
pub async fn repo_pop_stash(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    stash_sha: String,
) -> Result<StashApplyOutcome, AppError> {
    let session = state.get_session(&repo_id).await?;
    session
        .backend
        .pop_stash(&stash_sha)
        .await
        .map_err(AppError::Git)
}

#[tauri::command]
#[specta::specta]
pub async fn repo_drop_stash(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    stash_sha: String,
) -> Result<(), AppError> {
    let session = state.get_session(&repo_id).await?;
    session
        .backend
        .drop_stash(&stash_sha)
        .await
        .map_err(AppError::Git)
}

#[tauri::command]
#[specta::specta]
pub async fn repo_stash_branch(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    stash_sha: String,
    branch_name: String,
) -> Result<(), AppError> {
    let session = state.get_session(&repo_id).await?;
    session
        .backend
        .stash_branch(&stash_sha, &branch_name)
        .await
        .map_err(AppError::Git)
}

#[tauri::command]
#[specta::specta]
pub async fn repo_rename_stash(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    stash_sha: String,
    message: String,
) -> Result<(), AppError> {
    let session = state.get_session(&repo_id).await?;
    session
        .backend
        .rename_stash(&stash_sha, &message)
        .await
        .map_err(AppError::Git)
}
