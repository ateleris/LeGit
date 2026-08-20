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

/// Pre-commit consistency check: staged `.gitmodules` vs staged gitlinks.
/// Findings feed the composer's warning banner; empty = nothing to warn about.
#[tauri::command]
#[specta::specta]
pub async fn repo_gitmodules_consistency(
    state: tauri::State<'_, AppState>,
    repo_id: String,
) -> Result<Vec<legit_core::GitmodulesFinding>, AppError> {
    let session = state.get_session(&repo_id).await?;
    session
        .backend
        .gitmodules_consistency()
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
///
/// The component check alone is not enough: a tracked in-repo symlink
/// (`link -> /outside`) is all-plain components yet the filesystem follows it
/// out of the repo on read/write. So after joining, the path is
/// canonicalized (following every symlink, including a final-component file
/// symlink) and verified to still sit under the canonicalized root. Both
/// sides are canonicalized so the comparison is consistent on Windows, where
/// `canonicalize` returns `\\?\`-prefixed paths. The final component may not
/// exist yet (a save creating the file): its parent is verified instead, and
/// the plain-component check already guarantees the final name itself cannot
/// traverse.
pub(crate) fn resolve_repo_relative(root: &Path, rel: &str) -> Result<PathBuf, AppError> {
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
    let joined = root.join(rel_path);
    let canonical_root = std::fs::canonicalize(root)
        .map_err(|e| AppError::Io(format!("resolve {}: {e}", root.display())))?;
    let canonical = match std::fs::canonicalize(&joined) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let parent = joined
                .parent()
                .ok_or_else(|| AppError::ParseArgs(format!("invalid repo-relative path: {rel}")))?;
            let canonical_parent = std::fs::canonicalize(parent)
                .map_err(|e| AppError::Io(format!("resolve {}: {e}", parent.display())))?;
            canonical_parent.join(joined.file_name().expect("plain final component"))
        }
        Err(e) => return Err(AppError::Io(format!("resolve {}: {e}", joined.display()))),
    };
    if !canonical.starts_with(&canonical_root) {
        return Err(AppError::ParseArgs(format!(
            "path escapes the repository: {rel}"
        )));
    }
    Ok(canonical)
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
        let repo = tempfile::tempdir().unwrap();
        std::fs::create_dir(repo.path().join("src")).unwrap();
        std::fs::write(repo.path().join("src/main.rs"), "fn main() {}").unwrap();
        let p = resolve_repo_relative(repo.path(), "src/main.rs").unwrap();
        assert!(p.ends_with("src/main.rs") || p.ends_with("src\\main.rs"));
        assert!(p.starts_with(std::fs::canonicalize(repo.path()).unwrap()));
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

    /// A tracked symlink pointing outside the repo must not be followable:
    /// `link/secret` and a file symlink as the final component both resolve
    /// (via the filesystem) to paths outside the root, even though every
    /// path component is plain. The component check alone cannot see this -
    /// only canonicalize-and-verify can.
    #[cfg(unix)]
    #[test]
    fn resolve_repo_relative_rejects_symlink_escape() {
        let repo = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret.txt"), "s").unwrap();
        std::os::unix::fs::symlink(outside.path(), repo.path().join("link")).unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("secret.txt"),
            repo.path().join("flink.txt"),
        )
        .unwrap();

        // Directory symlink traversal.
        assert!(resolve_repo_relative(repo.path(), "link/secret.txt").is_err());
        // File symlink as the final component (fs::write would follow it).
        assert!(resolve_repo_relative(repo.path(), "flink.txt").is_err());
        // Writing a NEW file through an escaping directory symlink.
        assert!(resolve_repo_relative(repo.path(), "link/new.txt").is_err());
    }

    /// In-repo symlinks that stay inside the repo remain usable.
    #[cfg(unix)]
    #[test]
    fn resolve_repo_relative_allows_inside_symlink() {
        let repo = tempfile::tempdir().unwrap();
        std::fs::write(repo.path().join("real.txt"), "r").unwrap();
        std::os::unix::fs::symlink(repo.path().join("real.txt"), repo.path().join("alias.txt"))
            .unwrap();
        assert!(resolve_repo_relative(repo.path(), "alias.txt").is_ok());
    }

    /// The final component may not exist yet (saving creates it); the parent
    /// is verified instead.
    #[test]
    fn resolve_repo_relative_allows_new_file_in_existing_dir() {
        let repo = tempfile::tempdir().unwrap();
        std::fs::create_dir(repo.path().join("src")).unwrap();
        let p = resolve_repo_relative(repo.path(), "src/new.rs").unwrap();
        assert!(p.ends_with("src/new.rs") || p.ends_with("src\\new.rs"));
    }
}
