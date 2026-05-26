//! Multi-repo session commands. Every command takes a `repo_id` (DESIGN.md
//! §4.1) — the centralized lookup-or-error is `AppState::get_session`.

use crate::error::AppError;
use crate::state::{AppState, RepoSession, RepoSummary};
use legit_core::GitRunner;
use std::path::PathBuf;
use std::sync::Arc;

#[tauri::command]
#[specta::specta]
pub async fn open_repo(
    state: tauri::State<'_, AppState>,
    path: String,
) -> Result<RepoSummary, AppError> {
    let path = PathBuf::from(path);
    if !path.exists() {
        return Err(AppError::NotARepo(format!(
            "path does not exist: {}",
            path.display()
        )));
    }
    let git_path = state.git_path.read().await.clone();
    let probe_runner = GitRunner::for_repo(git_path.clone(), &path);
    let out = probe_runner
        .run(&["rev-parse", "--show-toplevel"])
        .await
        .map_err(AppError::from)?;
    if !out.success {
        return Err(AppError::NotARepo(out.stderr.trim().to_string()));
    }
    let toplevel = PathBuf::from(out.stdout.trim());

    // If a session for this canonical path is already open, reuse it.
    // The lock is dropped before any further work.
    let existing_summary = {
        let repos = state.repos.read().await;
        repos
            .values()
            .find(|s| s.path == toplevel)
            .map(|s| s.summary())
    };

    let summary = if let Some(s) = existing_summary {
        tracing::info!(path = %toplevel.display(), id = %s.id, "open_repo: reusing existing session");
        s
    } else {
        let runner = Arc::new(GitRunner::for_repo(git_path, &toplevel));
        let session = Arc::new(RepoSession::new(toplevel, runner));
        let summary = session.summary();
        state
            .repos
            .write()
            .await
            .insert(session.id.clone(), session);
        summary
    };

    // Bump the path to the front of the recents list and remember it as
    // currently-open so it's restored on next launch. Both updates are
    // independent of new-vs-reused — the user explicitly asked to open it.
    {
        let mut settings = state.settings.write().await;
        let p = summary.path.clone();
        settings.last_open_repos.retain(|other| other != &p);
        settings.last_open_repos.insert(0, p.clone());
        settings.last_open_repos.truncate(20);

        if !settings.currently_open.iter().any(|x| x == &p) {
            settings.currently_open.push(p.clone());
        }
        // Opening a repo activates it.
        settings.active_open_repo = Some(p);
    }
    state.persist_settings().await.ok();

    Ok(summary)
}

#[tauri::command]
#[specta::specta]
pub async fn close_repo(
    state: tauri::State<'_, AppState>,
    repo_id: String,
) -> Result<(), AppError> {
    let path = state
        .repos
        .write()
        .await
        .remove(&repo_id)
        .map(|s| s.path.to_string_lossy().to_string());

    if let Some(path) = path {
        let mut settings = state.settings.write().await;
        settings.currently_open.retain(|p| p != &path);
        // If the closed repo was the active one, fall back to the next open
        // path (the frontend will reconcile by picking from the resulting
        // session list anyway).
        if settings.active_open_repo.as_deref() == Some(path.as_str()) {
            settings.active_open_repo = settings.currently_open.last().cloned();
        }
    }
    state.persist_settings().await.ok();
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn set_active_repo(
    state: tauri::State<'_, AppState>,
    repo_id: Option<String>,
) -> Result<(), AppError> {
    let path = if let Some(id) = repo_id {
        state
            .repos
            .read()
            .await
            .get(&id)
            .map(|s| s.path.to_string_lossy().to_string())
    } else {
        None
    };
    {
        let mut settings = state.settings.write().await;
        settings.active_open_repo = path;
    }
    state.persist_settings().await.ok();
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn list_repos(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<RepoSummary>, AppError> {
    let repos = state.repos.read().await;
    let mut out: Vec<RepoSummary> = repos.values().map(|s| s.summary()).collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

#[tauri::command]
#[specta::specta]
pub async fn recent_repos(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<String>, AppError> {
    let settings = state.settings.read().await;
    Ok(settings.last_open_repos.clone())
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, specta::Type)]
pub struct RestoreResult {
    pub repos: Vec<RepoSummary>,
    /// Id of the session matching the persisted active path, if any.
    pub active_id: Option<String>,
}

/// Re-open every repo that was open at last shutdown. Paths that no longer
/// exist (or no longer pass `git rev-parse`) are dropped from settings so
/// the broken entries don't accumulate. The returned `active_id` (if any)
/// matches the persisted active-repo path.
#[tauri::command]
#[specta::specta]
pub async fn restore_open_repos(
    state: tauri::State<'_, AppState>,
) -> Result<RestoreResult, AppError> {
    let (paths, persisted_active) = {
        let s = state.settings.read().await;
        (s.currently_open.clone(), s.active_open_repo.clone())
    };
    let git_path = state.git_path.read().await.clone();

    let mut summaries: Vec<RepoSummary> = Vec::new();
    let mut still_valid: Vec<String> = Vec::new();
    let mut active_id: Option<String> = None;

    for raw in paths {
        let path = PathBuf::from(&raw);
        if !path.exists() {
            tracing::info!(path = %raw, "restore: skipping missing path");
            continue;
        }
        let probe = GitRunner::for_repo(git_path.clone(), &path);
        let Ok(out) = probe.run(&["rev-parse", "--show-toplevel"]).await else {
            tracing::warn!(path = %raw, "restore: rev-parse spawn failed");
            continue;
        };
        if !out.success {
            tracing::info!(path = %raw, stderr = %out.stderr.trim(), "restore: not a repo");
            continue;
        }
        let toplevel = PathBuf::from(out.stdout.trim());

        let existing = {
            let repos = state.repos.read().await;
            repos
                .values()
                .find(|s| s.path == toplevel)
                .map(|s| s.summary())
        };
        let summary = if let Some(s) = existing {
            s
        } else {
            let runner = Arc::new(GitRunner::for_repo(git_path.clone(), &toplevel));
            let session = Arc::new(RepoSession::new(toplevel.clone(), runner));
            let summary = session.summary();
            state
                .repos
                .write()
                .await
                .insert(session.id.clone(), session);
            summary
        };
        still_valid.push(summary.path.clone());
        if persisted_active.as_deref() == Some(summary.path.as_str()) {
            active_id = Some(summary.id.clone());
        }
        summaries.push(summary);
    }

    // If the persisted active didn't survive, fall back to the first restored
    // repo so the user lands on *something* rather than nothing.
    if active_id.is_none() {
        active_id = summaries.first().map(|s| s.id.clone());
    }

    // Persist the cleaned list (drops broken entries; preserves order).
    {
        let mut settings = state.settings.write().await;
        settings.currently_open = still_valid;
        if let Some(id) = &active_id {
            settings.active_open_repo = summaries
                .iter()
                .find(|s| &s.id == id)
                .map(|s| s.path.clone());
        }
    }
    state.persist_settings().await.ok();

    Ok(RestoreResult {
        repos: summaries,
        active_id,
    })
}
