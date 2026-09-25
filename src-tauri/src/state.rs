//! Application state — multi-repo session map and scoped settings.
//! v0.2: scope (global vs. repo) is a first-class concept here.
//! See DESIGN-v0.2.md §B and §D.

use crate::error::AppError;
use crate::remote::{HostRef, RepoLocator};
use legit_host::{Host, HostId, LocalHost, WatchHandle};
use legit_core::{
    GitBackend, GitCliBackend, GitExecutor, OperationId, PullStrategy, SwitchDirtyBehavior,
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
/// SHA-256 of the persisted locator (for a local repo: the canonicalized
/// absolute path, lowercased on case-insensitive filesystems), first 8 bytes
/// as 16 lowercase hex chars. Short enough to be readable; collision-safe for
/// any realistic number of repos. Local repos hash byte-identically to what
/// older versions wrote (case-folding keyed on the APP OS, matching the
/// historical behavior), so existing `repos/<hash>/` dirs keep resolving.
/// Remote paths hash case-SENSITIVELY — their filesystems are, and the app
/// OS's case rules must not corrupt their identity.
pub fn repo_hash_locator(locator: &RepoLocator) -> String {
    let input = match locator {
        RepoLocator::Local { path } => {
            let s = path.to_string_lossy();
            if cfg!(any(target_os = "windows", target_os = "macos")) {
                s.to_lowercase()
            } else {
                s.into_owned()
            }
        }
        remote => remote.to_persist_string(),
    };
    hash16(&input)
}

fn hash16(input: &str) -> String {
    let mut h = Sha256::new();
    h.update(input.as_bytes());
    let b = h.finalize();
    format!(
        "{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]
    )
}

/// The repos/<hash> names a PRE-LOCATOR version computed for a WSL repo
/// opened through its Explorer share: git reported the toplevel as
/// `//wsl.localhost/<distro>/<path>` (or the legacy `//wsl$/...`), which
/// `repo_hash` case-folded like any Windows-local path.
fn legacy_wsl_repo_hashes(distro: &str, posix_path: &str) -> [String; 2] {
    ["wsl.localhost", "wsl$"]
        .map(|server| hash16(&format!("//{server}/{distro}{posix_path}").to_lowercase()))
}

/// One-time repo-identity migration: a WSL repo that older versions keyed by
/// its UNC toplevel re-keys as `wsl://...` — rename its existing
/// repos/<hash>/ directory so per-repo settings survive, and refresh
/// `path.txt` to the persisted locator. No-op when the locator-keyed
/// directory already exists (live settings are never clobbered) or no legacy
/// directory is found. Best-effort: a failed rename only costs the old
/// settings, never the open.
pub fn migrate_legacy_wsl_repo_dir(repos_data_dir: &Path, locator: &RepoLocator) {
    let RepoLocator::Wsl { distro, path } = locator else {
        return;
    };
    let new_dir = repos_data_dir.join(repo_hash_locator(locator));
    if new_dir.exists() {
        return;
    }
    for hash in legacy_wsl_repo_hashes(distro, path.as_str()) {
        let old_dir = repos_data_dir.join(&hash);
        if !old_dir.is_dir() {
            continue;
        }
        match std::fs::rename(&old_dir, &new_dir) {
            Ok(()) => {
                let _ = std::fs::write(new_dir.join("path.txt"), locator.to_persist_string());
                tracing::info!(
                    from = %old_dir.display(),
                    to = %new_dir.display(),
                    "migrated legacy UNC-keyed WSL repo data dir"
                );
            }
            Err(e) => {
                tracing::warn!(
                    err = %e,
                    from = %old_dir.display(),
                    "legacy WSL repo data dir migration failed"
                );
            }
        }
        return;
    }
}

// ---------------------------------------------------------------------------
// Global-scope settings  (DESIGN-v0.2.md §D.2)
// ---------------------------------------------------------------------------

/// Logical (DPI-independent) window size.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct WindowSize {
    pub width: f64,
    pub height: f64,
}

/// UI region placement mode. See DESIGN-v0.2.md §C.2.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Default, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum RegionPlacement {
    Top,
    #[default]
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
    22.0
}

/// Default per-lane horizontal spacing for the Commits graph, in px.
pub fn default_commits_lane_width() -> f64 {
    22.0
}

/// Default commit-dot radius for the Commits graph, in px.
pub fn default_commits_dot_radius() -> f64 {
    8.0
}

/// Default stroke width for the Commits graph connector lines/arcs, in px.
pub fn default_commits_line_width() -> f64 {
    2.0
}

/// Default global UI font size (px) — the base all panels derive their text
/// sizes (and the panel min-size constraints) from.
pub fn default_ui_font_size() -> f64 {
    12.0
}

