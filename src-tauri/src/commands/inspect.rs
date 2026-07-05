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

/// Blame `path` - at `rev` when given, else the working tree.
#[tauri::command]
#[specta::specta]
pub async fn repo_blame(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    path: PathBuf,
    rev: Option<String>,
) -> Result<Vec<BlameHunk>, AppError> {
    let session = state.get_session(&repo_id).await?;
    session
        .backend
        .blame(&path, rev.as_deref())
        .await
        .map_err(AppError::Git)
}

/// Merge base of two revs, or null for unrelated histories (Compare's
/// three-dot mode diffs from this base instead of `from` itself).
#[tauri::command]
#[specta::specta]
pub async fn repo_merge_base(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    a: String,
    b: String,
) -> Result<Option<String>, AppError> {
    let session = state.get_session(&repo_id).await?;
    session.backend.merge_base(&a, &b).await.map_err(AppError::Git)
}

/// Full content of a repo-relative file as of an arbitrary tree-ish; binary
/// content is classified (with its blob size) instead of returned.
#[tauri::command]
#[specta::specta]
pub async fn repo_file_at_revision(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    rev: String,
    path: PathBuf,
) -> Result<legit_core::FileAtRevision, AppError> {
    let session = state.get_session(&repo_id).await?;
    session
        .backend
        .file_at_revision(&rev, &path)
        .await
        .map_err(AppError::Git)
}
