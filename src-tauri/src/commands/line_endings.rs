//! Line-endings commands — §H of DESIGN-v0.2.md.
//!
//! LeGit panels are a direct mirror of `core.autocrlf` and `core.eol`
//! at the corresponding `git config` scope.  There is no LeGit-side
//! "strategy" — the only persistent state is what `git config` stores.
//!
//! All reads/writes go through `GitRunner`.  System scope is read-only.

use crate::commands::config_util::{
    read_config_all_scopes, read_config_global_scopes, write_config_global, write_config_local,
    ConfigValue,
};
use crate::commands::working::resolve_repo_relative;
use crate::error::AppError;
use crate::state::AppState;
use legit_core::types::LineEndingKind;
use legit_core::{classify_line_endings, convert_line_endings, mixed_endings_in_bytes, GitRunner};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::{Path, PathBuf};

// ---------------------------------------------------------------------------
// Types exposed to the frontend
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct GitAttrRule {
    pub pattern: String,
    /// `text` attribute value: "set", "auto", or "unset" (from `-text`/`binary`).
    pub text: Option<String>,
    /// `eol` attribute value: "lf" or "crlf".
    pub eol: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct LineEndingsView {
    pub autocrlf_local: ConfigValue,
    pub autocrlf_global: ConfigValue,
    pub autocrlf_system: ConfigValue,
    pub autocrlf_resolved: ConfigValue,
    pub eol_local: ConfigValue,
    pub eol_global: ConfigValue,
    pub eol_system: ConfigValue,
    pub eol_resolved: ConfigValue,
    /// Line-ending-relevant rules from `.gitattributes`.
    pub gitattributes: Vec<GitAttrRule>,
    /// True when a `.gitattributes` rule covers all files (`*` pattern with a
    /// text attribute) — in which case `core.autocrlf`/`eol` have no effect
    /// for those files.
    pub gitattributes_covers_all: bool,
    /// Files with mixed CRLF+LF line endings. Empty when `warn_on_mixed_endings`
    /// is off or the repo has no tracked files.
    pub mixed_ending_files: Vec<String>,
}

// ---------------------------------------------------------------------------
// View assembly (shared by the read and write commands)
// ---------------------------------------------------------------------------

/// The effective mixed-endings warning toggle: repo override, else global.
async fn effective_warn(state: &AppState, session: &crate::state::RepoSession) -> bool {
    let repo_s = session.settings.read().await;
    let global_s = state.global_settings.read().await;
    repo_s.warn_on_mixed_endings.unwrap_or(global_s.warn_on_mixed_endings)
}

/// Assemble the full repo-scope view: configs at all scopes, `.gitattributes`
/// rules, and (when the warning is enabled) the mixed-endings file scan.
async fn build_repo_view(
    state: &AppState,
    session: &crate::state::RepoSession,
    runner: &GitRunner,
) -> LineEndingsView {
    let autocrlf = read_config_all_scopes(runner, "core.autocrlf").await;
    let eol = read_config_all_scopes(runner, "core.eol").await;
    let (gitattributes, gitattributes_covers_all) = read_gitattributes(&session.path).await;
    let mixed = if effective_warn(state, session).await {
        detect_mixed_endings(runner, &session.path).await
    } else {
        vec![]
    };

    LineEndingsView {
        autocrlf_local: autocrlf.local,
        autocrlf_global: autocrlf.global,
        autocrlf_system: autocrlf.system,
        autocrlf_resolved: autocrlf.resolved,
        eol_local: eol.local,
        eol_global: eol.global,
        eol_system: eol.system,
        eol_resolved: eol.resolved,
        gitattributes,
        gitattributes_covers_all,
        mixed_ending_files: mixed,
    }
}

/// Assemble the global-scope view: no local scope, no `.gitattributes`, no
/// mixed-endings scan (they only exist inside a repo). Reads global + system
/// only: the unbound runner's cwd may lie inside some repo, and an all-scopes
/// read would leak that repo's local config into the resolved value
/// (see `read_config_global_scopes`).
async fn build_global_view(runner: &GitRunner) -> LineEndingsView {
    let autocrlf = read_config_global_scopes(runner, "core.autocrlf").await;
    let eol = read_config_global_scopes(runner, "core.eol").await;

    LineEndingsView {
        autocrlf_local: ConfigValue::unset(),
        autocrlf_global: autocrlf.global,
        autocrlf_system: autocrlf.system,
        autocrlf_resolved: autocrlf.resolved,
        eol_local: ConfigValue::unset(),
        eol_global: eol.global,
        eol_system: eol.system,
        eol_resolved: eol.resolved,
        gitattributes: vec![],
        gitattributes_covers_all: false,
        mixed_ending_files: vec![],
    }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Read all line-ending information for the active repo.
#[tauri::command]
#[specta::specta]
pub async fn repo_line_endings_view(
    state: tauri::State<'_, AppState>,
    repo_id: String,
) -> Result<LineEndingsView, AppError> {
    let session = state.get_session(&repo_id).await?;
    let runner = session.runner.read().await.clone();
    Ok(build_repo_view(&state, &session, &runner).await)
}

/// Read line-ending information at global scope (no repo required).
/// `.gitattributes` and mixed-ending detection don't apply at global scope.
#[tauri::command]
#[specta::specta]
pub async fn global_line_endings_view(
    state: tauri::State<'_, AppState>,
) -> Result<LineEndingsView, AppError> {
    let git_path = state.git_path.read().await.clone();
    let runner = GitRunner::unbound(&git_path);
    Ok(build_global_view(&runner).await)
}

/// Write `core.autocrlf` and `core.eol` to the repo's `.git/config`.
/// `None` means unset (removes the key). Returns the refreshed view.
#[tauri::command]
#[specta::specta]
pub async fn repo_write_line_endings(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    autocrlf: Option<String>,
    eol: Option<String>,
) -> Result<LineEndingsView, AppError> {
    let session = state.get_session(&repo_id).await?;
    let runner = session.runner.read().await.clone();
    write_config_local(&runner, "core.autocrlf", autocrlf.as_deref()).await?;
    write_config_local(&runner, "core.eol", eol.as_deref()).await?;
    Ok(build_repo_view(&state, &session, &runner).await)
}

/// Write `core.autocrlf` and `core.eol` to `~/.gitconfig`.
/// `None` means unset. Returns the refreshed global view.
#[tauri::command]
#[specta::specta]
pub async fn global_write_line_endings(
    state: tauri::State<'_, AppState>,
    autocrlf: Option<String>,
    eol: Option<String>,
) -> Result<LineEndingsView, AppError> {
    let git_path = state.git_path.read().await.clone();
    let runner = GitRunner::unbound(&git_path);
    write_config_global(&runner, "core.autocrlf", autocrlf.as_deref()).await?;
    write_config_global(&runner, "core.eol", eol.as_deref()).await?;
    Ok(build_global_view(&runner).await)
}

// ---------------------------------------------------------------------------
// .gitattributes parsing
// ---------------------------------------------------------------------------

async fn read_gitattributes(repo_root: &Path) -> (Vec<GitAttrRule>, bool) {
    let path = repo_root.join(".gitattributes");
    let contents = match tokio::fs::read_to_string(&path).await {
        Ok(s) => s,
        Err(_) => return (vec![], false),
    };

    let mut rules: Vec<GitAttrRule> = Vec::new();
    let mut covers_all = false;

    for line in contents.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some(rule) = parse_attr_line(line) else { continue };

        // A `*` pattern with a text attribute covers all files.
        if rule.pattern == "*" && rule.text.is_some() {
            covers_all = true;
        }
        rules.push(rule);
    }

    (rules, covers_all)
}

fn parse_attr_line(line: &str) -> Option<GitAttrRule> {
    let mut parts = line.split_whitespace();
    let pattern = parts.next()?.to_string();

    let mut text: Option<String> = None;
    let mut eol: Option<String> = None;

    for attr in parts {
        if attr == "text" {
            text = Some("set".to_string());
        } else if attr == "text=auto" {
            text = Some("auto".to_string());
        } else if attr == "-text" || attr == "binary" {
            text = Some("unset".to_string());
        } else if let Some(v) = attr.strip_prefix("eol=") {
            eol = Some(v.to_string());
        }
    }

    // Only include lines relevant to line endings.
    if text.is_none() && eol.is_none() {
        return None;
    }

    Some(GitAttrRule { pattern, text, eol })
}

/// The line-ending style of a file at a given side, for the Diff / File View /
/// Blame indicator. `rev` selects the side: `None` = working tree, `":"` = the
/// index, otherwise a rev spec (a commit sha, `HEAD`, `<sha>^`, a branch, …).
/// Returns `None` (no indicator) on any failure — a missing file, a path absent
/// at that rev (e.g. a root commit's parent), a too-large blob, or binary.
#[tauri::command]
#[specta::specta]
pub async fn repo_line_ending_kind(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    path: String,
    rev: Option<String>,
) -> Result<LineEndingKind, AppError> {
    let session = state.get_session(&repo_id).await?;
    let text: Option<String> = match rev.as_deref() {
        None => read_capped_text(&resolve_repo_relative(&session.path, &path)?).await,
        Some(spec_rev) => {
            let runner = session.runner.read().await.clone();
            // The index is addressed as `:path`; any other rev as `<rev>:path`.
            let spec = if spec_rev == ":" {
                format!(":{path}")
            } else {
                format!("{spec_rev}:{path}")
            };
            match runner.run(&["show", &spec]).await {
                Ok(o) if o.success && o.stdout.len() <= MAX_LINE_ENDING_BYTES => Some(o.stdout),
                _ => None,
            }
        }
    };
    Ok(text.map(|t| classify_line_endings(&t)).unwrap_or(LineEndingKind::None))
}

/// Rewrite a working-tree file's line endings to `target`, leaving content
/// untouched (backs the Diff panel's chip action that reverts an accidental
/// EOL flip while keeping content edits). Refuses binary files, non-concrete
/// targets (only lf/crlf/cr), and files over the indicator's 2 MB cap; the
/// byte-level contract is `legit_core::convert_line_endings` (pure, tested).
#[tauri::command]
#[specta::specta]
pub async fn repo_revert_line_endings(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    path: String,
    target: LineEndingKind,
) -> Result<(), AppError> {
    let session = state.get_session(&repo_id).await?;
    let abs = resolve_repo_relative(&session.path, &path)?;

    let meta = tokio::fs::metadata(&abs).await.map_err(|e| AppError::Io(e.to_string()))?;
    if meta.len() > MAX_LINE_ENDING_BYTES as u64 {
        return Err(AppError::Io(format!("{path}: file too large to convert line endings")));
    }
    let bytes = tokio::fs::read(&abs).await.map_err(|e| AppError::Io(e.to_string()))?;

    let converted = convert_line_endings(&bytes, target).ok_or_else(|| {
        AppError::Io(format!("{path}: cannot convert line endings (binary file or invalid target)"))
    })?;
    if converted != bytes {
        tokio::fs::write(&abs, converted).await.map_err(|e| AppError::Io(e.to_string()))?;
    }
    Ok(())
}

/// 2 MB cap: above this the indicator is skipped rather than reading/scanning a
/// large blob (matches the mixed-ending detector's guard).
const MAX_LINE_ENDING_BYTES: usize = 2 * 1024 * 1024;

/// Read a working-tree file as text for line-ending classification; `None` if
/// missing, unreadable, or over the size cap.
async fn read_capped_text(abs: &Path) -> Option<String> {
    let meta = tokio::fs::metadata(abs).await.ok()?;
    if meta.len() > MAX_LINE_ENDING_BYTES as u64 {
        return None;
    }
    let bytes = tokio::fs::read(abs).await.ok()?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

// ---------------------------------------------------------------------------
// Mixed-ending detection
// ---------------------------------------------------------------------------

/// Scan every tracked file for mixed endings. IO orchestration only - the
/// byte-level decision is `legit_core::mixed_endings_in_bytes` (pure, tested
/// next to `classify_line_endings`).
async fn detect_mixed_endings(runner: &GitRunner, repo_root: &Path) -> Vec<String> {
    let out = match runner.run(&["ls-files", "-z"]).await {
        Ok(o) if o.success => o,
        _ => return vec![],
    };

    let files: Vec<&str> = out.stdout.split('\0').filter(|s| !s.is_empty()).collect();
    let mut mixed: Vec<String> = Vec::new();

    for rel_path in files {
        let abs = repo_root.join(rel_path);
        if let Some(true) = is_mixed_endings(&abs).await {
            mixed.push(rel_path.to_string());
        }
    }

    mixed
}

/// Returns `Some(true)` if the file has mixed CRLF+LF endings,
/// `Some(false)` if uniform, `None` if binary, unreadable, or over the
/// 2 MB cap (matches `repo_line_ending_kind`'s guard).
async fn is_mixed_endings(path: &PathBuf) -> Option<bool> {
    let meta = tokio::fs::metadata(path).await.ok()?;
    if meta.len() > MAX_LINE_ENDING_BYTES as u64 {
        return None;
    }
    let bytes = tokio::fs::read(path).await.ok()?;
    mixed_endings_in_bytes(&bytes)
}
