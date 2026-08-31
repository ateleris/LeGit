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
use legit_core::types::{FileState, LineEndingKind, LineEndingStatusEntry, RenormalizeOutcome};
use legit_core::{
    classify_line_endings, convert_line_endings, derive_line_ending_entry, parse_autocrlf,
    parse_cat_file_batch, parse_check_attr_z, AutocrlfSetting, EolTextAttr, GitExecutor, GitRunner,
};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::{HashMap, HashSet};
use std::path::Path;

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
}

// ---------------------------------------------------------------------------
// View assembly (shared by the read and write commands)
// ---------------------------------------------------------------------------

/// Assemble the full repo-scope view: configs at all scopes plus the
/// `.gitattributes` rules.
async fn build_repo_view(
    fs: &dyn legit_core::RepoFs,
    repo_root: &Path,
    runner: &dyn GitExecutor,
) -> LineEndingsView {
    let autocrlf = read_config_all_scopes(runner, "core.autocrlf").await;
    let eol = read_config_all_scopes(runner, "core.eol").await;
    let (gitattributes, gitattributes_covers_all) = read_gitattributes(fs, repo_root).await;

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
    }
}

/// Assemble the global-scope view: no local scope and no `.gitattributes`
/// (it only exists inside a repo). Reads global + system only: the unbound
/// runner's cwd may lie inside some repo, and an all-scopes read would leak
/// that repo's local config into the resolved value
/// (see `read_config_global_scopes`).
async fn build_global_view(runner: &dyn GitExecutor) -> LineEndingsView {
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
    Ok(build_repo_view(session.host.fs().as_ref(), &session.path, runner.as_ref()).await)
}

/// Read line-ending information at global scope (no repo required).
/// `.gitattributes` doesn't apply at global scope.
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
    write_config_local(runner.as_ref(), "core.autocrlf", autocrlf.as_deref()).await?;
    write_config_local(runner.as_ref(), "core.eol", eol.as_deref()).await?;
    Ok(build_repo_view(session.host.fs().as_ref(), &session.path, runner.as_ref()).await)
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

