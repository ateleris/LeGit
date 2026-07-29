//! Application state — multi-repo session map and scoped settings.
//! v0.2: scope (global vs. repo) is a first-class concept here.
//! See DESIGN-v0.2.md §B and §D.

use crate::error::AppError;
use crate::watcher::RepoWatcher;
use legit_core::{
    GitBackend, GitCliBackend, GitRunner, OperationId, PullStrategy, SwitchDirtyBehavior,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use specta::Type;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
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

/// Absolute date format for the Commits panel's Date column (applies when
/// `commit_date_absolute` is on). Rendering lives in the frontend
/// (`src/lib/time.ts`); this only persists the choice.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, Default, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum CommitDateFormat {
    /// ISO 8601: 2026-07-20 14:30
    #[default]
    Iso,
    /// Swiss/German: 20.07.2026 14:30
    Swiss,
    /// UK/European: 20/07/2026 14:30
    Uk,
    /// US: 07/20/2026 2:30 PM
    Us,
}

/// Default minutes between background auto-fetches.
fn default_auto_fetch_interval() -> u32 {
    15
}

fn default_true() -> bool {
    true
}

/// Default line/row height for the Commits panel, in px.
pub fn default_commits_row_height() -> f64 {
    40.0
}

/// Default per-lane horizontal spacing for the Commits graph, in px.
pub fn default_commits_lane_width() -> f64 {
    40.0
}

/// Default commit-dot radius for the Commits graph, in px.
pub fn default_commits_dot_radius() -> f64 {
    5.0
}

/// Default stroke width for the Commits graph connector lines/arcs, in px.
pub fn default_commits_line_width() -> f64 {
    1.5
}

/// Default global UI font size (px) — the base all panels derive their text
/// sizes (and the panel min-size constraints) from.
pub fn default_ui_font_size() -> f64 {
    12.0
}

/// Minimum Commits-panel row height for a given UI font size. A ref chip is
/// `font * 1.3` (line-height) + 2px padding + 2px border tall; rows must be
/// 2px taller so chips on adjacent rows never touch. Mirrors the frontend
/// `minCommitsRowHeight`.
pub fn min_commits_row_height(ui_font_size: f64) -> f64 {
    ((ui_font_size * 1.3).ceil() + 6.0).max(16.0)
}

/// Largest commit-dot radius that fits a cell of the given row height and lane
/// width without overflowing vertically or overlapping the neighbouring lane.
pub fn max_commits_dot_radius(row_height: f64, lane_width: f64) -> f64 {
    row_height.min(lane_width) / 2.0
}

/// A named git-identity profile, defined once globally and selectable per repo.
/// Bundles identity + signing + auth-key config that is written to a repo's
/// LOCAL `.git/config` when applied. Definitions live in `GlobalSettings`; the
/// per-repo selection lives in `RepoSettings::git_profile_id`.
///
/// Fields are `Option<String>`: `Some` sets the key on apply, `None` unsets it
/// (a profile is a *complete* identity — see `commands/profiles.rs`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GitProfile {
    /// Stable opaque id (UUID v4); survives renames and field edits.
    pub id: String,
    /// Human label shown in the UI.
    pub name: String,
    pub user_name: Option<String>,
    pub user_email: Option<String>,
    pub gpg_format: Option<String>,
    pub signing_key: Option<String>,
    pub commit_gpgsign: Option<String>,
    pub allowed_signers_file: Option<String>,
    /// Path to the auth SSH private key; synthesized into `core.sshCommand`
    /// on apply and parsed back on read (see `commands/profiles.rs`).
    pub auth_ssh_key: Option<String>,
    /// HTTPS credential helper (e.g. `manager`, `store`, `osxkeychain`), written
    /// to local `credential.helper` on apply. LeGit stores no secrets — the
    /// helper holds them (see `commands/profiles.rs`).
    pub credential_helper: Option<String>,
}

/// Versioned on-disk envelope for the profile list (mirrors `LaneLocksDoc`).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GitProfilesDoc {
    pub format: String,
    pub format_version: u32,
    pub profiles: Vec<GitProfile>,
}

