//! Tauri wrapper around `SyncCore`: owns the debounced export trigger, the
//! current status, and the events. Thin by design - everything with logic
//! sits in `engine`/`model`/`themes` where the tests reach it.

use std::path::PathBuf;
use std::sync::Arc;

use tauri::{AppHandle, Emitter as _, Manager as _};

use super::engine::{SyncCore, SyncStatusKind, SyncStatusPayload};
use super::model::import_synced_settings;
use crate::commands::persistence::GLOBAL_SETTINGS_CHANGED_EVENT;
use crate::state::AppState;

pub const SETTINGS_SYNC_STATUS_EVENT: &str = "legit://settings-sync-status";
pub const THEMES_CHANGED_EVENT: &str = "legit://themes-changed";

/// Quiet period after the last settings/theme change before exporting, so a
/// whole settings-tweaking session becomes one sync commit instead of one per
/// pause. Safe to be generous: local persistence is eager, and the startup
/// import captures anything a quit cuts off.
const EXPORT_QUIET: std::time::Duration = std::time::Duration::from_secs(30);

/// Hard cap from the FIRST change of a burst: a user tweaking every few
/// seconds must not defer the export forever.
const EXPORT_MAX_LATENCY: std::time::Duration = std::time::Duration::from_secs(300);

/// Managed handle (`app.manage`) the sync commands resolve.
pub struct SyncHandle(pub Arc<SettingsSyncEngine>);

pub struct SettingsSyncEngine {
    app: AppHandle,
    status: tokio::sync::RwLock<SyncStatusPayload>,
    /// Serializes sync cycles: the debounced export, the startup import,
    /// "Sync now" and adopt/seed must never run git on the repo concurrently
    /// (an export's working-tree write during a pull breaks the rebase, and
    /// racing cycles would publish each other's stale status).
    cycle_lock: tokio::sync::Mutex<()>,
}

impl SettingsSyncEngine {
    /// Build the engine, wire the nudge channel into `AppState`, and start
    /// the debounce task.
    pub fn start(app: AppHandle) -> Arc<Self> {
        let state = app.state::<AppState>();
        let configured = {
            // Startup runs before any command can write settings; try_read
            // cannot contend here.
            let settings = state.global_settings.try_read();
            settings.map(|s| s.settings_sync_path.is_some()).unwrap_or(false)
        };
        let initial = if configured {
            // Not yet synced this session; the startup import replaces this.
            SyncStatusPayload::of(SyncStatusKind::Offline)
        } else {
            SyncStatusPayload::of(SyncStatusKind::Disabled)
        };
        let engine = Arc::new(Self {
            app: app.clone(),
            status: tokio::sync::RwLock::new(initial),
            cycle_lock: tokio::sync::Mutex::new(()),
        });

        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<()>();
        let _ = state.sync_nudge.set(tx);
        let task_engine = Arc::clone(&engine);
        tauri::async_runtime::spawn(async move {
            while rx.recv().await.is_some() {
                // Export after EXPORT_QUIET without a further nudge, or at
                // EXPORT_MAX_LATENCY after the burst's first nudge, whichever
                // comes first; every nudge restarts only the quiet timer.
                let deadline = tokio::time::Instant::now() + EXPORT_MAX_LATENCY;
                loop {
                    tokio::select! {
                        _ = tokio::time::sleep(EXPORT_QUIET) => break,
                        _ = tokio::time::sleep_until(deadline) => break,
                        more = rx.recv() => {
                            if more.is_none() { return; }
                        }
                    }
                }
                task_engine.run_export().await;
            }
        });
        engine
    }

