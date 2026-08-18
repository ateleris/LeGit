//! Repo LFS probes (spec: 2026-08-17-lfs-detection-warning-design.md):
//! does the repo declare LFS, is git-lfs usable, which files are
//! LFS-tracked.

use crate::error::AppError;
use crate::state::AppState;
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

/// The attribute set `git lfs track` writes; a tracked line consisting of a
/// subset of these can be removed safely, anything extra must not be dropped.
const LFS_ATTRS: [&str; 4] = ["filter=lfs", "diff=lfs", "merge=lfs", "-text"];

/// LFS patterns of the repo: the manageable root `.gitattributes` ones plus
/// (read-only) which nested attribute files also declare `filter=lfs`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, specta::Type)]
pub struct LfsPatternsView {
    pub root_patterns: Vec<String>,
    pub nested_files: Vec<String>,
}

/// Split a `.gitattributes` line into (pattern, attrs). The pattern token may
/// be double-quoted (patterns containing whitespace). None for blank/comment
/// lines or a dangling quote.
fn split_attr_line(line: &str) -> Option<(String, Vec<&str>)> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') {
        return None;
    }
    if let Some(rest) = line.strip_prefix('"') {
        let end = rest.find('"')?;
        Some((rest[..end].to_string(), rest[end + 1..].split_whitespace().collect()))
    } else {
        let mut parts = line.split_whitespace();
        let pattern = parts.next()?.to_string();
        Some((pattern, parts.collect()))
    }
}

/// Patterns whose attributes include `filter=lfs`, in file order.
fn parse_lfs_patterns(text: &str) -> Vec<String> {
    text.lines()
        .filter_map(split_attr_line)
        .filter(|(_, attrs)| attrs.contains(&"filter=lfs"))
        .map(|(pattern, _)| pattern)
        .collect()
}

/// The exact line `git lfs track <pattern>` would write (quoted when the
/// pattern contains whitespace).
fn format_track_line(pattern: &str) -> String {
    let quoted = if pattern.chars().any(char::is_whitespace) {
        format!("\"{pattern}\"")
    } else {
        pattern.to_string()
    };
    format!("{quoted} filter=lfs diff=lfs merge=lfs -text")
}

/// Append a track line for `pattern`. None = already tracked (no-op).
/// Preserves existing content and guarantees a trailing newline.
fn add_lfs_pattern(existing: &str, pattern: &str) -> Option<String> {
    if parse_lfs_patterns(existing).iter().any(|p| p == pattern) {
        return None;
    }
    let mut out = existing.to_string();
    if !out.is_empty() && !out.ends_with('\n') {
        out.push('\n');
    }
    out.push_str(&format_track_line(pattern));
    out.push('\n');
    Some(out)
}

/// Remove `pattern`'s LFS line. Ok(None) = not tracked (no-op). Err when the
/// matching line carries attributes beyond the standard LFS set - refusing
/// beats silently dropping the user's other attributes.
fn remove_lfs_pattern(existing: &str, pattern: &str) -> Result<Option<String>, String> {
    let mut removed = false;
    let mut kept: Vec<&str> = Vec::new();
    for line in existing.lines() {
        match split_attr_line(line) {
            Some((p, attrs)) if p == pattern && attrs.contains(&"filter=lfs") => {
                if attrs.iter().any(|a| !LFS_ATTRS.contains(a)) {
                    return Err(format!(
                        "the .gitattributes line for \"{pattern}\" carries attributes \
                         besides the standard LFS set; edit .gitattributes directly \
                         so they are not lost"
                    ));
                }
                removed = true;
            }
            _ => kept.push(line),
        }
    }
    if !removed {
        return Ok(None);
    }
    let mut out = kept.join("\n");
    if !out.is_empty() {
        out.push('\n');
    }
    Ok(Some(out))
}

