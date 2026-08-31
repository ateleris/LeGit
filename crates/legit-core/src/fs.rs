//! Host-filesystem access for repo-side files.
//!
//! `GitBackend` flows sometimes need the *repository host's* filesystem, not
//! git: op-state probe files (`MERGE_MSG`, `rebase-merge/*`), submodule gitdir
//! maintenance, worktree file reads. On a remote repo those files live on the
//! remote host, so every such access goes through `RepoFs` — never `std::fs` /
//! `tokio::fs` directly. `LocalFs` is the passthrough implementation; a remote
//! host provides its own backed by the agent protocol.
//!
//! `HostPath` exists so a remote path can never be handed to `std::fs` by
//! accident: it is an opaque absolute path *in the host's filesystem*,
//! treated textually ('/'-joined — git and Windows both accept forward
//! slashes), converted to a native `PathBuf` only inside `LocalFs`.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::{Path, PathBuf};
use thiserror::Error;

/// An absolute path in a host's filesystem (see module docs).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(transparent)]
pub struct HostPath(pub String);

impl HostPath {
    pub fn from_path(p: &Path) -> Self {
        Self(p.to_string_lossy().into_owned())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Textual join with '/'. `rel` must be relative; separators in `rel`
    /// are kept as given.
    pub fn join(&self, rel: &str) -> HostPath {
        if self.0.ends_with('/') || self.0.ends_with('\\') {
            HostPath(format!("{}{rel}", self.0))
        } else {
            HostPath(format!("{}/{rel}", self.0))
        }
    }

    /// Native path form — for `LocalFs` (and other app-machine-local uses)
    /// only; meaningless for a path on a remote host.
    pub fn as_local(&self) -> PathBuf {
        PathBuf::from(&self.0)
    }

    /// Textual parent (std `Path` semantics: '/' always separates; '\\' only
    /// on Windows builds — remote paths are always posix, so this is sound
    /// for local-native and remote-posix paths alike).
    pub fn parent(&self) -> Option<HostPath> {
        Path::new(&self.0).parent().map(HostPath::from_path)
    }

    pub fn file_name(&self) -> Option<String> {
        Path::new(&self.0)
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
    }
}

impl From<&Path> for HostPath {
    fn from(p: &Path) -> Self {
        Self::from_path(p)
    }
}

impl std::fmt::Display for HostPath {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

#[derive(Debug, Error)]
pub enum FsError {
    #[error("{path}: {message}")]
    Io { path: String, message: String },

    /// The path does not exist. Distinct from `Io` because callers branch on
    /// it (e.g. `resolve_repo_relative` canonicalizes the parent when the
    /// final component is a file being created).
    #[error("{path}: not found")]
    NotFound { path: String },

    #[error("{path}: file is {len} bytes, over the {cap} byte cap")]
    TooLarge { path: String, len: u64, cap: u64 },

