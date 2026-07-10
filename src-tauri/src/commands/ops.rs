//! Merge/rebase operations, repo-op-state probing, and whole-file conflict
//! resolution. Conflicts cross the IPC boundary as OUTCOMES (data), not
//! errors - the panels render them as in-progress state, not failure toasts.

use crate::error::AppError;
use crate::state::AppState;
use legit_core::types::{
    ConflictEntry, ConflictFileSides, ConflictSide, MergeOptions, MergeOutcome, RebaseOutcome,
    RebaseStep, ReflogEntry, RepoOpState, ResetMode, SequenceOutcome,
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
pub async fn repo_rebase_interactive(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    base: String,
    plan: Vec<RebaseStep>,
) -> Result<RebaseOutcome, AppError> {
    let session = state.get_session(&repo_id).await?;
    session
        .backend
        .rebase_interactive(&base, &plan)
        .await
        .map_err(AppError::Git)
}

#[tauri::command]
#[specta::specta]
pub async fn repo_conflict_file_sides(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    path: PathBuf,
) -> Result<ConflictFileSides, AppError> {
    let session = state.get_session(&repo_id).await?;
    session
        .backend
        .conflict_file_sides(&path)
        .await
        .map_err(AppError::Git)
}

#[tauri::command]
#[specta::specta]
pub async fn repo_reset(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    target: String,
    mode: ResetMode,
) -> Result<(), AppError> {
    let session = state.get_session(&repo_id).await?;
    session.backend.reset(&target, mode).await.map_err(AppError::Git)
}

#[tauri::command]
#[specta::specta]
pub async fn repo_revert(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    sha: String,
) -> Result<SequenceOutcome, AppError> {
    let session = state.get_session(&repo_id).await?;
    session.backend.revert(&sha).await.map_err(AppError::Git)
}

#[tauri::command]
#[specta::specta]
pub async fn repo_cherry_pick(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    sha: String,
) -> Result<SequenceOutcome, AppError> {
    let session = state.get_session(&repo_id).await?;
    session.backend.cherry_pick(&sha).await.map_err(AppError::Git)
}

#[tauri::command]
#[specta::specta]
pub async fn repo_cherry_pick_continue(
    state: tauri::State<'_, AppState>,
    repo_id: String,
) -> Result<SequenceOutcome, AppError> {
    let session = state.get_session(&repo_id).await?;
    session.backend.cherry_pick_continue().await.map_err(AppError::Git)
}

#[tauri::command]
#[specta::specta]
pub async fn repo_cherry_pick_skip(
    state: tauri::State<'_, AppState>,
    repo_id: String,
) -> Result<SequenceOutcome, AppError> {
    let session = state.get_session(&repo_id).await?;
    session.backend.cherry_pick_skip().await.map_err(AppError::Git)
}

#[tauri::command]
#[specta::specta]
pub async fn repo_cherry_pick_abort(
    state: tauri::State<'_, AppState>,
    repo_id: String,
) -> Result<(), AppError> {
    let session = state.get_session(&repo_id).await?;
    session.backend.cherry_pick_abort().await.map_err(AppError::Git)
}

#[tauri::command]
#[specta::specta]
pub async fn repo_revert_continue(
    state: tauri::State<'_, AppState>,
    repo_id: String,
) -> Result<SequenceOutcome, AppError> {
    let session = state.get_session(&repo_id).await?;
    session.backend.revert_continue().await.map_err(AppError::Git)
}

#[tauri::command]
#[specta::specta]
pub async fn repo_revert_skip(
    state: tauri::State<'_, AppState>,
    repo_id: String,
) -> Result<SequenceOutcome, AppError> {
    let session = state.get_session(&repo_id).await?;
    session.backend.revert_skip().await.map_err(AppError::Git)
}

#[tauri::command]
#[specta::specta]
pub async fn repo_revert_abort(
    state: tauri::State<'_, AppState>,
    repo_id: String,
) -> Result<(), AppError> {
    let session = state.get_session(&repo_id).await?;
    session.backend.revert_abort().await.map_err(AppError::Git)
}

#[tauri::command]
#[specta::specta]
pub async fn repo_reflog(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    max_count: u32,
) -> Result<Vec<ReflogEntry>, AppError> {
    let session = state.get_session(&repo_id).await?;
    session.backend.reflog(max_count).await.map_err(AppError::Git)
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

#[tauri::command]
#[specta::specta]
pub async fn repo_resolve_undo_paths(
    state: tauri::State<'_, AppState>,
    repo_id: String,
) -> Result<Vec<String>, AppError> {
    let session = state.get_session(&repo_id).await?;
    session.backend.resolve_undo_paths().await.map_err(AppError::Git)
}

#[tauri::command]
#[specta::specta]
pub async fn repo_staged_marker_paths(
    state: tauri::State<'_, AppState>,
    repo_id: String,
) -> Result<Vec<String>, AppError> {
    let session = state.get_session(&repo_id).await?;
    session.backend.staged_marker_paths().await.map_err(AppError::Git)
}

#[tauri::command]
#[specta::specta]
pub async fn repo_unstaged_marker_paths(
    state: tauri::State<'_, AppState>,
    repo_id: String,
) -> Result<Vec<String>, AppError> {
    let session = state.get_session(&repo_id).await?;
    session.backend.unstaged_marker_paths().await.map_err(AppError::Git)
}

#[tauri::command]
#[specta::specta]
pub async fn repo_conflict_reopen(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    path: String,
) -> Result<(), AppError> {
    let session = state.get_session(&repo_id).await?;
    session
        .backend
        .conflict_reopen(&PathBuf::from(path))
        .await
        .map_err(AppError::Git)
}
