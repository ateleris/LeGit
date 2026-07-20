//! Persistence commands: settings, dock layout, theme files (DESIGN.md §7.8).
//!
//! Settings are a single JSON document under the app data dir. Themes are
//! `.legit-theme.json` files under either the bundled resource dir
//! (read-only built-ins) or `<app_data>/themes/` (user-writable). The
//! validation rules from §6.5 live next to `save_theme`.

use crate::error::AppError;
use crate::state::{
    max_commits_dot_radius, min_commits_row_height, AppState, CommitDateFormat, GlobalSettings,
    RegionPlacement,
};
use legit_core::SwitchDirtyBehavior;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::PathBuf;

const THEME_EXT: &str = ".legit-theme.json";

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct ThemeEntry {
    pub name: String,
    pub source: ThemeSource,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum ThemeSource {
    Builtin,
    User,
}

#[tauri::command]
#[specta::specta]
pub async fn get_global_settings(
    state: tauri::State<'_, AppState>,
) -> Result<GlobalSettings, AppError> {
    Ok(state.global_settings.read().await.clone())
}

#[tauri::command]
#[specta::specta]
pub async fn set_active_theme(
    state: tauri::State<'_, AppState>,
    name: String,
) -> Result<(), AppError> {
    state.mutate_global(|s| {
        s.active_theme = Some(name);
    })
    .await
}

/// Persist the region layout state (divider sizes, collapse, placement).
/// Called on drag-end and toggle; debounced by the frontend for dragging.
#[tauri::command]
#[specta::specta]
pub async fn save_region_state(
    state: tauri::State<'_, AppState>,
    placement: RegionPlacement,
    size_top: Option<f64>,
    size_left: Option<f64>,
    collapsed: bool,
) -> Result<(), AppError> {
    state.mutate_global(|s| {
        s.global_region_placement = placement;
        s.global_region_size_top = size_top;
        s.global_region_size_left = size_left;
        s.global_dock_collapsed = collapsed;
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn save_column_preferences(
    state: tauri::State<'_, AppState>,
    prefs: serde_json::Value,
) -> Result<(), AppError> {
    state.mutate_global(|s| {
        s.column_preferences = prefs;
    })
    .await
}

/// Persist the Changed Files panel's view mode (`"tree"` | `"flat"`).
#[tauri::command]
#[specta::specta]
pub async fn save_changed_files_view_mode(
    state: tauri::State<'_, AppState>,
    mode: String,
) -> Result<(), AppError> {
    state.mutate_global(|s| {
        s.changed_files_view_mode = Some(mode);
    })
    .await
}

/// Persist the global UI font size (px), clamped to a sane range.
#[tauri::command]
#[specta::specta]
pub async fn save_ui_font_size(
    state: tauri::State<'_, AppState>,
    size: f64,
) -> Result<f64, AppError> {
    let clamped = size.clamp(8.0, 24.0);
    state.mutate_global(|s| {
        s.ui_font_size = clamped;
    })
    .await?;
    Ok(clamped)
}

/// Persist the Commits-panel graph metrics (row/line height, per-lane width,
/// commit-dot radius, and connector line width). Clamps each value to sane px
/// bounds before storing; the dot radius and line width are capped to half the
/// smaller cell dimension so they can never overflow the cell or overlap a
/// neighbouring lane. Text has no per-panel size — it follows the global UI
/// font size.
#[tauri::command]
#[specta::specta]
pub async fn save_commits_graph_metrics(
    state: tauri::State<'_, AppState>,
    row_height: f64,
    lane_width: f64,
    dot_radius: f64,
    line_width: f64,
) -> Result<(), AppError> {
    state.mutate_global(|s| {
        // The row must clear a ref chip, which scales with the UI font size;
        // lane width shares the same font-derived floor.
        let min_rh = min_commits_row_height(s.ui_font_size);
        let rh = row_height.clamp(min_rh, 120.0);
        let lw = lane_width.clamp(min_rh, 120.0);
        s.commits_row_height = rh;
        s.commits_lane_width = lw;
        s.commits_dot_radius = dot_radius.clamp(1.0, max_commits_dot_radius(rh, lw));
        // Line width can't exceed half the smaller cell dimension or the stroke
        // would overflow the cell / neighbouring lane — same bound as the dot.
        s.commits_line_width = line_width.clamp(1.0, max_commits_dot_radius(rh, lw));
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn set_line_ending_chips_in_changes(
    state: tauri::State<'_, AppState>,
    enabled: bool,
) -> Result<(), AppError> {
    state.mutate_global(|s| {
        s.line_ending_chips_in_changes = enabled;
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn set_warn_on_line_ending_commit(
    state: tauri::State<'_, AppState>,
    warn: bool,
) -> Result<(), AppError> {
    state.mutate_global(|s| {
        s.warn_on_line_ending_commit = warn;
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn set_confirm_discard(
    state: tauri::State<'_, AppState>,
    confirm: bool,
) -> Result<(), AppError> {
    state.mutate_global(|s| {
        s.confirm_discard = confirm;
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn set_external_editor_command(
    state: tauri::State<'_, AppState>,
    command: Option<String>,
) -> Result<(), AppError> {
    state.mutate_global(|s| {
        // Blank means "not configured" — store None so the fallback applies.
        s.external_editor_command = command.filter(|c| !c.trim().is_empty());
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn set_auto_fetch_enabled(
    state: tauri::State<'_, AppState>,
    enabled: bool,
) -> Result<(), AppError> {
    state.mutate_global(|s| {
        s.auto_fetch_enabled = enabled;
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn set_auto_fetch_interval_minutes(
    state: tauri::State<'_, AppState>,
    minutes: u32,
) -> Result<(), AppError> {
    state.mutate_global(|s| {
        s.auto_fetch_interval_minutes = minutes.max(1);
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn set_commit_avatars(
    state: tauri::State<'_, AppState>,
    enabled: bool,
) -> Result<(), AppError> {
    state.mutate_global(|s| {
        s.commit_avatars = enabled;
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn set_diff_syntax_highlighting(
    state: tauri::State<'_, AppState>,
    enabled: bool,
) -> Result<(), AppError> {
    state.mutate_global(|s| {
        s.diff_syntax_highlighting = enabled;
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn set_commit_date_absolute(
    state: tauri::State<'_, AppState>,
    enabled: bool,
) -> Result<(), AppError> {
    state.mutate_global(|s| {
        s.commit_date_absolute = enabled;
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn set_commit_date_format(
    state: tauri::State<'_, AppState>,
    format: CommitDateFormat,
) -> Result<(), AppError> {
    state.mutate_global(|s| {
        s.commit_date_format = format;
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn set_commit_date_show_time(
    state: tauri::State<'_, AppState>,
    enabled: bool,
) -> Result<(), AppError> {
    state.mutate_global(|s| {
        s.commit_date_show_time = enabled;
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn set_suppressed_auto_open_panels(
    state: tauri::State<'_, AppState>,
    panels: Vec<String>,
) -> Result<(), AppError> {
    state.mutate_global(|s| {
        s.suppressed_auto_open_panels = panels;
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn set_working_changes_section_order(
    state: tauri::State<'_, AppState>,
    order: Vec<String>,
) -> Result<(), AppError> {
    state.mutate_global(|s| {
        s.working_changes_section_order = order;
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn save_switch_dirty_behavior(
    state: tauri::State<'_, AppState>,
    behavior: SwitchDirtyBehavior,
) -> Result<(), AppError> {
    state.mutate_global(|s| {
        s.switch_dirty_behavior = Some(behavior);
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn save_pull_strategy(
    state: tauri::State<'_, AppState>,
    strategy: legit_core::PullStrategy,
) -> Result<(), AppError> {
    state.mutate_global(|s| {
        s.pull_strategy = Some(strategy);
    })
    .await
}

/// Persist the Stash button's default mode (include untracked files or not).
#[tauri::command]
#[specta::specta]
pub async fn save_stash_include_untracked(
    state: tauri::State<'_, AppState>,
    include_untracked: bool,
) -> Result<(), AppError> {
    state.mutate_global(|s| {
        s.stash_include_untracked = include_untracked;
    })
    .await
}

/// Persist the `push --recurse-submodules` guard mode (None = off).
#[tauri::command]
#[specta::specta]
pub async fn save_push_recurse_submodules(
    state: tauri::State<'_, AppState>,
    mode: Option<legit_core::PushRecurseMode>,
) -> Result<(), AppError> {
    state.mutate_global(|s| {
        s.push_recurse_submodules = mode;
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn list_themes(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<ThemeEntry>, AppError> {
    let mut out = Vec::new();
    out.extend(read_theme_dir(&state.builtin_themes_dir, ThemeSource::Builtin).await?);
    out.extend(read_theme_dir(&state.user_themes_dir, ThemeSource::User).await?);
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}

async fn read_theme_dir(
    dir: &std::path::Path,
    source: ThemeSource,
) -> Result<Vec<ThemeEntry>, AppError> {
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut entries = Vec::new();
    let mut rd = tokio::fs::read_dir(dir).await?;
    while let Some(entry) = rd.next_entry().await? {
        let path = entry.path();
        let Some(file_name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if !file_name.to_lowercase().ends_with(THEME_EXT) {
            continue;
        }
        let stem = &file_name[..file_name.len() - THEME_EXT.len()];
        entries.push(ThemeEntry {
            name: stem.to_string(),
            source: source.clone(),
            path: path.to_string_lossy().to_string(),
        });
    }
    Ok(entries)
}

#[tauri::command]
#[specta::specta]
pub async fn load_theme(
    state: tauri::State<'_, AppState>,
    name: String,
) -> Result<serde_json::Value, AppError> {
    for dir in [&state.user_themes_dir, &state.builtin_themes_dir] {
        let path = dir.join(format!("{name}{THEME_EXT}"));
        if path.exists() {
            let bytes = tokio::fs::read(&path).await?;
            let value: serde_json::Value =
                serde_json::from_slice(&bytes).map_err(AppError::from)?;
            return Ok(value);
        }
    }
    Err(AppError::InvalidTheme(format!("theme not found: {name}")))
}

#[tauri::command]
#[specta::specta]
pub async fn save_theme(
    state: tauri::State<'_, AppState>,
    name: String,
    contents: serde_json::Value,
) -> Result<ThemeEntry, AppError> {
    validate_theme(&contents)?;
    let safe = sanitize_theme_name(&name)?;
    let dir = state.user_themes_dir.clone();
    tokio::fs::create_dir_all(&dir).await?;
    let path = dir.join(format!("{safe}{THEME_EXT}"));
    let json = serde_json::to_string_pretty(&contents)?;
    tokio::fs::write(&path, json).await?;
    Ok(ThemeEntry {
        name: safe,
        source: ThemeSource::User,
        path: path.to_string_lossy().to_string(),
    })
}

#[tauri::command]
#[specta::specta]
pub async fn delete_theme(
    state: tauri::State<'_, AppState>,
    name: String,
) -> Result<(), AppError> {
    let safe = sanitize_theme_name(&name)?;
    let path = state.user_themes_dir.join(format!("{safe}{THEME_EXT}"));
    if path.exists() {
        tokio::fs::remove_file(path).await?;
    }
    Ok(())
}

/// Validate against the rules in DESIGN.md §6.5. Strict on structure, lenient
/// on unknown content. Tokens missing/unknown tokens are *not* rejected here
/// — the frontend fills missing ones from the default theme and preserves
/// unknown ones silently.
fn validate_theme(value: &serde_json::Value) -> Result<(), AppError> {
    let obj = value
        .as_object()
        .ok_or_else(|| AppError::InvalidTheme("theme must be a JSON object".into()))?;
    let format = obj
        .get("format")
        .and_then(|v| v.as_str())
        .ok_or_else(|| AppError::InvalidTheme("missing `format`".into()))?;
    if format != "legit-theme" {
        return Err(AppError::InvalidTheme(format!(
            "format must be 'legit-theme', got '{format}'"
        )));
    }
    obj.get("formatVersion")
        .and_then(|v| v.as_u64())
        .ok_or_else(|| AppError::InvalidTheme("missing or invalid `formatVersion`".into()))?;
    let name = obj
        .get("name")
        .and_then(|v| v.as_str())
        .ok_or_else(|| AppError::InvalidTheme("missing `name`".into()))?;
    if name.trim().is_empty() {
        return Err(AppError::InvalidTheme("`name` cannot be empty".into()));
    }
    let palette = obj
        .get("palette")
        .and_then(|v| v.as_object())
        .ok_or_else(|| AppError::InvalidTheme("missing `palette` object".into()))?;
    for (k, v) in palette {
        let color = v
            .as_str()
            .ok_or_else(|| AppError::InvalidTheme(format!("palette.{k} must be a string")))?;
        if !is_valid_color(color) {
            return Err(AppError::InvalidTheme(format!(
                "palette.{k} is not a valid color: '{color}'"
            )));
        }
    }
    let tokens = obj
        .get("tokens")
        .and_then(|v| v.as_object())
        .ok_or_else(|| AppError::InvalidTheme("missing `tokens` object".into()))?;
    // Filter ids for derived-colour bindings — mirror `TOKEN_FILTERS` in
    // `src/theme/filters.ts`.
    const KNOWN_FILTERS: [&str; 6] =
        ["lighter-soft", "lighter", "darker-soft", "darker", "faded", "subtle"];
    for (k, v) in tokens {
        // A binding is a bare palette name, or { ref, filter } for derived colours.
        let reference = if let Some(s) = v.as_str() {
            s
        } else if let Some(obj) = v.as_object() {
            let filter = obj.get("filter").and_then(|f| f.as_str()).ok_or_else(|| {
                AppError::InvalidTheme(format!("tokens.{k}: missing `filter` string"))
            })?;
            if !KNOWN_FILTERS.contains(&filter) {
                return Err(AppError::InvalidTheme(format!(
                    "tokens.{k}: unknown filter '{filter}'"
                )));
            }
            obj.get("ref").and_then(|r| r.as_str()).ok_or_else(|| {
                AppError::InvalidTheme(format!("tokens.{k}: missing `ref` string"))
            })?
        } else {
            return Err(AppError::InvalidTheme(format!(
                "tokens.{k} must be a palette name or {{ ref, filter }}"
            )));
        };
        if !palette.contains_key(reference) {
            return Err(AppError::InvalidTheme(format!(
                "tokens.{k} references undefined palette name '{reference}'"
            )));
        }
    }
    Ok(())
}

fn is_valid_color(s: &str) -> bool {
    let s = s.trim();
    if let Some(rest) = s.strip_prefix('#') {
        return matches!(rest.len(), 3 | 4 | 6 | 8) && rest.chars().all(|c| c.is_ascii_hexdigit());
    }
    let lower = s.to_lowercase();
    lower.starts_with("rgb(")
        || lower.starts_with("rgba(")
        || lower.starts_with("hsl(")
        || lower.starts_with("hsla(")
        || lower.starts_with("oklch(")
}

fn sanitize_theme_name(name: &str) -> Result<String, AppError> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(AppError::InvalidTheme("theme name is empty".into()));
    }
    let bad: &[char] = &['/', '\\', '\0', ':', '*', '?', '"', '<', '>', '|'];
    if trimmed.chars().any(|c| bad.contains(&c) || c.is_control()) {
        return Err(AppError::InvalidTheme(format!(
            "theme name contains forbidden character(s): {trimmed:?}"
        )));
    }
    Ok(trimmed.to_string())
}


/// Compute the on-disk locations used by `AppState`. Returns
/// `(global_settings_path, repos_data_dir, user_themes_dir, builtin_themes_dir)`.
/// Falls back to the current working directory when `app_data_dir` is
/// unavailable (rare; mostly during tests).
pub fn resolve_dirs(app: &tauri::AppHandle) -> (PathBuf, PathBuf, PathBuf, PathBuf) {
    use tauri::Manager;
    let data = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    let global_settings_path = data.join("global-settings.json");
    let repos_data_dir = data.join("repos");
    let user_themes_dir = data.join("themes");
    // Bundled themes: the resources map in tauri.conf.json places them at
    // `<resource_dir>/themes`. Older builds (array-form resources) put
    // `../`-relative files under a literal `_up_/` — check that too, plus the
    // exe dir as a last resort, and take the first candidate that exists.
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(res) = app.path().resource_dir() {
        candidates.push(res.join("themes"));
        candidates.push(res.join("_up_").join("themes"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("themes"));
        }
    }
    let builtin_themes_dir = candidates
        .iter()
        .find(|p| p.is_dir())
        .cloned()
        .unwrap_or_else(|| {
            tracing::warn!(
                ?candidates,
                "no builtin themes directory found — the theme list will only show user themes"
            );
            candidates
                .first()
                .cloned()
                .unwrap_or_else(|| PathBuf::from("themes"))
        });
    (global_settings_path, repos_data_dir, user_themes_dir, builtin_themes_dir)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn good() -> serde_json::Value {
        json!({
            "format": "legit-theme",
            "formatVersion": 1,
            "name": "X",
            "palette": { "bg": "#000000", "fg": "#ffffff" },
            "tokens": { "panel.bg": "bg", "panel.fg": "fg" }
        })
    }

    #[test]
    fn accepts_minimal_valid() {
        assert!(validate_theme(&good()).is_ok());
    }

    #[test]
    fn rejects_bad_format() {
        let mut v = good();
        v["format"] = json!("not-legit");
        assert!(validate_theme(&v).is_err());
    }

    #[test]
    fn rejects_undefined_palette_reference() {
        let mut v = good();
        v["tokens"]["panel.bg"] = json!("missing");
        assert!(validate_theme(&v).is_err());
    }

    #[test]
    fn rejects_bad_color() {
        let mut v = good();
        v["palette"]["bg"] = json!("not-a-color");
        assert!(validate_theme(&v).is_err());
    }

    #[test]
    fn rejects_empty_name() {
        let mut v = good();
        v["name"] = json!("   ");
        assert!(validate_theme(&v).is_err());
    }
}
