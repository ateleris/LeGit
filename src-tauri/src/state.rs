//! Application state — the multi-repo session map and persisted user
//! settings. Per DESIGN.md §4.1, sessions are keyed by a generated `RepoId`,
//! wrapped in `Arc`, and held under `RwLock` so the map lock is never held
//! across Git work.

use crate::error::AppError;
use legit_core::{GitBackend, GitCliBackend, GitRunner};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::SystemTime;
use tokio::sync::RwLock;
use uuid::Uuid;

pub type RepoId = String;

pub struct RepoSession {
    pub id: RepoId,
    pub path: PathBuf,
    pub runner: Arc<GitRunner>,
    pub backend: Arc<dyn GitBackend>,
    pub opened_at: SystemTime,
}

impl RepoSession {
    pub fn new(path: PathBuf, runner: Arc<GitRunner>) -> Self {
        let backend = Arc::new(GitCliBackend::new(runner.clone()));
        Self {
            id: Uuid::new_v4().to_string(),
            path,
            runner,
            backend,
            opened_at: SystemTime::now(),
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

#[derive(Debug, Clone, Serialize, Deserialize, Type, Default)]
pub struct AppSettings {
    /// User-specified override for the git binary path (DESIGN.md §7.6).
    pub git_path_override: Option<String>,
    /// Recent-repo history (deduplicated, newest first). Survives close.
    #[serde(default)]
    pub last_open_repos: Vec<String>,
    /// Repos that were open at last shutdown and should be re-opened on launch.
    #[serde(default)]
    pub currently_open: Vec<String>,
    /// Canonical path of the repo that was active at last shutdown.
    pub active_open_repo: Option<String>,
    /// Name of the active theme (key into the themes directory).
    pub active_theme: Option<String>,
    /// Serialized dockview layout (opaque JSON).
    pub dock_layout: Option<serde_json::Value>,
}

pub struct AppState {
    pub repos: RwLock<HashMap<RepoId, Arc<RepoSession>>>,
    pub settings: RwLock<AppSettings>,
    /// Resolved git binary path the runner uses *right now*.
    pub git_path: RwLock<PathBuf>,
    /// On-disk location for `settings.json`.
    pub settings_path: PathBuf,
    /// On-disk location for user themes.
    pub user_themes_dir: PathBuf,
    /// On-disk location for built-in themes (read-only).
    pub builtin_themes_dir: PathBuf,
}

impl AppState {
    pub fn new(
        git_path: PathBuf,
        settings: AppSettings,
        settings_path: PathBuf,
        user_themes_dir: PathBuf,
        builtin_themes_dir: PathBuf,
    ) -> Self {
        Self {
            repos: RwLock::new(HashMap::new()),
            settings: RwLock::new(settings),
            git_path: RwLock::new(git_path),
            settings_path,
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

    pub async fn persist_settings(&self) -> Result<(), AppError> {
        let settings = self.settings.read().await.clone();
        if let Some(parent) = self.settings_path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        let json = serde_json::to_string_pretty(&settings)?;
        tokio::fs::write(&self.settings_path, json).await?;
        Ok(())
    }
}