/// Build the view: root patterns from `<root>/.gitattributes` (missing file =
/// none), nested files from the same tracked-attribute-files grep the LFS
/// status probe uses (exit 1 = no hits).
async fn patterns_view(session: &crate::state::RepoSession) -> LfsPatternsView {
    let root_text = tokio::fs::read_to_string(session.path.join(".gitattributes"))
        .await
        .unwrap_or_default();
    let runner = session.runner.read().await.clone();
    let nested_files = match runner
        .run_expecting(
            &["grep", "-l", "-e", "filter=lfs", "--", ":(glob)**/.gitattributes"],
            &[1],
        )
        .await
    {
        Ok(out) if out.exit_code == Some(0) => out
            .stdout
            .lines()
            .filter(|f| *f != ".gitattributes" && !f.is_empty())
            .map(str::to_string)
            .collect(),
        _ => vec![],
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
    let path = session.path.join(".gitattributes");
    let existing = tokio::fs::read_to_string(&path).await.unwrap_or_default();
    if let Some(updated) = add_lfs_pattern(&existing, pattern) {
        tokio::fs::write(&path, updated).await?;
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
    let path = session.path.join(".gitattributes");
    let existing = tokio::fs::read_to_string(&path).await.unwrap_or_default();
    match remove_lfs_pattern(&existing, pattern.trim()) {
        Err(msg) => return Err(AppError::ParseArgs(msg)),
        Ok(Some(updated)) => tokio::fs::write(&path, updated).await?,
        Ok(None) => {}
    }
    Ok(patterns_view(&session).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_lfs_patterns_shapes() {
        let text = "\
# comment\n\
*.png filter=lfs diff=lfs merge=lfs -text\n\
\"my file.psd\" filter=lfs diff=lfs merge=lfs -text\n\
*.txt text eol=lf\n\
*.bin filter=lfs\n";
        let patterns = parse_lfs_patterns(text);
        assert_eq!(patterns, vec!["*.png", "my file.psd", "*.bin"]);
        assert!(parse_lfs_patterns("").is_empty());
    }

    #[test]
    fn add_lfs_pattern_appends_and_dedupes() {
        // Create-from-empty, with trailing newline.
        let out = add_lfs_pattern("", "*.png").expect("added");
        assert_eq!(out, "*.png filter=lfs diff=lfs merge=lfs -text\n");
        // Append preserves existing content and fixes a missing final newline.
        let out = add_lfs_pattern("*.txt text eol=lf", "*.png").expect("added");
        assert_eq!(out, "*.txt text eol=lf\n*.png filter=lfs diff=lfs merge=lfs -text\n");
        // Whitespace patterns are quoted on write.
        let out = add_lfs_pattern("", "my file.psd").expect("added");
        assert_eq!(out, "\"my file.psd\" filter=lfs diff=lfs merge=lfs -text\n");
        // Duplicate (plain and quoted existing forms) is a no-op.
        assert!(add_lfs_pattern("*.png filter=lfs diff=lfs merge=lfs -text\n", "*.png").is_none());
        assert!(add_lfs_pattern("\"my file.psd\" filter=lfs\n", "my file.psd").is_none());
    }

    #[test]
    fn remove_lfs_pattern_rules() {
        let text = "*.txt text eol=lf\n*.png filter=lfs diff=lfs merge=lfs -text\n";
        // Standard line removed, others kept.
        let out = remove_lfs_pattern(text, "*.png").expect("ok").expect("removed");
        assert_eq!(out, "*.txt text eol=lf\n");
        // Absent pattern is a no-op (Ok(None)).
        assert!(remove_lfs_pattern(text, "*.zip").expect("ok").is_none());
        // A same-pattern line WITHOUT filter=lfs is not touched and not a match.
        assert!(remove_lfs_pattern("*.png text\n", "*.png").expect("ok").is_none());
        // Extra attributes on the LFS line: refuse rather than drop them.
        let err = remove_lfs_pattern("*.png filter=lfs text=auto\n", "*.png").unwrap_err();
        assert!(err.contains(".gitattributes"), "message should point at manual editing: {err}");
        // Quoted lines match their unquoted pattern.
        let out = remove_lfs_pattern("\"my file.psd\" filter=lfs diff=lfs merge=lfs -text\n", "my file.psd")
            .expect("ok")
            .expect("removed");
        assert_eq!(out, "");
    }
}
