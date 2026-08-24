//! Files-tree commands: list the whole repo (tracked/untracked/ignored),
//! add paths to `.gitignore`, stop tracking a file, and reveal it in the OS
//! file manager. Backs the Files panel.
//!
//! The git parts (`ls-files`, `rm --cached`) live in `legit-core`; the
//! `.gitignore` write is plain file I/O and lives here (like `line_endings`),
//! with the line-composition rules extracted into pure, unit-tested helpers.

use crate::commands::working::resolve_repo_relative;
use crate::error::AppError;
use crate::state::AppState;
use legit_core::types::{FileAtRevision, RepoFileEntry};
use std::path::PathBuf;


/// Every file in the repo, classified tracked/untracked/(ignored). Backs the
/// Files tree.
#[tauri::command]
#[specta::specta]
pub async fn repo_list_files(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    show_ignored: bool,
) -> Result<Vec<RepoFileEntry>, AppError> {
    let session = state.get_session(&repo_id).await?;
    session
        .backend
        .list_repo_files(show_ignored)
        .await
        .map_err(AppError::Git)
}

/// Every entry in the tree of `rev` (browse-at-commit mode of the Files
/// panel). A commit only records tracked content, so every entry is
/// `Tracked`; gitlinks carry the `submodule` flag.
#[tauri::command]
#[specta::specta]
pub async fn repo_files_at_revision(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    rev: String,
) -> Result<Vec<RepoFileEntry>, AppError> {
    let session = state.get_session(&repo_id).await?;
    session
        .backend
        .list_files_at_revision(&rev)
        .await
        .map_err(AppError::Git)
}

/// Append a path to the repo-root `.gitignore` (`path` for a file, `path/` for
/// a directory), anchored to the repo root. A no-op if the exact line is
/// already present.
#[tauri::command]
#[specta::specta]
pub async fn repo_add_to_gitignore(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    path: String,
    is_dir: bool,
) -> Result<(), AppError> {
    let session = state.get_session(&repo_id).await?;
    // Defence in depth: reject absolute / traversal paths even though these
    // come from our own `ls-files` output.
    resolve_repo_relative(&session.path, &path)?;
    write_gitignore_line(&session.path, &path, is_dir).await
}

/// Stop tracking a file (`git rm --cached`, keeps it on disk) and add it to
/// `.gitignore`. If the git step succeeds but the gitignore write fails, the
/// error says so - the file *is* already untracked.
#[tauri::command]
#[specta::specta]
pub async fn repo_untrack_path(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    path: String,
    is_dir: bool,
) -> Result<(), AppError> {
    let session = state.get_session(&repo_id).await?;
    resolve_repo_relative(&session.path, &path)?;
    session
        .backend
        .rm_cached(&[PathBuf::from(&path)])
        .await
        .map_err(AppError::Git)?;
    write_gitignore_line(&session.path, &path, is_dir)
        .await
        .map_err(|e| {
            AppError::Io(format!(
                "stopped tracking {path}, but failed to update .gitignore: {e}"
            ))
        })
}

/// A file's current working-tree content (binary-aware), for File View's
/// working-tree mode. Mirrors `file_at_revision`'s classification but reads the
/// file from disk rather than `git show <rev>:<path>`, so it works for
/// untracked and ignored files too.
#[tauri::command]
#[specta::specta]
pub async fn repo_file_worktree(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    path: String,
) -> Result<FileAtRevision, AppError> {
    let session = state.get_session(&repo_id).await?;
    let abs = resolve_repo_relative(&session.path, &path)?;
    let bytes = tokio::fs::read(&abs)
        .await
        .map_err(|e| AppError::Io(format!("read {}: {e}", abs.display())))?;
    Ok(classify_worktree_bytes(&bytes))
}

/// Classify raw working-tree bytes as text or binary via legit-core's
/// unified sniff (git's leading-window NUL heuristic, same window as
/// `file_at_revision`). Text is decoded lossily (like the runner), so a
/// non-UTF-8 but NUL-free file still shows as text.
fn classify_worktree_bytes(bytes: &[u8]) -> FileAtRevision {
    if legit_core::is_binary_bytes(bytes) {
        FileAtRevision::Binary { size_bytes: bytes.len() as u64 }
    } else {
        FileAtRevision::Text(String::from_utf8_lossy(bytes).into_owned())
    }
}

