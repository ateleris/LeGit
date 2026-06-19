//! Multi-repo session commands.
//! Every repo command takes a `repo_id`; global scope takes none.
//! See DESIGN-v0.2.md §D.3.

use crate::error::AppError;
use crate::state::{
    load_repo_settings_sync, persist_repo_settings, AppState, LaneLock, RepoSession, RepoSettings,
    RepoSummary,
};
use legit_core::{classify_remote_error, GitError, GitRunner, OperationId};
use std::path::PathBuf;
use std::sync::Arc;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Resolve the git binary for a specific repo: repo override → global.
/// Falls back to `global_git_path` if the override path doesn't exist.
pub fn resolve_repo_git_path(
    repo_settings: &RepoSettings,
    global_git_path: &std::path::Path,
) -> PathBuf {
    if let Some(ref ov) = repo_settings.git_path_override {
        let p = PathBuf::from(ov);
        if p.exists() {
            return p;
        }
        tracing::warn!(
            override_path = ?p,
            "repo git path override does not exist — falling back to global"
        );
    }
    global_git_path.to_path_buf()
}

/// Open (or reuse) a session for `toplevel`, loading its `RepoSettings`
/// and resolving the git binary through the scope hierarchy. Starts a
/// filesystem watcher for the new session when watching is enabled.
pub async fn open_session(
    state: &AppState,
    app: &tauri::AppHandle,
    global_git_path: PathBuf,
    toplevel: PathBuf,
) -> RepoSummary {
    let (_, settings_path) = state.repo_data_paths(&toplevel);
    let repo_settings = load_repo_settings_sync(&settings_path);
    let resolved_git = resolve_repo_git_path(&repo_settings, &global_git_path);

    let runner = Arc::new(GitRunner::for_repo(resolved_git, &toplevel));
    let session = Arc::new(RepoSession::new(toplevel, runner, repo_settings, settings_path));
    let summary = session.summary();
    state
        .repos
        .write()
        .await
        .insert(session.id.clone(), session.clone());
    start_repo_watcher(state, app, &session).await;
    summary
}

