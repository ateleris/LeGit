//! Repo LFS probes (spec: 2026-08-17-lfs-detection-warning-design.md):
//! does the repo declare LFS, is git-lfs usable, which files are
//! LFS-tracked.

use crate::error::AppError;
use crate::state::AppState;
use legit_core::cli_impl::parsers::lfs::{add_lfs_pattern, parse_lfs_patterns, remove_lfs_pattern};
use legit_core::LfsStatus;

/// LFS usage/availability for the repo. A missing binary or unset config is
/// an answer (status fields), never an error - only a broken repo errors.
#[tauri::command]
#[specta::specta]
pub async fn repo_lfs_status(
    state: tauri::State<'_, AppState>,
    repo_id: String,
) -> Result<LfsStatus, AppError> {
    let session = state.get_session(&repo_id).await?;
    session.backend.lfs_status().await.map_err(AppError::Git)
}

/// The LFS-tracked subset of the repo's file listing (worktree attributes).
/// Backs the Files panel's LFS icons; `show_ignored` mirrors the listing
/// the panel displays. Lists files server-side so the result can never race
/// a stale client-side paths snapshot.
#[tauri::command]
#[specta::specta]
pub async fn repo_lfs_files(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    show_ignored: bool,
) -> Result<Vec<String>, AppError> {
    let session = state.get_session(&repo_id).await?;
    let files = session
        .backend
        .list_repo_files(show_ignored)
        .await
        .map_err(AppError::Git)?;
    // Submodules/nested repos have no blob content - attributes don't apply.
    let paths: Vec<String> = files
        .iter()
        .filter(|f| !f.submodule)
        .map(|f| f.path.to_string_lossy().into_owned())
        .collect();
    session
        .backend
        .lfs_tracked_subset(&paths)
        .await
        .map_err(AppError::Git)
}

// ---------------------------------------------------------------------------
// Track/pattern management (root .gitattributes only; spec:
// 2026-08-17-lfs-track-management-design.md)
// ---------------------------------------------------------------------------


/// LFS patterns of the repo: the manageable root `.gitattributes` ones plus
/// (read-only) which nested attribute files also declare `filter=lfs`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, specta::Type)]
pub struct LfsPatternsView {
    pub root_patterns: Vec<String>,
    pub nested_files: Vec<String>,
}






/// Build the view: root patterns from `<root>/.gitattributes` (missing file =
/// none), nested files from the same tracked-attribute-files grep the LFS
/// status probe uses (exit 1 = no hits).
async fn patterns_view(session: &crate::state::RepoSession) -> LfsPatternsView {
    let root_text = read_gitattributes(session).await;
    let nested_files = match session.backend.lfs_attribute_files().await {
        Ok(files) => files.into_iter().filter(|f| f != ".gitattributes").collect(),
        Err(_) => vec![],
    };
    LfsPatternsView { root_patterns: parse_lfs_patterns(&root_text), nested_files }
}

fn validate_pattern(pattern: &str) -> Result<(), AppError> {
    if pattern.is_empty() {
        return Err(AppError::ParseArgs("pattern must not be empty".into()));
    }
    if pattern.contains('\n') || pattern.contains('\0') {
        return Err(AppError::ParseArgs("pattern must be a single line".into()));
    }
    if pattern.starts_with('#') || pattern.starts_with('!') {
        return Err(AppError::ParseArgs(
            "pattern must not start with '#' or '!' (comment/negation in .gitattributes)".into(),
        ));
    }
    Ok(())
}

/// The repo's LFS patterns (root = manageable, nested = read-only).
#[tauri::command]
#[specta::specta]
pub async fn repo_lfs_patterns(
    state: tauri::State<'_, AppState>,
    repo_id: String,
) -> Result<LfsPatternsView, AppError> {
    let session = state.get_session(&repo_id).await?;
    Ok(patterns_view(&session).await)
}

/// Track `pattern` in LFS: append the standard line to the root
/// `.gitattributes` (duplicate = no-op). The write is a plain worktree edit -
/// it shows up as an uncommitted change for the user to review and commit.
#[tauri::command]
#[specta::specta]
pub async fn repo_lfs_track(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    pattern: String,
) -> Result<LfsPatternsView, AppError> {
    let session = state.get_session(&repo_id).await?;
    let pattern = pattern.trim();
    validate_pattern(pattern)?;
    let existing = read_gitattributes(&session).await;
    if let Some(updated) = add_lfs_pattern(&existing, pattern) {
        write_gitattributes(&session, &updated).await?;
    }
    Ok(patterns_view(&session).await)
}

/// Untrack `pattern` (remove its standard LFS line from the root
/// `.gitattributes`). Refuses when the line carries extra attributes.
#[tauri::command]
#[specta::specta]
pub async fn repo_lfs_untrack(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    pattern: String,
) -> Result<LfsPatternsView, AppError> {
    let session = state.get_session(&repo_id).await?;
    let existing = read_gitattributes(&session).await;
    match remove_lfs_pattern(&existing, pattern.trim()) {
        Err(msg) => return Err(AppError::ParseArgs(msg)),
        Ok(Some(updated)) => write_gitattributes(&session, &updated).await?,
        Ok(None) => {}
    }
    Ok(patterns_view(&session).await)
}

/// Root `.gitattributes` text via the repo host's fs (missing = empty, like
/// the read_to_string().unwrap_or_default() it replaces).
async fn read_gitattributes(session: &crate::state::RepoSession) -> String {
    let hp = session.root.clone().join(".gitattributes");
    match session.host.fs().read(&hp, None).await {
        Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
        Err(_) => String::new(),
    }
}

async fn write_gitattributes(
    session: &crate::state::RepoSession,
    content: &str,
) -> Result<(), AppError> {
    let hp = session.root.clone().join(".gitattributes");
    session
        .host
        .fs()
        .write(&hp, content.as_bytes())
        .await
        .map_err(|e| AppError::Io(format!("write {hp}: {e}")))
}