/// Open the OS file manager with `path` revealed/selected (best effort).
#[tauri::command]
#[specta::specta]
pub async fn repo_reveal_path(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    path: String,
) -> Result<(), AppError> {
    let session = state.get_session(&repo_id).await?;
    let abs = resolve_repo_relative(&session.path, &path)?;
    reveal_in_file_manager(&abs)
}

// ---------------------------------------------------------------------------
// gitignore line composition (pure)
// ---------------------------------------------------------------------------

/// The `.gitignore` line for a path, anchored to the repo root with a leading
/// `/` so it matches exactly this path and not a same-named file elsewhere in
/// the tree. Directories get a trailing `/`. The leading `/` also neutralises
/// a leading `#`/`!` (comment/negation), which are only special at line start.
fn gitignore_line(rel: &str, is_dir: bool) -> String {
    let trimmed = rel.trim_end_matches('/');
    if is_dir {
        format!("/{trimmed}/")
    } else {
        format!("/{trimmed}")
    }
}

/// Compute the new `.gitignore` content after adding `line`, or `None` if the
/// line is already present (verbatim, ignoring surrounding whitespace). A
/// non-empty file without a trailing newline gets one before the new line is
/// appended, so lines never merge.
fn append_gitignore(existing: &str, line: &str) -> Option<String> {
    if existing.lines().any(|l| l.trim() == line) {
        return None;
    }
    if existing.is_empty() {
        return Some(format!("{line}\n"));
    }
    let sep = if existing.ends_with('\n') { "" } else { "\n" };
    Some(format!("{existing}{sep}{line}\n"))
}

/// Read `.gitignore`, append the line for `rel`, write it back. No-op when the
/// line is already there.
async fn write_gitignore_line(root: &std::path::Path, rel: &str, is_dir: bool) -> Result<(), AppError> {
    let gitignore = root.join(".gitignore");
    let existing = match tokio::fs::read_to_string(&gitignore).await {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(AppError::Io(format!("read {}: {e}", gitignore.display()))),
    };
    let line = gitignore_line(rel, is_dir);
    if let Some(updated) = append_gitignore(&existing, &line) {
        tokio::fs::write(&gitignore, updated)
            .await
            .map_err(|e| AppError::Io(format!("write {}: {e}", gitignore.display())))?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// reveal in file manager (platform I/O, best effort)
// ---------------------------------------------------------------------------

/// Launch the platform file manager focused on `abs`. Windows/macOS select the
/// file; other platforms open its containing directory. Fire-and-forget: the
/// spawned process is not awaited, but a failure to spawn is reported.
/// Render a path in the plain backslash form explorer.exe requires. Explorer
/// does not error on a malformed path argument - it silently opens the
/// Documents folder instead. Two malformed-for-explorer forms actually reach
/// us: forward-slash paths (git prints `C:/...` for `--show-toplevel`, and
/// session paths keep that form) and `\\?\`-verbatim paths (what
/// `std::fs::canonicalize` returns on Windows). Every path handed to
/// explorer must go through here.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) fn explorer_path(path: &std::path::Path) -> String {
    let backslashed = path.to_string_lossy().replace('/', "\\");
    if let Some(rest) = backslashed.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = backslashed.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        backslashed
    }
}