/// Start (and register) a filesystem watcher for `session`, unless watching is
/// disabled in global settings. Resolves the git dir so linked worktrees /
/// submodules (where `.git` is a file pointing elsewhere) are watched correctly.
/// Best-effort: a failure is logged, never fatal to opening the repo.
async fn start_repo_watcher(state: &AppState, app: &tauri::AppHandle, session: &Arc<RepoSession>) {
    if !state.global_settings.read().await.watcher_enabled {
        return;
    }
    let runner = session.runner.read().await.clone();
    let git_dir = match runner.run(&["rev-parse", "--absolute-git-dir"]).await {
        Ok(out) if out.success => PathBuf::from(out.stdout.trim()),
        _ => session.path.join(".git"),
    };
    match crate::watcher::RepoWatcher::start(
        app.clone(),
        session.id.clone(),
        session.path.clone(),
        git_dir,
    ) {
        Ok(w) => {
            state.watchers.lock().unwrap().insert(session.id.clone(), w);
        }
        Err(e) => {
            tracing::warn!(repo_id = %session.id, err = %e, "failed to start repo watcher");
        }
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Probe `probe_path` for its repo top-level, reuse-or-open a session for it, and
/// update the recent/open/active bookkeeping. Shared by `open_repo`, `repo_init`,
/// and `repo_clone`.
async fn register_open_repo(
    state: &AppState,
    app: &tauri::AppHandle,
    git_path: PathBuf,
    probe_path: PathBuf,
) -> Result<RepoSummary, AppError> {
    let probe_runner = GitRunner::for_repo(git_path.clone(), &probe_path);
    let out = probe_runner
        .run(&["rev-parse", "--show-toplevel"])
        .await
        .map_err(AppError::from)?;
    if !out.success {
        return Err(AppError::NotARepo(out.stderr.trim().to_string()));
    }
    let toplevel = PathBuf::from(out.stdout.trim());

    // Reuse an existing session for this canonical path if one is open.
    let existing_summary = {
        let repos = state.repos.read().await;
        repos
            .values()
            .find(|s| s.path == toplevel)
            .map(|s| s.summary())
    };

    let summary = if let Some(s) = existing_summary {
        tracing::info!(path = %toplevel.display(), id = %s.id, "open: reusing existing session");
        s
    } else {
        open_session(state, app, git_path, toplevel).await
    };

    {
        let mut settings = state.global_settings.write().await;
        let p = summary.path.clone();
        settings.last_open_repos.retain(|other| other != &p);
        settings.last_open_repos.insert(0, p.clone());
        settings.last_open_repos.truncate(20);
        if !settings.currently_open.iter().any(|x| x == &p) {
            settings.currently_open.push(p.clone());
        }
        settings.active_open_repo = Some(p);
    }
    state.persist_global_settings().await.ok();

    Ok(summary)
}

#[tauri::command]
#[specta::specta]
pub async fn open_repo(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
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
    register_open_repo(&state, &app, git_path, path).await
}

/// Initialize a new repository in `path` (`git init`), open it, and optionally
/// apply (and select) a profile. `path` must be an existing directory.
#[tauri::command]
#[specta::specta]
pub async fn repo_init(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    path: String,
    profile_id: Option<String>,
) -> Result<RepoSummary, AppError> {
    let dir = PathBuf::from(&path);
    if !dir.exists() {
        return Err(AppError::NotARepo(format!(
            "path does not exist: {}",
            dir.display()
        )));
    }
    let git_path = state.git_path.read().await.clone();
    let runner = GitRunner::for_repo(git_path.clone(), &dir);
    let out = runner.run(&["init"]).await.map_err(AppError::from)?;
    if !out.success {
        return Err(AppError::Git(GitError::CommandFailed {
            exit_code: out.exit_code.unwrap_or(-1),
            stderr: out.stderr.trim().to_string(),
        }));
    }
    let summary = register_open_repo(&state, &app, git_path, dir).await?;
    if let Some(pid) = profile_id {
        let session = state.get_session(&summary.id).await?;
        crate::commands::profiles::apply_profile_core(&state, &session, &pid).await?;
    }
    Ok(summary)
}

/// Clone `url` into `parent_dir/name`, open it, and optionally apply (and select)
/// a profile. When a profile is given its auth is injected into the clone via
/// `-c` (so the clone authenticates with that identity) and then applied to the
/// new repo. Cancellable via `cancel_clone(op_id)`.
#[tauri::command]
#[specta::specta]
pub async fn repo_clone(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    url: String,
    parent_dir: String,
    name: String,
    profile_id: Option<String>,
    op_id: String,
) -> Result<RepoSummary, AppError> {
    let parent = PathBuf::from(&parent_dir);
    if !parent.exists() {
        return Err(AppError::NotARepo(format!(
            "directory does not exist: {}",
            parent.display()
        )));
    }
    let git_path = state.git_path.read().await.clone();

    // git-level `-c` auth overrides from the optional profile, then `clone`.
    let mut args: Vec<String> = Vec::new();
    if let Some(pid) = &profile_id {
        let profile = state
            .global_settings
            .read()
            .await
            .git_profiles_doc
            .profiles
            .iter()
            .find(|p| p.id == *pid)
            .cloned()
            .ok_or_else(|| AppError::UnknownProfile(pid.clone()))?;
        args.extend(crate::commands::profiles::clone_auth_config_args(&profile));
    }
    args.push("clone".into());
    args.push(url.clone());
    args.push(name.clone());

    // Run on a transient runner registered for the op so cancel_clone can reach it.
    let oid = OperationId(op_id);
    let runner = Arc::new(GitRunner::for_repo(git_path.clone(), &parent));
    state
        .transient_ops
        .lock()
        .unwrap()
        .insert(oid.clone(), runner.clone());
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let result = runner.run_with_op(&arg_refs, oid.clone()).await;
    state.transient_ops.lock().unwrap().remove(&oid);

    let out = result.map_err(AppError::from)?;
    if !out.success {
        return Err(AppError::Git(classify_remote_error(
            out.exit_code.unwrap_or(-1),
            &out.stderr,
        )));
    }

    let summary = register_open_repo(&state, &app, git_path, parent.join(&name)).await?;
    if let Some(pid) = profile_id {
        let session = state.get_session(&summary.id).await?;
        crate::commands::profiles::apply_profile_core(&state, &session, &pid).await?;
    }
    Ok(summary)
}

/// Cancel an in-flight `repo_clone` by its `op_id`. Returns whether the op was found.
#[tauri::command]
#[specta::specta]
pub async fn cancel_clone(
    state: tauri::State<'_, AppState>,
    op_id: String,
) -> Result<bool, AppError> {
    let oid = OperationId(op_id);
    let runner = state.transient_ops.lock().unwrap().get(&oid).cloned();
    Ok(match runner {
        Some(r) => r.cancel(&oid),
        None => false,
    })
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

    // Stop and drop the repo's watcher (no-op if watching was disabled).
    state.watchers.lock().unwrap().remove(&repo_id);

    if let Some(path) = path {
        let mut settings = state.global_settings.write().await;
        settings.currently_open.retain(|p| p != &path);
        if settings.active_open_repo.as_deref() == Some(path.as_str()) {
            settings.active_open_repo = settings.currently_open.last().cloned();
        }
    }
    state.persist_global_settings().await.ok();
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
        let mut settings = state.global_settings.write().await;
        settings.active_open_repo = path;
    }
    state.persist_global_settings().await.ok();
    Ok(())
}

/// Toggle the filesystem watcher globally and apply it live: start watchers for
/// all open repos when enabling, drop them all when disabling. Persisted so the
/// choice survives restart.
#[tauri::command]
#[specta::specta]
pub async fn set_watcher_enabled(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    enabled: bool,
) -> Result<(), AppError> {
    {
        let mut s = state.global_settings.write().await;
        s.watcher_enabled = enabled;
    }
    state.persist_global_settings().await.ok();

    if enabled {
        let sessions: Vec<Arc<RepoSession>> =
            state.repos.read().await.values().cloned().collect();
        for session in sessions {
            let already = state.watchers.lock().unwrap().contains_key(&session.id);
            if !already {
                start_repo_watcher(&state, &app, &session).await;
            }
        }
    } else {
        state.watchers.lock().unwrap().clear();
    }
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
    let settings = state.global_settings.read().await;
    Ok(settings.last_open_repos.clone())
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, specta::Type)]
pub struct RestoreResult {
    pub repos: Vec<RepoSummary>,
    pub active_id: Option<String>,
}

