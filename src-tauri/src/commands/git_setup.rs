//! Startup `git --version` check and runtime Git binary path configuration
//! (DESIGN.md §7.6).

use crate::error::AppError;
use crate::git_resolve::resolve_git_path;
use crate::state::{AppState, RepoSummary};
use crate::commands::repo::resolve_repo_git_path;
use legit_core::{GitRunner, GitVersion, MIN_SUPPORTED_GIT_VERSION};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct GitStatus {
    pub resolved_path: String,
    /// `null` when the binary cannot be spawned at all.
    pub version: Option<GitVersion>,
    /// `true` when `version` is set and meets the minimum (§7.6).
    pub meets_minimum: bool,
    pub minimum_required: (u32, u32, u32),
    pub user_override: Option<String>,
    pub error: Option<String>,
}

#[tauri::command]
#[specta::specta]
pub async fn git_status_check(
    state: tauri::State<'_, AppState>,
) -> Result<GitStatus, AppError> {
    let path = state.git_path.read().await.clone();
    let user_override = state.global_settings.read().await.git_path_override.clone();
    probe(&path, user_override).await
}

#[tauri::command]
#[specta::specta]
pub async fn set_git_path(
    state: tauri::State<'_, AppState>,
    path: Option<String>,
) -> Result<GitStatus, AppError> {
    let override_pb = path.as_deref().map(PathBuf::from);
    let resolved = resolve_git_path(override_pb.as_ref());
    // Separate acquisitions - nesting them would pin a lock order for no gain.
    {
        let mut current = state.git_path.write().await;
        *current = resolved.clone();
    }
    state
        .mutate_global(|settings| settings.git_path_override = path.clone())
        .await?;

    // Hot-swap the runner of every open LOCAL session so the change takes
    // effect immediately - this is what the `RwLock<Arc<GitRunner>>`
    // indirection in `RepoSession` exists for. Sessions with a per-repo
    // override keep their own binary (`resolve_repo_git_path` prefers the
    // override when valid). Remote sessions are skipped: their git binary
    // lives on the remote host (host override or the agent's PATH `git`) and
    // must never be replaced by an app-machine path.
    // Snapshot the sessions first: the per-session awaits below must not run
    // under the `repos` guard (holding an AppState lock across awaits blocks
    // close/open for the whole loop).
    let sessions: Vec<_> = state.repos.read().await.values().cloned().collect();
    for session in sessions {
        let repo_settings = session.settings.read().await.clone();
        let Some(effective) = local_hot_swap_git(&session.locator, &repo_settings, &resolved)
        else {
            continue;
        };
        *session.runner.write().await = session.host.executor_for(
            &legit_core::HostPath::from_path(&effective),
            Some(&session.root.clone()),
        );
    }

    probe(&resolved, path).await
}

/// Set a per-repo git binary override. Probes the new binary; if it passes,
/// persists the setting and hot-swaps the session's runner in place (same
/// session id, backend and watcher untouched) via the `RwLock` indirection
/// in `RepoSession.runner`, exactly like a global git path change.
#[tauri::command]
#[specta::specta]
pub async fn set_repo_git_path(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    path: Option<String>,
) -> Result<RepoSummary, AppError> {
    set_repo_git_path_impl(&state, &repo_id, path).await
}

async fn set_repo_git_path_impl(
    state: &AppState,
    repo_id: &str,
    path: Option<String>,
) -> Result<RepoSummary, AppError> {
    let session = state.get_session(repo_id).await?;
    // Per-repo git overrides for REMOTE repos are deferred (the picker would
    // browse the wrong machine). The per-host surface exists now — Settings ->
    // Git (WSL), `set_wsl_host_git_path` — and Repo Settings hides the field
    // for remote repos (`supportsRepoGitOverride` in src/lib/locator.ts), so
    // this is unreachable from the UI. It stays as the backend invariant: a
    // Windows path must never become a WSL session's git binary.
    if !matches!(session.locator, crate::remote::RepoLocator::Local { .. }) {
        return Err(AppError::Io(
            "setting a per-repo git binary is not supported for remote repositories yet".into(),
        ));
    }

    // Resolve and probe the candidate binary before touching anything.
    let global_git_path = state.git_path.read().await.clone();
    let mut candidate_settings = session.settings.read().await.clone();
    candidate_settings.git_path_override = path.clone();
    let resolved = resolve_repo_git_path(&candidate_settings, &global_git_path);
    let status = probe(&resolved, path).await?;
    if !status.meets_minimum {
        return Err(AppError::Git(legit_core::GitError::GitUnavailable(
            status.error.unwrap_or_else(|| format!(
                "{} does not meet the minimum required version",
                resolved.display()
            )),
        )));
    }

    *session.settings.write().await = candidate_settings;
    state.persist_session_settings(&session).await?;

    *session.runner.write().await = session
        .host
        .executor_for(&legit_core::HostPath::from_path(&resolved), Some(&session.root));
    Ok(state.attach_watch_error(session.summary()))
}

