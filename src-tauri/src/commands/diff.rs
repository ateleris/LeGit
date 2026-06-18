//! Diff commands: produce a single file's diff and apply individual hunks to
//! the index or working tree. Backs the Diff panel.

use crate::error::AppError;
use crate::state::AppState;
use legit_core::types::{DiffEntry, DiffSource, HunkOp};
use std::path::PathBuf;

/// The diff for `path` from one of the comparison sources (working unstaged,
/// working staged, or a commit vs its parent). `context` is the number of
/// surrounding context lines — small for the chunked view, very large for the
/// whole-file view.
#[tauri::command]
#[specta::specta]
pub async fn repo_diff(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    source: DiffSource,
    path: String,
    old_path: Option<String>,
    context: u32,
) -> Result<DiffEntry, AppError> {
    let session = state.get_session(&repo_id).await?;
    let old = old_path.map(PathBuf::from);
    session
        .backend
        .file_diff(&source, &PathBuf::from(path), old.as_deref(), context)
        .await
        .map_err(AppError::Git)
}

/// Stage a single hunk of `path`'s unstaged diff (`git apply --cached`).
#[tauri::command]
#[specta::specta]
pub async fn repo_stage_hunk(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    path: String,
    hunk_index: u32,
) -> Result<(), AppError> {
    let session = state.get_session(&repo_id).await?;
    session
        .backend
        .apply_hunk(&PathBuf::from(path), hunk_index as usize, HunkOp::Stage)
        .await
        .map_err(AppError::Git)
}

/// Unstage a single hunk of `path`'s staged diff (`git apply --cached -R`).
#[tauri::command]
#[specta::specta]
pub async fn repo_unstage_hunk(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    path: String,
    hunk_index: u32,
) -> Result<(), AppError> {
    let session = state.get_session(&repo_id).await?;
    session
        .backend
        .apply_hunk(&PathBuf::from(path), hunk_index as usize, HunkOp::Unstage)
        .await
        .map_err(AppError::Git)
}

/// Discard a single hunk of `path`'s unstaged diff from the working tree
/// (`git apply -R`).
#[tauri::command]
#[specta::specta]
pub async fn repo_discard_hunk(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    path: String,
    hunk_index: u32,
) -> Result<(), AppError> {
    let session = state.get_session(&repo_id).await?;
    session
        .backend
        .apply_hunk(&PathBuf::from(path), hunk_index as usize, HunkOp::Discard)
        .await
        .map_err(AppError::Git)
}

fn to_indices(line_indices: Vec<u32>) -> Vec<usize> {
    line_indices.into_iter().map(|i| i as usize).collect()
}

/// Stage a subset of a hunk's lines (`line_indices` index into the hunk's diff
/// lines, context included).
#[tauri::command]
#[specta::specta]
pub async fn repo_stage_lines(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    path: String,
    hunk_index: u32,
    line_indices: Vec<u32>,
) -> Result<(), AppError> {
    let session = state.get_session(&repo_id).await?;
    session
        .backend
        .apply_lines(&PathBuf::from(path), hunk_index as usize, &to_indices(line_indices), HunkOp::Stage)
        .await
        .map_err(AppError::Git)
}

/// Unstage a subset of a hunk's lines.
#[tauri::command]
#[specta::specta]
pub async fn repo_unstage_lines(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    path: String,
    hunk_index: u32,
    line_indices: Vec<u32>,
) -> Result<(), AppError> {
    let session = state.get_session(&repo_id).await?;
    session
        .backend
        .apply_lines(&PathBuf::from(path), hunk_index as usize, &to_indices(line_indices), HunkOp::Unstage)
        .await
        .map_err(AppError::Git)
}

/// Discard a subset of a hunk's lines from the working tree.
#[tauri::command]
#[specta::specta]
pub async fn repo_discard_lines(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    path: String,
    hunk_index: u32,
    line_indices: Vec<u32>,
) -> Result<(), AppError> {
    let session = state.get_session(&repo_id).await?;
    session
        .backend
        .apply_lines(&PathBuf::from(path), hunk_index as usize, &to_indices(line_indices), HunkOp::Discard)
        .await
        .map_err(AppError::Git)
}
