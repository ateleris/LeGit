//! Working-tree write operations: stage, unstage, discard, and commit.
//! Backs the Working Changes panel.

use crate::error::AppError;
use crate::state::AppState;
use legit_core::types::{CommitId, CommitOptions};
use std::path::PathBuf;

fn to_paths(paths: Vec<String>) -> Vec<PathBuf> {
    paths.into_iter().map(PathBuf::from).collect()
}

/// Stage the given paths (`git add`).
#[tauri::command]
#[specta::specta]
pub async fn repo_stage(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    paths: Vec<String>,
) -> Result<(), AppError> {
    let session = state.get_session(&repo_id).await?;
    session
        .backend
        .stage(&to_paths(paths))
        .await
        .map_err(AppError::Git)
}

/// Unstage the given paths (`git restore --staged`).
#[tauri::command]
#[specta::specta]
pub async fn repo_unstage(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    paths: Vec<String>,
) -> Result<(), AppError> {
    let session = state.get_session(&repo_id).await?;
    session
        .backend
        .unstage(&to_paths(paths))
        .await
        .map_err(AppError::Git)
}

/// Discard working-tree changes for the given paths (revert tracked, remove untracked).
#[tauri::command]
#[specta::specta]
pub async fn repo_discard(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    paths: Vec<String>,
) -> Result<(), AppError> {
    let session = state.get_session(&repo_id).await?;
    session
        .backend
        .discard(&to_paths(paths))
        .await
        .map_err(AppError::Git)
}

/// Commit the staged changes with the given message; returns the new commit id.
/// When `amend` is set, rewrites HEAD instead of creating a new commit.
#[tauri::command]
#[specta::specta]
pub async fn repo_commit(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    message: String,
    amend: bool,
) -> Result<CommitId, AppError> {
    let session = state.get_session(&repo_id).await?;
    let opts = CommitOptions {
        message,
        amend,
        ..Default::default()
    };
    session.backend.commit(opts).await.map_err(AppError::Git)
}

/// Reword (rename) a commit's message; returns the new commit id. v1 rewords
/// HEAD only and refuses commits already reachable from a remote (pushed).
#[tauri::command]
#[specta::specta]
pub async fn repo_reword_commit(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    commit_id: String,
    message: String,
) -> Result<CommitId, AppError> {
    let session = state.get_session(&repo_id).await?;
    session
        .backend
        .reword_commit(&CommitId::new(commit_id), &message)
        .await
        .map_err(AppError::Git)
}
