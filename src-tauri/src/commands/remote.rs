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
use legit_core::types::{FetchOptions, PullOptions, PullOutcome, PushOptions, Remote, TrackingStatus};
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
) -> Result<PullOutcome, AppError> {
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

// --- remote management -----------------------------------------------------

/// List the configured remotes with their fetch/push URLs.
#[tauri::command]
#[specta::specta]
pub async fn repo_list_remotes(
    state: tauri::State<'_, AppState>,
    repo_id: String,
) -> Result<Vec<Remote>, AppError> {
    let session = state.get_session(&repo_id).await?;
    session.backend.list_remotes().await.map_err(AppError::Git)
}

/// Add a remote (`git remote add`).
#[tauri::command]
#[specta::specta]
pub async fn repo_add_remote(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    name: String,
    url: String,
) -> Result<(), AppError> {
    let session = state.get_session(&repo_id).await?;
    session
        .backend
        .add_remote(&name, &url)
        .await
        .map_err(AppError::Git)
}

/// Remove a remote and its tracking refs (`git remote remove`).
#[tauri::command]
#[specta::specta]
pub async fn repo_remove_remote(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    name: String,
) -> Result<(), AppError> {
    let session = state.get_session(&repo_id).await?;
    session
        .backend
        .remove_remote(&name)
        .await
        .map_err(AppError::Git)
}

/// Rename a remote (`git remote rename`).
#[tauri::command]
#[specta::specta]
pub async fn repo_rename_remote(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    old_name: String,
    new_name: String,
) -> Result<(), AppError> {
    let session = state.get_session(&repo_id).await?;
    session
        .backend
        .rename_remote(&old_name, &new_name)
        .await
        .map_err(AppError::Git)
}

/// Set a remote's fetch or push URL (`git remote set-url [--push]`).
#[tauri::command]
#[specta::specta]
pub async fn repo_set_remote_url(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    name: String,
    url: String,
    push: bool,
) -> Result<(), AppError> {
    let session = state.get_session(&repo_id).await?;
    session
        .backend
        .set_remote_url(&name, &url, push)
        .await
        .map_err(AppError::Git)
}

/// Prune stale remote-tracking refs (`git remote prune`). Cancellable via `op_id`.
#[tauri::command]
#[specta::specta]
pub async fn repo_prune_remote(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    name: String,
    op_id: String,
) -> Result<(), AppError> {
    let session = state.get_session(&repo_id).await?;
    session
        .backend
        .prune_remote(&name, OperationId(op_id))
        .await
        .map_err(AppError::Git)
}
