//! Open the repository root — or a single file — in the user's configured
//! external editor.
//!
//! The Global Settings "External editor" value is a command template like
//! `code "$ROOT"` or just `subl`: `$ROOT` is replaced by the absolute repo
//! root; a template that never mentions `$ROOT` gets the root appended as the
//! final argument. The same template drives "open file in editor": `$FILE` is
//! replaced by the absolute file path where present, otherwise the file is
//! appended as the final argument. With no editor configured, the commands
//! fall back to the OS file manager (open the folder / reveal the file).
//!
//! The template parsing and PATH resolution are pure functions with unit
//! tests below — the spawn itself is fire-and-forget (editors are long-lived;
//! only a failure to spawn is reported).

use crate::error::AppError;
use crate::state::AppState;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Split a command template into tokens. Double quotes group words (so paths
/// with spaces work); there is no escape syntax. An unterminated quote or an
/// empty template is an error.
fn tokenize_template(template: &str) -> Result<Vec<String>, String> {
    let mut tokens: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    let mut token_started = false;

    for c in template.chars() {
        match c {
            '"' => {
                in_quotes = !in_quotes;
                // A quote starts a token even if it's empty ("").
                token_started = true;
            }
            c if c.is_whitespace() && !in_quotes => {
                if token_started {
                    tokens.push(std::mem::take(&mut current));
                    token_started = false;
                }
            }
            c => {
                current.push(c);
                token_started = true;
            }
        }
    }
    if in_quotes {
        return Err("unterminated quote in editor command".to_string());
    }
    if token_started {
        tokens.push(current);
    }
    if tokens.is_empty() {
        return Err("editor command is empty".to_string());
    }
    Ok(tokens)
}

/// Build the (program, args) invocation for a template and repo root:
/// tokenize first, then substitute `$ROOT` inside tokens — so a root path
/// containing spaces can never re-split a token. Templates without `$ROOT`
/// get the root appended as the final argument.
fn build_editor_invocation(template: &str, root: &Path) -> Result<Vec<String>, String> {
    let root_str = root.to_string_lossy();
    let mut tokens = tokenize_template(template)?;
    let mut substituted = false;
    for t in tokens.iter_mut() {
        if t.contains("$ROOT") {
            *t = t.replace("$ROOT", &root_str);
            substituted = true;
        }
    }
    if !substituted {
        tokens.push(root_str.into_owned());
    }
    Ok(tokens)
}

/// Build the invocation for opening one file: `$ROOT` and `$FILE` substitute
/// inside tokens (post-tokenize, so paths with spaces never re-split); a
/// template that never mentions `$FILE` gets the file appended as the final
/// argument — so an open-repo template like `code "$ROOT"` still delivers the
/// file (folder + file in one window).
fn build_editor_file_invocation(
    template: &str,
    root: &Path,
    file: &Path,
) -> Result<Vec<String>, String> {
    let root_str = root.to_string_lossy();
    let file_str = file.to_string_lossy();
    let mut tokens = tokenize_template(template)?;
    let mut file_substituted = false;
    for t in tokens.iter_mut() {
        if t.contains("$ROOT") {
            *t = t.replace("$ROOT", &root_str);
        }
        if t.contains("$FILE") {
            *t = t.replace("$FILE", &file_str);
            file_substituted = true;
        }
    }
    if !file_substituted {
        tokens.push(file_str.into_owned());
    }
    Ok(tokens)
}

/// Resolve a program name against a PATH directory list. A name containing a
/// path separator is used as-is. Otherwise each directory is tried with the
/// name verbatim and with each extension in `exts` appended (Windows PATHEXT;
/// empty elsewhere). `exists` is injected so the search logic is testable.
fn find_in_path(
    prog: &str,
    dirs: &[PathBuf],
    exts: &[String],
    exists: &dyn Fn(&Path) -> bool,
) -> Option<PathBuf> {
    if prog.contains('/') || prog.contains('\\') {
        let p = PathBuf::from(prog);
        return exists(&p).then_some(p);
    }
    for dir in dirs {
        let candidate = dir.join(prog);
        if exists(&candidate) {
            return Some(candidate);
        }
        for ext in exts {
            let with_ext = dir.join(format!("{prog}{ext}"));
            if exists(&with_ext) {
                return Some(with_ext);
            }
        }
    }
    None
}

/// The OS-specific extension list for PATH lookups: PATHEXT on Windows
/// (lower-cased, e.g. `.com;.exe;.bat;.cmd`), empty elsewhere.
fn path_extensions() -> Vec<String> {
    #[cfg(target_os = "windows")]
    {
        std::env::var("PATHEXT")
            .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string())
            .split(';')
            .filter(|e| !e.is_empty())
            .map(|e| e.to_lowercase())
            .collect()
    }
    #[cfg(not(target_os = "windows"))]
    {
        Vec::new()
    }
}

