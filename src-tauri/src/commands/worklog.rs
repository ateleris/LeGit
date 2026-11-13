//! Work Log window data commands: the per-day sweep and the uncommitted
//! file list with host-fs mtimes.

use crate::{error::AppError, state::AppState};
use legit_core::{FileState, WorkLogRepoData};
use serde::Serialize;
use specta::Type;

#[tauri::command]
#[specta::specta]
pub async fn repo_work_log(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    since_unix: i64,
) -> Result<WorkLogRepoData, AppError> {
    let session = state.get_session(&repo_id).await?;
    session.backend.work_log(since_unix).await.map_err(AppError::Git)
}

/// One working-tree change with its file's last-modified time. A path both
/// staged and modified yields two entries (same shape as `FileStatus`).
#[derive(Debug, Clone, Serialize, Type)]
pub struct WorkLogUncommittedFile {
    pub path: String,
    /// Rename/copy source; a diff of such an entry must pair both sides or
    /// it reads as a whole-file add.
    pub old_path: Option<String>,
    pub state: FileState,
    pub staged: bool,
    /// `None` for deleted files (nothing to stat) and stat failures.
    pub mtime_unix: Option<i64>,
}

#[tauri::command]
#[specta::specta]
pub async fn repo_work_log_uncommitted(
    state: tauri::State<'_, AppState>,
    repo_id: String,
) -> Result<Vec<WorkLogUncommittedFile>, AppError> {
    let session = state.get_session(&repo_id).await?;
    let status = session.backend.status().await.map_err(AppError::Git)?;
    let fs = session.host.fs();
    // Paths come from git's own status output (repo-relative, no user
    // input), so a plain join needs no canonicalize round trips; stat_many
    // keeps WSL at one wire call for the whole list.
    let paths: Vec<_> = status
        .iter()
        .map(|f| session.root.join(&f.path.to_string_lossy()))
        .collect();
    let stats = fs
        .stat_many(&paths)
        .await
        .map_err(|e| AppError::Io(e.to_string()))?;
    Ok(status
        .into_iter()
        .zip(stats)
        .map(|(f, st)| WorkLogUncommittedFile {
            path: f.path.to_string_lossy().into_owned(),
            old_path: f.old_path.as_ref().map(|p| p.to_string_lossy().into_owned()),
            state: f.state,
            staged: f.staged,
            mtime_unix: st.and_then(|s| s.mtime_unix),
        })
        .collect())
}
