//! Multi-repo session commands.
//! Every repo command takes a `repo_id`; global scope takes none.
//! See DESIGN-v0.2.md §D.3.

use crate::error::AppError;
use crate::state::{
    load_repo_settings_sync, AppState, LaneLock, RepoSession, RepoSettings,
    RepoSummary,
};
use legit_core::{classify_remote_error, GitError, GitRunner, OperationId};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::Manager as _;

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

/// Session bookkeeping (open-repo list, active repo, tab order) is
/// deliberately best-effort: a failed settings persist must never fail the
/// primary operation. But it must not be silent either (house rule): log a
/// warning so "my tabs did not survive a restart" is diagnosable.
fn warn_if_bookkeeping_persist_failed(what: &str, result: Result<(), AppError>) {
    if let Err(e) = result {
        tracing::warn!(err = %e, what, "session bookkeeping persist failed");
    }
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
    // Reuse-or-insert under ONE `repos` write guard: two concurrent opens of
    // the same directory (double-click, open racing restore) must never both
    // miss the lookup and create twin sessions + watchers. No await happens
    // while the guard is held; the watcher starts outside it (it runs git).
    let session = {
        let mut repos = state.repos.write().await;
        if let Some(existing) = repos.values().find(|s| same_dir(&s.path, &toplevel)) {
            tracing::info!(path = %toplevel.display(), id = %existing.id, "open: reusing existing session");
            return existing.summary();
        }
        let (_, settings_path) = state.repo_data_paths(&toplevel);
        let repo_settings = load_repo_settings_sync(&settings_path);
        let resolved_git = resolve_repo_git_path(&repo_settings, &global_git_path);

        let runner = Arc::new(GitRunner::for_repo(resolved_git, &toplevel));
        let session = Arc::new(RepoSession::new(toplevel, runner, repo_settings, settings_path));
        repos.insert(session.id.clone(), session.clone());
        session
    };
    tracing::info!(path = %session.path.display(), id = %session.id, "open: new session");
    let summary = session.summary();
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

/// Whether two paths name the same directory, regardless of spelling.
/// Session paths come from `git rev-parse --show-toplevel` output and
/// persisted settings, which can disagree in separator style or case (e.g. a
/// repo reached once via the file dialog and once through a submodule chain).
/// A literal `PathBuf` comparison then misses the match and a second session
/// opens for the same repo - so compare filesystem identity instead.
fn same_dir(a: &Path, b: &Path) -> bool {
    if a == b {
        return true;
    }
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(ca), Ok(cb)) => ca == cb,
        _ => false,
    }
}

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

    // open_session reuses an existing session for this directory (identity
    // comparison, atomically with the insert) or creates one.
    let summary = open_session(state, app, git_path, toplevel).await;

    warn_if_bookkeeping_persist_failed(
        "record opened repo",
        state
            .mutate_global(|settings| {
                let p = summary.path.clone();
                settings.last_open_repos.retain(|other| other != &p);
                settings.last_open_repos.insert(0, p.clone());
                settings.last_open_repos.truncate(20);
                if !settings.currently_open.iter().any(|x| x == &p) {
                    settings.currently_open.push(p.clone());
                }
                settings.active_open_repo = Some(p);
            })
            .await,
    );

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

/// Build the `git init` argument list. Pure so the option handling is
/// unit-testable; blank branch names degrade to git's default.
fn build_init_args(bare: bool, initial_branch: Option<&str>) -> Vec<String> {
    let mut args = vec!["init".to_string()];
    if bare {
        args.push("--bare".into());
    }
    if let Some(branch) = initial_branch.map(str::trim).filter(|b| !b.is_empty()) {
        args.push("--initial-branch".into());
        args.push(branch.to_string());
    }
    args
}

/// Initialize a new repository in `path` (`git init`), open it, and optionally
/// apply (and select) a profile. `path` must be an existing directory.
///
/// A `--bare` repository has no worktree, so it cannot become a session:
/// it is created but not opened, and the result is `None` (profiles are
/// session-scoped, so a profile selection is ignored for bare repos too).
#[tauri::command]
#[specta::specta]
pub async fn repo_init(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    path: String,
    profile_id: Option<String>,
    bare: bool,
    initial_branch: Option<String>,
) -> Result<Option<RepoSummary>, AppError> {
    let dir = PathBuf::from(&path);
    if !dir.exists() {
        return Err(AppError::NotARepo(format!(
            "path does not exist: {}",
            dir.display()
        )));
    }
    let git_path = state.git_path.read().await.clone();
    let runner = GitRunner::for_repo(git_path.clone(), &dir);
    let args = build_init_args(bare, initial_branch.as_deref());
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let out = runner.run(&arg_refs).await.map_err(AppError::from)?;
    if !out.success {
        return Err(AppError::Git(GitError::CommandFailed {
            exit_code: out.exit_code.unwrap_or(-1),
            stderr: out.stderr.trim().to_string(),
        }));
    }
    if bare {
        return Ok(None);
    }
    let summary = register_open_repo(&state, &app, git_path, dir).await?;
    if let Some(pid) = profile_id {
        let session = state.get_session(&summary.id).await?;
        crate::commands::profiles::apply_profile_core(&state, &session, &pid).await?;
    }
    Ok(Some(summary))
}

