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

/// Validate a user-facing file-stem name (theme / layout): trimmed, non-empty,
/// no path separators, Windows-forbidden or control characters, no Windows
/// reserved device name (CON, NUL, COM1, ... - reserved even with an
/// extension), and no trailing dot (Windows strips it on create, silently
/// colliding names). Err carries the reason, starting with "name ...".
pub fn sanitize_file_stem(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("name is empty".to_string());
    }
    const BAD: &[char] = &['/', '\\', '\0', ':', '*', '?', '"', '<', '>', '|'];
    if trimmed.chars().any(|c| BAD.contains(&c) || c.is_control()) {
        return Err(format!("name contains forbidden character(s): {trimmed:?}"));
    }
    if trimmed.ends_with('.') {
        return Err(format!("name must not end with a dot: {trimmed:?}"));
    }
    // Windows matches device names on the part before the first dot.
    let stem = trimmed.split('.').next().unwrap_or(trimmed);
    let upper = stem.to_ascii_uppercase();
    let reserved = matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ((upper.starts_with("COM") || upper.starts_with("LPT"))
            && upper.len() == 4
            && upper.as_bytes()[3].is_ascii_digit()
            && upper.as_bytes()[3] != b'0');
    if reserved {
        return Err(format!("name is a reserved Windows device name: {trimmed:?}"));
    }
    Ok(trimmed.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_stem_accepts_normal_names_trimmed() {
        assert_eq!(sanitize_file_stem("  My Theme "), Ok("My Theme".to_string()));
        assert_eq!(sanitize_file_stem("dark-2"), Ok("dark-2".to_string()));
    }

    #[test]
    fn file_stem_rejects_empty_and_forbidden_characters() {
        for bad in ["", "   ", "a/b", "a\\b", "a:b", "a*b", "a?b", "a\"b", "a<b", "a>b", "a|b", "a\0b"] {
            assert!(sanitize_file_stem(bad).is_err(), "accepted {bad:?}");
        }
    }

    #[test]
    fn file_stem_rejects_windows_reserved_device_names() {
        // Reserved with or without an extension-like suffix, any case:
        // "con.legit-theme.json" is still the CON device on Windows.
        for bad in ["CON", "con", "Nul", "AUX", "prn", "COM1", "lpt9", "con.backup"] {
            assert!(sanitize_file_stem(bad).is_err(), "accepted {bad:?}");
        }
        // Similar-but-not-reserved names stay fine.
        for ok in ["CONSOLE", "com10", "lpt0", "nulx"] {
            assert!(sanitize_file_stem(ok).is_ok(), "rejected {ok:?}");
        }
    }

    #[test]
    fn file_stem_rejects_trailing_dots() {
        // Windows strips trailing dots on create, silently colliding names.
        assert!(sanitize_file_stem("theme.").is_err());
        assert!(sanitize_file_stem("theme..").is_err());
        assert!(sanitize_file_stem("the.me").is_ok());
    }

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
