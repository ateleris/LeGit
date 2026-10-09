//! Commands for the settings-sync feature: probe/designate the sync
//! repository, query status, and sync on demand. `settings_sync_path` is
//! command-owned because setting it has side effects (adopt or seed).

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::AppError;
use crate::state::AppState;
use crate::sync::engine::{SyncCore, SyncStatusKind, SyncStatusPayload};
use crate::sync::tauri_engine::SyncHandle;
use legit_core::GitExecutor as _;

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncProbe {
    pub valid: bool,
    pub reason: Option<String>,
    pub has_sync_doc: bool,
}

/// The one refusal (or none) for a sync-path candidate, in check order.
fn probe_reason(exists: bool, is_git: bool, has_branch: bool, has_remote: bool) -> Option<String> {
    if !exists {
        return Some("the folder does not exist".into());
    }
    if !is_git {
        return Some("the folder is not a git repository".into());
    }
    if !has_branch {
        return Some("the repository has no branch checked out".into());
    }
    if !has_remote {
        return Some("the repository has no remote to sync with".into());
    }
    None
}

async fn probe(state: &AppState, path: &str) -> SyncProbe {
    let dir = Path::new(path);
    let exists = dir.is_dir();
    let is_git = exists && dir.join(".git").exists();
    let (mut has_branch, mut has_remote) = (false, false);
    if is_git {
        let git_path = state.git_path.read().await.clone();
        let runner = legit_core::GitRunner::for_repo(git_path, dir);
        has_branch = matches!(
            runner.run_expecting(&["symbolic-ref", "-q", "HEAD"], &[1]).await,
            Ok(out) if out.success
        );
        has_remote = matches!(
            legit_core::sync::first_remote(&runner).await,
            Ok(Some(_))
        );
    }
    let reason = probe_reason(exists, is_git, has_branch, has_remote);
    SyncProbe {
        valid: reason.is_none(),
        reason,
        has_sync_doc: SyncCore::has_sync_doc(dir).await,
    }
}

#[tauri::command]
#[specta::specta]
pub async fn probe_settings_sync_path(
    state: tauri::State<'_, AppState>,
    path: String,
) -> Result<SyncProbe, AppError> {
    Ok(probe(&state, &path).await)
}

/// Designate (adopt or seed), or clear with `None`.
#[tauri::command]
#[specta::specta]
pub async fn set_settings_sync_path(
    state: tauri::State<'_, AppState>,
    engine: tauri::State<'_, SyncHandle>,
    path: Option<String>,
) -> Result<SyncStatusPayload, AppError> {
    let Some(path) = path else {
        {
            let mut settings = state.global_settings.write().await;
            settings.settings_sync_path = None;
        }
        state.persist_global_settings().await?;
        let status = SyncStatusPayload::of(SyncStatusKind::Disabled);
        engine.0.set_status(status.clone()).await;
        return Ok(status);
    };
    let probe = probe(&state, &path).await;
    if let Some(reason) = probe.reason {
        return Err(AppError::Settings(reason));
    }
    {
        let mut settings = state.global_settings.write().await;
        settings.settings_sync_path = Some(path);
    }
    state.persist_global_settings().await?;
    // A repo that already carries a sync doc is adopted (its settings win);
    // an empty one is seeded from this machine.
    let status = if probe.has_sync_doc {
        engine.0.run_import().await
    } else {
        engine.0.run_export().await
    };
    Ok(status)
}

#[tauri::command]
#[specta::specta]
pub async fn settings_sync_now(
    engine: tauri::State<'_, SyncHandle>,
) -> Result<SyncStatusPayload, AppError> {
    Ok(engine.0.sync_now().await)
}

#[tauri::command]
#[specta::specta]
pub async fn settings_sync_status(
    engine: tauri::State<'_, SyncHandle>,
) -> Result<SyncStatusPayload, AppError> {
    Ok(engine.0.status().await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probe_refusals_name_the_failed_check() {
        assert!(probe_reason(true, true, true, true).is_none());
        assert!(probe_reason(false, false, false, false).unwrap().contains("does not exist"));
        assert!(probe_reason(true, false, false, false).unwrap().contains("not a git repository"));
        assert!(probe_reason(true, true, false, true).unwrap().contains("no branch"));
        assert!(probe_reason(true, true, true, false).unwrap().contains("no remote"));
    }
}