impl Default for GitProfilesDoc {
    fn default() -> Self {
        GitProfilesDoc {
            format: "legit-git-profiles".to_string(),
            format_version: 1,
            profiles: vec![],
        }
    }
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
    /// Whether the global region sits above (top) or to the left (left) of the
    /// repo region.
    pub global_region_placement: RegionPlacement,
    /// Divider size in px when in top mode; None = use default.
    pub global_region_size_top: Option<f64>,
    /// Divider size in px when in left mode; None = use default.
    pub global_region_size_left: Option<f64>,
    /// Whether the global dock is collapsed to zero height/width.
    pub global_dock_collapsed: bool,
    /// Attention-only line-ending chips on Working Changes rows; per-repo
    /// settings can override.
    #[serde(default = "default_true")]
    pub line_ending_chips_in_changes: bool,
    /// Warn before committing staged line-ending changes; per-repo override.
    #[serde(default = "default_true")]
    pub warn_on_line_ending_commit: bool,
    /// Serialized column preferences for the Commits panel (frontend-owned schema).
    #[serde(default)]
    pub column_preferences: serde_json::Value,
    /// Line/row height for the Commits panel rows, in px.
    #[serde(default = "default_commits_row_height")]
    pub commits_row_height: f64,
    /// Per-lane horizontal spacing for the Commits graph column, in px.
    #[serde(default = "default_commits_lane_width")]
    pub commits_lane_width: f64,
    /// Commit-dot radius for the Commits graph, in px.
    #[serde(default = "default_commits_dot_radius")]
    pub commits_dot_radius: f64,
    /// Stroke width for the Commits graph connector lines/arcs, in px.
    #[serde(default = "default_commits_line_width")]
    pub commits_line_width: f64,
    /// Remembered view mode for the Changed Files panel (`"tree"` | `"flat"`).
    /// `None` until the user first toggles it.
    #[serde(default)]
    pub changed_files_view_mode: Option<String>,
    /// Global UI font size (px). Base for every panel's text scale and for the
    /// panel min-size constraints.
    #[serde(default = "default_ui_font_size")]
    pub ui_font_size: f64,
    /// Whether the filesystem watcher auto-refreshes the UI on disk changes.
    /// When off, refresh falls back to window/panel focus only.
    #[serde(default = "default_true")]
    pub watcher_enabled: bool,
    /// Whether discarding changes asks for confirmation first. When off, discard
    /// actions run immediately.
    #[serde(default = "default_true")]
    pub confirm_discard: bool,
    /// Periodic background auto-fetch of the active repo's remotes. OFF by
    /// default (network access on a timer is opt-in). Fetch-only and quiet:
    /// never pulls/merges, never toasts.
    #[serde(default)]
    pub auto_fetch_enabled: bool,
    /// Minutes between background auto-fetches (UI enforces a minimum of 1).
    #[serde(default = "default_auto_fetch_interval")]
    pub auto_fetch_interval_minutes: u32,
    /// Command template for "open in external editor" (e.g. `code "$ROOT"`);
    /// `$ROOT` is the repo root, appended when absent. `None`/blank = no
    /// editor configured — the action opens the folder in the OS file manager.
    #[serde(default)]
    pub external_editor_command: Option<String>,
    /// How to handle uncommitted changes when switching branches. `None` = `TryDirectly`.
    pub switch_dirty_behavior: Option<SwitchDirtyBehavior>,
    /// Pull integration strategy for the sync toolbar. `None` = `Default`
    /// (the repo's `pull.rebase` config decides).
    #[serde(default)]
    pub pull_strategy: Option<PullStrategy>,
    /// Whether the Commits-toolbar Stash button includes untracked files.
    /// Persisted default picked via the button's caret menu (pull-strategy
    /// style); off = tracked changes only.
    #[serde(default)]
    pub stash_include_untracked: bool,
    /// `git push --recurse-submodules` guard mode. `None` = off (no flag).
    #[serde(default)]
    pub push_recurse_submodules: Option<legit_core::PushRecurseMode>,
    /// After LeGit-driven submodule updates, attach a detached submodule HEAD
    /// to a branch pointing at the same commit (configured branch first, else
    /// a unique local match). Opt-in; see
    /// design/2026-07-23-submodule-branch-attach.md.
    #[serde(default)]
    pub submodule_attach_branch: bool,
    /// Show author avatars (Gravatar) in the commit graph. OFF by default —
    /// enabling it sends hashed author emails to gravatar.com (privacy
    /// opt-in; see BACKLOG/settings copy).
    #[serde(default)]
    pub commit_avatars: bool,
    /// Syntax-highlight code in the diff viewer. Off by default: highlighting
    /// parses each hunk's sides on the UI thread, so it is opt-in.
    #[serde(default)]
    pub diff_syntax_highlighting: bool,
    /// Show the full author datetime in the Commits panel's Date column
    /// instead of the compact relative form (default off = relative).
    #[serde(default)]
    pub commit_date_absolute: bool,
    /// Which absolute format the Date column uses (when `commit_date_absolute`).
    #[serde(default)]
    pub commit_date_format: CommitDateFormat,
    /// Whether the absolute Date column includes the time of day (on by
    /// default; off shows the date only). Ignored while the column is relative.
    #[serde(default = "default_true")]
    pub commit_date_show_time: bool,
    /// Panel IDs the user has opted out of auto-opening: a `summon` to one of
    /// these degrades to `notifyIfOpen` (updates it only if already open, never
    /// pops it open). Empty = every panel auto-opens as before.
    #[serde(default)]
    pub suppressed_auto_open_panels: Vec<String>,
    /// Top-to-bottom order of the Working Changes panel's three sections
    /// ("unstaged", "staged", "commit"). Empty/partial is normalized on the UI
    /// side; default is unstaged → staged → commit.
    #[serde(default)]
    pub working_changes_section_order: Vec<String>,
    /// User-defined git identity profiles (versioned envelope).
    #[serde(default, rename = "gitProfiles")]
    pub git_profiles_doc: GitProfilesDoc,
    /// Platform accounts connected via PAT (`commands/accounts.rs`).
    /// METADATA ONLY: the token lives in the OS keychain under the broker's
    /// `https://<host>` key; settings files hold no secrets.
    #[serde(default)]
    pub connected_accounts: Vec<ConnectedAccountMeta>,
}

