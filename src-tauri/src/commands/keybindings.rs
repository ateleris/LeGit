//! User keybindings: ONE active keymap, stored as a diff from the shipped
//! defaults at `<app_data>/keybindings.json` (not file-per-entry like themes
//! and layouts). Strict validation on load; an unparseable file is an error
//! the frontend reports and ignores - never a silent reset. Unknown command
//! ids are preserved verbatim so downgrade/upgrade cycles keep bindings.
//! See design/2026-08-24-keyboard-shortcuts-system.md.

use crate::error::AppError;
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashMap;
use std::path::Path;

pub const KEYBINDINGS_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct KeybindingsFile {
    pub version: u32,
    /// CommandId -> chords. `[]` = explicitly unbound; an absent id inherits
    /// the shipped default (the frontend owns that semantics).
    pub bindings: HashMap<String, Vec<String>>,
}

impl Default for KeybindingsFile {
    fn default() -> Self {
        Self { version: KEYBINDINGS_VERSION, bindings: HashMap::new() }
    }
}

pub fn validate_keybindings(file: &KeybindingsFile) -> Result<(), AppError> {
    if file.version > KEYBINDINGS_VERSION {
        return Err(AppError::Settings(format!(
            "keybindings.json was written by a newer LeGit (version {}, this build reads {})",
            file.version, KEYBINDINGS_VERSION
        )));
    }
    for (id, chords) in &file.bindings {
        if id.trim().is_empty() {
            return Err(AppError::Settings("keybindings.json: empty command id".into()));
        }
        for chord in chords {
            if chord.trim().is_empty() {
                return Err(AppError::Settings(format!(
                    "keybindings.json: empty chord for command \"{id}\""
                )));
            }
        }
    }
    Ok(())
}

pub async fn read_keybindings_file(path: &Path) -> Result<KeybindingsFile, AppError> {
    if !path.exists() {
        return Ok(KeybindingsFile::default());
    }
    let bytes = tokio::fs::read(path).await?;
    let file: KeybindingsFile = serde_json::from_slice(&bytes).map_err(|e| {
        AppError::Settings(format!("keybindings.json is not valid JSON: {e}"))
    })?;
    validate_keybindings(&file)?;
    Ok(file)
}

pub async fn write_keybindings_file(path: &Path, file: &KeybindingsFile) -> Result<(), AppError> {
    validate_keybindings(file)?;
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let json = serde_json::to_string_pretty(file)?;
    crate::persist::write_atomic(path, json).await?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn load_keybindings(
    state: tauri::State<'_, AppState>,
) -> Result<KeybindingsFile, AppError> {
    read_keybindings_file(&state.keybindings_path).await
}

#[tauri::command]
#[specta::specta]
pub async fn save_keybindings(
    state: tauri::State<'_, AppState>,
    file: KeybindingsFile,
) -> Result<(), AppError> {
    write_keybindings_file(&state.keybindings_path, &file).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(bindings: &[(&str, &[&str])]) -> KeybindingsFile {
        KeybindingsFile {
            version: KEYBINDINGS_VERSION,
            bindings: bindings
                .iter()
                .map(|(id, chords)| {
                    (id.to_string(), chords.iter().map(|c| c.to_string()).collect())
                })
                .collect(),
        }
    }

    #[test]
    fn accepts_bindings_and_explicit_unbinds() {
        let f = file(&[("repo.fetch", &["Mod+Shift+F", "F6"]), ("repo.pull", &[])]);
        assert!(validate_keybindings(&f).is_ok());
        assert!(validate_keybindings(&KeybindingsFile::default()).is_ok());
    }

    #[test]
    fn rejects_blank_ids_and_blank_chords() {
        assert!(validate_keybindings(&file(&[("", &["F6"])])).is_err());
        assert!(validate_keybindings(&file(&[("  ", &["F6"])])).is_err());
        assert!(validate_keybindings(&file(&[("repo.fetch", &[""])])).is_err());
        assert!(validate_keybindings(&file(&[("repo.fetch", &["  "])])).is_err());
    }

    #[test]
    fn rejects_a_newer_file_version() {
        let mut f = file(&[]);
        f.version = KEYBINDINGS_VERSION + 1;
        assert!(validate_keybindings(&f).is_err());
    }

    #[tokio::test]
    async fn missing_file_loads_as_empty_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let loaded = read_keybindings_file(&dir.path().join("keybindings.json"))
            .await
            .unwrap();
        assert_eq!(loaded.version, KEYBINDINGS_VERSION);
        assert!(loaded.bindings.is_empty());
    }

    #[tokio::test]
    async fn round_trips_and_preserves_unknown_ids() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("keybindings.json");
        let f = file(&[("future.command", &["F9"]), ("repo.fetch", &[])]);
        write_keybindings_file(&path, &f).await.unwrap();
        let loaded = read_keybindings_file(&path).await.unwrap();
        assert_eq!(loaded.bindings["future.command"], vec!["F9"]);
        assert_eq!(loaded.bindings["repo.fetch"], Vec::<String>::new());
    }

    #[tokio::test]
    async fn unparseable_file_is_an_error_not_a_reset() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("keybindings.json");
        tokio::fs::write(&path, b"{ not json").await.unwrap();
        assert!(read_keybindings_file(&path).await.is_err());
        // The broken file must survive the failed load untouched.
        assert_eq!(tokio::fs::read(&path).await.unwrap(), b"{ not json");
    }
}