    /// The host connection died mid-call (remote hosts only).
    #[error("host connection lost: {0}")]
    HostGone(String),
}

impl FsError {
    fn io(path: &HostPath, e: &std::io::Error) -> Self {
        if e.kind() == std::io::ErrorKind::NotFound {
            return FsError::NotFound {
                path: path.0.clone(),
            };
        }
        FsError::Io {
            path: path.0.clone(),
            message: e.to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FsStat {
    pub is_dir: bool,
    pub len: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FsDirEntry {
    pub name: String,
    pub is_dir: bool,
}

/// One entry of a batched `probe_many`: existence, kind, and (for regular
/// files up to the cap) contents, in a single answer. Unreadable or
/// over-cap files degrade to `Missing` — the batch is a best-effort probe
/// (mirrors `read(...).ok()` semantics), not a strict read.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum FsProbe {
    Missing,
    Dir,
    File(Vec<u8>),
}

impl FsProbe {
    pub fn exists(&self) -> bool {
        !matches!(self, FsProbe::Missing)
    }

    /// File contents as UTF-8, `None` for missing/dir/non-UTF-8 — the exact
    /// shape of `tokio::fs::read_to_string(...).ok()`.
    pub fn into_utf8(self) -> Option<String> {
        match self {
            FsProbe::File(bytes) => String::from_utf8(bytes).ok(),
            _ => None,
        }
    }
}

#[async_trait]
pub trait RepoFs: Send + Sync + 'static {
    /// `Ok(None)` = the path does not exist.
    async fn stat(&self, path: &HostPath) -> Result<Option<FsStat>, FsError>;

    /// Full contents; `cap` (bytes) rejects oversized files with `TooLarge`
    /// before transferring them.
    async fn read(&self, path: &HostPath, cap: Option<u64>) -> Result<Vec<u8>, FsError>;

    /// Batched existence+content probe: one round trip for N small files
    /// (the op-state poll). See `FsProbe` for per-entry semantics.
    async fn probe_many(
        &self,
        paths: &[HostPath],
        cap_each: u64,
    ) -> Result<Vec<FsProbe>, FsError>;

    async fn write(&self, path: &HostPath, bytes: &[u8]) -> Result<(), FsError>;

    async fn create_dir_all(&self, path: &HostPath) -> Result<(), FsError>;

    async fn remove_file(&self, path: &HostPath) -> Result<(), FsError>;

    async fn remove_dir_all(&self, path: &HostPath) -> Result<(), FsError>;

    async fn canonicalize(&self, path: &HostPath) -> Result<HostPath, FsError>;

    async fn read_dir(&self, path: &HostPath) -> Result<Vec<FsDirEntry>, FsError>;

    /// A fresh, not-yet-existing path under the host's temp directory.
    async fn temp_path(&self, prefix: &str) -> Result<HostPath, FsError>;
}

/// `tokio::fs` passthrough for repos on the app's own machine.
pub struct LocalFs;

fn stat_of(meta: &std::fs::Metadata) -> FsStat {
    FsStat {
        is_dir: meta.is_dir(),
        len: meta.len(),
    }
}

#[async_trait]
impl RepoFs for LocalFs {
    async fn stat(&self, path: &HostPath) -> Result<Option<FsStat>, FsError> {
        match tokio::fs::metadata(path.as_local()).await {
            Ok(meta) => Ok(Some(stat_of(&meta))),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(FsError::io(path, &e)),
        }
    }

    async fn read(&self, path: &HostPath, cap: Option<u64>) -> Result<Vec<u8>, FsError> {
        if let Some(cap) = cap {
            let meta = tokio::fs::metadata(path.as_local())
                .await
                .map_err(|e| FsError::io(path, &e))?;
            if meta.len() > cap {
                return Err(FsError::TooLarge {
                    path: path.0.clone(),
                    len: meta.len(),
                    cap,
                });
            }
        }
        tokio::fs::read(path.as_local())
            .await
            .map_err(|e| FsError::io(path, &e))
    }

    async fn probe_many(
        &self,
        paths: &[HostPath],
        cap_each: u64,
    ) -> Result<Vec<FsProbe>, FsError> {
        let mut out = Vec::with_capacity(paths.len());
        for path in paths {
            let probe = match tokio::fs::metadata(path.as_local()).await {
                Err(_) => FsProbe::Missing,
                Ok(meta) if meta.is_dir() => FsProbe::Dir,
                Ok(meta) if meta.len() > cap_each => FsProbe::Missing,
                Ok(_) => match tokio::fs::read(path.as_local()).await {
                    Ok(bytes) => FsProbe::File(bytes),
                    Err(_) => FsProbe::Missing,
                },
            };
            out.push(probe);
        }
        Ok(out)
    }

    async fn write(&self, path: &HostPath, bytes: &[u8]) -> Result<(), FsError> {
        tokio::fs::write(path.as_local(), bytes)
            .await
            .map_err(|e| FsError::io(path, &e))
    }

    async fn create_dir_all(&self, path: &HostPath) -> Result<(), FsError> {
        tokio::fs::create_dir_all(path.as_local())
            .await
            .map_err(|e| FsError::io(path, &e))
    }

    async fn remove_file(&self, path: &HostPath) -> Result<(), FsError> {
        tokio::fs::remove_file(path.as_local())
            .await
            .map_err(|e| FsError::io(path, &e))
    }

    async fn remove_dir_all(&self, path: &HostPath) -> Result<(), FsError> {
        tokio::fs::remove_dir_all(path.as_local())
            .await
            .map_err(|e| FsError::io(path, &e))
    }

    async fn canonicalize(&self, path: &HostPath) -> Result<HostPath, FsError> {
        let canon = tokio::fs::canonicalize(path.as_local())
            .await
            .map_err(|e| FsError::io(path, &e))?;
        Ok(HostPath::from_path(&canon))
    }

    async fn read_dir(&self, path: &HostPath) -> Result<Vec<FsDirEntry>, FsError> {
        let mut rd = tokio::fs::read_dir(path.as_local())
            .await
            .map_err(|e| FsError::io(path, &e))?;
        let mut out = Vec::new();
        while let Some(entry) = rd.next_entry().await.map_err(|e| FsError::io(path, &e))? {
            let is_dir = entry
                .file_type()
                .await
                .map(|t| t.is_dir())
                .unwrap_or(false);
            out.push(FsDirEntry {
                name: entry.file_name().to_string_lossy().into_owned(),
                is_dir,
            });
        }
        Ok(out)
    }

    async fn temp_path(&self, prefix: &str) -> Result<HostPath, FsError> {
        let p = std::env::temp_dir().join(format!("{prefix}{}", uuid::Uuid::new_v4()));
        Ok(HostPath::from_path(&p))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_path_join_inserts_single_slash() {
        assert_eq!(HostPath("/a/b".into()).join("c").0, "/a/b/c");
        assert_eq!(HostPath("/a/b/".into()).join("c").0, "/a/b/c");
        assert_eq!(HostPath("C:\\r\\".into()).join("x").0, "C:\\r\\x");
    }

    #[tokio::test]
    async fn probe_many_classifies_missing_dir_and_file() {
        let dir = std::env::temp_dir().join(format!("legit-fs-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("f"), b"hello").unwrap();
        std::fs::write(dir.join("big"), vec![b'x'; 32]).unwrap();

        let fs = LocalFs;
        let paths = [
            HostPath::from_path(&dir.join("absent")),
            HostPath::from_path(&dir.join("sub")),
            HostPath::from_path(&dir.join("f")),
            HostPath::from_path(&dir.join("big")),
        ];
        let probes = fs.probe_many(&paths, 16).await.unwrap();
        assert!(matches!(probes[0], FsProbe::Missing));
        assert!(matches!(probes[1], FsProbe::Dir));
        assert!(matches!(&probes[2], FsProbe::File(b) if b == b"hello"));
        // Over the per-entry cap degrades to Missing (best-effort probe).
        assert!(matches!(probes[3], FsProbe::Missing));

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn stat_distinguishes_absent_from_present() {
        let fs = LocalFs;
        let dir = std::env::temp_dir().join(format!("legit-fs-stat-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(fs
            .stat(&HostPath::from_path(&dir.join("nope")))
            .await
            .unwrap()
            .is_none());
        let st = fs.stat(&HostPath::from_path(&dir)).await.unwrap().unwrap();
        assert!(st.is_dir);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
