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
const ORDER_FILE: &str = "order.json";
const ORDER_VERSION: u32 = 1;

/// `layouts/order.json` - the user-controlled display order, which the
/// `app.applyLayoutN` shortcuts address by position.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct LayoutOrderFile {
    version: u32,
    #[serde(default)]
    order: Vec<String>,
}

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
    let entries = read_entries(dir).await?;
    let order = read_order(dir).await;
    Ok(order_entries(entries, &order))
}

/// Persist the user's layout order (drag-and-drop in the Layouts panel).
#[tauri::command]
#[specta::specta]
pub async fn set_layouts_order(
    state: tauri::State<'_, AppState>,
    order: Vec<String>,
) -> Result<(), AppError> {
    let clean: Vec<String> = order
        .iter()
        .filter_map(|n| sanitize_layout_name(n).ok())
        .collect();
    write_order(&state.layouts_dir, &clean).await
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
    // Order first: it is advisory, so a later failure can only leave a name
    // with no file, which `order_entries` ignores.
    let next = append_to_order(&ordered_names(&dir).await, &safe);
    write_order(&dir, &next).await?;
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
    let safe_old = sanitize_layout_name(&old_name)?;
    let dir = state.layouts_dir.clone();
    let next = rename_in_order(&ordered_names(&dir).await, &safe_old, &safe);
    write_order(&dir, &next).await?;
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
    let dir = state.layouts_dir.clone();
    let path = layout_file_path(&dir, &name)?;
    let safe = sanitize_layout_name(&name)?;
    let next = remove_from_order(&ordered_names(&dir).await, &safe);
    write_order(&dir, &next).await?;
    if path.exists() {
        tokio::fs::remove_file(path).await?;
    }
    Ok(())
}

/// The user's explicit order, persisted next to the layout files. Advisory:
/// a missing or unreadable file simply means "no explicit order", and names
/// in it that no longer have a file are ignored.
async fn read_order(dir: &std::path::Path) -> Vec<String> {
    let Ok(bytes) = tokio::fs::read(dir.join(ORDER_FILE)).await else {
        return Vec::new();
    };
    serde_json::from_slice::<LayoutOrderFile>(&bytes)
        .map(|f| f.order)
        .unwrap_or_default()
}

async fn write_order(dir: &std::path::Path, order: &[String]) -> Result<(), AppError> {
    tokio::fs::create_dir_all(dir).await?;
    let file = LayoutOrderFile {
        version: ORDER_VERSION,
        order: order.to_vec(),
    };
    tokio::fs::write(dir.join(ORDER_FILE), serde_json::to_string_pretty(&file)?).await?;
    Ok(())
}

/// Every layout file in `dir`, unordered.
async fn read_entries(dir: &std::path::Path) -> Result<Vec<LayoutEntry>, AppError> {
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
    Ok(entries)
}

/// Layout names in display order - what a mutation transforms and writes back.
async fn ordered_names(dir: &std::path::Path) -> Vec<String> {
    let entries = read_entries(dir).await.unwrap_or_default();
    let order = read_order(dir).await;
    order_entries(entries, &order)
        .into_iter()
        .map(|e| e.name)
        .collect()
}

/// Display order of the layouts: the user's explicit order first (names with
/// no file on disk are ignored), then any remaining files by name. The
/// `app.applyLayoutN` shortcuts address layouts by this position.
fn order_entries(mut entries: Vec<LayoutEntry>, order: &[String]) -> Vec<LayoutEntry> {
    entries.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    // Stable, so the alphabetical baseline survives for the unordered tail.
    entries.sort_by_key(|e| {
        order
            .iter()
            .position(|n| n == &e.name)
            .unwrap_or(usize::MAX)
    });
    entries
}

/// Replaces `old` with `new` in place so a renamed layout keeps its slot.
fn rename_in_order(order: &[String], old: &str, new: &str) -> Vec<String> {
    let mut next = order.to_vec();
    match next.iter().position(|n| n == old) {
        Some(i) => next[i] = new.to_string(),
        None => next.push(new.to_string()),
    }
    next
}

/// A new layout lands at the end; an override keeps its slot.
fn append_to_order(order: &[String], name: &str) -> Vec<String> {
    let mut next = order.to_vec();
    if !next.iter().any(|n| n == name) {
        next.push(name.to_string());
    }
    next
}

