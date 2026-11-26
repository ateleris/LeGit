//! Local sync bookkeeping (`<app-data>/sync-state.json`): the theme manifest
//! from the last sync (deletion propagation needs it) and the last sync time.
//! Missing or corrupt state degrades to defaults, never to an error.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::AppError;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SyncStateFile {
    pub last_manifest: Vec<String>,
    pub last_sync: Option<String>,
    /// The sync checkout this bookkeeping belongs to. It says nothing about
    /// any other repository: a theme missing from a newly designated one
    /// was not deleted there.
    pub repo: Option<String>,
    /// `SYNC_SETTINGS_REVISION` at the last completed import. Until this
    /// instance has imported at its current revision, its values for
    /// settings it did not know before are defaults nobody chose.
    pub settings_revision: u32,
    /// The synced settings this machine and the repository agreed on at
    /// the last sync. A local value that differs from it is a change this
    /// machine has not sent yet (`import_keeping_unsent`).
    pub base: Option<serde_json::Value>,
    /// Content hash of each synced theme as of the last sync: a local file
    /// that differs was edited here since.
    pub theme_hashes: std::collections::BTreeMap<String, String>,
}

pub async fn read_state(path: &Path) -> SyncStateFile {
    match tokio::fs::read_to_string(path).await {
        Ok(text) => serde_json::from_str(&text).unwrap_or_default(),
        Err(_) => SyncStateFile::default(),
    }
}

pub async fn write_state(path: &Path, state: &SyncStateFile) -> Result<(), AppError> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let json = serde_json::to_string_pretty(state)?;
    crate::persist::write_atomic(path, json).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn missing_file_reads_as_default() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(read_state(&dir.path().join("sync-state.json")).await, SyncStateFile::default());
    }

    #[tokio::test]
    async fn corrupt_file_reads_as_default() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sync-state.json");
        tokio::fs::write(&path, "{not json").await.unwrap();
        assert_eq!(read_state(&path).await, SyncStateFile::default());
    }

    #[tokio::test]
    async fn roundtrip_keeps_manifest_and_timestamp() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("sync-state.json");
        let state = SyncStateFile {
            last_manifest: vec!["A".into(), "B".into()],
            last_sync: Some("2026-10-02T10:00:00Z".into()),
            repo: Some("/sync".into()),
            settings_revision: 3,
            base: Some(serde_json::json!({"a": 1})),
            theme_hashes: [("A".to_string(), "00".to_string())].into(),
        };
        write_state(&path, &state).await.unwrap();
        assert_eq!(read_state(&path).await, state);
    }
}