async fn read_gitattributes(
    fs: &dyn legit_core::RepoFs,
    repo_root: &Path,
) -> (Vec<GitAttrRule>, bool) {
    let path = legit_core::HostPath::from_path(&repo_root.join(".gitattributes"));
    let contents = match fs.read(&path, None).await {
        Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
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
        None => {
            let fs = session.host.fs();
            let abs = resolve_repo_relative(fs.as_ref(), &session.path, &path).await?;
            read_capped_text(fs.as_ref(), &abs).await
        }
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
    let fs = session.host.fs();
    let abs = resolve_repo_relative(fs.as_ref(), &session.path, &path).await?;
    let hp = legit_core::HostPath::from_path(&abs);

    let bytes = match fs.read(&hp, Some(MAX_LINE_ENDING_BYTES as u64)).await {
        Ok(b) => b,
        Err(legit_core::FsError::TooLarge { .. }) => {
            return Err(AppError::Io(format!(
                "{path}: file too large to convert line endings"
            )))
        }
        Err(e) => return Err(AppError::Io(e.to_string())),
    };

    let converted = convert_line_endings(&bytes, target).ok_or_else(|| {
        AppError::Io(format!("{path}: cannot convert line endings (binary file or invalid target)"))
    })?;
    if converted != bytes {
        fs.write(&hp, &converted)
            .await
            .map_err(|e| AppError::Io(e.to_string()))?;
    }
    Ok(())
}

/// Line-ending summary for every changed file - drives the Working Changes
/// chips, the Diff/Merge working-vs-index badges, and the commit warning.
/// Fixed subprocess budget regardless of file count: status (via the
/// backend), one `config --get`, one `check-attr --stdin`, one
/// `cat-file --batch`; working files are read from disk. Every classifiable
/// changed file gets an entry (the Diff header wants `working_raw` even
/// when nothing is noteworthy); consumers filter for attention client-side.
#[tauri::command]
#[specta::specta]
pub async fn repo_line_ending_status(
    state: tauri::State<'_, AppState>,
    repo_id: String,
) -> Result<Vec<LineEndingStatusEntry>, AppError> {
    let session = state.get_session(&repo_id).await?;
    let runner = session.runner.read().await.clone();

    let statuses = session.backend.status().await.map_err(AppError::Git)?;
    // One record per path (a partially-staged file appears twice in status);
    // submodules and ignored files have no blob content of their own.
    let mut paths: Vec<String> = Vec::new();
    let mut untracked: HashSet<String> = HashSet::new();
    let mut seen: HashSet<String> = HashSet::new();
    for s in &statuses {
        if matches!(
            s.state,
            FileState::SubmoduleChanged | FileState::SubmoduleDirty | FileState::Ignored
        ) {
            continue;
        }
        let path = s.path.to_string_lossy().into_owned();
        if s.state == FileState::Untracked {
            untracked.insert(path.clone());
        }
        if seen.insert(path.clone()) {
            paths.push(path);
        }
    }
    if paths.is_empty() {
        return Ok(vec![]);
    }

    // Resolved core.autocrlf (exit 1 + empty stdout when unset = False).
    let autocrlf: AutocrlfSetting = match runner.run_expecting(&["config", "--get", "core.autocrlf"], &[1]).await {
        Ok(o) => parse_autocrlf(&o.stdout),
        Err(_) => AutocrlfSetting::False,
    };

    // text/eol attributes for all changed paths in one call.
    let attr_stdin: String = paths.iter().map(|p| format!("{p}\0")).collect();
    let attrs: HashMap<String, (EolTextAttr, bool)> = match runner
        .run_with_stdin(&["check-attr", "-z", "--stdin", "text", "eol"], &attr_stdin)
        .await
    {
        Ok(o) if o.success => parse_check_attr_z(&o.stdout),
        _ => HashMap::new(),
    };

    // Index and HEAD blobs for every tracked changed path, one subprocess.
    // Request order mirrors `paths` so the results zip back positionally.
    let tracked: Vec<&String> = paths.iter().filter(|p| !untracked.contains(*p)).collect();
    let mut blobs: HashMap<&str, (Option<Vec<u8>>, Option<Vec<u8>>)> = HashMap::new();
    if !tracked.is_empty() {
        let stdin: String = tracked.iter().map(|p| format!(":{p}\nHEAD:{p}\n")).collect();
        if let Ok(out) = runner.run_with_stdin_bytes(&["cat-file", "--batch"], &stdin).await {
            if let Some(parsed) = parse_cat_file_batch(&out.stdout) {
                if parsed.len() == tracked.len() * 2 {
                    let mut it = parsed.into_iter();
                    for p in &tracked {
                        let index =
                            it.next().flatten().filter(|b| b.len() <= MAX_LINE_ENDING_BYTES);
                        let head =
                            it.next().flatten().filter(|b| b.len() <= MAX_LINE_ENDING_BYTES);
                        blobs.insert(p.as_str(), (index, head));
                    }
                }
            }
        }
    }

    let mut entries: Vec<LineEndingStatusEntry> = Vec::with_capacity(paths.len());
    for path in &paths {
        let working =
            match resolve_repo_relative(session.host.fs().as_ref(), &session.path, path).await {
                Ok(abs) => read_capped_bytes(session.host.fs().as_ref(), &abs).await,
                Err(_) => None,
            };
        let (index, head) = blobs.get(path.as_str()).cloned().unwrap_or((None, None));
        let (text_attr, eol_set) = attrs
            .get(path)
            .copied()
            .unwrap_or((EolTextAttr::Unspecified, false));
        entries.push(derive_line_ending_entry(
            path,
            working.as_deref(),
            index.as_deref(),
            head.as_deref(),
            text_attr,
            eol_set,
            autocrlf,
        ));
    }
    Ok(entries)
}

/// Read a working-tree file's raw bytes for line-ending classification;
/// `None` if missing, unreadable, or over the size cap (byte-level sibling
/// of `read_capped_text`).
async fn read_capped_bytes(fs: &dyn legit_core::RepoFs, abs: &Path) -> Option<Vec<u8>> {
    fs.read(
        &legit_core::HostPath::from_path(abs),
        Some(MAX_LINE_ENDING_BYTES as u64),
    )
    .await
    .ok()
}

/// 2 MB cap: above this the indicator is skipped rather than reading/scanning a
/// large blob (matches the mixed-ending detector's guard).
const MAX_LINE_ENDING_BYTES: usize = 2 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Renormalize (Repo Settings "Line endings" -> Normalize block)
// ---------------------------------------------------------------------------

/// Preview for the Normalize block: which index entries a renormalize would
/// change, plus how many tracked files carry unstaged changes (restaging
/// stages those edits too - `--renormalize` implies `-u`).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct RenormalizePreview {
    pub files: Vec<String>,
    pub unstaged_changes: u32,
}