/// The binary a session should be hot-swapped to after a GLOBAL git path
/// change — `None` for remote sessions, whose git is resolved on their host.
fn local_hot_swap_git(
    locator: &crate::remote::RepoLocator,
    repo_settings: &crate::state::RepoSettings,
    resolved_global: &std::path::Path,
) -> Option<PathBuf> {
    match locator {
        crate::remote::RepoLocator::Local { .. } => {
            Some(resolve_repo_git_path(repo_settings, resolved_global))
        }
        crate::remote::RepoLocator::Wsl { .. } => None,
    }
}

async fn probe(
    git_path: &std::path::Path,
    user_override: Option<String>,
) -> Result<GitStatus, AppError> {
    let runner = GitRunner::unbound(git_path);
    match runner.check_version().await {
        Ok(v) => Ok(GitStatus {
            resolved_path: git_path.display().to_string(),
            meets_minimum: v.meets_minimum(),
            version: Some(v),
            minimum_required: MIN_SUPPORTED_GIT_VERSION,
            user_override,
            error: None,
        }),
        Err(e) => Ok(GitStatus {
            resolved_path: git_path.display().to_string(),
            version: None,
            meets_minimum: false,
            minimum_required: MIN_SUPPORTED_GIT_VERSION,
            user_override,
            error: Some(e.to_string()),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::remote::RepoLocator;
    use crate::state::{GlobalSettings, RepoSession, RepoSettings};
    use legit_host::LocalHost;
    use std::sync::Arc;

    // Regression: a per-repo git path change must hot-swap the runner in
    // place - same session id, session kept in the map - not tear down and
    // reopen the session under a new id.
    #[tokio::test]
    async fn repo_git_path_change_keeps_the_session_and_swaps_the_runner() {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new(
            PathBuf::from("git"),
            GlobalSettings::default(),
            dir.path().join("global-settings.json"),
            dir.path().join("repos"),
            dir.path().join("themes"),
            dir.path().join("builtin-themes"),
        );
        let session = Arc::new(RepoSession::new(
            RepoLocator::local(dir.path().to_path_buf()),
            Arc::new(LocalHost),
            Arc::new(legit_core::GitRunner::for_repo("git", dir.path())),
            RepoSettings::default(),
            dir.path().join("settings.json"),
        ));
        let id = session.id.clone();
        state.repos.write().await.insert(id.clone(), session.clone());
        let runner_before = Arc::clone(&*session.runner.read().await);

        let summary = set_repo_git_path_impl(&state, &id, None).await.unwrap();

        assert_eq!(summary.id, id, "session id must survive a git path change");
        assert!(state.repos.read().await.contains_key(&id), "session must stay open");
        let runner_after = Arc::clone(&*session.runner.read().await);
        assert!(
            !Arc::ptr_eq(&runner_before, &runner_after),
            "runner must be replaced by the hot-swap"
        );
    }

    // Regression: a global git path change must never clobber a REMOTE
    // session's runner with an app-machine binary path.
    #[test]
    fn global_git_swap_skips_remote_sessions() {
        let settings = RepoSettings::default();
        let global = std::path::Path::new("C:/Program Files/Git/cmd/git.exe");

        let local = RepoLocator::local("/x/repo");
        assert_eq!(
            local_hot_swap_git(&local, &settings, global),
            Some(global.to_path_buf())
        );

        let remote = RepoLocator::parse("wsl://Ubuntu/home/u/repo");
        assert_eq!(local_hot_swap_git(&remote, &settings, global), None);
    }
}
