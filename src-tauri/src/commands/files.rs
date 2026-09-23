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
use legit_core::{HostPath, RepoFs};
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
    resolve_repo_relative(session.host.fs().as_ref(), &session.root, &path).await?;
    write_gitignore_line(session.host.fs().as_ref(), &session.root, &path, is_dir).await
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
    resolve_repo_relative(session.host.fs().as_ref(), &session.root, &path).await?;
    session
        .backend
        .rm_cached(&[PathBuf::from(&path)])
        .await
        .map_err(AppError::Git)?;
    write_gitignore_line(session.host.fs().as_ref(), &session.root, &path, is_dir)
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
    let fs = session.host.fs();
    let abs = resolve_repo_relative(fs.as_ref(), &session.root, &path).await?;
    let bytes = fs
        .read(&abs.clone(), None)
        .await
        .map_err(|e| AppError::Io(format!("read {}: {e}", abs)))?;
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
    let abs = resolve_repo_relative(session.host.fs().as_ref(), &session.root, &path).await?;
    if let crate::remote::RepoLocator::Wsl { .. } = &session.locator {
        return reveal_remote_in_explorer(&session, &abs);
    }
    reveal_in_file_manager(&abs.as_local())
}

// ---------------------------------------------------------------------------
// gitignore line composition (pure)
// ---------------------------------------------------------------------------

/// The `.gitignore` line for a path. Directories get a trailing `/`. A
/// leading `/` anchor is added only where it changes matching: single-segment
/// names (unanchored, they'd match at any depth; a slash-containing pattern
/// is root-anchored by git already) and names starting with `#`/`!`
/// (comment/negation, special at line start only).
fn gitignore_line(rel: &str, is_dir: bool) -> String {
    let trimmed = rel.trim_end_matches('/');
    let anchor = if !trimmed.contains('/') || trimmed.starts_with('#') || trimmed.starts_with('!') {
        "/"
    } else {
        ""
    };
    if is_dir {
        format!("{anchor}{trimmed}/")
    } else {
        format!("{anchor}{trimmed}")
    }
}

/// Compute the new `.gitignore` content after adding `line`, or `None` if the
/// line is already present (verbatim, ignoring surrounding whitespace). A
/// non-empty file without a trailing newline gets one before the new line is
/// appended, so lines never merge. Byte-level on purpose: the whole file is
/// written back, and existing non-UTF8 bytes must survive verbatim.
fn append_gitignore(existing: &[u8], line: &str) -> Option<Vec<u8>> {
    if existing
        .split(|b| *b == b'\n')
        .any(|l| l.trim_ascii() == line.as_bytes())
    {
        return None;
    }
    let mut out = existing.to_vec();
    if !out.is_empty() && out.last() != Some(&b'\n') {
        out.push(b'\n');
    }
    out.extend_from_slice(line.as_bytes());
    out.push(b'\n');
    Some(out)
}