/// Simulated `git add --renormalize` (throwaway index; the real index is
/// untouched). Also cleans up the simulation's temp index file, best-effort.
#[tauri::command]
#[specta::specta]
pub async fn repo_renormalize_preview(
    state: tauri::State<'_, AppState>,
    repo_id: String,
) -> Result<RenormalizePreview, AppError> {
    let session = state.get_session(&repo_id).await?;
    // Serialize previews: they share one throwaway-index path, and git's
    // `.lock` on it makes concurrent runs fail ("Another git process seems
    // to be running"). The pre-run cleanup self-heals after a crashed run
    // whose lock file would otherwise block every future preview.
    let _preview_guard = session.renormalize_preview_lock.lock().await;
    remove_preview_index(&session).await;
    let files = session.backend.renormalize_preview().await;
    remove_preview_index(&session).await;
    let files = files.map_err(AppError::Git)?;

    let statuses = session.backend.status().await.map_err(AppError::Git)?;
    // `--renormalize` implies `-u`: unstaged modifications, deletions, and
    // submodule pointer moves of tracked paths all get staged by the run.
    let unstaged_changes = statuses
        .iter()
        .filter(|s| {
            !s.staged
                && matches!(
                    s.state,
                    FileState::Modified | FileState::Deleted | FileState::SubmoduleChanged
                )
        })
        .count() as u32;
    Ok(RenormalizePreview { files, unstaged_changes })
}

/// Best-effort removal of the preview's throwaway index file AND its
/// `.lock` (the backend is executor-only and cannot delete files). The
/// `.lock` matters: git leaves it behind when a preview is killed mid-run,
/// and a stale lock makes every subsequent preview fail. Never fails.
async fn remove_preview_index(session: &crate::state::RepoSession) {
    let runner = session.runner.read().await.clone();
    let Ok(out) = runner.run(&["rev-parse", "--git-path", "index"]).await else {
        return;
    };
    if !out.success {
        return;
    }
    let rel = Path::new(out.stdout.trim());
    let abs = if rel.is_absolute() { rel.to_path_buf() } else { session.path.join(rel) };
    let mut name = abs.file_name().unwrap_or_default().to_os_string();
    name.push(legit_core::cli_impl::parsers::renormalize::RENORMALIZE_PREVIEW_INDEX_SUFFIX);
    let temp = abs.with_file_name(name);
    let mut lock_name = temp.file_name().unwrap_or_default().to_os_string();
    lock_name.push(".lock");
    let fs = session.host.fs();
    let _ = fs
        .remove_file(&legit_core::HostPath::from_path(&temp.with_file_name(lock_name)))
        .await;
    let _ = fs
        .remove_file(&legit_core::HostPath::from_path(&temp))
        .await;
}

/// Run `git add --renormalize -- .`: restages tracked files through the
/// clean filter. The result is left staged for review, never committed.
#[tauri::command]
#[specta::specta]
pub async fn repo_renormalize(
    state: tauri::State<'_, AppState>,
    repo_id: String,
) -> Result<RenormalizeOutcome, AppError> {
    let session = state.get_session(&repo_id).await?;
    session.backend.renormalize().await.map_err(AppError::Git)
}

