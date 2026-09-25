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
//! The template parsing is pure and unit-tested below; the spawn runs on the
//! repo's host (`Host::spawn_detached`) and is fire-and-forget (editors are
//! long-lived; only a failure to spawn is reported).

use crate::error::AppError;
use crate::state::AppState;
use std::path::Path;

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
fn build_editor_invocation(template: &str, root: &str) -> Result<Vec<String>, String> {
    let mut tokens = tokenize_template(template)?;
    let mut substituted = false;
    for t in tokens.iter_mut() {
        if t.contains("$ROOT") {
            *t = t.replace("$ROOT", root);
            substituted = true;
        }
    }
    if !substituted {
        tokens.push(root.to_string());
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
    root: &str,
    file: &str,
) -> Result<Vec<String>, String> {
    let mut tokens = tokenize_template(template)?;
    let mut file_substituted = false;
    for t in tokens.iter_mut() {
        if t.contains("$ROOT") {
            *t = t.replace("$ROOT", root);
        }
        if t.contains("$FILE") {
            *t = t.replace("$FILE", file);
            file_substituted = true;
        }
    }
    if !file_substituted {
        tokens.push(file.to_string());
    }
    Ok(tokens)
}







/// Open a directory in the OS file manager — the fallback when no external
/// editor is configured. (Distinct from `repo_reveal_path`, which *selects* a
/// file; this opens the folder itself.)
fn open_directory(dir: &Path) -> Result<(), AppError> {
    crate::os_open::os_open(crate::os_open::OpenTarget::Folder(dir), "open folder")
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
/// manager when no editor is configured. Remote repos spawn the editor
/// command INSIDE the distro (`code .` there does the VS Code Remote thing
/// via interop); with no editor configured they fall back to revealing the
/// root in Explorer through the `\\wsl.localhost\` share.
#[tauri::command]
#[specta::specta]
pub async fn repo_open_in_editor(
    state: tauri::State<'_, AppState>,
    repo_id: String,
) -> Result<(), AppError> {
    let session = state.get_session(&repo_id).await?;
    let template = effective_editor_template(&state, &session).await;

    if template.trim().is_empty() {
        return match &session.locator {
            crate::remote::RepoLocator::Wsl { .. } => {
                crate::commands::files::reveal_remote_in_explorer(&session, &session.root)
            }
            crate::remote::RepoLocator::Local { .. } => open_directory(&session.root.as_local()),
        };
    }
    let tokens = build_editor_invocation(&template, session.root.as_str()).map_err(AppError::Io)?;
    spawn_on_host(&session, &tokens).await
}

/// Fire-and-forget a template invocation on the repo's host, in the repo
/// root. PATH resolution happens on that host (a WSL agent inherits the
/// login-shell env; `code .` there does the VS Code Remote thing).
async fn spawn_on_host(
    session: &crate::state::RepoSession,
    tokens: &[String],
) -> Result<(), AppError> {
    session
        .host
        .spawn_detached(
            &tokens[0],
            &tokens[1..],
            Some(&session.root.clone()),
        )
        .await
        .map_err(|e| match e {
            legit_host::HostError::ProgramNotFound(p) => AppError::Io(format!(
                "Editor command not found: {p} - check Settings > External editor"
            )),
            e => AppError::Io(format!("launch editor: {e}")),
        })
}

/// Open one working-tree file in the configured external editor (same
/// template, `$FILE` = absolute file path), or with the OS default
/// application when no editor is configured. Errors clearly when the file is
/// gone from the working tree (e.g. a deleted row in Changed Files).
#[tauri::command]
#[specta::specta]
pub async fn repo_open_file_in_editor(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    path: String,
) -> Result<(), AppError> {
    let session = state.get_session(&repo_id).await?;
    let fs = session.host.fs();
    let abs =
        crate::commands::working::resolve_repo_relative(fs.as_ref(), &session.root, &path).await?;
    let is_file = matches!(
        fs.stat(&abs.clone()).await,
        Ok(Some(st)) if !st.is_dir
    );
    if !is_file {
        return Err(AppError::Io(format!(
            "{path} does not exist in the working tree"
        )));
    }

    let template = effective_editor_template(&state, &session).await;
    if template.trim().is_empty() {
        // No editor configured: the OS default application for the file type
        // (the dedicated reveal entry covers the file manager).
        return crate::commands::files::open_with_default_app(&session, &abs);
    }
    let tokens =
        build_editor_file_invocation(&template, session.root.as_str(), abs.as_str()).map_err(AppError::Io)?;
    spawn_on_host(&session, &tokens).await
}

/// Temp-file name for a blob opened at a revision: keeps the extension (the
/// editor's language detection) and shows the short sha in the tab title.
fn revision_file_name(path: &str, rev: &str) -> String {
    let file = path.rsplit('/').next().unwrap_or(path);
    let short: String = rev.chars().take(8).collect();
    match file.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => format!("{stem}@{short}.{ext}"),
        _ => format!("{file}@{short}"),
    }
}

/// Open the file's content AT a revision in the configured external editor:
/// the blob is written to a fresh host temp dir under a name that keeps the
/// extension (editor language detection) and shows the short sha (tab
/// title), then opened like any file. The copy is detached - edits go
/// nowhere. No editor configured = the OS default application.
#[tauri::command]
#[specta::specta]
pub async fn repo_open_file_at_revision_in_editor(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    rev: String,
    path: String,
) -> Result<(), AppError> {
    let session = state.get_session(&repo_id).await?;
    let content = session
        .backend
        .file_at_revision(&rev, std::path::Path::new(&path))
        .await
        .map_err(AppError::Git)?;
    let text = match content {
        legit_core::FileAtRevision::Text(t) => t,
        legit_core::FileAtRevision::Binary { .. } => {
            let short: String = rev.chars().take(8).collect();
            return Err(AppError::Io(format!(
                "{path} is binary at {short} - nothing to open in an editor"
            )));
        }
    };

    let fs = session.host.fs();
    let dir = fs
        .temp_path("legit-rev-")
        .await
        .map_err(|e| AppError::Io(format!("create revision copy: {e}")))?;
    fs.create_dir_all(&dir)
        .await
        .map_err(|e| AppError::Io(format!("create revision copy: {e}")))?;
    let file = dir.join(&revision_file_name(&path, &rev));
    fs.write(&file, text.as_bytes())
        .await
        .map_err(|e| AppError::Io(format!("write revision copy: {e}")))?;

    let template = effective_editor_template(&state, &session).await;
    if template.trim().is_empty() {
        return crate::commands::files::open_with_default_app(&session, &file);
    }
    let tokens = build_editor_file_invocation(&template, session.root.as_str(), file.as_str())
        .map_err(AppError::Io)?;
    spawn_on_host(&session, &tokens).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn revision_file_name_keeps_stem_and_extension() {
        assert_eq!(revision_file_name("src/parser.rs", "a1b2c3d4e5f6"), "parser@a1b2c3d4.rs");
        assert_eq!(revision_file_name("Makefile", "deadbeef99"), "Makefile@deadbeef");
        assert_eq!(revision_file_name("a/b/x.test.tsx", "0123456789ab"), "x.test@01234567.tsx");
        assert_eq!(revision_file_name("f.rs", "ab"), "f@ab.rs");
        assert_eq!(revision_file_name(".gitignore", "a1b2c3d4e5"), ".gitignore@a1b2c3d4");
    }

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
            build_editor_invocation(r#"ed --folder="$ROOT""#, "/repo dir").unwrap();
        assert_eq!(tokens, vec!["ed", "--folder=/repo dir"]);
    }

    #[test]
    fn appends_root_when_template_has_no_placeholder() {
        let tokens = build_editor_invocation("code -n", "/repo").unwrap();
        assert_eq!(tokens, vec!["code", "-n", "/repo"]);
    }

    #[test]
    fn quoted_root_with_spaces_stays_one_token() {
        let tokens = build_editor_invocation(r#"code "$ROOT""#, "/a b/c").unwrap();
        assert_eq!(tokens, vec!["code", "/a b/c"]);
    }

    #[test]
    fn file_invocation_substitutes_file_inside_tokens() {
        let tokens = build_editor_file_invocation(
            r#"ed --goto="$FILE""#,
            "/repo",
            "/repo/src/a.ts",
        )
        .unwrap();
        assert_eq!(tokens, vec!["ed", "--goto=/repo/src/a.ts"]);
    }

    #[test]
    fn file_invocation_appends_file_when_no_placeholder() {
        let tokens = build_editor_file_invocation(
            "code -n",
            "/repo",
            "/repo/src/a.ts",
        )
        .unwrap();
        assert_eq!(tokens, vec!["code", "-n", "/repo/src/a.ts"]);
    }

    #[test]
    fn file_invocation_substitutes_root_and_file() {
        let tokens = build_editor_file_invocation(
            r#"ed "$ROOT" "$FILE""#,
            "/repo",
            "/repo/src/a.ts",
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
            "/repo",
            "/repo/src/a.ts",
        )
        .unwrap();
        assert_eq!(tokens, vec!["code", "/repo", "/repo/src/a.ts"]);
    }

    #[test]
    fn file_invocation_path_with_spaces_stays_one_token() {
        let tokens = build_editor_file_invocation(
            r#"ed "$FILE""#,
            "/a b",
            "/a b/c d.txt",
        )
        .unwrap();
        assert_eq!(tokens, vec!["ed", "/a b/c d.txt"]);
    }





    // --- cmd.exe quoting (Windows batch-shim editors) ---



}
