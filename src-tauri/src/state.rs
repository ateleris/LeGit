//! Application state — multi-repo session map and scoped settings.
//! v0.2: scope (global vs. repo) is a first-class concept here.
//! See DESIGN-v0.2.md §B and §D.

use crate::error::AppError;
use legit_core::{GitBackend, GitCliBackend, GitRunner};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use specta::Type;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::SystemTime;
use tokio::sync::RwLock;
use uuid::Uuid;

pub type RepoId = String;

// ---------------------------------------------------------------------------
// Repo identity hashing  (DESIGN-v0.2.md §B.5)
// ---------------------------------------------------------------------------

/// Compute the 16-hex-char directory name for a repo's app-data entry.
///
/// SHA-256 of the canonicalized absolute path (lowercased on case-insensitive
/// filesystems), first 8 bytes as 16 lowercase hex chars. Short enough to be
/// readable; collision-safe for any realistic number of repos.
pub fn repo_hash(canonical_path: &Path) -> String {
    let path_str = {
        let s = canonical_path.to_string_lossy();
        if cfg!(any(target_os = "windows", target_os = "macos")) {
            s.to_lowercase()
        } else {
            s.into_owned()
        }
    };
    let mut h = Sha256::new();
    h.update(path_str.as_bytes());
    let b = h.finalize();
    format!(
        "{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]
    )
}

// ---------------------------------------------------------------------------
// Global-scope settings  (DESIGN-v0.2.md §D.2)
// ---------------------------------------------------------------------------

/// UI region placement mode. See DESIGN-v0.2.md §C.2.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Default, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum RegionPlacement {
    #[default]
    Top,
    Left,
}

fn default_warn_on_mixed_endings() -> bool {
    true
}

/// User-level settings shared across all repos. On disk as
/// `<app-data>/global-settings.json`. See DESIGN-v0.2.md §G.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(default)]
pub struct GlobalSettings {
    /// Global default git binary path override (None = auto-detect).
    pub git_path_override: Option<String>,
    /// Recent-repo history (deduplicated, newest first). Survives close.
    #[serde(default)]
    pub last_open_repos: Vec<String>,
    /// Repos that were open at last shutdown; re-opened on launch.
    #[serde(default)]
    pub currently_open: Vec<String>,
    /// Canonical path of the repo active at last shutdown.
    pub active_open_repo: Option<String>,
    /// Name of the active theme.
    pub active_theme: Option<String>,
    /// Serialized dockview layout for the global region (Repositories, Theme
    /// Editor, Global Settings).
    pub global_dock_layout: Option<serde_json::Value>,
    /// Serialized dockview layout for the repo region (Console, Repo Settings).
    pub repo_dock_layout: Option<serde_json::Value>,
    /// Whether the global region sits above (top) or to the left (left) of the
    /// repo region.
    pub global_region_placement: RegionPlacement,
    /// Divider size in px when in top mode; None = use default.
    pub global_region_size_top: Option<f64>,
    /// Divider size in px when in left mode; None = use default.
    pub global_region_size_left: Option<f64>,
    /// Whether the global dock is collapsed to zero height/width.
    pub global_dock_collapsed: bool,
    /// Default for mixed-ending detection; per-repo settings can override.
    #[serde(default = "default_warn_on_mixed_endings")]
    pub warn_on_mixed_endings: bool,
}

impl Default for GlobalSettings {
    fn default() -> Self {
        Self {
            git_path_override: None,
            last_open_repos: vec![],
            currently_open: vec![],
            active_open_repo: None,
            active_theme: None,
            global_dock_layout: None,
            repo_dock_layout: None,
            global_region_placement: RegionPlacement::Top,
            global_region_size_top: None,
            global_region_size_left: None,
            global_dock_collapsed: false,
            warn_on_mixed_endings: true,
        }
    }
}

// ---------------------------------------------------------------------------
// Repo-scope settings  (DESIGN-v0.2.md §D.1)
// ---------------------------------------------------------------------------

/// Settings that persist for a specific repo. On disk as
/// `<app-data>/repos/<hash>/settings.json`. Loaded into the `RepoSession`
/// when the repo is opened; dropped on close.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Default)]
#[serde(default)]
pub struct RepoSettings {
    /// Per-repo override for the git binary path (None = inherit global).
    pub git_path_override: Option<String>,
    /// Per-repo override for mixed-ending detection (None = inherit global).
    pub warn_on_mixed_endings: Option<bool>,
}

// ---------------------------------------------------------------------------
// System info (read-only at startup)
// ---------------------------------------------------------------------------

/// Host-system information determined once at startup. Not persisted.
#[derive(Debug, Clone)]
pub struct SystemInfo {
    /// The git binary that would be used absent any user overrides.
    pub system_git_path: PathBuf,
}

// ---------------------------------------------------------------------------
// Repo session
// ---------------------------------------------------------------------------

