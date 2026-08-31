//! Remote-repository support: locators (and, in later phases, the WSL
//! transport, agent deploy, and host connection lifecycle).

pub mod connection;
pub mod locator;
pub mod wsl;

pub use locator::{HostRef, RepoLocator};

/// After a reconnect, everything about this host's repos may be stale: emit a
/// full-domain repo-changed for each of its sessions so react-query refetches.
pub async fn invalidate_host_repos(
    app: &tauri::AppHandle,
    state: &crate::state::AppState,
    distro: &str,
) {
    use tauri::Emitter as _;
    let sessions: Vec<_> = state
        .repos
        .read()
        .await
        .values()
        .filter(|s| {
            matches!(&s.locator, RepoLocator::Wsl { distro: d, .. } if d == distro)
        })
        .map(|s| s.id.clone())
        .collect();
    for repo_id in sessions {
        let payload = legit_watch::RepoChangedPayload {
            repo_id,
            domains: vec![
                legit_watch::ChangeDomain::Status,
                legit_watch::ChangeDomain::Log,
                legit_watch::ChangeDomain::Branches,
                legit_watch::ChangeDomain::Stashes,
                legit_watch::ChangeDomain::Tags,
                legit_watch::ChangeDomain::Diff,
                legit_watch::ChangeDomain::OpState,
                legit_watch::ChangeDomain::Submodules,
            ],
            trigger_paths: vec!["<reconnected>".to_string()],
            trigger_count: 0,
        };
        let _ = app.emit(crate::watcher::REPO_CHANGED_EVENT, payload);
    }
}
