//! Log and Commit Details commands (DESIGN-v0.3.md §C.2, §C.3, §F.1).

use crate::error::AppError;
use crate::state::AppState;
use legit_core::types::{
    Branch, Commit, CommitDetails, CommitFileChange, CommitId, FileStatus, LogOptions,
};

/// Fetch the log for the active repo.
///
/// Returns at most `max_count` commits starting from `skip` (for load-more).
/// Defaults: max_count = 500, skip = 0. With `revision_range` set (e.g.
/// `base..HEAD` for the interactive-rebase plan) only that range is walked —
/// no branch refs, no synthetic stash nodes.
#[tauri::command]
#[specta::specta]
pub async fn repo_log(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    max_count: Option<u32>,
    skip: Option<u32>,
    revision_range: Option<String>,
    include_remotes: Option<bool>,
    author: Option<String>,
    include_stashes: Option<bool>,
) -> Result<Vec<Commit>, AppError> {
    let session = state.get_session(&repo_id).await?;
    let refs = if revision_range.is_some() {
        legit_core::types::RefSelector::Head
    } else if include_remotes.unwrap_or(false) {
        legit_core::types::RefSelector::AllBranchesAndRemotes
    } else {
        legit_core::types::RefSelector::AllLocalBranches
    };
    let opts = LogOptions {
        max_count,
        skip,
        revision_range,
        paths: vec![],
        refs,
        author,
        include_stashes: include_stashes.unwrap_or(false),
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

/// Working-tree status for the active repo: every staged, unstaged, and
/// untracked change. Drives the Commits panel's "uncommitted changes" row.
#[tauri::command]
#[specta::specta]
pub async fn repo_status(
    state: tauri::State<'_, AppState>,
    repo_id: String,
) -> Result<Vec<FileStatus>, AppError> {
    let session = state.get_session(&repo_id).await?;
    session.backend.status().await.map_err(AppError::Git)
}

/// Files changed by a commit, relative to its first parent (empty tree for a
/// root commit). Drives the Changed Files panel.
#[tauri::command]
#[specta::specta]
pub async fn repo_commit_files(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    commit_id: String,
) -> Result<Vec<CommitFileChange>, AppError> {
    let session = state.get_session(&repo_id).await?;
    let id = CommitId::new(commit_id);
    session
        .backend
        .commit_files(&id)
        .await
        .map_err(AppError::Git)
}

/// The subset of `commit_ids` that carry a signature header - presence only,
/// via one batched raw-header scan (per-SHA cached; no verifier spawns).
/// Backs the Commits panel's Signed column; the frontend queries this only
/// while that column is visible.
#[tauri::command]
#[specta::specta]
pub async fn repo_signature_presence(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    commit_ids: Vec<String>,
) -> Result<Vec<CommitId>, AppError> {
    let session = state.get_session(&repo_id).await?;
    let ids: Vec<CommitId> = commit_ids.into_iter().map(CommitId::new).collect();
    session
        .backend
        .signature_presence(&ids)
        .await
        .map_err(AppError::Git)
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