/// Resolve the template's program against the real PATH, giving a clear
/// "not found" error instead of a raw spawn failure.
fn resolve_program(prog: &str) -> Result<PathBuf, AppError> {
    let dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    find_in_path(prog, &dirs, &path_extensions(), &|p| p.is_file()).ok_or_else(|| {
        AppError::Io(format!(
            "Editor command not found: {prog} — check Settings → External editor"
        ))
    })
}

/// Spawn the editor invocation detached, with the repo root as working
/// directory. On Windows, `.cmd`/`.bat` shims (VS Code's `code`, etc.) cannot
/// be spawned directly by CreateProcess — they run through `cmd /C`.
fn spawn_editor(tokens: &[String], root: &Path) -> Result<(), AppError> {
    let program = resolve_program(&tokens[0])?;
    let args = &tokens[1..];

    #[allow(unused_mut)]
    let mut cmd;
    #[cfg(target_os = "windows")]
    {
        let is_batch = program
            .extension()
            .map(|e| {
                let e = e.to_string_lossy().to_lowercase();
                e == "cmd" || e == "bat"
            })
            .unwrap_or(false);
        if is_batch {
            cmd = Command::new("cmd");
            cmd.arg("/C").arg(&program).args(args);
        } else {
            cmd = Command::new(&program);
            cmd.args(args);
        }
        // No console flash for the wrapper; the editor's own window still shows.
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    #[cfg(not(target_os = "windows"))]
    {
        cmd = Command::new(&program);
        cmd.args(args);
    }

    cmd.current_dir(root);
    cmd.spawn()
        .map(|_| ())
        .map_err(|e| AppError::Io(format!("launch editor: {e}")))
}

/// Open a directory in the OS file manager — the fallback when no external
/// editor is configured. (Distinct from `repo_reveal_path`, which *selects* a
/// file; this opens the folder itself.)
fn open_directory(dir: &Path) -> Result<(), AppError> {
    let spawn = |mut cmd: Command| -> Result<(), AppError> {
        cmd.spawn()
            .map(|_| ())
            .map_err(|e| AppError::Io(format!("open folder: {e}")))
    };
    #[cfg(target_os = "windows")]
    {
        let mut cmd = Command::new("explorer");
        // Session paths come from `git rev-parse --show-toplevel`, which
        // prints forward slashes on Windows - explorer silently opens the
        // Documents folder for such a path, so normalize first.
        cmd.arg(crate::commands::files::explorer_path(dir));
        spawn(cmd)
    }
    #[cfg(target_os = "macos")]
    {
        let mut cmd = Command::new("open");
        cmd.arg(dir);
        spawn(cmd)
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let mut cmd = Command::new("xdg-open");
        cmd.arg(dir);
        spawn(cmd)
    }
}

/// The effective editor template for a repo: the repo-scope override wins
/// over the global template (None/blank = inherit). Blank = none configured.
async fn effective_editor_template(
    state: &AppState,
    session: &crate::state::RepoSession,
) -> String {
    let repo_template = session.settings.read().await.external_editor_command.clone();
    match repo_template.filter(|t| !t.trim().is_empty()) {
        Some(t) => t,
        None => state
            .global_settings
            .read()
            .await
            .external_editor_command
            .clone()
            .unwrap_or_default(),
    }
}

/// Open the repo root in the configured external editor, or in the OS file
/// manager when no editor is configured.
#[tauri::command]
#[specta::specta]
pub async fn repo_open_in_editor(
    state: tauri::State<'_, AppState>,
    repo_id: String,
) -> Result<(), AppError> {
    let session = state.get_session(&repo_id).await?;
    let template = effective_editor_template(&state, &session).await;

    if template.trim().is_empty() {
        return open_directory(&session.path);
    }
    let tokens = build_editor_invocation(&template, &session.path).map_err(AppError::Io)?;
    spawn_editor(&tokens, &session.path)
}

/// Open one working-tree file in the configured external editor (same
/// template, `$FILE` = absolute file path), or reveal it in the OS file
/// manager when no editor is configured. Errors clearly when the file is
/// gone from the working tree (e.g. a deleted row in Changed Files).
#[tauri::command]
#[specta::specta]
pub async fn repo_open_file_in_editor(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    path: String,
) -> Result<(), AppError> {
    let session = state.get_session(&repo_id).await?;
    let abs = crate::commands::working::resolve_repo_relative(&session.path, &path)?;
    if !abs.is_file() {
        return Err(AppError::Io(format!(
            "{path} does not exist in the working tree"
        )));
    }

    let template = effective_editor_template(&state, &session).await;
    if template.trim().is_empty() {
        return crate::commands::files::reveal_in_file_manager(&abs);
    }
    let tokens =
        build_editor_file_invocation(&template, &session.path, &abs).map_err(AppError::Io)?;
    spawn_editor(&tokens, &session.path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokenizes_plain_words() {
        assert_eq!(tokenize_template("code -n").unwrap(), vec!["code", "-n"]);
    }

    #[test]
    fn tokenizes_quoted_path_with_spaces() {
        assert_eq!(
            tokenize_template(r#""C:\Program Files\Editor\ed.exe" "$ROOT""#).unwrap(),
            vec![r"C:\Program Files\Editor\ed.exe", "$ROOT"]
        );
    }

    #[test]
    fn rejects_empty_and_unterminated_templates() {
        assert!(tokenize_template("").is_err());
        assert!(tokenize_template("   ").is_err());
        assert!(tokenize_template(r#"code "unterminated"#).is_err());
    }

    #[test]
    fn substitutes_root_inside_tokens() {
        let tokens =
            build_editor_invocation(r#"ed --folder="$ROOT""#, Path::new("/repo dir")).unwrap();
        assert_eq!(tokens, vec!["ed", "--folder=/repo dir"]);
    }

    #[test]
    fn appends_root_when_template_has_no_placeholder() {
        let tokens = build_editor_invocation("code -n", Path::new("/repo")).unwrap();
        assert_eq!(tokens, vec!["code", "-n", "/repo"]);
    }

    #[test]
    fn quoted_root_with_spaces_stays_one_token() {
        let tokens = build_editor_invocation(r#"code "$ROOT""#, Path::new("/a b/c")).unwrap();
        assert_eq!(tokens, vec!["code", "/a b/c"]);
    }

    #[test]
    fn file_invocation_substitutes_file_inside_tokens() {
        let tokens = build_editor_file_invocation(
            r#"ed --goto="$FILE""#,
            Path::new("/repo"),
            Path::new("/repo/src/a.ts"),
        )
        .unwrap();
        assert_eq!(tokens, vec!["ed", "--goto=/repo/src/a.ts"]);
    }

    #[test]
    fn file_invocation_appends_file_when_no_placeholder() {
        let tokens = build_editor_file_invocation(
            "code -n",
            Path::new("/repo"),
            Path::new("/repo/src/a.ts"),
        )
        .unwrap();
        assert_eq!(tokens, vec!["code", "-n", "/repo/src/a.ts"]);
    }

    #[test]
    fn file_invocation_substitutes_root_and_file() {
        let tokens = build_editor_file_invocation(
            r#"ed "$ROOT" "$FILE""#,
            Path::new("/repo"),
            Path::new("/repo/src/a.ts"),
        )
        .unwrap();
        assert_eq!(tokens, vec!["ed", "/repo", "/repo/src/a.ts"]);
    }

    #[test]
    fn file_invocation_root_only_template_still_appends_file() {
        // `code "$ROOT"` is a valid open-repo template; opening a file with it
        // must still deliver the file (folder + file in one window).
        let tokens = build_editor_file_invocation(
            r#"code "$ROOT""#,
            Path::new("/repo"),
            Path::new("/repo/src/a.ts"),
        )
        .unwrap();
        assert_eq!(tokens, vec!["code", "/repo", "/repo/src/a.ts"]);
    }

    #[test]
    fn file_invocation_path_with_spaces_stays_one_token() {
        let tokens = build_editor_file_invocation(
            r#"ed "$FILE""#,
            Path::new("/a b"),
            Path::new("/a b/c d.txt"),
        )
        .unwrap();
        assert_eq!(tokens, vec!["ed", "/a b/c d.txt"]);
    }

    #[test]
    fn find_in_path_tries_extensions_in_order() {
        let dirs = vec![PathBuf::from("/bin"), PathBuf::from("/usr/bin")];
        let exts = vec![".exe".to_string(), ".cmd".to_string()];
        let existing = PathBuf::from("/usr/bin/code.cmd");
        let found = find_in_path("code", &dirs, &exts, &|p| p == existing);
        assert_eq!(found, Some(existing));
    }

    #[test]
    fn find_in_path_prefers_verbatim_name() {
        let dirs = vec![PathBuf::from("/bin")];
        let found = find_in_path("ed", &dirs, &[], &|p| p == Path::new("/bin/ed"));
        assert_eq!(found, Some(PathBuf::from("/bin/ed")));
    }

    #[test]
    fn find_in_path_uses_explicit_paths_verbatim() {
        // A name with a separator is not searched, just checked.
        assert_eq!(
            find_in_path("/opt/ed", &[PathBuf::from("/bin")], &[], &|p| p
                == Path::new("/opt/ed")),
            Some(PathBuf::from("/opt/ed"))
        );
        assert_eq!(
            find_in_path("/missing/ed", &[PathBuf::from("/bin")], &[], &|_| false),
            None
        );
    }

    #[test]
    fn find_in_path_misses_cleanly() {
        assert_eq!(find_in_path("nope", &[PathBuf::from("/bin")], &[], &|_| false), None);
    }
}