pub struct RepoSession {
    pub id: RepoId,
    pub path: PathBuf,
    /// The active runner. Wrapped in an `Arc<RwLock<…>>` so the same lock is
    /// shared with `GitCliBackend`. Swapping the inner `Arc<GitRunner>` (e.g.
    /// on per-repo git-path override) is visible to both the session and the
    /// backend without rebuilding either (DESIGN-v0.3.md §C.5/F.3).
    pub runner: Arc<RwLock<Arc<GitRunner>>>,
    pub backend: Arc<dyn GitBackend>,
    pub opened_at: SystemTime,
    /// Repo-scoped settings loaded on open; flushed on close.
    pub settings: Arc<RwLock<RepoSettings>>,
    /// On-disk path for `repos/<hash>/settings.json`.
    pub settings_path: PathBuf,
}

impl RepoSession {
    pub fn new(
        path: PathBuf,
        runner: Arc<GitRunner>,
        settings: RepoSettings,
        settings_path: PathBuf,
    ) -> Self {
        let runner_lock = Arc::new(RwLock::new(runner));
        let backend = Arc::new(GitCliBackend::new(runner_lock.clone()));
        Self {
            id: Uuid::new_v4().to_string(),
            path,
            runner: runner_lock,
            backend,
            opened_at: SystemTime::now(),
            settings: Arc::new(RwLock::new(settings)),
            settings_path,
        }
    }

    pub fn summary(&self) -> RepoSummary {
        RepoSummary {
            id: self.id.clone(),
            path: self.path.to_string_lossy().to_string(),
            name: self
                .path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("repo")
                .to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct RepoSummary {
    pub id: RepoId,
    pub path: String,
    pub name: String,
}

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------

pub struct AppState {
    pub repos: RwLock<HashMap<RepoId, Arc<RepoSession>>>,
    pub global_settings: Arc<RwLock<GlobalSettings>>,
    pub system_info: Arc<SystemInfo>,
    /// Resolved git binary path the runner uses *right now*.
    pub git_path: RwLock<PathBuf>,
    /// On-disk path for `global-settings.json`.
    pub global_settings_path: PathBuf,
    /// On-disk root for per-repo data: `repos/<hash>/`.
    pub repos_data_dir: PathBuf,
    /// On-disk location for user themes.
    pub user_themes_dir: PathBuf,
    /// On-disk location for built-in themes (read-only).
    pub builtin_themes_dir: PathBuf,
}

impl AppState {
    pub fn new(
        git_path: PathBuf,
        global_settings: GlobalSettings,
        global_settings_path: PathBuf,
        repos_data_dir: PathBuf,
        user_themes_dir: PathBuf,
        builtin_themes_dir: PathBuf,
        system_info: SystemInfo,
    ) -> Self {
        Self {
            repos: RwLock::new(HashMap::new()),
            global_settings: Arc::new(RwLock::new(global_settings)),
            system_info: Arc::new(system_info),
            git_path: RwLock::new(git_path),
            global_settings_path,
            repos_data_dir,
            user_themes_dir,
            builtin_themes_dir,
        }
    }

    pub async fn get_session(&self, repo_id: &str) -> Result<Arc<RepoSession>, AppError> {
        self.repos
            .read()
            .await
            .get(repo_id)
            .cloned()
            .ok_or_else(|| AppError::UnknownRepo(repo_id.to_string()))
    }

    pub async fn persist_global_settings(&self) -> Result<(), AppError> {
        let settings = self.global_settings.read().await.clone();
        if let Some(parent) = self.global_settings_path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        let json = serde_json::to_string_pretty(&settings)?;
        tokio::fs::write(&self.global_settings_path, json).await?;
        Ok(())
    }

    /// Resolve the `repos/<hash>/` directory for `canonical_path` and return
    /// `(repo_dir, settings_path)`. Creates the directory and writes
    /// `path.txt` lazily when `write = true`.
    pub fn repo_data_paths(&self, canonical_path: &Path) -> (PathBuf, PathBuf) {
        let hash = repo_hash(canonical_path);
        let repo_dir = self.repos_data_dir.join(&hash);
        let settings_path = repo_dir.join("settings.json");
        (repo_dir, settings_path)
    }
}

// ---------------------------------------------------------------------------
// Repo settings I/O helpers (sync, for use at open time)
// ---------------------------------------------------------------------------

/// Load `RepoSettings` from disk, or return defaults if missing/malformed.
pub fn load_repo_settings_sync(settings_path: &Path) -> RepoSettings {
    match std::fs::read(settings_path) {
        Ok(bytes) => match serde_json::from_slice::<RepoSettings>(&bytes) {
            Ok(s) => s,
            Err(e) => {
                tracing::warn!(
                    err = %e,
                    path = %settings_path.display(),
                    "repo settings.json is malformed — using defaults",
                );
                RepoSettings::default()
            }
        },
        Err(_) => RepoSettings::default(),
    }
}

/// Write `RepoSettings` to disk. Creates the repo data directory and
/// `path.txt` lazily on the first write.
pub async fn persist_repo_settings(
    settings: &RepoSettings,
    repo_dir: &Path,
    settings_path: &Path,
    canonical_path: &Path,
) -> Result<(), AppError> {
    tokio::fs::create_dir_all(repo_dir).await?;
    // Write path.txt so the directory is human-inspectable.
    let path_txt = repo_dir.join("path.txt");
    if !path_txt.exists() {
        tokio::fs::write(&path_txt, canonical_path.to_string_lossy().as_bytes()).await?;
    }
    let json = serde_json::to_string_pretty(settings)?;
    tokio::fs::write(settings_path, json).await?;
    Ok(())
}
