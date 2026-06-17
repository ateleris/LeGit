//! Startup `git --version` check and runtime Git binary path configuration
//! (DESIGN.md §7.6).

use crate::error::AppError;
use crate::git_resolve::resolve_git_path;
use crate::state::{persist_repo_settings, AppState, RepoSummary};
use crate::commands::repo::{open_session, resolve_repo_git_path};
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
    let user_override = state.global_settings.read().await.git_path_override.clone();
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
        let mut settings = state.global_settings.write().await;
        settings.git_path_override = path.clone();
        let mut current = state.git_path.write().await;
        *current = resolved.clone();
    }
    state.persist_global_settings().await?;
    probe(&resolved, path).await
}

/// Set a per-repo git binary override. Probes the new binary; if it passes,
/// tears down the old session and opens a fresh one so runner + backend are
/// both rebuilt from scratch. Returns the new RepoSummary (new session ID).
/// See DESIGN-v0.2.md §E.
#[tauri::command]
#[specta::specta]
pub async fn set_repo_git_path(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    repo_id: String,
    path: Option<String>,
) -> Result<RepoSummary, AppError> {
    let session = state.get_session(&repo_id).await?;
    let repo_path = session.path.clone();

    // Resolve and probe the candidate binary before touching anything.
    let global_git_path = state.git_path.read().await.clone();
    let mut candidate_settings = session.settings.read().await.clone();
    candidate_settings.git_path_override = path.clone();
    let resolved = resolve_repo_git_path(&candidate_settings, &global_git_path);
    let status = probe(&resolved, path.clone()).await?;
    if !status.meets_minimum {
        return Err(AppError::Git(legit_core::GitError::GitUnavailable(
            status.error.unwrap_or_else(|| format!(
                "{} does not meet the minimum required version",
                resolved.display()
            )),
        )));
    }

    // Persist the new settings.
    let (repo_dir, settings_path) = state.repo_data_paths(&repo_path);
    persist_repo_settings(&candidate_settings, &repo_dir, &settings_path, &repo_path).await?;

    // Tear down the old session (and its watcher) and open a fresh one. The new
    // session picks up the persisted settings and builds runner + backend from
    // them; open_session starts a new watcher for it.
    state.repos.write().await.remove(&repo_id);
    state.watchers.lock().unwrap().remove(&repo_id);
    let summary = open_session(&state, &app, global_git_path, repo_path).await;
    Ok(summary)
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