    /// The startup sync. Detached, so it never delays the app, and never
    /// bounded by a kill: aborting the future would kill git mid-rebase or
    /// mid-commit (kill_on_drop), leaving REBASE_HEAD/index.lock behind. The
    /// status reads Offline until it reports. A full `sync_now`: the
    /// capturing import commits whatever the last session's debounce cut
    /// off, and the export pushes it (plus any offline leftovers).
    pub fn startup(self: &Arc<Self>) {
        let engine = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            if engine.core().await.is_none() {
                return;
            }
            engine.sync_now().await;
        });
    }

    pub async fn status(&self) -> SyncStatusPayload {
        self.status.read().await.clone()
    }

    pub async fn set_status(&self, status: SyncStatusPayload) {
        *self.status.write().await = status.clone();
        let _ = self.app.emit(SETTINGS_SYNC_STATUS_EVENT, status);
    }

    /// `None` while no sync path is configured.
    pub async fn core(&self) -> Option<SyncCore> {
        let state = self.app.state::<AppState>();
        let repo = {
            let settings = state.global_settings.read().await;
            PathBuf::from(settings.settings_sync_path.as_deref()?)
        };
        let git_path = state.git_path.read().await.clone();
        let state_path = state
            .global_settings_path
            .parent()
            .map(|p| p.join("sync-state.json"))
            .unwrap_or_else(|| PathBuf::from("sync-state.json"));
        Some(SyncCore {
            exec: Arc::new(legit_core::GitRunner::for_repo(git_path, &repo)),
            repo,
            user_themes_dir: state.user_themes_dir.clone(),
            state_path,
        })
    }

    pub async fn run_export(&self) -> SyncStatusPayload {
        let _cycle = self.cycle_lock.lock().await;
        let Some(core) = self.core().await else {
            return SyncStatusPayload::of(SyncStatusKind::Disabled);
        };
        let state = self.app.state::<AppState>();
        let settings = state.global_settings.read().await.clone();
        let status = core.export_cycle(&settings).await;
        self.set_status(status.clone()).await;
        status
    }

    /// Plain (non-capturing) import: the ADOPT path, where the repo's
    /// content replacing this machine's is the point.
    pub async fn run_import(&self) -> SyncStatusPayload {
        let _cycle = self.cycle_lock.lock().await;
        self.run_import_locked(false).await
    }

    async fn run_import_locked(&self, capture: bool) -> SyncStatusPayload {
        let Some(core) = self.core().await else {
            return SyncStatusPayload::of(SyncStatusKind::Disabled);
        };
        let state = self.app.state::<AppState>();
        let local = state.global_settings.read().await.clone();
        let (adopted, mut status) = if capture {
            core.import_cycle_capturing(&local).await
        } else {
            core.import_cycle(&local).await
        };
        if let Some(adopted) = adopted {
            // Re-merge over the LIVE settings under the write lock: a value
            // the user changed while the pull ran must not be reverted by the
            // pre-pull snapshot.
            {
                let mut settings = state.global_settings.write().await;
                match import_synced_settings(&settings, &adopted.0) {
                    Ok(merged) => *settings = merged,
                    Err(e) => status = SyncStatusPayload::error(e.to_string()),
                }
            }
            if let Err(e) = state.persist_global_settings().await {
                tracing::warn!(err = %e, "imported synced settings could not be persisted");
            }
            let _ = self.app.emit(GLOBAL_SETTINGS_CHANGED_EVENT, ());
            let _ = self.app.emit(THEMES_CHANGED_EVENT, ());
        }
        self.set_status(status.clone()).await;
        status
    }

    /// Manual "Sync now": import first, then push whatever is left over. An
    /// import that failed (Conflict OR Error, e.g. a malformed sync doc) must
    /// stop here: a follow-on export would overwrite the repo's content and
    /// mask the failure behind an InSync.
    pub async fn sync_now(&self) -> SyncStatusPayload {
        let status = {
            let _cycle = self.cycle_lock.lock().await;
            self.run_import_locked(true).await
        };
        if matches!(
            status.kind,
            SyncStatusKind::Conflict | SyncStatusKind::Error | SyncStatusKind::Disabled
        ) {
            return status;
        }
        self.run_export().await
    }
}
