//! Worktree management commands. Backs the Refs panel's Worktrees pane.

use crate::error::AppError;
use crate::state::AppState;
use legit_core::types::WorktreeAddMode;

/// All worktrees of the repo, main first.
#[tauri::command]
#[specta::specta]
pub async fn repo_worktree_list(
    state: tauri::State<'_, AppState>,
    repo_id: String,
) -> Result<Vec<legit_core::WorktreeInfo>, AppError> {
    let session = state.get_session(&repo_id).await?;
    session.backend.worktree_list().await.map_err(AppError::Git)
}

/// Create a worktree at `path` (absolute, on the repo's host).
#[tauri::command]
#[specta::specta]
pub async fn repo_worktree_add(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    path: String,
    mode: WorktreeAddMode,
) -> Result<(), AppError> {
    let session = state.get_session(&repo_id).await?;
    session
        .backend
        .worktree_add(&path, &mode)
        .await
        .map_err(AppError::Git)
}

/// Remove a worktree checkout; `force` also drops a dirty tree.
#[tauri::command]
#[specta::specta]
pub async fn repo_worktree_remove(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    path: String,
    force: bool,
) -> Result<(), AppError> {
    let session = state.get_session(&repo_id).await?;
    session
        .backend
        .worktree_remove(&path, force)
        .await
        .map_err(AppError::Git)
}

/// Drop stale bookkeeping of manually deleted worktrees.
#[tauri::command]
#[specta::specta]
pub async fn repo_worktree_prune(
    state: tauri::State<'_, AppState>,
    repo_id: String,
) -> Result<(), AppError> {
    let session = state.get_session(&repo_id).await?;
    session.backend.worktree_prune().await.map_err(AppError::Git)
}