/// Read `.gitignore`, append the line for `rel`, write it back. No-op when the
/// line is already there.
async fn write_gitignore_line(
    fs: &dyn RepoFs,
    root: &HostPath,
    rel: &str,
    is_dir: bool,
) -> Result<(), AppError> {
    let gitignore = root.join(".gitignore");
    let existing = match fs.read(&gitignore, None).await {
        Ok(bytes) => bytes,
        Err(legit_core::FsError::NotFound { .. }) => Vec::new(),
        Err(e) => return Err(AppError::Io(format!("read {gitignore}: {e}"))),
    };
    let line = gitignore_line(rel, is_dir);
    if let Some(updated) = append_gitignore(&existing, &line) {
        fs.write(&gitignore, &updated)
            .await
            .map_err(|e| AppError::Io(format!("write {gitignore}: {e}")))?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// reveal in file manager (platform I/O, best effort)
// ---------------------------------------------------------------------------

/// Launch the platform file manager focused on `abs`. Windows/macOS select the
/// file; other platforms open its containing directory. Fire-and-forget: the
/// spawned process is not awaited, but a failure to spawn is reported.
/// Reveal a REMOTE repo path: Explorer opens the WSL filesystem through the
/// `\\wsl.localhost\<distro>\...` share (runs on the Windows side — no agent
/// involvement, and Explorer handles the 9P access itself). Windows-only by
/// nature; other app OSes report it unsupported.
pub(crate) fn reveal_remote_in_explorer(
    session: &crate::state::RepoSession,
    abs: &HostPath,
) -> Result<(), AppError> {
    let crate::remote::RepoLocator::Wsl { distro, .. } = &session.locator else {
        return reveal_in_file_manager(&abs.as_local());
    };
    let unc = wsl_unc_path(distro, abs.as_str());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        return std::process::Command::new("explorer")
            .raw_arg(format!("/select,\"{unc}\""))
            .creation_flags(0x0800_0000)
            .spawn()
            .map(|_| ())
            .map_err(|e| AppError::Io(format!("explorer: {e}")));
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err(AppError::Io(format!(
            "revealing {unc} requires Windows Explorer"
        )))
    }
}

/// `\\wsl.localhost\<distro>\home\...` form of a posix path in a distro.
pub(crate) fn wsl_unc_path(distro: &str, posix: &str) -> String {
    format!(
        r"\\wsl.localhost\{distro}{}",
        posix.replace('/', "\\")
    )
}

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

    // Explorer opens WSL repos through the \\wsl.localhost\ share; a
    // malformed UNC silently opens Documents instead, so the form is pinned.
    #[test]
    fn wsl_unc_path_backslashes_the_posix_path() {
        assert_eq!(
            wsl_unc_path("Ubuntu", "/home/orell/github/LeGit/src/main.rs"),
            r"\\wsl.localhost\Ubuntu\home\orell\github\LeGit\src\main.rs"
        );
    }

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
    fn gitignore_line_anchors_single_segment_names() {
        // Without the anchor, "secret.env" would match at any depth.
        assert_eq!(gitignore_line("secret.env", false), "/secret.env");
        assert_eq!(gitignore_line("build", true), "/build/");
        // An incoming trailing slash is not doubled.
        assert_eq!(gitignore_line("build/", true), "/build/");
    }

    #[test]
    fn gitignore_line_leaves_nested_paths_unanchored() {
        // A pattern containing a slash is root-anchored by git already.
        assert_eq!(gitignore_line("src/gen.rs", false), "src/gen.rs");
        assert_eq!(gitignore_line("src/out", true), "src/out/");
    }

    #[test]
    fn gitignore_line_anchors_comment_and_negation_leaders() {
        // `#`/`!` are special at line start even in a slash-containing line.
        assert_eq!(gitignore_line("#tags.md", false), "/#tags.md");
        assert_eq!(gitignore_line("!important/notes.md", true), "/!important/notes.md/");
    }

    /// Validates the pattern-semantics assumptions behind `gitignore_line`
    /// against the real binary: a slash-containing pattern is root-anchored
    /// without a leading `/`, a trailing slash alone does NOT anchor (so
    /// single-segment names need the `/`), and the `/` neutralises a leading
    /// `#` that would otherwise make the line a comment.
    #[test]
    fn gitignore_lines_match_only_the_intended_paths_in_a_real_repo() {
        let dir = tempfile::tempdir().unwrap();
        let git = |args: &[&str]| {
            std::process::Command::new("git")
                .current_dir(dir.path())
                .env("GIT_CONFIG_GLOBAL", "/dev/null")
                .env("GIT_CONFIG_SYSTEM", "/dev/null")
                .args(args)
                .output()
                .unwrap()
        };
        assert!(git(&["init", "-q"]).status.success());

        let lines = [
            gitignore_line("src/gen.rs", false),
            gitignore_line("build", true),
            gitignore_line("#tags.md", false),
        ];
        std::fs::write(dir.path().join(".gitignore"), lines.join("\n") + "\n").unwrap();

        let ignored = |path: &str| {
            let out = git(&["check-ignore", "-q", "--", path]);
            match out.status.code() {
                Some(0) => true,
                Some(1) => false,
                c => panic!("check-ignore {path}: exit {c:?}"),
            }
        };
        assert!(ignored("src/gen.rs"));
        assert!(!ignored("a/src/gen.rs"), "middle slash must root-anchor");
        assert!(ignored("build/out.o"));
        assert!(!ignored("nested/build/out.o"), "anchor must stop any-depth matching");
        assert!(ignored("#tags.md"), "leading / must keep the line from parsing as a comment");
    }

    #[test]
    fn append_gitignore_to_empty_file() {
        assert_eq!(append_gitignore(b"", "/a"), Some(b"/a\n".to_vec()));
    }

    #[test]
    fn append_gitignore_appends_after_trailing_newline() {
        assert_eq!(
            append_gitignore(b"/x\n", "/a"),
            Some(b"/x\n/a\n".to_vec())
        );
    }

    #[test]
    fn append_gitignore_adds_missing_newline_before_appending() {
        assert_eq!(
            append_gitignore(b"/x", "/a"),
            Some(b"/x\n/a\n".to_vec())
        );
    }

    #[test]
    fn append_gitignore_is_noop_when_line_present() {
        assert_eq!(append_gitignore(b"/a\n", "/a"), None);
        assert_eq!(append_gitignore(b"*.log\n/a\n", "/a"), None);
        // Surrounding whitespace on the existing line is ignored.
        assert_eq!(append_gitignore(b"  /a  \n", "/a"), None);
        // CRLF files match too.
        assert_eq!(append_gitignore(b"/a\r\n", "/a"), None);
    }

    #[test]
    fn append_gitignore_preserves_non_utf8_bytes() {
        // A Latin-1 comment ("# Auslöser"): appending one line must keep every
        // existing byte verbatim - the old str-based version lossy-decoded the
        // file and wrote U+FFFD replacements back over it.
        let existing = b"# Ausl\xf6ser\n".to_vec();
        assert_eq!(
            append_gitignore(&existing, "/a"),
            Some(b"# Ausl\xf6ser\n/a\n".to_vec())
        );
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
