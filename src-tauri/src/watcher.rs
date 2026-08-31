//! Tauri side of the extracted watcher core (`legit-watch`).
//!
//! The core (notify wiring, debounce, change-domain classification) lives in
//! `crates/legit-watch`, and starting a watch goes through the repo's `Host`
//! (`legit-host`), so remote repos watch on the remote machine. This module
//! only supplies the sink that binds a watch to a `repo_id` and forwards each
//! classified batch to the frontend as the repo-changed event.

use tauri::{AppHandle, Emitter};

pub use legit_watch::{RepoChangedPayload, WatchBatch};
use legit_watch::WatchSink;

/// Tauri event channel carrying which query domains changed for a repo.
pub const REPO_CHANGED_EVENT: &str = "legit://repo-changed";

/// A sink that emits each batch as [`REPO_CHANGED_EVENT`] for `repo_id`.
pub fn emit_sink(app: AppHandle, repo_id: String) -> WatchSink {
    Box::new(move |batch: WatchBatch| {
        let payload = RepoChangedPayload {
            repo_id: repo_id.clone(),
            domains: batch.domains,
            trigger_paths: batch.trigger_paths,
            trigger_count: batch.trigger_count,
        };
        if let Err(e) = app.emit(REPO_CHANGED_EVENT, payload) {
            tracing::warn!(err = %e, "failed to emit repo-changed event");
        }
    })
}
