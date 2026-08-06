//! Submodule read commands: enumeration for the Refs-panel section and
//! pointer-range logs for the diff view. Read-only (tier 1); mutations come
//! with the tier-2/3 sub-projects.

use crate::error::AppError;
use crate::state::AppState;
use legit_core::types::{
    CommitId, SubmoduleAutoUpdateResult, SubmoduleGitdirInfo, SubmoduleInfo, SubmoduleLog,
    SubmoduleUpdateOptions, SubmoduleUpdateStrategy,
};
use legit_core::OperationId;
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

/// Check out recorded submodule SHAs (`git submodule update`). Cancellable.
/// Registration is folded in via `opts.init` (`--init`); there is no separate
/// init command.
#[tauri::command]
#[specta::specta]
pub async fn repo_submodule_update(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    opts: SubmoduleUpdateOptions,
    op_id: String,
) -> Result<(), AppError> {
    let session = state.get_session(&repo_id).await?;
    let mut opts = opts;
    // The frontend never sets this; it mirrors the global setting.
    opts.attach_branch = state.global_settings.read().await.submodule_attach_branch;
    session
        .backend
        .submodule_update(opts, OperationId(op_id))
        .await
        .map_err(AppError::Git)
}

/// Re-sync submodule URLs (`git submodule sync`).
#[tauri::command]
#[specta::specta]
pub async fn repo_submodule_sync(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    paths: Vec<String>,
    recursive: bool,
) -> Result<(), AppError> {
    let session = state.get_session(&repo_id).await?;
    let paths: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    session
        .backend
        .submodule_sync(&paths, recursive)
        .await
        .map_err(AppError::Git)
}

/// Fetch inside one submodule. Cancellable.
#[tauri::command]
#[specta::specta]
pub async fn repo_submodule_fetch(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    path: String,
    op_id: String,
) -> Result<(), AppError> {
    let session = state.get_session(&repo_id).await?;
    session
        .backend
        .submodule_fetch(&PathBuf::from(path), OperationId(op_id))
        .await
        .map_err(AppError::Git)
}

/// The superproject working tree containing this repo, if any.
#[tauri::command]
#[specta::specta]
pub async fn repo_superproject(
    state: tauri::State<'_, AppState>,
    repo_id: String,
) -> Result<Option<String>, AppError> {
    let session = state.get_session(&repo_id).await?;
    let path = session.backend.superproject_path().await.map_err(AppError::Git)?;
    Ok(path.map(|p| p.to_string_lossy().into_owned()))
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

/// Add a submodule. Cancellable (clones).
#[tauri::command]
#[specta::specta]
pub async fn repo_submodule_add(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    url: String,
    path: String,
    branch: Option<String>,
    op_id: String,
) -> Result<(), AppError> {
    let session = state.get_session(&repo_id).await?;
    session
        .backend
        .submodule_add(&url, &PathBuf::from(path), branch.as_deref(), OperationId(op_id))
        .await
        .map_err(AppError::Git)
}

/// Change a submodule's URL (.gitmodules) and auto-sync it.
#[tauri::command]
#[specta::specta]
pub async fn repo_submodule_set_url(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    path: String,
    url: String,
) -> Result<(), AppError> {
    let session = state.get_session(&repo_id).await?;
    session
        .backend
        .submodule_set_url(&PathBuf::from(path), &url)
        .await
        .map_err(AppError::Git)
}

/// Set or clear (None) the tracked branch used by `update --remote`.
#[tauri::command]
#[specta::specta]
pub async fn repo_submodule_set_branch(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    path: String,
    branch: Option<String>,
) -> Result<(), AppError> {
    let session = state.get_session(&repo_id).await?;
    session
        .backend
        .submodule_set_branch(&PathBuf::from(path), branch.as_deref())
        .await
        .map_err(AppError::Git)
}

/// Pull each submodule's tracked branch and stage the moved pointers.
/// Dirty submodules follow the GLOBAL switch strategy (stash/carry/rollback,
/// same machinery as the post-switch auto-update); outcomes are data.
#[tauri::command]
#[specta::specta]
pub async fn repo_submodule_update_remote(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    paths: Vec<String>,
    strategy: SubmoduleUpdateStrategy,
    op_id: String,
) -> Result<Vec<SubmoduleAutoUpdateResult>, AppError> {
    let session = state.get_session(&repo_id).await?;
    let paths: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    let (behavior, attach_branch) = {
        let gs = state.global_settings.read().await;
        (gs.switch_dirty_behavior.unwrap_or_default(), gs.submodule_attach_branch)
    };
    session
        .backend
        .submodule_update_remote(&paths, strategy, behavior, attach_branch, OperationId(op_id))
        .await
        .map_err(AppError::Git)
}

/// Remove a submodule (refuses dirty; keeps the gitdir).
#[tauri::command]
#[specta::specta]
pub async fn repo_submodule_remove(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    path: String,
) -> Result<(), AppError> {
    let session = state.get_session(&repo_id).await?;
    session
        .backend
        .submodule_remove(&PathBuf::from(path))
        .await
        .map_err(AppError::Git)
}

/// Move a submodule to another path (`git mv`; stages the result).
#[tauri::command]
#[specta::specta]
pub async fn repo_submodule_move(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    from: String,
    to: String,
) -> Result<(), AppError> {
    let session = state.get_session(&repo_id).await?;
    session
        .backend
        .submodule_move(&PathBuf::from(from), &PathBuf::from(to))
        .await
        .map_err(AppError::Git)
}

/// Inspect a removed submodule's retained gitdir.
#[tauri::command]
#[specta::specta]
pub async fn repo_submodule_gitdir_info(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    name: String,
) -> Result<Option<SubmoduleGitdirInfo>, AppError> {
    let session = state.get_session(&repo_id).await?;
    session.backend.submodule_gitdir_info(&name).await.map_err(AppError::Git)
}

/// Permanently delete `.git/modules/<name>` (caller confirms).
#[tauri::command]
#[specta::specta]
pub async fn repo_submodule_delete_gitdir(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    name: String,
) -> Result<(), AppError> {
    let session = state.get_session(&repo_id).await?;
    session.backend.submodule_delete_gitdir(&name).await.map_err(AppError::Git)
}

/// Post-switch/pull submodule auto-update. Gated on the per-repo setting
/// (default ON); dirty submodules follow the GLOBAL switch strategy. Returns
/// per-submodule outcomes (partial success is data, not an error).
#[tauri::command]
#[specta::specta]
pub async fn repo_submodule_auto_update(
    state: tauri::State<'_, AppState>,
    repo_id: String,
) -> Result<Vec<SubmoduleAutoUpdateResult>, AppError> {
    let session = state.get_session(&repo_id).await?;
    let enabled = session.settings.read().await.submodule_auto_update.unwrap_or(true);
    if !enabled {
        return Ok(Vec::new());
    }
    let (behavior, attach_branch) = {
        let gs = state.global_settings.read().await;
        (gs.switch_dirty_behavior.unwrap_or_default(), gs.submodule_attach_branch)
    };
    session
        .backend
        .submodule_auto_update(behavior, attach_branch)
        .await
        .map_err(AppError::Git)
}

/// Create and switch to a branch at the submodule's current HEAD.
#[tauri::command]
#[specta::specta]
pub async fn repo_submodule_create_branch(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    path: String,
    name: String,
) -> Result<(), AppError> {
    let session = state.get_session(&repo_id).await?;
    session
        .backend
        .submodule_create_branch(&PathBuf::from(path), &name)
        .await
        .map_err(AppError::Git)
}
