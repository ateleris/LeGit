//! Inspection commands: compare (range diff), search, blame. All read-only.

use crate::error::AppError;
use crate::state::AppState;
use legit_core::types::{BlameHunk, Commit, CommitFileChange, CommitSearchKind};
use std::path::PathBuf;

/// Files changed between two arbitrary revs — the Compare view's file list.
#[tauri::command]
#[specta::specta]
pub async fn repo_diff_files(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    from: String,
    to: String,
) -> Result<Vec<CommitFileChange>, AppError> {
    let session = state.get_session(&repo_id).await?;
    session.backend.diff_files(&from, &to).await.map_err(AppError::Git)
}

#[tauri::command]
#[specta::specta]
pub async fn repo_search_commits(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    query: String,
    kind: CommitSearchKind,
    max_count: u32,
) -> Result<Vec<Commit>, AppError> {
    let session = state.get_session(&repo_id).await?;
    session
        .backend
        .search_commits(&query, kind, max_count)
        .await
        .map_err(AppError::Git)
}

#[tauri::command]
#[specta::specta]
pub async fn repo_search_paths(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    query: String,
    max_count: u32,
) -> Result<Vec<PathBuf>, AppError> {
    let session = state.get_session(&repo_id).await?;
    session
        .backend
        .search_paths(&query, max_count)
        .await
        .map_err(AppError::Git)
}

#[tauri::command]
#[specta::specta]
pub async fn repo_blame(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    path: PathBuf,
) -> Result<Vec<BlameHunk>, AppError> {
    let session = state.get_session(&repo_id).await?;
    session.backend.blame(&path).await.map_err(AppError::Git)
}
