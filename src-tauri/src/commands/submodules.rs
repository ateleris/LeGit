//! Submodule read commands: enumeration for the Refs-panel section and
//! pointer-range logs for the diff view. Read-only (tier 1); mutations come
//! with the tier-2/3 sub-projects.

use crate::error::AppError;
use crate::state::AppState;
use legit_core::types::{CommitId, SubmoduleInfo, SubmoduleLog};
use std::path::PathBuf;

/// List the repo's submodules with their full state.
#[tauri::command]
#[specta::specta]
pub async fn repo_submodules(
    state: tauri::State<'_, AppState>,
    repo_id: String,
) -> Result<Vec<SubmoduleInfo>, AppError> {
    let session = state.get_session(&repo_id).await?;
    session.backend.submodules().await.map_err(AppError::Git)
}

/// Commits between two submodule pointers (diff-view enrichment).
#[tauri::command]
#[specta::specta]
pub async fn repo_submodule_log(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    path: String,
    from: Option<String>,
    to: String,
) -> Result<SubmoduleLog, AppError> {
    let session = state.get_session(&repo_id).await?;
    let from = from.map(CommitId::new);
    session
        .backend
        .submodule_log(&PathBuf::from(path), from.as_ref(), &CommitId::new(to))
        .await
        .map_err(AppError::Git)
}
