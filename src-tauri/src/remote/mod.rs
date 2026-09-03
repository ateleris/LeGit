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
        crate::watcher::emit_all_domains_changed(app, &repo_id, "<reconnected>");
    }
}
