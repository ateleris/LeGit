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
        };
        write_state(&path, &state).await.unwrap();
        assert_eq!(read_state(&path).await, state);
    }
}