/// Build the `git clone` argument list (auth `-c` overrides are spliced in
/// front by the caller). Pure so the option handling is unit-testable.
///
/// `--progress` forces the transfer meter onto our piped stderr; the runner
/// parses it into progress-observer updates and strips it from logged output.
fn build_clone_args(
    url: &str,
    name: &str,
    depth: Option<u32>,
    branch: Option<&str>,
    recurse_submodules: bool,
) -> Vec<String> {
    let mut args = vec!["clone".to_string(), "--progress".to_string()];
    if let Some(depth) = depth.filter(|d| *d > 0) {
        args.push("--depth".into());
        args.push(depth.to_string());
    }
    if let Some(branch) = branch.map(str::trim).filter(|b| !b.is_empty()) {
        args.push("--branch".into());
        args.push(branch.to_string());
    }
    if recurse_submodules {
        args.push("--recurse-submodules".into());
    }
    args.push(url.to_string());
    args.push(name.to_string());
    args
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
    depth: Option<u32>,
    branch: Option<String>,
    recurse_submodules: bool,
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
    args.extend(build_clone_args(
        &url,
        &name,
        depth,
        branch.as_deref(),
        recurse_submodules,
    ));

    // Run on a transient runner registered for the op so cancel_clone can reach it.
    let oid = OperationId(op_id);
    let runner = Arc::new(GitRunner::for_repo(git_path.clone(), &parent));
    state
        .transient_ops
        .lock()
        .unwrap()
        .insert(oid.clone(), runner.clone());
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let result = runner.run_with_op_progress(&arg_refs, oid.clone()).await;
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
        warn_if_bookkeeping_persist_failed(
            "record closed repo",
            state
                .mutate_global(|settings| {
                    settings.currently_open.retain(|p| p != &path);
                    if settings.active_open_repo.as_deref() == Some(path.as_str()) {
                        settings.active_open_repo = settings.currently_open.last().cloned();
                    }
                })
                .await,
        );
    }
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
    warn_if_bookkeeping_persist_failed(
        "record active repo",
        state
            .mutate_global(|settings| settings.active_open_repo = path)
            .await,
    );
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
    warn_if_bookkeeping_persist_failed(
        "record watcher toggle",
        state
            .mutate_global(|s| {
                s.watcher_enabled = enabled;
            })
            .await,
    );

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
    // Snapshot for the final merge: `currently_open` entries added while
    // restore runs (open_repo racing the splash) must not be clobbered.
    let snapshot: std::collections::HashSet<String> = paths.iter().cloned().collect();
    let git_path = state.git_path.read().await.clone();

    let mut summaries: Vec<RepoSummary> = Vec::new();
    let mut still_valid: Vec<String> = Vec::new();
    let mut active_id: Option<String> = None;

    // Probe phase: all persisted paths concurrently. This is the startup hot
    // path (the frontend holds the splash until restore completes): each repo
    // costs at least one process spawn, which dominates on Windows, so with
    // many repos sequential probing is the visible splash time.
    let probe_handles: Vec<_> = paths
        .into_iter()
        .map(|raw| {
            let git_path = git_path.clone();
            tokio::spawn(async move {
                let path = PathBuf::from(&raw);
                if !path.exists() {
                    tracing::info!(path = %raw, "restore: skipping missing path");
                    return None;
                }
                let probe = GitRunner::for_repo(git_path, &path);
                let Ok(out) = probe.run(&["rev-parse", "--show-toplevel"]).await else {
                    tracing::warn!(path = %raw, "restore: rev-parse spawn failed");
                    return None;
                };
                if !out.success {
                    tracing::info!(path = %raw, stderr = %out.stderr.trim(), "restore: not a repo");
                    return None;
                }
                Some(PathBuf::from(out.stdout.trim()))
            })
        })
        .collect();

    // Await in submission order (keeps the user-controlled tab order) and
    // dedup by resolved toplevel BEFORE opening anything: two persisted paths
    // inside the same repo must not race to create two sessions for it.
    let mut toplevels: Vec<PathBuf> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for handle in probe_handles {
        if let Ok(Some(toplevel)) = handle.await {
            // Key the dedup on filesystem identity, not spelling (see
            // `same_dir`): persisted entries can carry different forms of
            // the same directory.
            let key = std::fs::canonicalize(&toplevel).unwrap_or_else(|_| toplevel.clone());
            if seen.insert(key) {
                toplevels.push(toplevel);
            }
        }
    }

    // Open phase: sessions concurrently (settings read + git spawn + watcher
    // each), reassembled in the persisted order below. The concurrent
    // sessions insert into the `repos` map behind its RwLock; the toplevels
    // are unique, so no two tasks open the same repo.
    let open_handles: Vec<_> = toplevels
        .into_iter()
        .map(|toplevel| {
            let app = app.clone();
            let git_path = git_path.clone();
            tokio::spawn(async move {
                let state = app.state::<AppState>();
                // open_session reuses-or-creates atomically, so a restore
                // racing a manual open of the same repo cannot double-open.
                open_session(&state, &app, git_path, toplevel).await
            })
        })
        .collect();

    for handle in open_handles {
        let Ok(summary) = handle.await else { continue };
        still_valid.push(summary.path.clone());
        if persisted_active.as_deref() == Some(summary.path.as_str()) {
            active_id = Some(summary.id.clone());
        }
        summaries.push(summary);
    }

    if active_id.is_none() {
        active_id = summaries.first().map(|s| s.id.clone());
    }

    warn_if_bookkeeping_persist_failed(
        "record restored repos",
        state
            .mutate_global(|settings| {
                // Merge instead of overwrite: keep any paths that were opened while
                // restore was running (they weren't in our snapshot), in their order.
                let mut merged = still_valid;
                for p in &settings.currently_open {
                    if !snapshot.contains(p) && !merged.contains(p) {
                        merged.push(p.clone());
                    }
                }
                settings.currently_open = merged;
                // Keep active consistent with the list: clear it when nothing
                // restored, rather than leaving a pointer at a repo that is gone.
                settings.active_open_repo = active_id
                    .as_ref()
                    .and_then(|id| summaries.iter().find(|s| &s.id == id))
                    .map(|s| s.path.clone())
                    .or_else(|| settings.currently_open.first().cloned());
            })
            .await,
    );

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
    warn_if_bookkeeping_persist_failed(
        "record tab order",
        state
            .mutate_global(|settings| {
                let mut next = ordered_paths;
                for p in &settings.currently_open {
                    if !next.contains(p) {
                        next.push(p.clone());
                    }
                }
                settings.currently_open = next;
            })
            .await,
    );
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
        *s = settings;
    }
    state.persist_session_settings(&session).await
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
    let locks = {
        let mut s = session.settings.write().await;
        if let Some(existing) = s.lane_locks_doc.locks.iter_mut().find(|l| l.ref_name == ref_name) {
            existing.lane_index = lane_index;
        } else {
            s.lane_locks_doc.locks.push(LaneLock { ref_name, lane_index });
        }
        s.lane_locks_doc.locks.clone()
    };
    state.persist_session_settings(&session).await?;
    Ok(locks)
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
    let locks = {
        let mut s = session.settings.write().await;
        s.lane_locks_doc.locks.retain(|l| l.ref_name != ref_name);
        s.lane_locks_doc.locks.clone()
    };
    state.persist_session_settings(&session).await?;
    Ok(locks)
}

