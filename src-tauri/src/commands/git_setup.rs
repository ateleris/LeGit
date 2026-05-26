//! Startup `git --version` check and runtime Git binary path configuration
//! (DESIGN.md §7.6).

use crate::error::AppError;
use crate::git_resolve::resolve_git_path;
use crate::state::AppState;
use legit_core::{GitRunner, GitVersion, MIN_SUPPORTED_GIT_VERSION};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct GitStatus {
    pub resolved_path: String,
    /// `null` when the binary cannot be spawned at all.
    pub version: Option<GitVersion>,
    /// `true` when `version` is set and meets the minimum (§7.6).
    pub meets_minimum: bool,
    pub minimum_required: (u32, u32, u32),
    pub user_override: Option<String>,
    pub error: Option<String>,
}

#[tauri::command]
#[specta::specta]
pub async fn git_status_check(
    state: tauri::State<'_, AppState>,
) -> Result<GitStatus, AppError> {
    let path = state.git_path.read().await.clone();
    let user_override = state.settings.read().await.git_path_override.clone();
    probe(&path, user_override).await
}

#[tauri::command]
#[specta::specta]
pub async fn set_git_path(
    state: tauri::State<'_, AppState>,
    path: Option<String>,
) -> Result<GitStatus, AppError> {
    let override_pb = path.as_deref().map(PathBuf::from);
    let resolved = resolve_git_path(override_pb.as_ref());
    {
        let mut settings = state.settings.write().await;
        settings.git_path_override = path.clone();
        let mut current = state.git_path.write().await;
        *current = resolved.clone();
    }
    state.persist_settings().await?;
    probe(&resolved, path).await
}

async fn probe(
    git_path: &std::path::Path,
    user_override: Option<String>,
) -> Result<GitStatus, AppError> {
    let runner = GitRunner::unbound(git_path);
    match runner.check_version().await {
        Ok(v) => Ok(GitStatus {
            resolved_path: git_path.display().to_string(),
            meets_minimum: v.meets_minimum(),
            version: Some(v),
            minimum_required: MIN_SUPPORTED_GIT_VERSION,
            user_override,
            error: None,
        }),
        Err(e) => Ok(GitStatus {
            resolved_path: git_path.display().to_string(),
            version: None,
            meets_minimum: false,
            minimum_required: MIN_SUPPORTED_GIT_VERSION,
            user_override,
            error: Some(e.to_string()),
        }),
    }
}
