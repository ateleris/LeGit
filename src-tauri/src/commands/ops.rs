//! Merge/rebase operations, repo-op-state probing, and whole-file conflict
//! resolution. Conflicts cross the IPC boundary as OUTCOMES (data), not
//! errors - the panels render them as in-progress state, not failure toasts.

use crate::error::AppError;
use crate::state::AppState;
use legit_core::types::{
    ConflictEntry, ConflictSide, MergeOptions, MergeOutcome, RebaseOutcome, RepoOpState,
};
use std::path::PathBuf;

#[tauri::command]
#[specta::specta]
pub async fn repo_merge(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    target: String,
    options: MergeOptions,
) -> Result<MergeOutcome, AppError> {
    let session = state.get_session(&repo_id).await?;
    session.backend.merge(&target, options).await.map_err(AppError::Git)
}

#[tauri::command]
#[specta::specta]
pub async fn repo_merge_continue(
    state: tauri::State<'_, AppState>,
    repo_id: String,
) -> Result<MergeOutcome, AppError> {
    let session = state.get_session(&repo_id).await?;
    session.backend.merge_continue().await.map_err(AppError::Git)
}

#[tauri::command]
#[specta::specta]
pub async fn repo_merge_abort(
    state: tauri::State<'_, AppState>,
    repo_id: String,
) -> Result<(), AppError> {
    let session = state.get_session(&repo_id).await?;
    session.backend.merge_abort().await.map_err(AppError::Git)
}

#[tauri::command]
#[specta::specta]
pub async fn repo_rebase(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    onto: String,
) -> Result<RebaseOutcome, AppError> {
    let session = state.get_session(&repo_id).await?;
    session.backend.rebase(&onto).await.map_err(AppError::Git)
}

#[tauri::command]
#[specta::specta]
pub async fn repo_rebase_continue(
    state: tauri::State<'_, AppState>,
    repo_id: String,
) -> Result<RebaseOutcome, AppError> {
    let session = state.get_session(&repo_id).await?;
    session.backend.rebase_continue().await.map_err(AppError::Git)
}

#[tauri::command]
#[specta::specta]
pub async fn repo_rebase_skip(
    state: tauri::State<'_, AppState>,
    repo_id: String,
) -> Result<RebaseOutcome, AppError> {
    let session = state.get_session(&repo_id).await?;
    session.backend.rebase_skip().await.map_err(AppError::Git)
}

#[tauri::command]
#[specta::specta]
pub async fn repo_rebase_abort(
    state: tauri::State<'_, AppState>,
    repo_id: String,
) -> Result<(), AppError> {
    let session = state.get_session(&repo_id).await?;
    session.backend.rebase_abort().await.map_err(AppError::Git)
}

#[tauri::command]
#[specta::specta]
pub async fn repo_op_state(
    state: tauri::State<'_, AppState>,
    repo_id: String,
) -> Result<RepoOpState, AppError> {
    let session = state.get_session(&repo_id).await?;
    session.backend.op_state().await.map_err(AppError::Git)
}

#[tauri::command]
#[specta::specta]
pub async fn repo_conflict_entries(
    state: tauri::State<'_, AppState>,
    repo_id: String,
) -> Result<Vec<ConflictEntry>, AppError> {
    let session = state.get_session(&repo_id).await?;
    session.backend.conflict_entries().await.map_err(AppError::Git)
}

#[tauri::command]
#[specta::specta]
pub async fn repo_resolve_take_side(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    path: String,
    side: ConflictSide,
) -> Result<(), AppError> {
    let session = state.get_session(&repo_id).await?;
    session
        .backend
        .resolve_take_side(&PathBuf::from(path), side)
        .await
        .map_err(AppError::Git)
}