/// Default panel-group border thickness (px): the classic hairline.
pub fn default_panel_border_width() -> f64 {
    1.0
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
    /// Parent directory of the most recent successful clone. Prefills the
    /// clone (and init) dialog's folder field - most users keep one source
    /// directory where all their repositories live. None = never cloned.
    #[serde(default)]
    pub last_clone_parent_dir: Option<String>,
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
    /// Branches section list style (`"tree"` | `"flat"`). `None`/unknown =
    /// flat. Toggled from the Branches section header, applies globally.
    #[serde(default)]
    pub branch_list_view: Option<String>,
    /// Sort order for branches in the Refs panel
    /// (`"alphabetical"` | `"date"` | `"date_reversed"`). `None` = alphabetical.
    /// Tags inherit this unless `tags_sort_mode` is set.
    #[serde(default)]
    pub refs_sort_mode: Option<String>,
    /// Sort order for the Tags section. `None` = inherit `refs_sort_mode`.
    #[serde(default)]
    pub tags_sort_mode: Option<String>,
    /// Global UI font size (px). Base for every panel's text scale and for the
    /// panel min-size constraints.
    #[serde(default = "default_ui_font_size")]
    pub ui_font_size: f64,
    /// Gap between dockview panel groups (px); 0 = the compact flush look.
    #[serde(default)]
    pub panel_gap: f64,
    /// Corner radius of dockview panel groups (px); 0 = square.
    #[serde(default)]
    pub panel_corner_radius: f64,
    /// Border thickness of dockview panel groups (px) while the spaced/rounded
    /// chrome is armed; 1 = the classic hairline. Any non-default value arms
    /// the chrome even at 0 gap/radius.
    #[serde(default = "default_panel_border_width")]
    pub panel_border_width: f64,
    /// Colour branch chips in the Commits graph from their row's lane instead
    /// of the theme's static ref tokens (the theme contributes the per-part
    /// filters via `laneChipFilters`).
    #[serde(default)]
    pub lane_colored_branch_chips: bool,
    /// Colour a stash node with the lane of its BASE commit instead of the
    /// lane the stash row occupies.
    #[serde(default)]
    pub stash_base_lane_color: bool,
    /// Whether the filesystem watcher auto-refreshes the UI on disk changes.
    /// When off, refresh falls back to window/panel focus only.
    #[serde(default = "default_true")]
    pub watcher_enabled: bool,
    /// Whether discarding changes asks for confirmation first. When off, discard
    /// actions run immediately.
    #[serde(default = "default_true")]
    pub confirm_discard: bool,
    /// Detect case-only renames git status cannot see (tracked path vs
    /// on-disk case on case-insensitive filesystems) and offer to stage
    /// them. When off, the scan never runs.
    #[serde(default = "default_true")]
    pub detect_case_renames: bool,
    /// Whether creating a branch also checks it out (default true). Applies
    /// to the Commits panel's inline create and the Branches section's form;
    /// "branch from stash" always checks out (`git stash branch` semantics).
    #[serde(default = "default_true")]
    pub checkout_new_branch: bool,
    /// Periodic background auto-fetch of the active repo's remotes. OFF by
    /// default (network access on a timer is opt-in). Fetch-only and quiet:
    /// never pulls/merges, never toasts.
    #[serde(default)]
    pub auto_fetch_enabled: bool,
    /// Minutes between background auto-fetches (UI enforces a minimum of 1).
    #[serde(default = "default_auto_fetch_interval")]
    pub auto_fetch_interval_minutes: u32,
    /// Check for app updates once at startup (quiet: only an update-available
    /// toast; never downloads without consent). ON by default - check-only.
    #[serde(default = "default_true")]
    pub check_updates_on_startup: bool,
    /// Command template for "open in external editor" (e.g. `code "$ROOT"`);
    /// `$ROOT` is the repo root, appended when absent. `None`/blank = no
    /// editor configured — the action opens the folder in the OS file manager.
    #[serde(default)]
    pub external_editor_command: Option<String>,
    /// How to handle uncommitted changes when switching branches. `None` = `TryDirectly`.
    pub switch_dirty_behavior: Option<SwitchDirtyBehavior>,
    /// Checking out a remote branch also fast-forwards the local branch to
    /// the remote tip (a LOCAL `merge --ff-only`, never a network pull).
    /// Default ON - landing on a stale local branch after double-clicking a
    /// remote chip is the confusing behavior this setting exists to fix; off
    /// = plain checkout like other git clients.
    #[serde(default = "default_true")]
    pub checkout_remote_fast_forward: bool,
    /// Pull integration strategy for the sync toolbar. `None` = `Default`
    /// (the repo's `pull.rebase` config decides).
    #[serde(default)]
    pub pull_strategy: Option<PullStrategy>,
    /// Whether the Commits-toolbar Stash button includes untracked files.
    /// Persisted default picked via the button's caret menu (pull-strategy
    /// style); off = tracked changes only.
    #[serde(default)]
    pub stash_include_untracked: bool,
    /// Open file-history summons in a separate OS window (history + diff)
    /// instead of the docked panel.
    #[serde(default)]
    pub file_history_opens_window: bool,
    /// Last-used history-window size; new history windows reuse it.
    /// Written by the window-close handler, never by a settings patch.
    #[serde(default)]
    pub file_history_window_size: Option<WindowSize>,
    /// `git push --recurse-submodules` guard mode. `None` = off (no flag).
    #[serde(default)]
    pub push_recurse_submodules: Option<legit_core::PushRecurseMode>,
    /// Auto-push tags with their commit (default OFF - tag pushes commonly
    /// trigger CI release pipelines, so this is a deliberate opt-in): a push
    /// also pushes the tags whose target commit became public through it, and
    /// a tag created on an already-public commit is pushed immediately.
    /// Repo-overridable (`RepoSettings::auto_push_tags`).
    #[serde(default)]
    pub auto_push_tags: bool,
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
    /// Show author initials in the commit graph dots (default off). Purely
    /// local. With `commit_avatars` also on, initials show only for authors
    /// without a Gravatar.
    #[serde(default)]
    pub commit_initials: bool,
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
            last_clone_parent_dir: None,
            active_open_repo: None,
            active_theme: None,
            global_region_placement: RegionPlacement::Left,
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
            branch_list_view: None,
            refs_sort_mode: None,
            tags_sort_mode: None,
            ui_font_size: default_ui_font_size(),
            panel_gap: 0.0,
            panel_corner_radius: 0.0,
            panel_border_width: default_panel_border_width(),
            lane_colored_branch_chips: false,
            stash_base_lane_color: false,
            watcher_enabled: true,
            confirm_discard: true,
            detect_case_renames: true,
            checkout_new_branch: true,
            auto_fetch_enabled: false,
            auto_fetch_interval_minutes: default_auto_fetch_interval(),
            check_updates_on_startup: true,
            external_editor_command: None,
            switch_dirty_behavior: None,
            checkout_remote_fast_forward: true,
            pull_strategy: None,
            stash_include_untracked: false,
            file_history_opens_window: false,
            file_history_window_size: None,
            push_recurse_submodules: None,
            auto_push_tags: false,
            submodule_attach_branch: false,
            commit_avatars: false,
            commit_initials: false,
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

/// Global settings owned by dedicated commands or flows (the probed git
/// binary, theme name sanitizing, watcher start/stop side effects, session
/// bookkeeping, profiles, accounts); a settings patch must never write them.
const GLOBAL_SETTINGS_COMMAND_OWNED: [&str; 10] = [
    "file_history_window_size",
    "git_path_override",
    "active_theme",
    "watcher_enabled",
    "last_open_repos",
    "currently_open",
    "active_open_repo",
    "last_clone_parent_dir",
    "gitProfiles",
    "connected_accounts",
];

impl GlobalSettings {
    /// `self` with the fields named in `patch` (JSON field names) replaced and
    /// the result normalized. Fields not in the patch keep their current value.
    pub fn with_patch(&self, patch: &serde_json::Value) -> Result<Self, AppError> {
        let patch = patch
            .as_object()
            .ok_or_else(|| AppError::Settings("global settings patch must be an object".into()))?;
        let serde_json::Value::Object(mut merged) = serde_json::to_value(self)? else {
            unreachable!("GlobalSettings serializes to an object");
        };
        for (key, value) in patch {
            if GLOBAL_SETTINGS_COMMAND_OWNED.contains(&key.as_str()) {
                return Err(AppError::Settings(format!(
                    "global setting '{key}' is managed by its own command"
                )));
            }
            if !merged.contains_key(key) {
                return Err(AppError::Settings(format!("unknown global setting '{key}'")));
            }
            merged.insert(key.clone(), value.clone());
        }
        let next: Self = serde_json::from_value(serde_json::Value::Object(merged))
            .map_err(|e| AppError::Settings(format!("invalid global settings patch: {e}")))?;
        Ok(next.normalized())
    }

    /// Enforce every value invariant on the merged result, so a patch cannot
    /// store an out-of-range value regardless of which fields it combines.
    fn normalized(mut self) -> Self {
        self.ui_font_size = self.ui_font_size.clamp(8.0, 24.0);
        self.panel_gap = self.panel_gap.clamp(0.0, 16.0);
        self.panel_corner_radius = self.panel_corner_radius.clamp(0.0, 16.0);
        self.panel_border_width = self.panel_border_width.clamp(0.0, 8.0);
        // The row must clear a ref chip, which scales with the UI font size;
        // lane width shares the same font-derived floor. Dot radius and line
        // width are capped to half the smaller (clamped) cell dimension so
        // they can never overflow the cell or overlap a neighbouring lane.
        let min_rh = min_commits_row_height(self.ui_font_size);
        self.commits_row_height = self.commits_row_height.clamp(min_rh, 120.0);
        self.commits_lane_width = self.commits_lane_width.clamp(min_rh, 120.0);
        let max_dot = max_commits_dot_radius(self.commits_row_height, self.commits_lane_width);
        self.commits_dot_radius = self.commits_dot_radius.clamp(1.0, max_dot);
        self.commits_line_width = self.commits_line_width.clamp(1.0, max_dot);
        self.auto_fetch_interval_minutes = self.auto_fetch_interval_minutes.max(1);
        // Blank means "not configured": store None so the fallback applies.
        self.external_editor_command = self.external_editor_command.filter(|c| !c.trim().is_empty());
        self
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

/// Default action of the Working Changes commit button: plain commit, or
/// commit followed by a push of the current branch. Deliberately per-repo
/// ONLY (no global default): push is outward-facing, and a globally
/// persisted Commit & Push would silently follow the user from a hobby repo
/// into one where every push triggers CI. The button's caret menu is the
/// only UI - there is deliberately no RepoSettingsPanel section (see the
/// BACKLOG "Commit & Push" entry).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum CommitButtonMode {
    Commit,
    CommitAndPush,
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
    /// Per-repo override for auto-push tags (None = inherit global).
    #[serde(default)]
    pub auto_push_tags: Option<bool>,
    /// Suppress the "uses LFS but git-lfs unavailable" warning banner for
    /// this repo (None = warn, the default; set via the banner's
    /// "Don't warn for this repo" or the Repo Settings panel).
    #[serde(default)]
    pub suppress_lfs_warning: Option<bool>,
    /// Commit button default: plain commit vs commit-and-push
    /// (None = plain commit). Set only via the button's caret menu.
    #[serde(default)]
    pub commit_button_mode: Option<CommitButtonMode>,
}

/// Repo settings owned by dedicated commands (lane locks, profile selection,
/// the probed git binary); a settings patch must never write them.
const REPO_SETTINGS_COMMAND_OWNED: [&str; 3] = ["laneLocks", "git_profile_id", "git_path_override"];

impl RepoSettings {
    /// `self` with the fields named in `patch` (JSON field names) replaced.
    /// Fields not in the patch keep their current value.
    pub fn with_patch(&self, patch: &serde_json::Value) -> Result<Self, AppError> {
        let patch = patch
            .as_object()
            .ok_or_else(|| AppError::Settings("repo settings patch must be an object".into()))?;
        let serde_json::Value::Object(mut merged) = serde_json::to_value(self)? else {
            unreachable!("RepoSettings serializes to an object");
        };
        for (key, value) in patch {
            if REPO_SETTINGS_COMMAND_OWNED.contains(&key.as_str()) {
                return Err(AppError::Settings(format!(
                    "repo setting '{key}' is managed by its own command"
                )));
            }
            if !merged.contains_key(key) {
                return Err(AppError::Settings(format!("unknown repo setting '{key}'")));
            }
            merged.insert(key.clone(), value.clone());
        }
        serde_json::from_value(serde_json::Value::Object(merged))
            .map_err(|e| AppError::Settings(format!("invalid repo settings patch: {e}")))
    }
}

// ---------------------------------------------------------------------------
// Repo session
// ---------------------------------------------------------------------------

pub struct RepoSession {
    pub id: RepoId,
    /// The repo root as the repo's HOST prints it (posix for a WSL repo, also
    /// on a Windows app build). Extend it with `HostPath::join` / `resolve`;
    /// only code acting on the app machine converts it (`as_local`).
    pub root: legit_core::HostPath,
    /// Where this repo lives (local path or `wsl://<distro>/<path>`).
    pub locator: RepoLocator,
    /// The host this repo lives on — every repo-side action (git spawn, FS,
    /// watch, helper process) goes through it.
    pub host: Arc<dyn Host>,
    /// The active runner. Wrapped in an `Arc<RwLock<…>>` so the same lock is
    /// shared with `GitCliBackend`. Swapping the inner `Arc<dyn GitExecutor>`
    /// (e.g. on per-repo git-path override) is visible to both the session and
    /// the backend without rebuilding either (DESIGN-v0.3.md §C.5/F.3).
    /// Dyn so a session can be backed by a remote host's executor.
    pub runner: Arc<RwLock<Arc<dyn GitExecutor>>>,
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
        locator: RepoLocator,
        host: Arc<dyn Host>,
        runner: Arc<dyn GitExecutor>,
        settings: RepoSettings,
        settings_path: PathBuf,
    ) -> Self {
        let runner_lock = Arc::new(RwLock::new(runner));
        let backend = Arc::new(GitCliBackend::new(runner_lock.clone(), host.fs()));
        let root = legit_core::HostPath(locator.display_path());
        Self {
            id: Uuid::new_v4().to_string(),
            locator,
            host,
            root,
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
            path: self.locator.display_path(),
            name: self.root.file_name().unwrap_or_else(|| "repo".to_string()),
            host: self.locator.host_ref(),
            locator: self.locator.to_persist_string(),
            watch_error: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct RepoSummary {
    pub id: RepoId,
    /// The repo root as the repo's HOST sees it (display + copy affordances).
    pub path: String,
    pub name: String,
    /// `None` = local repo. See `remote::HostRef`.
    #[serde(default)]
    pub host: Option<HostRef>,
    /// The persistable locator string (bare path for local repos,
    /// `wsl://<distro>/<path>` for remote) — what recents/currently-open
    /// bookkeeping stores and `open_repo` accepts.
    #[serde(default)]
    pub locator: String,
    /// Why the repo's filesystem watcher failed to start (`None` = watching,
    /// or watching deliberately disabled). Feeds the "live updates off" badge
    /// on the repo tab. `RepoSession::summary` leaves it `None`;
    /// `AppState::attach_watch_error` fills it where state is at hand.
    #[serde(default)]
    pub watch_error: Option<String>,
}

/// `repo_clone`'s result: the opened repo plus any LFS pointer stubs the
/// clone's checkout left behind (git can exit 0 with failed LFS downloads
/// under `lfs.skipdownloaderrors` / a non-required filter).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct CloneOutcome {
    pub summary: RepoSummary,
    pub lfs_stubs: Option<legit_core::LfsStubs>,
}

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------

pub struct AppState {
    pub repos: RwLock<HashMap<RepoId, Arc<RepoSession>>>,
    /// Known hosts, keyed by identity. `HostId::Local` is always present;
    /// remote hosts register on connect.
    pub hosts: Mutex<HashMap<HostId, Arc<dyn Host>>>,
    /// Live filesystem watchers, one per open repo (keyed by `RepoId`). Dropping
    /// an entry stops its watch (and, for remote repos, unregisters it on the
    /// agent). `std::sync::Mutex` (not async) so close and teardown stay
    /// trivial. See `crate::watcher`.
    pub watchers: Mutex<HashMap<RepoId, WatchHandle>>,
    /// Why a repo's watcher failed to start (keyed by `RepoId`; absent =
    /// watching or deliberately disabled). Lives here, not only in an event:
    /// a failure during restore can be emitted before the frontend mounts its
    /// listener, so the state must be readable later — it is carried on
    /// `RepoSummary` (`list_repos`), with `WATCH_STATE_EVENT` as the live
    /// update.
    pub watch_errors: Mutex<HashMap<RepoId, String>>,
    pub global_settings: Arc<RwLock<GlobalSettings>>,
    /// Resolved git binary path the runner uses *right now*.
    pub git_path: RwLock<PathBuf>,
    /// On-disk path for `global-settings.json`.
    pub global_settings_path: PathBuf,
    /// Held from settings snapshot to rename, so an older snapshot can never
    /// land on disk after a newer one.
    persist_lock: tokio::sync::Mutex<()>,
    /// On-disk root for per-repo data: `repos/<hash>/`.
    pub repos_data_dir: PathBuf,
    /// On-disk location for user themes.
    pub user_themes_dir: PathBuf,
    /// On-disk location for built-in themes (read-only).
    pub builtin_themes_dir: PathBuf,
    /// In-flight session-less git operations (currently `git clone`), keyed by
    /// `OperationId`, so a separate cancel command can reach the runner. Entries
    /// are inserted for the op's duration and removed when it finishes.
    pub transient_ops: Mutex<HashMap<OperationId, Arc<TransientOp>>>,
    /// Live WSL agent connections, one per distro (see `remote::connection`).
    pub wsl_hosts: crate::remote::connection::WslHosts,
    /// On-disk root for per-host settings: `hosts/wsl-<distro>.json`.
    pub hosts_data_dir: PathBuf,
    /// On-disk location for saved panel layouts: `layouts/<name>.legit-layout.json`.
    pub layouts_dir: PathBuf,
    /// On-disk location of the single user keymap: `keybindings.json`.
    pub keybindings_path: PathBuf,
    /// Cached per-host settings, keyed by distro (lazily loaded).
    pub host_settings: RwLock<HashMap<String, HostSettings>>,
}

/// An in-flight session-less git operation (see `AppState::transient_ops`).
pub struct TransientOp {
    pub runner: Arc<dyn GitExecutor>,
    /// Set by the cancel command BEFORE the kill is delivered, so when the
    /// kill unblocks the operation's own future it can already tell a
    /// user cancellation apart from a real failure (the killed process's
    /// exit status alone cannot).
    pub cancelled: std::sync::atomic::AtomicBool,
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
        let mut hosts: HashMap<HostId, Arc<dyn Host>> = HashMap::new();
        hosts.insert(HostId::Local, Arc::new(LocalHost));
        // Siblings of `repos/` under the app-data dir.
        let hosts_data_dir = repos_data_dir
            .parent()
            .map(|p| p.join("hosts"))
            .unwrap_or_else(|| repos_data_dir.join("hosts"));
        let layouts_dir = repos_data_dir
            .parent()
            .map(|p| p.join("layouts"))
            .unwrap_or_else(|| repos_data_dir.join("layouts"));
        let keybindings_path = repos_data_dir
            .parent()
            .map(|p| p.join("keybindings.json"))
            .unwrap_or_else(|| repos_data_dir.join("keybindings.json"));
        Self {
            repos: RwLock::new(HashMap::new()),
            hosts: Mutex::new(hosts),
            watchers: Mutex::new(HashMap::new()),
            watch_errors: Mutex::new(HashMap::new()),
            global_settings: Arc::new(RwLock::new(global_settings)),
            git_path: RwLock::new(git_path),
            global_settings_path,
            persist_lock: tokio::sync::Mutex::new(()),
            repos_data_dir,
            user_themes_dir,
            builtin_themes_dir,
            transient_ops: Mutex::new(HashMap::new()),
            wsl_hosts: crate::remote::connection::WslHosts::default(),
            hosts_data_dir,
            layouts_dir,
            keybindings_path,
            host_settings: RwLock::new(HashMap::new()),
        }
    }

    /// Fill `RepoSummary::watch_error` from `watch_errors` for summaries
    /// crossing IPC (a `RepoSession` cannot — it has no state access).
    pub fn attach_watch_error(&self, mut summary: RepoSummary) -> RepoSummary {
        summary.watch_error = self.watch_errors.lock().unwrap().get(&summary.id).cloned();
        summary
    }

    /// Park a freshly started watch for `repo_id`. Returns `false` (and drops
    /// the watch) when the repo was closed or watching was disabled while the
    /// watch was starting.
    pub async fn adopt_watch(&self, repo_id: &str, watch: WatchHandle) -> bool {
        // Both guards are held across check + insert: `close_repo` needs the
        // `repos` write guard and disabling needs the settings write guard, so
        // neither can slip in between and leave a watch parked.
        let repos = self.repos.read().await;
        let settings = self.global_settings.read().await;
        if !repos.contains_key(repo_id) || !settings.watcher_enabled {
            return false;
        }
        self.watchers.lock().unwrap().insert(repo_id.to_string(), watch);
        self.watch_errors.lock().unwrap().remove(repo_id);
        true
    }

    /// Record why `repo_id`'s watch failed to start. Returns `false` when the
    /// failure is moot (repo closed or watching disabled meanwhile).
    pub async fn record_watch_failure(&self, repo_id: &str, msg: String) -> bool {
        let repos = self.repos.read().await;
        let settings = self.global_settings.read().await;
        if !repos.contains_key(repo_id) || !settings.watcher_enabled {
            return false;
        }
        self.watch_errors.lock().unwrap().insert(repo_id.to_string(), msg);
        true
    }

    /// Drop the watch and any recorded watch failure of `repo_id`.
    pub fn forget_watch(&self, repo_id: &str) {
        self.watchers.lock().unwrap().remove(repo_id);
        self.watch_errors.lock().unwrap().remove(repo_id);
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

    /// The app machine's host (always registered).
    pub fn local_host(&self) -> Arc<dyn Host> {
        self.hosts
            .lock()
            .expect("hosts map poisoned")
            .get(&HostId::Local)
            .expect("local host always present")
            .clone()
    }

    /// Persist `session`'s current repo settings - the single call point for
    /// the `repo_data_paths_locator` + `persist_repo_settings` pair, so the
    /// four arguments cannot drift apart between commands.
    pub async fn persist_session_settings(&self, session: &RepoSession) -> Result<(), AppError> {
        let _serial = self.persist_lock.lock().await;
        let settings = session.settings.read().await.clone();
        let (repo_dir, _) = self.repo_data_paths_locator(&session.locator);
        persist_repo_settings(&settings, &repo_dir, &session.settings_path, &session.root.as_local()).await
    }

    pub async fn persist_global_settings(&self) -> Result<(), AppError> {
        let _serial = self.persist_lock.lock().await;
        let settings = self.global_settings.read().await.clone();
        if let Some(parent) = self.global_settings_path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        let json = serde_json::to_string_pretty(&settings)?;
        crate::persist::write_atomic(&self.global_settings_path, json).await?;
        Ok(())
    }

    /// Resolve the `repos/<hash>/` directory for `locator` and return
    /// `(repo_dir, settings_path)` (remote repos hash by their full locator,
    /// see `repo_hash_locator`).
    pub fn repo_data_paths_locator(&self, locator: &RepoLocator) -> (PathBuf, PathBuf) {
        let hash = repo_hash_locator(locator);
        let repo_dir = self.repos_data_dir.join(&hash);
        let settings_path = repo_dir.join("settings.json");
        (repo_dir, settings_path)
    }
}

// ---------------------------------------------------------------------------
// Per-host settings (remote hosts; `<app-data>/hosts/wsl-<distro>.json`)
// ---------------------------------------------------------------------------

/// Host-scoped app settings (one file per remote host). Fields follow the
/// `Option<T>` + `#[serde(default)]` convention: `None` = use the default.
#[derive(Debug, Clone, Default, Serialize, Deserialize, Type)]
pub struct HostSettings {
    /// Git binary override ON THAT HOST (a path/name the host resolves);
    /// `None` = the agent's login-shell PATH `git`.
    #[serde(default)]
    pub git_path_override: Option<String>,
}

impl AppState {
    fn host_settings_path(&self, distro: &str) -> PathBuf {
        // Distro names come from wsl.exe registration; keep the file name
        // safe on Windows regardless.
        let safe: String = distro
            .chars()
            .map(|c| if c.is_alphanumeric() || "-_.".contains(c) { c } else { '_' })
            .collect();
        self.hosts_data_dir.join(format!("wsl-{safe}.json"))
    }

    /// Load-or-cache the settings for a WSL host.
    pub async fn host_settings(&self, distro: &str) -> HostSettings {
        if let Some(s) = self.host_settings.read().await.get(distro) {
            return s.clone();
        }
        let loaded: HostSettings =
            crate::persist::load_json_or_default(&self.host_settings_path(distro));
        self.host_settings
            .write()
            .await
            .entry(distro.to_string())
            .or_insert_with(|| loaded.clone());
        loaded
    }

    /// Persist new settings for a WSL host (cache + disk).
    pub async fn set_host_settings(
        &self,
        distro: &str,
        settings: HostSettings,
    ) -> Result<(), AppError> {
        self.host_settings
            .write()
            .await
            .insert(distro.to_string(), settings.clone());
        tokio::fs::create_dir_all(&self.hosts_data_dir).await?;
        let json = serde_json::to_string_pretty(&settings)?;
        crate::persist::write_atomic(&self.host_settings_path(distro), json).await?;
        Ok(())
    }

    /// The effective git override for a WSL host (`None` = PATH `git`).
    pub async fn host_git_override(&self, distro: &str) -> Option<String> {
        self.host_settings(distro)
            .await
            .git_path_override
            .filter(|s| !s.trim().is_empty())
    }
}

// ---------------------------------------------------------------------------
// Repo settings I/O helpers (sync, for use at open time)
// ---------------------------------------------------------------------------

/// Load `RepoSettings` from disk; defaults when missing, and a malformed file
/// is moved aside first (see `persist::load_json_or_default`).
pub fn load_repo_settings_sync(settings_path: &Path) -> RepoSettings {
    crate::persist::load_json_or_default(settings_path)
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
    crate::persist::write_atomic(settings_path, json).await?;
    Ok(())
}

#[cfg(test)]
mod watch_lifecycle_tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    struct DropFlag(Arc<AtomicBool>);
    impl Drop for DropFlag {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }

    fn watch() -> (WatchHandle, Arc<AtomicBool>) {
        let dropped = Arc::new(AtomicBool::new(false));
        (WatchHandle::new(DropFlag(dropped.clone())), dropped)
    }

    fn state(dir: &Path) -> AppState {
        AppState::new(
            PathBuf::from("git"),
            GlobalSettings::default(),
            dir.join("global-settings.json"),
            dir.join("repos"),
            dir.join("themes"),
            dir.join("builtin-themes"),
        )
    }

    async fn open_repo(state: &AppState, dir: &Path) -> RepoId {
        let session = Arc::new(RepoSession::new(
            RepoLocator::local(dir.to_path_buf()),
            Arc::new(LocalHost),
            Arc::new(legit_core::GitRunner::for_repo("git", dir)),
            RepoSettings::default(),
            dir.join("settings.json"),
        ));
        let id = session.id.clone();
        state.repos.write().await.insert(id.clone(), session);
        id
    }

    #[tokio::test]
    async fn watch_for_open_repo_is_kept_and_clears_a_stale_failure() {
        let dir = tempfile::tempdir().unwrap();
        let state = state(dir.path());
        let id = open_repo(&state, dir.path()).await;
        state.watch_errors.lock().unwrap().insert(id.clone(), "old".into());
        let (w, dropped) = watch();

        assert!(state.adopt_watch(&id, w).await);

        assert!(!dropped.load(Ordering::SeqCst));
        assert!(state.watchers.lock().unwrap().contains_key(&id));
        assert!(!state.watch_errors.lock().unwrap().contains_key(&id));
    }

    #[tokio::test]
    async fn watch_finishing_after_close_is_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let state = state(dir.path());
        let (w, dropped) = watch();

        assert!(!state.adopt_watch("closed-repo", w).await);

        assert!(dropped.load(Ordering::SeqCst));
        assert!(state.watchers.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn watch_finishing_after_watching_was_disabled_is_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let state = state(dir.path());
        let id = open_repo(&state, dir.path()).await;
        state.global_settings.write().await.watcher_enabled = false;
        let (w, dropped) = watch();

        assert!(!state.adopt_watch(&id, w).await);

        assert!(dropped.load(Ordering::SeqCst));
        assert!(state.watchers.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn watch_failure_of_a_closed_repo_is_not_recorded() {
        let dir = tempfile::tempdir().unwrap();
        let state = state(dir.path());

        assert!(!state.record_watch_failure("closed-repo", "limit".into()).await);

        assert!(state.watch_errors.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn watch_failure_after_watching_was_disabled_is_not_recorded() {
        let dir = tempfile::tempdir().unwrap();
        let state = state(dir.path());
        let id = open_repo(&state, dir.path()).await;
        state.global_settings.write().await.watcher_enabled = false;

        assert!(!state.record_watch_failure(&id, "limit".into()).await);

        assert!(state.watch_errors.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn forget_watch_drops_watch_and_failure() {
        let dir = tempfile::tempdir().unwrap();
        let state = state(dir.path());
        let id = open_repo(&state, dir.path()).await;
        let (w, dropped) = watch();
        state.adopt_watch(&id, w).await;
        state.watch_errors.lock().unwrap().insert(id.clone(), "x".into());

        state.forget_watch(&id);

        assert!(dropped.load(Ordering::SeqCst));
        assert!(state.watch_errors.lock().unwrap().is_empty());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings_with_owned_fields() -> RepoSettings {
        let mut s = RepoSettings::default();
        s.lane_locks_doc.locks.push(LaneLock { ref_name: "refs/heads/main".into(), lane_index: 2 });
        s.git_profile_id = Some("work".into());
        s.git_path_override = Some("/opt/git".into());
        s.show_remote_branches = Some(true);
        s
    }

    #[test]
    fn repo_settings_patch_changes_only_the_sent_fields() {
        let current = settings_with_owned_fields();
        let next = current
            .with_patch(&serde_json::json!({ "show_remote_branches": false, "auto_push_tags": true }))
            .unwrap();
        assert_eq!(next.show_remote_branches, Some(false));
        assert_eq!(next.auto_push_tags, Some(true));
        assert_eq!(next.lane_locks_doc.locks.len(), 1);
        assert_eq!(next.git_profile_id.as_deref(), Some("work"));
        assert_eq!(next.git_path_override.as_deref(), Some("/opt/git"));
    }

    #[test]
    fn repo_settings_patch_null_resets_an_override() {
        let next = settings_with_owned_fields()
            .with_patch(&serde_json::json!({ "show_remote_branches": null }))
            .unwrap();
        assert_eq!(next.show_remote_branches, None);
    }

    #[test]
    fn repo_settings_patch_refuses_fields_owned_by_dedicated_commands() {
        let current = settings_with_owned_fields();
        for patch in [
            serde_json::json!({ "laneLocks": { "format": "x", "formatVersion": 1, "locks": [] } }),
            serde_json::json!({ "git_profile_id": null }),
            serde_json::json!({ "git_path_override": "/evil" }),
        ] {
            assert!(current.with_patch(&patch).is_err(), "accepted {patch}");
        }
    }

    #[test]
    fn repo_settings_patch_refuses_unknown_fields_and_wrong_types() {
        let current = RepoSettings::default();
        assert!(current.with_patch(&serde_json::json!({ "show_remote_branchs": true })).is_err());
        assert!(current.with_patch(&serde_json::json!({ "auto_push_tags": "yes" })).is_err());
        assert!(current.with_patch(&serde_json::json!(["not", "an", "object"])).is_err());
    }

    #[test]
    fn file_history_window_size_is_command_owned() {
        assert!(GlobalSettings::default()
            .with_patch(&serde_json::json!({
                "file_history_window_size": { "width": 1.0, "height": 1.0 }
            }))
            .is_err());
    }

    #[test]
    fn file_history_opens_window_is_patchable() {
        let merged = GlobalSettings::default()
            .with_patch(&serde_json::json!({ "file_history_opens_window": true }))
            .unwrap();
        assert!(merged.file_history_opens_window);
    }

    #[test]
    fn global_settings_patch_changes_only_the_sent_fields() {
        let current = GlobalSettings::default();
        let next = current
            .with_patch(&serde_json::json!({ "confirm_discard": false, "commit_avatars": true }))
            .unwrap();
        assert!(!next.confirm_discard);
        assert!(next.commit_avatars);
        assert_eq!(next.ui_font_size, current.ui_font_size);
        assert_eq!(next.auto_fetch_enabled, current.auto_fetch_enabled);
    }

    #[test]
    fn global_settings_patch_refuses_fields_owned_by_dedicated_commands() {
        for patch in [
            serde_json::json!({ "git_path_override": "/evil" }),
            serde_json::json!({ "active_theme": "x" }),
            serde_json::json!({ "watcher_enabled": false }),
            serde_json::json!({ "currently_open": [] }),
            serde_json::json!({ "last_open_repos": [] }),
            serde_json::json!({ "active_open_repo": null }),
            serde_json::json!({ "last_clone_parent_dir": "/x" }),
            serde_json::json!({ "gitProfiles": {} }),
            serde_json::json!({ "connected_accounts": [] }),
        ] {
            assert!(GlobalSettings::default().with_patch(&patch).is_err(), "accepted {patch}");
        }
    }

    #[test]
    fn global_settings_patch_refuses_unknown_fields_and_wrong_types() {
        let current = GlobalSettings::default();
        assert!(current.with_patch(&serde_json::json!({ "confirm_discardd": true })).is_err());
        assert!(current.with_patch(&serde_json::json!({ "confirm_discard": "yes" })).is_err());
        assert!(current.with_patch(&serde_json::json!(["not", "an", "object"])).is_err());
    }

    #[test]
    fn global_settings_patch_normalizes_out_of_range_values() {
        let d = GlobalSettings::default;
        assert_eq!(d().with_patch(&serde_json::json!({ "ui_font_size": 99.0 })).unwrap().ui_font_size, 24.0);
        assert_eq!(d().with_patch(&serde_json::json!({ "ui_font_size": 1.0 })).unwrap().ui_font_size, 8.0);
        assert_eq!(
            d().with_patch(&serde_json::json!({ "auto_fetch_interval_minutes": 0 }))
                .unwrap()
                .auto_fetch_interval_minutes,
            1
        );
        assert_eq!(
            d().with_patch(&serde_json::json!({ "external_editor_command": "   " }))
                .unwrap()
                .external_editor_command,
            None
        );
        let chrome = d()
            .with_patch(&serde_json::json!({
                "panel_gap": 99.0, "panel_corner_radius": -3.0, "panel_border_width": 99.0
            }))
            .unwrap();
        assert_eq!(chrome.panel_gap, 16.0);
        assert_eq!(chrome.panel_corner_radius, 0.0);
        assert_eq!(chrome.panel_border_width, 8.0);
    }

    #[test]
    fn global_settings_patch_clamps_graph_metrics_against_the_patched_font_size() {
        let next = GlobalSettings::default()
            .with_patch(&serde_json::json!({
                "ui_font_size": 24.0,
                "commits_row_height": 1.0,
                "commits_lane_width": 1.0,
                "commits_dot_radius": 500.0,
                "commits_line_width": 500.0,
            }))
            .unwrap();
        let min_rh = min_commits_row_height(24.0);
        assert_eq!(next.commits_row_height, min_rh);
        assert_eq!(next.commits_lane_width, min_rh);
        assert_eq!(next.commits_dot_radius, max_commits_dot_radius(min_rh, min_rh));
        assert_eq!(next.commits_line_width, max_commits_dot_radius(min_rh, min_rh));
    }

    // Pins repo-identity backward compatibility across the RepoLocator
    // generalization: a local repo's hash must stay byte-identical to what
    // pre-locator versions computed, or every existing repos/<hash>/
    // settings.json silently detaches from its repo. The constant is
    // sha256("/tmp/legit-fixed-example")[0..8] — an all-lowercase path so the
    // expectation holds on case-folding (win/mac) and case-preserving (linux)
    // builds alike.
    #[test]
    fn local_repo_hash_is_pinned() {
        assert_eq!(
            repo_hash_locator(&RepoLocator::local("/tmp/legit-fixed-example")),
            "25bd95ddb634925e"
        );
    }

    // A WSL repo opened on a PRE-LOCATOR version went through git's UNC
    // toplevel (`//wsl.localhost/<distro>/<path>`), hashed as a lowercased
    // local path. Re-keying it as wsl:// must carry the existing repos/<hash>/
    // directory over, or its per-repo settings silently detach.
    #[test]
    fn migrates_legacy_unc_hashed_repo_dir_to_locator_hash() {
        let dir = tempfile::tempdir().unwrap();
        let locator = RepoLocator::Wsl {
            distro: "Ubuntu".into(),
            path: legit_core::HostPath("/home/u/Repo".into()),
        };
        // Exactly what dev's repo_hash produced on Windows for that repo:
        // the raw git output, lowercased by the case-folding branch.
        let legacy = hash16("//wsl.localhost/ubuntu/home/u/repo");
        let legacy_dir = dir.path().join(&legacy);
        std::fs::create_dir_all(&legacy_dir).unwrap();
        std::fs::write(legacy_dir.join("settings.json"), b"{\"git_path_override\":null}").unwrap();
        std::fs::write(legacy_dir.join("path.txt"), b"//wsl.localhost/Ubuntu/home/u/Repo").unwrap();

        migrate_legacy_wsl_repo_dir(dir.path(), &locator);

        let new_dir = dir.path().join(repo_hash_locator(&locator));
        assert!(new_dir.join("settings.json").exists(), "settings must move to the locator hash");
        assert!(!legacy_dir.exists(), "legacy dir must be renamed away");
        assert_eq!(
            std::fs::read_to_string(new_dir.join("path.txt")).unwrap(),
            "wsl://Ubuntu/home/u/Repo",
            "path.txt must be refreshed to the persisted locator"
        );

        // Idempotent: with the new dir present, nothing moves (a fresh legacy
        // dir appearing later must never clobber live settings).
        std::fs::create_dir_all(&legacy_dir).unwrap();
        std::fs::write(legacy_dir.join("settings.json"), b"{}").unwrap();
        migrate_legacy_wsl_repo_dir(dir.path(), &locator);
        assert!(legacy_dir.exists(), "an existing locator dir wins");
    }

    #[test]
    fn migration_ignores_local_and_unrelated_repos() {
        let dir = tempfile::tempdir().unwrap();
        migrate_legacy_wsl_repo_dir(dir.path(), &RepoLocator::local("/x"));
        // No legacy dir at all: nothing to do, nothing created.
        let locator = RepoLocator::Wsl {
            distro: "Ubuntu".into(),
            path: legit_core::HostPath("/home/u/proj".into()),
        };
        migrate_legacy_wsl_repo_dir(dir.path(), &locator);
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    // Remote paths live on case-sensitive filesystems: the app OS's case
    // folding must never apply to them, or two distinct WSL repos could
    // collide (and a repo's identity would differ between app OSes).
    #[test]
    fn wsl_repo_hash_is_case_sensitive_on_every_platform() {
        let upper = repo_hash_locator(&RepoLocator::parse("wsl://Ubuntu/Home/User/Proj"));
        let lower = repo_hash_locator(&RepoLocator::parse("wsl://ubuntu/home/user/proj"));
        assert_eq!(upper, "1aaf3aacdde618f6");
        assert_eq!(lower, "ed404be154960be5");
        assert_ne!(upper, lower);
    }

    // Settings files written before a field existed must keep parsing: every
    // additive GlobalSettings field is `Option`/`#[serde(default)]` by
    // convention. This pins the assumption for a minimal old-style document
    // (the shape a pre-0.9.12 install has on disk).
    #[test]
    fn old_global_settings_without_new_fields_parse() {
        let old = r#"{
            "git_path_override": null,
            "active_open_repo": null,
            "active_theme": null,
            "global_region_placement": "top",
            "global_region_size_top": null,
            "global_region_size_left": null,
            "global_dock_collapsed": false,
            "switch_dirty_behavior": null
        }"#;
        let parsed: GlobalSettings =
            serde_json::from_str(old).expect("old settings document must parse");
        assert_eq!(parsed.last_clone_parent_dir, None);
        assert!(parsed.currently_open.is_empty());
        assert!(
            parsed.checkout_remote_fast_forward,
            "checkout_remote_fast_forward must default ON for old settings files"
        );
    }

    // Same convention for RepoSettings - and doubly important there, because
    // `load_repo_settings_sync` falls back to `RepoSettings::default()` on ANY
    // parse failure, so a field that breaks old documents would silently wipe
    // every per-repo setting (including lane locks) instead of erroring.
    #[test]
    fn old_repo_settings_without_new_fields_parse() {
        let old = r#"{
            "git_path_override": null,
            "line_ending_chips_in_changes": true,
            "laneLocks": { "format": "legit-lane-locks", "formatVersion": 1, "locks": [] }
        }"#;
        let parsed: RepoSettings =
            serde_json::from_str(old).expect("old repo settings document must parse");
        assert_eq!(parsed.line_ending_chips_in_changes, Some(true));
        assert!(
            parsed.commit_button_mode.is_none(),
            "commit_button_mode must default to None (= plain commit) for old files"
        );
    }

    #[test]
    fn commit_button_mode_roundtrips_snake_case() {
        let mut s = RepoSettings::default();
        s.commit_button_mode = Some(CommitButtonMode::CommitAndPush);
        let json = serde_json::to_string(&s).unwrap();
        assert!(
            json.contains(r#""commit_button_mode":"commit_and_push""#),
            "TS mirror relies on snake_case variants: {json}"
        );
        let back: RepoSettings = serde_json::from_str(&json).unwrap();
        assert_eq!(back.commit_button_mode, Some(CommitButtonMode::CommitAndPush));
    }

    #[test]
    fn last_clone_parent_dir_roundtrips() {
        let mut s = GlobalSettings::default();
        s.last_clone_parent_dir = Some("C:/src".into());
        let json = serde_json::to_string(&s).unwrap();
        let back: GlobalSettings = serde_json::from_str(&json).unwrap();
        assert_eq!(back.last_clone_parent_dir.as_deref(), Some("C:/src"));
    }
}