#[tauri::command]
#[specta::specta]
pub async fn restore_open_repos(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<RestoreResult, AppError> {
    let (paths, persisted_active) = {
        let s = state.global_settings.read().await;
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
            open_session(&state, &app, git_path.clone(), toplevel.clone()).await
        };
        still_valid.push(summary.path.clone());
        if persisted_active.as_deref() == Some(summary.path.as_str()) {
            active_id = Some(summary.id.clone());
        }
        summaries.push(summary);
    }

    if active_id.is_none() {
        active_id = summaries.first().map(|s| s.id.clone());
    }

    {
        let mut settings = state.global_settings.write().await;
        settings.currently_open = still_valid;
        if let Some(id) = &active_id {
            settings.active_open_repo = summaries
                .iter()
                .find(|s| &s.id == id)
                .map(|s| s.path.clone());
        }
    }
    state.persist_global_settings().await.ok();

    Ok(RestoreResult {
        repos: summaries,
        active_id,
    })
}

/// Persist the repository tab order: reorder `currently_open` (paths) to match
/// the given repo-id order. Ids that aren't open are ignored; any open repo
/// missing from the list is kept at the end. Drives tab order on restore.
#[tauri::command]
#[specta::specta]
pub async fn set_open_repos_order(
    state: tauri::State<'_, AppState>,
    repo_ids: Vec<String>,
) -> Result<(), AppError> {
    let ordered_paths: Vec<String> = {
        let repos = state.repos.read().await;
        repo_ids
            .iter()
            .filter_map(|id| repos.get(id).map(|s| s.summary().path))
            .collect()
    };
    {
        let mut settings = state.global_settings.write().await;
        let mut next = ordered_paths;
        for p in &settings.currently_open {
            if !next.contains(p) {
                next.push(p.clone());
            }
        }
        settings.currently_open = next;
    }
    state.persist_global_settings().await.ok();
    Ok(())
}

