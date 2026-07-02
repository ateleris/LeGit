//! Tag operation commands.
//! See DESIGN-v0.2.md §D.3 for repo-scoped command patterns.

use crate::{error::AppError, state::AppState};
use legit_core::{OperationId, RemoteTag, TagInfo};

#[tauri::command]
#[specta::specta]
pub async fn repo_tags(
    state: tauri::State<'_, AppState>,
    repo_id: String,
) -> Result<Vec<TagInfo>, AppError> {
    let session = state.get_session(&repo_id).await?;
    session.backend.tags().await.map_err(AppError::Git)
}

#[tauri::command]
#[specta::specta]
pub async fn repo_create_tag(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    name: String,
    target: Option<String>,
    message: Option<String>,
) -> Result<(), AppError> {
    let session = state.get_session(&repo_id).await?;
    session
        .backend
        .create_tag(&name, target.as_deref(), message.as_deref())
        .await
        .map_err(AppError::Git)
}

#[tauri::command]
#[specta::specta]
pub async fn repo_delete_tag(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    name: String,
) -> Result<(), AppError> {
    let session = state.get_session(&repo_id).await?;
    session
        .backend
        .delete_tag(&name)
        .await
        .map_err(AppError::Git)
}

#[tauri::command]
#[specta::specta]
pub async fn repo_push_tag(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    remote: String,
    name: String,
    op_id: String,
) -> Result<(), AppError> {
    let session = state.get_session(&repo_id).await?;
    session
        .backend
        .push_tag(&remote, &name, OperationId(op_id))
        .await
        .map_err(AppError::Git)
}

#[tauri::command]
#[specta::specta]
pub async fn repo_delete_remote_tag(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    remote: String,
    name: String,
    op_id: String,
) -> Result<(), AppError> {
    let session = state.get_session(&repo_id).await?;
    session
        .backend
        .delete_remote_tag(&remote, &name, OperationId(op_id))
        .await
        .map_err(AppError::Git)
}

#[tauri::command]
#[specta::specta]
pub async fn repo_remote_tags(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    remote: String,
    op_id: String,
) -> Result<Vec<RemoteTag>, AppError> {
    let session = state.get_session(&repo_id).await?;
    session
        .backend
        .remote_tags(&remote, OperationId(op_id))
        .await
        .map_err(AppError::Git)
}