/// Insert a covers-all `* text=auto [eol=...]` rule into `.gitattributes`
/// (created if missing). Returns the refreshed view, like
/// `repo_write_line_endings`. The file is a normal working-tree change for
/// the user to stage and commit.
#[tauri::command]
#[specta::specta]
pub async fn repo_write_gitattributes_eol(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    eol: Option<String>,
) -> Result<LineEndingsView, AppError> {
    let session = state.get_session(&repo_id).await?;
    let fs = session.host.fs();
    let hp = legit_core::HostPath::from_path(&session.path.join(".gitattributes"));
    let existing = match fs.read(&hp, None).await {
        Ok(bytes) => Some(String::from_utf8_lossy(&bytes).into_owned()),
        Err(_) => None,
    };
    let updated =
        insert_covers_all_rule(existing.as_deref(), eol.as_deref()).map_err(AppError::Io)?;
    fs.write(&hp, updated.as_bytes())
        .await
        .map_err(|e| AppError::Io(e.to_string()))?;
    let runner = session.runner.read().await.clone();
    Ok(build_repo_view(session.host.fs().as_ref(), &session.path, runner.as_ref()).await)
}

/// Build new `.gitattributes` content with a covers-all
/// `* text=auto [eol=...]` rule inserted at the TOP (after any leading
/// comment/blank block): last matching rule wins in gitattributes, so
/// appending would silently override every specific rule below it.
/// Errors are plain strings for `AppError::Io`.
fn insert_covers_all_rule(existing: Option<&str>, eol: Option<&str>) -> Result<String, String> {
    if let Some(v) = eol {
        if v != "lf" && v != "crlf" {
            return Err(format!("invalid eol value: {v}"));
        }
    }
    let rule = match eol {
        Some(v) => format!("* text=auto eol={v}"),
        None => "* text=auto".to_string(),
    };
    let Some(existing) = existing else {
        return Ok(format!("{rule}\n"));
    };
    for line in existing.lines() {
        let t = line.trim();
        if t.is_empty() || t.starts_with('#') {
            continue;
        }
        if let Some(r) = parse_attr_line(t) {
            if r.pattern == "*" && r.text.is_some() {
                return Err("a covers-all `*` text rule already exists in .gitattributes".into());
            }
        }
    }
    let lines: Vec<&str> = existing.lines().collect();
    let insert_at = lines
        .iter()
        .position(|l| {
            let t = l.trim();
            !t.is_empty() && !t.starts_with('#')
        })
        .unwrap_or(lines.len());
    let mut out: Vec<String> = Vec::with_capacity(lines.len() + 1);
    out.extend(lines[..insert_at].iter().map(|s| s.to_string()));
    out.push(rule);
    out.extend(lines[insert_at..].iter().map(|s| s.to_string()));
    Ok(out.join("\n") + "\n")
}

#[cfg(test)]
mod tests {
    use super::insert_covers_all_rule;

    #[test]
    fn creates_new_file_with_rule() {
        assert_eq!(
            insert_covers_all_rule(None, Some("lf")).unwrap(),
            "* text=auto eol=lf\n"
        );
        assert_eq!(insert_covers_all_rule(None, None).unwrap(), "* text=auto\n");
    }

    #[test]
    fn inserts_before_first_rule_keeping_leading_comments() {
        let existing = "# EOL policy\n\n*.bat eol=crlf\n*.png binary\n";
        let got = insert_covers_all_rule(Some(existing), Some("lf")).unwrap();
        assert_eq!(
            got,
            "# EOL policy\n\n* text=auto eol=lf\n*.bat eol=crlf\n*.png binary\n"
        );
    }

    #[test]
    fn comment_only_file_appends_after_comments() {
        let got = insert_covers_all_rule(Some("# notes\n"), None).unwrap();
        assert_eq!(got, "# notes\n* text=auto\n");
    }

    #[test]
    fn refuses_existing_covers_all_rule() {
        assert!(insert_covers_all_rule(Some("* text=auto\n"), Some("lf")).is_err());
        // Also the plain `text` form.
        assert!(insert_covers_all_rule(Some("* text\n"), None).is_err());
    }

    #[test]
    fn refuses_invalid_eol_value() {
        assert!(insert_covers_all_rule(None, Some("cr")).is_err());
    }
}

/// Read a working-tree file as text for line-ending classification; `None` if
/// missing, unreadable, or over the size cap.
async fn read_capped_text(fs: &dyn legit_core::RepoFs, abs: &Path) -> Option<String> {
    let bytes = read_capped_bytes(fs, abs).await?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

