//! Remote sync commands: fetch, pull, push, and ahead/behind tracking status.
//! Backs the Commits panel's sync toolbar.
//!
//! `repo_fetch`/`repo_pull`/`repo_push` take a frontend-generated `op_id` so the
//! UI can cancel the in-flight git invocation through the existing
//! `console_cancel` command (it shares the repo's `GitRunner`). Authentication is
//! driven entirely by the repo's local git config (the active git profile's SSH
//! command + credential helper); these commands add no auth-specific behavior.

use crate::error::AppError;
use crate::state::AppState;
use legit_core::types::{FetchOptions, PullOptions, PushOptions, TrackingStatus};
use legit_core::OperationId;

/// Fetch from remote(s). Cancellable via `op_id` (see `console_cancel`).
#[tauri::command]
#[specta::specta]
pub async fn repo_fetch(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    opts: FetchOptions,
    op_id: String,
) -> Result<(), AppError> {
    let session = state.get_session(&repo_id).await?;
    session
        .backend
        .fetch(opts, OperationId(op_id))
        .await
        .map_err(AppError::Git)
}

/// Pull (fetch + integrate) for the current branch. Cancellable via `op_id`.
#[tauri::command]
#[specta::specta]
pub async fn repo_pull(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    opts: PullOptions,
    op_id: String,
) -> Result<(), AppError> {
    let session = state.get_session(&repo_id).await?;
    session
        .backend
        .pull(opts, OperationId(op_id))
        .await
        .map_err(AppError::Git)
}

/// Push the current branch to its remote. Cancellable via `op_id`.
#[tauri::command]
#[specta::specta]
pub async fn repo_push(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    opts: PushOptions,
    op_id: String,
) -> Result<(), AppError> {
    let session = state.get_session(&repo_id).await?;
    session
        .backend
        .push(opts, OperationId(op_id))
        .await
        .map_err(AppError::Git)
}

/// Ahead/behind status of the current branch vs its upstream. `None` when HEAD
/// is detached or the current branch has no upstream configured.
#[tauri::command]
#[specta::specta]
pub async fn repo_tracking_status(
    state: tauri::State<'_, AppState>,
    repo_id: String,
) -> Result<Option<TrackingStatus>, AppError> {
    let session = state.get_session(&repo_id).await?;
    session
        .backend
        .tracking_status()
        .await
        .map_err(AppError::Git)
}
