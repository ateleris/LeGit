//! Branch operation commands.
//! See DESIGN-v0.2.md §D.3 for repo-scoped command patterns.

use crate::{error::AppError, state::AppState};
use legit_core::{BranchMergeAnalysis, OperationId, RemoteCheckoutOutcome, SwitchOutcome};

#[tauri::command]
#[specta::specta]
pub async fn repo_create_branch(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    name: String,
    start_point: Option<String>,
) -> Result<(), AppError> {
    let session = state.get_session(&repo_id).await?;
    session
        .backend
        .create_branch(&name, start_point.as_deref())
        .await
        .map_err(AppError::Git)
}

#[tauri::command]
#[specta::specta]
pub async fn repo_set_upstream(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    branch: String,
    upstream: Option<String>,
) -> Result<(), AppError> {
    let session = state.get_session(&repo_id).await?;
    session
        .backend
        .set_upstream(&branch, upstream.as_deref())
        .await
        .map_err(AppError::Git)
}

#[tauri::command]
#[specta::specta]
pub async fn repo_switch_branch(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    name: String,
) -> Result<SwitchOutcome, AppError> {
    let behavior = {
        let s = state.global_settings.read().await;
        s.switch_dirty_behavior.unwrap_or_default()
    };
    let session = state.get_session(&repo_id).await?;
    session
        .backend
        .switch_branch(&name, behavior)
        .await
        .map_err(AppError::Git)
}

#[tauri::command]
#[specta::specta]
pub async fn repo_checkout_remote_branch(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    remote_ref: String,
) -> Result<RemoteCheckoutOutcome, AppError> {
    let (behavior, fast_forward) = {
        let s = state.global_settings.read().await;
        (
            s.switch_dirty_behavior.unwrap_or_default(),
            s.checkout_remote_fast_forward,
        )
    };
    let session = state.get_session(&repo_id).await?;
    session
        .backend
        .checkout_remote_branch(&remote_ref, behavior, fast_forward)
        .await
        .map_err(AppError::Git)
}

#[tauri::command]
#[specta::specta]
pub async fn repo_delete_branch(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    name: String,
    force: bool,
) -> Result<(), AppError> {
    let session = state.get_session(&repo_id).await?;
    session
        .backend
        .delete_branch(&name, force)
        .await
        .map_err(AppError::Git)
}

#[tauri::command]
#[specta::specta]
pub async fn repo_branch_merge_analysis(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    name: String,
) -> Result<BranchMergeAnalysis, AppError> {
    let session = state.get_session(&repo_id).await?;
    session
        .backend
        .branch_merge_analysis(&name)
        .await
        .map_err(AppError::Git)
}

#[tauri::command]
#[specta::specta]
pub async fn repo_delete_remote_branch(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    remote: String,
    name: String,
    op_id: String,
) -> Result<(), AppError> {
    let session = state.get_session(&repo_id).await?;
    session
        .backend
        .delete_remote_branch(&remote, &name, OperationId(op_id))
        .await
        .map_err(AppError::Git)
}

#[tauri::command]
#[specta::specta]
pub async fn repo_rename_branch(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    old_name: String,
    new_name: String,
) -> Result<(), AppError> {
    let session = state.get_session(&repo_id).await?;
    session
        .backend
        .rename_branch(&old_name, &new_name)
        .await
        .map_err(AppError::Git)
}

#[tauri::command]
#[specta::specta]
pub async fn repo_checkout_commit(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    sha: String,
) -> Result<SwitchOutcome, AppError> {
    let behavior = {
        let s = state.global_settings.read().await;
        s.switch_dirty_behavior.unwrap_or_default()
    };
    let session = state.get_session(&repo_id).await?;
    session
        .backend
        .checkout_commit(&sha, behavior)
        .await
        .map_err(AppError::Git)
}