/// One connected platform account (see `commands/accounts.rs`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct ConnectedAccountMeta {
    /// Platform id: "github" | "gitlab" | "azure_devops".
    pub platform: String,
    /// Git HTTPS host, which is also the keychain key host (e.g. "github.com").
    pub host: String,
    /// Account username (doubles as the git basic-auth username).
    pub username: String,
    pub display_name: Option<String>,
}

impl Default for GlobalSettings {
    fn default() -> Self {
        Self {
            git_path_override: None,
            last_open_repos: vec![],
            currently_open: vec![],
            active_open_repo: None,
            active_theme: None,
            global_region_placement: RegionPlacement::Top,
            global_region_size_top: None,
            global_region_size_left: None,
            global_dock_collapsed: false,
            line_ending_chips_in_changes: true,
            warn_on_line_ending_commit: true,
            column_preferences: serde_json::Value::Null,
            commits_row_height: default_commits_row_height(),
            commits_lane_width: default_commits_lane_width(),
            commits_dot_radius: default_commits_dot_radius(),
            commits_line_width: default_commits_line_width(),
            changed_files_view_mode: None,
            ui_font_size: default_ui_font_size(),
            watcher_enabled: true,
            confirm_discard: true,
            auto_fetch_enabled: false,
            auto_fetch_interval_minutes: default_auto_fetch_interval(),
            external_editor_command: None,
            switch_dirty_behavior: None,
            pull_strategy: None,
            stash_include_untracked: false,
            push_recurse_submodules: None,
            submodule_attach_branch: false,
            commit_avatars: false,
            diff_syntax_highlighting: false,
            commit_date_absolute: false,
            commit_date_format: CommitDateFormat::Iso,
            commit_date_show_time: true,
            suppressed_auto_open_panels: vec![],
            working_changes_section_order: vec![],
            git_profiles_doc: GitProfilesDoc::default(),
            connected_accounts: vec![],
        }
    }
}

// ---------------------------------------------------------------------------
// Repo-scope settings  (DESIGN-v0.2.md §D.1)
// ---------------------------------------------------------------------------

/// A per-repo lane lock: pins a ref to a specific lane index.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LaneLock {
    pub ref_name: String,
    pub lane_index: u32,
}

/// Versioned on-disk envelope for lane locks (§I.2).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LaneLocksDoc {
    pub format: String,
    pub format_version: u32,
    pub locks: Vec<LaneLock>,
}

impl Default for LaneLocksDoc {
    fn default() -> Self {
        LaneLocksDoc {
            format: "legit-lane-locks".to_string(),
            format_version: 1,
            locks: vec![],
        }
    }
}

