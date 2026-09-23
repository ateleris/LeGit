//! Crash-safe persistence for the app's own JSON files (settings, themes,
//! layouts, keybindings).

use std::path::{Path, PathBuf};

use serde::de::DeserializeOwned;

/// Replace `path` with `bytes` so a crash leaves either the old or the new
/// file, never a truncated one: write a sibling temp file, fsync, rename.
pub async fn write_atomic(path: &Path, bytes: impl AsRef<[u8]>) -> std::io::Result<()> {
    use tokio::io::AsyncWriteExt;

    let tmp = sibling(path, &format!(".tmp-{}", uuid::Uuid::new_v4().simple()));
    let result = async {
        let mut f = tokio::fs::File::create(&tmp).await?;
        f.write_all(bytes.as_ref()).await?;
        f.sync_all().await?;
        drop(f);
        tokio::fs::rename(&tmp, path).await
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(&tmp).await;
    }
    result
}

/// Load a JSON document, falling back to defaults when it is missing. A file
/// that fails to parse is renamed to `<name>.corrupt-<unix-ms>` first, so the
/// next save cannot overwrite the user's data with defaults.
pub fn load_json_or_default<T: DeserializeOwned + Default>(path: &Path) -> T {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(_) => return T::default(),
    };
    match serde_json::from_slice::<T>(&bytes) {
        Ok(v) => v,
        Err(e) => {
            let ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0);
            let aside = sibling(path, &format!(".corrupt-{ms}"));
            match std::fs::rename(path, &aside) {
                Ok(()) => tracing::warn!(
                    err = %e,
                    path = %path.display(),
                    kept_as = %aside.display(),
                    "settings file is malformed - moved aside, using defaults",
                ),
                Err(re) => tracing::error!(
                    err = %e,
                    rename_err = %re,
                    path = %path.display(),
                    "settings file is malformed and could not be moved aside - using defaults",
                ),
            }
            T::default()
        }
    }
}

fn sibling(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(suffix);
    path.with_file_name(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(serde::Deserialize, Default, Debug, PartialEq)]
    struct Doc {
        #[serde(default)]
        n: u32,
    }

    fn corrupt_siblings(dir: &Path) -> Vec<PathBuf> {
        std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().path())
            .filter(|p| p.file_name().unwrap().to_string_lossy().contains(".corrupt-"))
            .collect()
    }

    #[test]
    fn malformed_file_is_moved_aside_before_defaults_are_used() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, b"{ \"n\": 7, truncated").unwrap();

        let loaded: Doc = load_json_or_default(&path);

        assert_eq!(loaded, Doc::default());
        assert!(!path.exists(), "the malformed file must not stay where the next save overwrites it");
        let aside = corrupt_siblings(dir.path());
        assert_eq!(aside.len(), 1, "{aside:?}");
        assert_eq!(std::fs::read(&aside[0]).unwrap(), b"{ \"n\": 7, truncated");
    }

    #[test]
    fn missing_file_yields_defaults_without_side_files() {
        let dir = tempfile::tempdir().unwrap();
        let loaded: Doc = load_json_or_default(&dir.path().join("absent.json"));
        assert_eq!(loaded, Doc::default());
        assert!(corrupt_siblings(dir.path()).is_empty());
    }

    #[test]
    fn valid_file_loads() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, b"{\"n\": 3}").unwrap();
        assert_eq!(load_json_or_default::<Doc>(&path), Doc { n: 3 });
        assert!(path.exists());
    }

    #[tokio::test]
    async fn atomic_write_replaces_content_and_leaves_no_temp_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, b"old").unwrap();

        write_atomic(&path, b"new").await.unwrap();

        assert_eq!(std::fs::read(&path).unwrap(), b"new");
        let names: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["settings.json".to_string()]);
    }

    #[tokio::test]
    async fn atomic_write_into_a_missing_directory_fails_without_debris() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nope").join("settings.json");
        assert!(write_atomic(&path, b"x").await.is_err());
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }
}
