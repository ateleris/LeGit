//! Log and Commit Details commands (DESIGN-v0.3.md §C.2, §C.3, §F.1).

use crate::error::AppError;
use crate::state::AppState;
use legit_core::types::{Branch, Commit, CommitDetails, CommitId, LogOptions};

/// Fetch the log for the active repo.
///
/// Returns at most `max_count` commits starting from `skip` (for load-more).
/// Defaults: max_count = 500, skip = 0.
#[tauri::command]
#[specta::specta]
pub async fn repo_log(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    max_count: Option<u32>,
    skip: Option<u32>,
) -> Result<Vec<Commit>, AppError> {
    let session = state.get_session(&repo_id).await?;
    let opts = LogOptions {
        max_count,
        skip,
        revision_range: None,
        paths: vec![],
        refs: legit_core::types::RefSelector::AllLocalBranches,
    };
    session.backend.log(opts).await.map_err(AppError::Git)
}

/// List all local and remote-tracking branches for the active repo,
/// including each local branch's configured upstream (used by the Commits
/// panel to fuse a branch with its remote when they sit on the same commit).
#[tauri::command]
#[specta::specta]
pub async fn repo_branches(
    state: tauri::State<'_, AppState>,
    repo_id: String,
) -> Result<Vec<Branch>, AppError> {
    let session = state.get_session(&repo_id).await?;
    session.backend.branches().await.map_err(AppError::Git)
}

/// Fetch full details for a single commit.
#[tauri::command]
#[specta::specta]
pub async fn repo_commit_details(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    commit_id: String,
) -> Result<CommitDetails, AppError> {
    let session = state.get_session(&repo_id).await?;
    let id = CommitId::new(commit_id);
    session
        .backend
        .commit_details(&id)
        .await
        .map_err(AppError::Git)
}
