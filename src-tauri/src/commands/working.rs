//! Working-tree write operations: stage, unstage, discard, and commit.
//! Backs the Working Changes panel.

use crate::error::AppError;
use crate::state::AppState;
use legit_core::types::{CommitId, CommitOptions};
use std::path::{Component, Path, PathBuf};

fn to_paths(paths: Vec<String>) -> Vec<PathBuf> {
    paths.into_iter().map(PathBuf::from).collect()
}

/// Stage the given paths (`git add`).
#[tauri::command]
#[specta::specta]
pub async fn repo_stage(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    paths: Vec<String>,
) -> Result<(), AppError> {
    let session = state.get_session(&repo_id).await?;
    session
        .backend
        .stage(&to_paths(paths))
        .await
        .map_err(AppError::Git)
}

/// Unstage the given paths (`git restore --staged`).
#[tauri::command]
#[specta::specta]
pub async fn repo_unstage(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    paths: Vec<String>,
) -> Result<(), AppError> {
    let session = state.get_session(&repo_id).await?;
    session
        .backend
        .unstage(&to_paths(paths))
        .await
        .map_err(AppError::Git)
}

/// Discard working-tree changes for the given paths (revert tracked, remove untracked).
#[tauri::command]
#[specta::specta]
pub async fn repo_discard(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    paths: Vec<String>,
) -> Result<(), AppError> {
    let session = state.get_session(&repo_id).await?;
    session
        .backend
        .discard(&to_paths(paths))
        .await
        .map_err(AppError::Git)
}

/// Restore a single file (index + working tree) to its content at `rev`.
/// Destructive - git overwrites local changes to the file without complaint;
/// the destructive-confirmation gate lives in the UI.
#[tauri::command]
#[specta::specta]
pub async fn repo_restore_file_at_revision(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    rev: String,
    path: String,
) -> Result<(), AppError> {
    let session = state.get_session(&repo_id).await?;
    session
        .backend
        .restore_file_at_revision(&rev, std::path::Path::new(&path))
        .await
        .map_err(AppError::Git)
}

/// Commit the staged changes with the given message; returns the new commit id.
/// When `amend` is set, rewrites HEAD instead of creating a new commit.
#[tauri::command]
#[specta::specta]
pub async fn repo_commit(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    message: String,
    amend: bool,
) -> Result<CommitId, AppError> {
    let session = state.get_session(&repo_id).await?;
    let opts = CommitOptions {
        message,
        amend,
        ..Default::default()
    };
    session.backend.commit(opts).await.map_err(AppError::Git)
}

/// Reword (rename) a commit's message; returns the new commit id. v1 rewords
/// HEAD only and refuses commits already reachable from a remote (pushed).
#[tauri::command]
#[specta::specta]
pub async fn repo_reword_commit(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    commit_id: String,
    message: String,
) -> Result<CommitId, AppError> {
    let session = state.get_session(&repo_id).await?;
    session
        .backend
        .reword_commit(&CommitId::new(commit_id), &message)
        .await
        .map_err(AppError::Git)
}

/// Resolve a repo-relative file path against the repo root, rejecting absolute
/// paths and any non-plain component (`..`, `.`, prefixes) so IPC callers can
/// only ever touch files inside the repository working tree.
fn resolve_repo_relative(root: &Path, rel: &str) -> Result<PathBuf, AppError> {
    let rel_path = Path::new(rel);
    let plain = !rel_path.as_os_str().is_empty()
        && rel_path
            .components()
            .all(|c| matches!(c, Component::Normal(_)));
    if rel_path.is_absolute() || !plain {
        return Err(AppError::ParseArgs(format!(
            "invalid repo-relative path: {rel}"
        )));
    }
    Ok(root.join(rel_path))
}

/// Read a working-tree file as UTF-8 text (the editable diff's save baseline).
#[tauri::command]
#[specta::specta]
pub async fn repo_read_worktree_file(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    path: String,
) -> Result<String, AppError> {
    let session = state.get_session(&repo_id).await?;
    let abs = resolve_repo_relative(&session.path, &path)?;
    let bytes = tokio::fs::read(&abs)
        .await
        .map_err(|e| AppError::Io(format!("read {}: {e}", abs.display())))?;
    String::from_utf8(bytes).map_err(|_| AppError::Io(format!("{path} is not UTF-8 text")))
}

/// Overwrite a working-tree file with the given text (the editable diff's
/// save path). The frontend is responsible for EOL preservation.
#[tauri::command]
#[specta::specta]
pub async fn repo_write_worktree_file(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    path: String,
    content: String,
) -> Result<(), AppError> {
    let session = state.get_session(&repo_id).await?;
    let abs = resolve_repo_relative(&session.path, &path)?;
    tokio::fs::write(&abs, content.as_bytes())
        .await
        .map_err(|e| AppError::Io(format!("write {}: {e}", abs.display())))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_repo_relative_joins_inside_root() {
        let root = Path::new("/repo");
        let p = resolve_repo_relative(root, "src/main.rs").unwrap();
        assert_eq!(p, Path::new("/repo/src/main.rs"));
    }

    #[test]
    fn resolve_repo_relative_rejects_absolute_paths() {
        let root = Path::new("/repo");
        assert!(resolve_repo_relative(root, "/etc/passwd").is_err());
    }

    #[test]
    fn resolve_repo_relative_rejects_traversal() {
        let root = Path::new("/repo");
        assert!(resolve_repo_relative(root, "../outside.txt").is_err());
        assert!(resolve_repo_relative(root, "src/../../outside.txt").is_err());
        assert!(resolve_repo_relative(root, "./x/./y").is_err());
        assert!(resolve_repo_relative(root, "").is_err());
    }
}