pub(crate) fn reveal_in_file_manager(abs: &std::path::Path) -> Result<(), AppError> {
    use std::process::Command;
    let spawn = |mut cmd: Command| -> Result<(), AppError> {
        cmd.spawn()
            .map(|_| ())
            .map_err(|e| AppError::Io(format!("open file manager: {e}")))
    };
    #[cfg(target_os = "windows")]
    {
        let mut cmd = Command::new("explorer");
        // `explorer /select,<path>` selects the file; it exits non-zero even on
        // success, so we only care that it spawned. The path must be in plain
        // backslash form (see `explorer_path`) or explorer opens Documents.
        cmd.arg(format!("/select,{}", explorer_path(abs)));
        spawn(cmd)
    }
    #[cfg(target_os = "macos")]
    {
        let mut cmd = Command::new("open");
        cmd.args(["-R".as_ref(), abs.as_os_str()]);
        spawn(cmd)
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        // xdg-open has no "select" mode; open the containing directory.
        let target = abs.parent().unwrap_or(abs);
        let mut cmd = Command::new("xdg-open");
        cmd.arg(target);
        spawn(cmd)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // explorer.exe path form: these encode the "explorer opens Documents on a
    // malformed path" fallback - both inputs below are real (git prints
    // forward-slash toplevels; canonicalize returns \\?\-verbatim paths).

    #[test]
    fn explorer_path_converts_forward_slashes() {
        // `git rev-parse --show-toplevel` output on Windows (session paths).
        assert_eq!(
            explorer_path(std::path::Path::new("C:/Dev/LeGit")),
            r"C:\Dev\LeGit"
        );
    }

    #[test]
    fn explorer_path_strips_verbatim_prefix() {
        // `std::fs::canonicalize` output on Windows (reveal targets).
        assert_eq!(
            explorer_path(std::path::Path::new(r"\\?\C:\repo\file.txt")),
            r"C:\repo\file.txt"
        );
    }

    #[test]
    fn explorer_path_rewrites_verbatim_unc_to_plain_unc() {
        assert_eq!(
            explorer_path(std::path::Path::new(r"\\?\UNC\server\share\repo")),
            r"\\server\share\repo"
        );
    }

    #[test]
    fn explorer_path_leaves_native_paths_unchanged() {
        assert_eq!(explorer_path(std::path::Path::new(r"C:\repo")), r"C:\repo");
        assert_eq!(
            explorer_path(std::path::Path::new(r"\\server\share")),
            r"\\server\share"
        );
    }

    #[test]
    fn gitignore_line_anchors_files_to_root() {
        assert_eq!(gitignore_line("secret.env", false), "/secret.env");
        assert_eq!(gitignore_line("src/gen.rs", false), "/src/gen.rs");
    }

    #[test]
    fn gitignore_line_marks_directories_with_trailing_slash() {
        assert_eq!(gitignore_line("build", true), "/build/");
        assert_eq!(gitignore_line("src/out", true), "/src/out/");
        // An incoming trailing slash is not doubled.
        assert_eq!(gitignore_line("build/", true), "/build/");
    }

    #[test]
    fn append_gitignore_to_empty_file() {
        assert_eq!(append_gitignore("", "/a"), Some("/a\n".to_string()));
    }

    #[test]
    fn append_gitignore_appends_after_trailing_newline() {
        assert_eq!(
            append_gitignore("/x\n", "/a"),
            Some("/x\n/a\n".to_string())
        );
    }

    #[test]
    fn append_gitignore_adds_missing_newline_before_appending() {
        assert_eq!(
            append_gitignore("/x", "/a"),
            Some("/x\n/a\n".to_string())
        );
    }

    #[test]
    fn append_gitignore_is_noop_when_line_present() {
        assert_eq!(append_gitignore("/a\n", "/a"), None);
        assert_eq!(append_gitignore("*.log\n/a\n", "/a"), None);
        // Surrounding whitespace on the existing line is ignored.
        assert_eq!(append_gitignore("  /a  \n", "/a"), None);
    }

    #[test]
    fn classify_worktree_plain_text() {
        assert_eq!(
            classify_worktree_bytes(b"hello\nworld\n"),
            FileAtRevision::Text("hello\nworld\n".to_string())
        );
    }

    #[test]
    fn classify_worktree_nul_in_window_is_binary() {
        let bytes = b"\x89PNG\x00\x00data";
        assert_eq!(
            classify_worktree_bytes(bytes),
            FileAtRevision::Binary { size_bytes: bytes.len() as u64 }
        );
    }

    #[test]
    fn classify_worktree_nul_beyond_window_is_text() {
        // A NUL past the 8000-byte sniff window doesn't count (matches git).
        let mut bytes = vec![b'a'; legit_core::BINARY_SNIFF_WINDOW];
        bytes.push(0);
        assert!(matches!(classify_worktree_bytes(&bytes), FileAtRevision::Text(_)));
    }

    #[test]
    fn classify_worktree_non_utf8_without_nul_is_lossy_text() {
        // Invalid UTF-8 but no NUL → text, decoded lossily (like the runner).
        let bytes = [0xffu8, 0xfe, b'h', b'i'];
        assert!(matches!(classify_worktree_bytes(&bytes), FileAtRevision::Text(_)));
    }
}
