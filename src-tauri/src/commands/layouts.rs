//! Saved panel layouts: named snapshots of both docks' arrangements, stored
//! as `<app_data>/layouts/<name>.legit-layout.json` (same file-per-entry
//! model as user themes). Validation is strict on structure, lenient on the
//! dockview content — the frontend prunes unknown panels when applying.

use crate::error::AppError;
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::PathBuf;

const LAYOUT_EXT: &str = ".legit-layout.json";

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct LayoutEntry {
    pub name: String,
    pub path: String,
}

#[tauri::command]
#[specta::specta]
pub async fn list_layouts(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<LayoutEntry>, AppError> {
    let dir = &state.layouts_dir;
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
        if !file_name.to_lowercase().ends_with(LAYOUT_EXT) {
            continue;
        }
        let stem = &file_name[..file_name.len() - LAYOUT_EXT.len()];
        entries.push(LayoutEntry {
            name: stem.to_string(),
            path: path.to_string_lossy().to_string(),
        });
    }
    entries.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(entries)
}

#[tauri::command]
#[specta::specta]
pub async fn load_layout(
    state: tauri::State<'_, AppState>,
    name: String,
) -> Result<serde_json::Value, AppError> {
    let path = layout_file_path(&state.layouts_dir, &name)?;
    if !path.exists() {
        return Err(AppError::InvalidLayout(format!("layout not found: {name}")));
    }
    let bytes = tokio::fs::read(&path).await?;
    let value: serde_json::Value = serde_json::from_slice(&bytes).map_err(AppError::from)?;
    Ok(value)
}

#[tauri::command]
#[specta::specta]
pub async fn save_layout(
    state: tauri::State<'_, AppState>,
    name: String,
    contents: serde_json::Value,
) -> Result<LayoutEntry, AppError> {
    validate_layout(&contents)?;
    let safe = sanitize_layout_name(&name)?;
    let dir = state.layouts_dir.clone();
    tokio::fs::create_dir_all(&dir).await?;
    let path = layout_file_path(&dir, &safe)?;
    // Keep the stored `name` in lockstep with the file name — the file name is
    // the identity everywhere else (list, load, delete).
    let mut contents = contents;
    contents["name"] = serde_json::Value::String(safe.clone());
    let json = serde_json::to_string_pretty(&contents)?;
    tokio::fs::write(&path, json).await?;
    Ok(LayoutEntry {
        name: safe,
        path: path.to_string_lossy().to_string(),
    })
}

#[tauri::command]
#[specta::specta]
pub async fn rename_layout(
    state: tauri::State<'_, AppState>,
    old_name: String,
    new_name: String,
) -> Result<LayoutEntry, AppError> {
    let old_path = layout_file_path(&state.layouts_dir, &old_name)?;
    let new_path = layout_file_path(&state.layouts_dir, &new_name)?;
    if !old_path.exists() {
        return Err(AppError::InvalidLayout(format!("layout not found: {old_name}")));
    }
    if new_path.exists() {
        return Err(AppError::InvalidLayout(format!(
            "a layout named '{}' already exists",
            new_name.trim()
        )));
    }
    let bytes = tokio::fs::read(&old_path).await?;
    let mut value: serde_json::Value = serde_json::from_slice(&bytes).map_err(AppError::from)?;
    let safe = sanitize_layout_name(&new_name)?;
    value["name"] = serde_json::Value::String(safe.clone());
    let json = serde_json::to_string_pretty(&value)?;
    tokio::fs::write(&new_path, json).await?;
    tokio::fs::remove_file(&old_path).await?;
    Ok(LayoutEntry {
        name: safe,
        path: new_path.to_string_lossy().to_string(),
    })
}

#[tauri::command]
#[specta::specta]
pub async fn delete_layout(
    state: tauri::State<'_, AppState>,
    name: String,
) -> Result<(), AppError> {
    let path = layout_file_path(&state.layouts_dir, &name)?;
    if path.exists() {
        tokio::fs::remove_file(path).await?;
    }
    Ok(())
}