fn remove_from_order(order: &[String], name: &str) -> Vec<String> {
    order.iter().filter(|n| n.as_str() != name).cloned().collect()
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

    fn entry(name: &str) -> LayoutEntry {
        LayoutEntry {
            name: name.to_string(),
            path: format!("/layouts/{name}{LAYOUT_EXT}"),
        }
    }

    fn names(entries: &[LayoutEntry]) -> Vec<String> {
        entries.iter().map(|e| e.name.clone()).collect()
    }

    #[test]
    fn explicit_order_wins_and_unordered_files_follow_by_name() {
        let entries = vec![entry("Wide diff"), entry("Alpha"), entry("Reviewing")];
        let order = vec!["Reviewing".to_string(), "Wide diff".to_string()];
        assert_eq!(
            names(&order_entries(entries, &order)),
            ["Reviewing", "Wide diff", "Alpha"]
        );
    }

    #[test]
    fn without_an_order_file_the_list_is_alphabetical() {
        let entries = vec![entry("wide diff"), entry("Alpha")];
        assert_eq!(names(&order_entries(entries, &[])), ["Alpha", "wide diff"]);
    }

    #[test]
    fn order_names_without_a_file_are_ignored() {
        let entries = vec![entry("Alpha")];
        let order = vec!["Deleted elsewhere".to_string(), "Alpha".to_string()];
        assert_eq!(names(&order_entries(entries, &order)), ["Alpha"]);
    }

    // `app.applyLayoutN` applies the Nth layout in list order, so a rename
    // must never move a layout to a different slot.
    #[test]
    fn a_renamed_layout_keeps_its_slot() {
        let order = vec![
            "Reviewing".to_string(),
            "Wide diff".to_string(),
            "Zoomed".to_string(),
        ];
        assert_eq!(
            rename_in_order(&order, "Wide diff", "Aaa diff"),
            ["Reviewing", "Aaa diff", "Zoomed"]
        );
    }

    #[test]
    fn renaming_a_layout_that_has_no_slot_yet_appends_it() {
        let order = vec!["Reviewing".to_string()];
        assert_eq!(
            rename_in_order(&order, "Wide diff", "Aaa diff"),
            ["Reviewing", "Aaa diff"]
        );
    }

    #[test]
    fn a_new_layout_lands_at_the_end() {
        let order = vec!["Reviewing".to_string()];
        assert_eq!(append_to_order(&order, "Aaa"), ["Reviewing", "Aaa"]);
    }

    #[test]
    fn overriding_a_layout_keeps_its_slot() {
        let order = vec!["Reviewing".to_string(), "Wide diff".to_string()];
        assert_eq!(
            append_to_order(&order, "Reviewing"),
            ["Reviewing", "Wide diff"]
        );
    }

    #[test]
    fn a_deleted_layout_leaves_the_order() {
        let order = vec!["Reviewing".to_string(), "Wide diff".to_string()];
        assert_eq!(remove_from_order(&order, "Reviewing"), ["Wide diff"]);
    }

    #[tokio::test]
    async fn an_unordered_directory_reads_as_no_order() {
        let dir = tempfile::tempdir().unwrap();
        assert!(read_order(dir.path()).await.is_empty());
    }

    #[tokio::test]
    async fn the_order_survives_a_write_read_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let order = vec!["Wide diff".to_string(), "Reviewing".to_string()];
        write_order(dir.path(), &order).await.unwrap();
        assert_eq!(read_order(dir.path()).await, order);
    }

    // Advisory file: a corrupt one must not break listing the layouts.
    #[tokio::test]
    async fn an_unreadable_order_file_reads_as_no_order() {
        let dir = tempfile::tempdir().unwrap();
        tokio::fs::write(dir.path().join(ORDER_FILE), "{ not json").await.unwrap();
        assert!(read_order(dir.path()).await.is_empty());
    }

    #[tokio::test]
    async fn the_order_file_is_not_itself_a_layout() {
        let dir = tempfile::tempdir().unwrap();
        write_order(dir.path(), &["Reviewing".to_string()]).await.unwrap();
        tokio::fs::write(dir.path().join(format!("Reviewing{LAYOUT_EXT}")), "{}").await.unwrap();
        tokio::fs::write(dir.path().join("notes.txt"), "x").await.unwrap();
        assert_eq!(names(&read_entries(dir.path()).await.unwrap()), ["Reviewing"]);
    }

    #[tokio::test]
    async fn ordered_names_follow_the_order_file() {
        let dir = tempfile::tempdir().unwrap();
        for n in ["Alpha", "Reviewing", "Wide diff"] {
            tokio::fs::write(dir.path().join(format!("{n}{LAYOUT_EXT}")), "{}").await.unwrap();
        }
        write_order(dir.path(), &["Wide diff".to_string(), "Reviewing".to_string()])
            .await
            .unwrap();
        assert_eq!(ordered_names(dir.path()).await, ["Wide diff", "Reviewing", "Alpha"]);
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