#[cfg(test)]
mod tests {
    #[test]
    fn same_dir_matches_different_spellings_of_one_directory() {
        let dir = tempfile::tempdir().expect("tempdir");
        let a = dir.path().to_path_buf();
        // A non-canonical spelling of the same directory (extra `.` hop).
        let b = a.join(".");
        assert!(super::same_dir(&a, &b));
        // A genuinely different (non-existent) path never matches.
        assert!(!super::same_dir(&a, &a.join("elsewhere")));
    }

    use super::{build_clone_args, build_init_args};

    #[test]
    fn clone_args_default_is_progress_url_name() {
        assert_eq!(
            build_clone_args("https://x/y.git", "y", None, None, false),
            vec!["clone", "--progress", "https://x/y.git", "y"],
        );
    }

    #[test]
    fn clone_args_with_all_options() {
        assert_eq!(
            build_clone_args("https://x/y.git", "y", Some(1), Some("dev"), true),
            vec![
                "clone",
                "--progress",
                "--depth",
                "1",
                "--branch",
                "dev",
                "--recurse-submodules",
                "https://x/y.git",
                "y",
            ],
        );
    }

    #[test]
    fn clone_args_ignore_blank_branch_and_zero_depth() {
        assert_eq!(
            build_clone_args("u", "n", Some(0), Some("  "), false),
            vec!["clone", "--progress", "u", "n"],
        );
    }

    #[test]
    fn init_args_default_is_bare_init() {
        assert_eq!(build_init_args(false, None), vec!["init"]);
    }

    #[test]
    fn init_args_with_bare_and_initial_branch() {
        assert_eq!(
            build_init_args(true, Some("trunk")),
            vec!["init", "--bare", "--initial-branch", "trunk"],
        );
        assert_eq!(build_init_args(false, Some(" ")), vec!["init"]);
    }
}
