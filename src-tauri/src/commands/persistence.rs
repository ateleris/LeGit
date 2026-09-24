//! Persistence commands: settings, dock layout, theme files (DESIGN-v0.1.md §7.8).
//!
//! Settings are a single JSON document under the app data dir. Themes are
//! `.legit-theme.json` files under either the bundled resource dir
//! (read-only built-ins) or `<app_data>/themes/` (user-writable). The
//! validation rules from §6.5 live next to `save_theme`.

use crate::error::AppError;
use crate::state::{AppState, GlobalSettings};
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
    let safe = sanitize_theme_name(&name)?;
    state.mutate_global(|s| {
        s.active_theme = Some(safe);
    })
    .await
}

/// Patch one or more global settings (JSON field names) in a single write and
/// return the merged result. Fields owned by dedicated commands (git path,
/// theme, watcher, session bookkeeping, profiles, accounts) are refused, and
/// values are normalized (clamped) by `GlobalSettings::with_patch` - so the
/// frontend never needs to mirror a clamp to know what was stored.
#[tauri::command]
#[specta::specta]
pub async fn patch_global_settings(
    state: tauri::State<'_, AppState>,
    patch: serde_json::Value,
) -> Result<GlobalSettings, AppError> {
    let merged = {
        let mut s = state.global_settings.write().await;
        let next = s.with_patch(&patch)?;
        *s = next.clone();
        next
    };
    state.persist_global_settings().await?;
    Ok(merged)
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
        let path = theme_file_path(dir, &name)?;
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
    let path = theme_file_path(&dir, &safe)?;
    let json = serde_json::to_string_pretty(&contents)?;
    crate::persist::write_atomic(&path, json).await?;
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
    let path = theme_file_path(&state.user_themes_dir, &name)?;
    if path.exists() {
        tokio::fs::remove_file(path).await?;
    }
    Ok(())
}

/// Validate against the rules in DESIGN-v0.1.md §6.5. Strict on structure, lenient
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
    const KNOWN_FILTERS: [&str; 8] = [
        "lighter-soft",
        "lighter",
        "lighter-strong",
        "darker-soft",
        "darker",
        "darker-strong",
        "faded",
        "subtle",
    ];
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

/// Palette values are written straight into CSS custom properties, so the
/// whole string must be ONE colour: a nested `(` would admit `url(...)` (a
/// remote fetch when the token is used in a `background` shorthand) and
/// anything after the closing paren a second declaration.
fn is_valid_color(s: &str) -> bool {
    let s = s.trim();
    if let Some(rest) = s.strip_prefix('#') {
        return matches!(rest.len(), 3 | 4 | 6 | 8) && rest.chars().all(|c| c.is_ascii_hexdigit());
    }
    let lower = s.to_lowercase();
    let Some(open) = lower.find('(') else { return false };
    if !matches!(&lower[..open], "rgb" | "rgba" | "hsl" | "hsla" | "oklch") {
        return false;
    }
    let Some(body) = lower[open + 1..].strip_suffix(')') else { return false };
    !body.trim().is_empty()
        && body.chars().all(|c| {
            c.is_ascii_alphanumeric() || matches!(c, ' ' | ',' | '.' | '%' | '/' | '+' | '-')
        })
}

/// The on-disk path of one theme file. Every theme path in this module goes
/// through here so the frontend-supplied name is confined to `dir`.
fn theme_file_path(dir: &std::path::Path, name: &str) -> Result<PathBuf, AppError> {
    let safe = sanitize_theme_name(name)?;
    Ok(dir.join(format!("{safe}{THEME_EXT}")))
}

fn sanitize_theme_name(name: &str) -> Result<String, AppError> {
    crate::persist::sanitize_file_stem(name).map_err(|e| AppError::InvalidTheme(format!("theme {e}")))
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

    // The filter list must mirror TOKEN_FILTERS in src/theme/filters.ts:
    // a filter the editor offers but this list omits makes save_theme reject
    // a theme the frontend validated.
    #[test]
    fn accepts_every_frontend_filter() {
        for filter in [
            "lighter-soft",
            "lighter",
            "lighter-strong",
            "darker-soft",
            "darker",
            "darker-strong",
            "faded",
            "subtle",
        ] {
            let mut v = good();
            v["tokens"]["panel.bg"] = json!({ "ref": "bg", "filter": filter });
            assert!(
                validate_theme(&v).is_ok(),
                "filter {filter:?} rejected by validate_theme"
            );
        }
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

    // Every theme file path (load, save, delete) is built by one helper, so a
    // name from the frontend can never leave the themes directory.
    #[test]
    fn theme_file_path_confines_names_to_the_directory() {
        let dir = std::path::Path::new("themes-root");
        assert_eq!(
            theme_file_path(dir, "Dark").unwrap(),
            dir.join("Dark.legit-theme.json")
        );
        assert_eq!(
            theme_file_path(dir, "  Solar Flare ").unwrap(),
            dir.join("Solar Flare.legit-theme.json")
        );
        for bad in ["../x", "/etc/passwd", "C:\\x", "a/b", "a\\b", "", "   ", "a\0b"] {
            assert!(theme_file_path(dir, bad).is_err(), "expected rejection: {bad:?}");
        }
    }

    // Palette values become CSS custom properties verbatim, so the grammar
    // must be a colour and nothing else: no trailing tokens, no nested
    // functions (`url(`, `var(`), no declarations smuggled in after a `;`.
    #[test]
    fn color_validation_accepts_real_colors_only() {
        for ok in [
            "#fff",
            "#ffff",
            "#4a9eff",
            "#4a9eff33",
            "rgb(1,2,3)",
            "rgba(74, 158, 255, 0.5)",
            "hsl(1, 2%, 3%)",
            "hsla(1, 2%, 3%, .5)",
            "hsl(120deg 50% 50%)",
            "oklch(0.5 0.1 200)",
            "oklch(0.5 0.1 200 / 50%)",
            "rgb(1 2 3 / 0.5)",
            " RGB(1, 2, 3) ",
        ] {
            assert!(is_valid_color(ok), "expected valid: {ok:?}");
        }
        for bad in [
            "red",
            "",
            "#12345",
            "#ggg",
            "url(x)",
            "rgb(0,0,0) url(https://example.com/x)",
            "rgb(0,0,0); background: red",
            "rgb(0 0 0) rgb(1 1 1)",
            "rgb(var(--x))",
            "rgb (1,2,3)",
            "rgb(1,2,3)) rgb(",
            "rgb()",
            "expression(1)",
            "color-mix(in srgb, red, blue)",
        ] {
            assert!(!is_valid_color(bad), "expected invalid: {bad:?}");
        }
    }
}