/// Structure check for a layout document. `global` and `repo` hold dockview
/// state the frontend owns; each may be null (a snapshot taken while that
/// dock had nothing to capture) but must otherwise be an object.
fn validate_layout(value: &serde_json::Value) -> Result<(), AppError> {
    let obj = value
        .as_object()
        .ok_or_else(|| AppError::InvalidLayout("layout must be a JSON object".into()))?;
    let format = obj
        .get("format")
        .and_then(|v| v.as_str())
        .ok_or_else(|| AppError::InvalidLayout("missing `format`".into()))?;
    if format != "legit-layout" {
        return Err(AppError::InvalidLayout(format!(
            "format must be 'legit-layout', got '{format}'"
        )));
    }
    obj.get("formatVersion")
        .and_then(|v| v.as_u64())
        .ok_or_else(|| AppError::InvalidLayout("missing or invalid `formatVersion`".into()))?;
    let name = obj
        .get("name")
        .and_then(|v| v.as_str())
        .ok_or_else(|| AppError::InvalidLayout("missing `name`".into()))?;
    if name.trim().is_empty() {
        return Err(AppError::InvalidLayout("`name` cannot be empty".into()));
    }
    for key in ["global", "repo"] {
        match obj.get(key) {
            None => return Err(AppError::InvalidLayout(format!("missing `{key}`"))),
            Some(v) if v.is_object() || v.is_null() => {}
            Some(_) => {
                return Err(AppError::InvalidLayout(format!(
                    "`{key}` must be an object or null"
                )))
            }
        }
    }
    if obj.get("global").is_some_and(|v| v.is_null())
        && obj.get("repo").is_some_and(|v| v.is_null())
    {
        return Err(AppError::InvalidLayout(
            "layout captures neither dock (`global` and `repo` are both null)".into(),
        ));
    }
    Ok(())
}

/// The on-disk path of one layout file. Every layout path in this module goes
/// through here so the frontend-supplied name is confined to `dir`.
fn layout_file_path(dir: &std::path::Path, name: &str) -> Result<PathBuf, AppError> {
    let safe = sanitize_layout_name(name)?;
    Ok(dir.join(format!("{safe}{LAYOUT_EXT}")))
}

fn sanitize_layout_name(name: &str) -> Result<String, AppError> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(AppError::InvalidLayout("layout name is empty".into()));
    }
    let bad: &[char] = &['/', '\\', '\0', ':', '*', '?', '"', '<', '>', '|'];
    if trimmed.chars().any(|c| bad.contains(&c) || c.is_control()) {
        return Err(AppError::InvalidLayout(format!(
            "layout name contains forbidden character(s): {trimmed:?}"
        )));
    }
    Ok(trimmed.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn good() -> serde_json::Value {
        json!({
            "format": "legit-layout",
            "formatVersion": 1,
            "name": "X",
            "global": { "grid": {}, "panels": {} },
            "repo": { "dockview": {}, "placements": {}, "fallbacks": {} }
        })
    }

    #[test]
    fn accepts_minimal_valid() {
        assert!(validate_layout(&good()).is_ok());
    }

    #[test]
    fn accepts_one_null_dock() {
        let mut v = good();
        v["global"] = json!(null);
        assert!(validate_layout(&v).is_ok());
    }

    #[test]
    fn rejects_both_docks_null() {
        let mut v = good();
        v["global"] = json!(null);
        v["repo"] = json!(null);
        assert!(validate_layout(&v).is_err());
    }

    #[test]
    fn rejects_bad_format() {
        let mut v = good();
        v["format"] = json!("legit-theme");
        assert!(validate_layout(&v).is_err());
    }

    #[test]
    fn rejects_missing_dock_key() {
        let mut v = good();
        v.as_object_mut().unwrap().remove("repo");
        assert!(validate_layout(&v).is_err());
    }

    #[test]
    fn rejects_non_object_dock() {
        let mut v = good();
        v["global"] = json!("layout");
        assert!(validate_layout(&v).is_err());
    }

    #[test]
    fn rejects_empty_name() {
        let mut v = good();
        v["name"] = json!("   ");
        assert!(validate_layout(&v).is_err());
    }

    // Every layout file path (load, save, rename, delete) is built by one
    // helper, so a name from the frontend can never leave the layouts
    // directory.
    #[test]
    fn layout_file_path_confines_names_to_the_directory() {
        let dir = std::path::Path::new("layouts-root");
        assert_eq!(
            layout_file_path(dir, "Reviewing").unwrap(),
            dir.join("Reviewing.legit-layout.json")
        );
        assert_eq!(
            layout_file_path(dir, "  Wide diff ").unwrap(),
            dir.join("Wide diff.legit-layout.json")
        );
        for bad in ["../x", "/etc/passwd", "C:\\x", "a/b", "a\\b", "", "   ", "a\0b"] {
            assert!(layout_file_path(dir, bad).is_err(), "expected rejection: {bad:?}");
        }
    }
}