/// Read the repo-scoped settings for an open repo.
#[tauri::command]
#[specta::specta]
pub async fn get_repo_settings(
    state: tauri::State<'_, AppState>,
    repo_id: String,
) -> Result<RepoSettings, AppError> {
    let session = state.get_session(&repo_id).await?;
    let s = session.settings.read().await.clone();
    Ok(s)
}

/// Replace the repo-scoped settings and persist them to disk.
#[tauri::command]
#[specta::specta]
pub async fn update_repo_settings(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    settings: RepoSettings,
) -> Result<(), AppError> {
    let session = state.get_session(&repo_id).await?;
    {
        let mut s = session.settings.write().await;
        *s = settings.clone();
    }
    let (repo_dir, _) = state.repo_data_paths(&session.path);
    persist_repo_settings(&settings, &repo_dir, &session.settings_path, &session.path).await
}

/// Return all lane locks for an open repo.
#[tauri::command]
#[specta::specta]
pub async fn list_lane_locks(
    state: tauri::State<'_, AppState>,
    repo_id: String,
) -> Result<Vec<LaneLock>, AppError> {
    let session = state.get_session(&repo_id).await?;
    let locks = session.settings.read().await.lane_locks_doc.locks.clone();
    Ok(locks)
}

/// Add or replace a lane lock. Returns the updated lock list.
/// Rejects lane_index > 64.
#[tauri::command]
#[specta::specta]
pub async fn set_lane_lock(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    ref_name: String,
    lane_index: u32,
) -> Result<Vec<LaneLock>, AppError> {
    if lane_index > 64 {
        return Err(AppError::InvalidLockIndex(lane_index));
    }
    let session = state.get_session(&repo_id).await?;
    let settings = {
        let mut s = session.settings.write().await;
        if let Some(existing) = s.lane_locks_doc.locks.iter_mut().find(|l| l.ref_name == ref_name) {
            existing.lane_index = lane_index;
        } else {
            s.lane_locks_doc.locks.push(LaneLock { ref_name, lane_index });
        }
        s.clone()
    };
    let (repo_dir, _) = state.repo_data_paths(&session.path);
    persist_repo_settings(&settings, &repo_dir, &session.settings_path, &session.path).await?;
    Ok(settings.lane_locks_doc.locks)
}

/// Remove a lane lock by ref name. Returns the updated lock list (no-op if not found).
#[tauri::command]
#[specta::specta]
pub async fn unset_lane_lock(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    ref_name: String,
) -> Result<Vec<LaneLock>, AppError> {
    let session = state.get_session(&repo_id).await?;
    let settings = {
        let mut s = session.settings.write().await;
        s.lane_locks_doc.locks.retain(|l| l.ref_name != ref_name);
        s.clone()
    };
    let (repo_dir, _) = state.repo_data_paths(&session.path);
    persist_repo_settings(&settings, &repo_dir, &session.settings_path, &session.path).await?;
    Ok(settings.lane_locks_doc.locks)
}