/// Settings that persist for a specific repo. On disk as
/// `<app-data>/repos/<hash>/settings.json`. Loaded into the `RepoSession`
/// when the repo is opened; persisted eagerly on each change.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Default)]
#[serde(default)]
pub struct RepoSettings {
    /// Per-repo override for the git binary path (None = inherit global).
    pub git_path_override: Option<String>,
    /// Per-repo override for the Working Changes line-ending chips
    /// (None = inherit global).
    pub line_ending_chips_in_changes: Option<bool>,
    /// Per-repo override for the commit line-ending warning
    /// (None = inherit global).
    pub warn_on_line_ending_commit: Option<bool>,
    /// Per-repo override for the external editor command template
    /// (None = inherit global; same `$ROOT` semantics).
    #[serde(default)]
    pub external_editor_command: Option<String>,
    /// Lane locks: pin specific refs to fixed lane indices (versioned envelope).
    #[serde(default, rename = "laneLocks")]
    pub lane_locks_doc: LaneLocksDoc,
    /// Selected git profile id (None = no profile selected / inherit global).
    /// A *hint* about intent, not the source of truth — the active profile is
    /// recomputed from live local config (see `commands/profiles.rs`).
    #[serde(default)]
    pub git_profile_id: Option<String>,
    /// Auto-update submodule pointers after switch/pull (None = default ON).
    #[serde(default)]
    pub submodule_auto_update: Option<bool>,
    /// Show remote-tracking branches in the commit tree (None = default ON).
    #[serde(default)]
    pub show_remote_branches: Option<bool>,
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
    /// Repo-scoped settings loaded on open; persisted eagerly on each change
    /// (close does not flush).
    pub settings: Arc<RwLock<RepoSettings>>,
    /// On-disk path for `repos/<hash>/settings.json`.
    pub settings_path: PathBuf,
    /// Serializes renormalize previews: they simulate on a fixed-path
    /// throwaway index (`GIT_INDEX_FILE`), so two concurrent previews would
    /// collide on git's `.lock` for that file.
    pub renormalize_preview_lock: tokio::sync::Mutex<()>,
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
            settings: Arc::new(RwLock::new(settings)),
            settings_path,
            renormalize_preview_lock: tokio::sync::Mutex::new(()),
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
    /// Live filesystem watchers, one per open repo (keyed by `RepoId`). Dropping
    /// an entry stops its watch thread. `std::sync::Mutex` (not async) so close
    /// and teardown stay trivial. See `crate::watcher`.
    pub watchers: Mutex<HashMap<RepoId, RepoWatcher>>,
    pub global_settings: Arc<RwLock<GlobalSettings>>,
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
    /// In-flight session-less git operations (currently `git clone`), keyed by
    /// `OperationId`, so a separate cancel command can reach the runner. Entries
    /// are inserted for the op's duration and removed when it finishes.
    pub transient_ops: Mutex<HashMap<OperationId, Arc<GitRunner>>>,
}

impl AppState {
    pub fn new(
        git_path: PathBuf,
        global_settings: GlobalSettings,
        global_settings_path: PathBuf,
        repos_data_dir: PathBuf,
        user_themes_dir: PathBuf,
        builtin_themes_dir: PathBuf,
    ) -> Self {
        Self {
            repos: RwLock::new(HashMap::new()),
            watchers: Mutex::new(HashMap::new()),
            global_settings: Arc::new(RwLock::new(global_settings)),
            git_path: RwLock::new(git_path),
            global_settings_path,
            repos_data_dir,
            user_themes_dir,
            builtin_themes_dir,
            transient_ops: Mutex::new(HashMap::new()),
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

    /// Apply `mutate` to the global settings under the write lock, then
    /// persist - the single mutate-then-persist path for every `set_*`
    /// command, so the ordering (and the persist itself) cannot be forgotten.
    pub async fn mutate_global(
        &self,
        mutate: impl FnOnce(&mut GlobalSettings),
    ) -> Result<(), AppError> {
        {
            let mut settings = self.global_settings.write().await;
            mutate(&mut settings);
        }
        self.persist_global_settings().await
    }

    /// Persist `session`'s current repo settings - the single call point for
    /// the `repo_data_paths` + `persist_repo_settings` pair, so the four
    /// arguments cannot drift apart between commands.
    pub async fn persist_session_settings(&self, session: &RepoSession) -> Result<(), AppError> {
        let settings = session.settings.read().await.clone();
        let (repo_dir, _) = self.repo_data_paths(&session.path);
        persist_repo_settings(&settings, &repo_dir, &session.settings_path, &session.path).await
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
