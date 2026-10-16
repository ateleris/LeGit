//! Repo tab group commands and lifecycle hooks. All structure logic lives in
//! `crate::repo_groups`; this layer resolves the open set, persists, and
//! keeps `currently_open` coherent with the doc's order.

use std::sync::Arc;

use crate::error::AppError;
use crate::repo_groups::{self, RepoGroupsDoc, RepoGroupsOp};
use crate::state::{AppState, RepoSession};


/// The open set for doc maintenance: the persisted tab order (which keeps
/// restore's unavailable-host entries alive) plus any live session missing
/// from it. Built INSIDE the settings lock from the current `currently_open`,
/// so a concurrent close can never resurrect its repo through a stale copy.
fn open_set(s: &crate::state::GlobalSettings, session_locs: &[String]) -> Vec<String> {
    let mut open = s.currently_open.clone();
    for l in session_locs {
        if !open.contains(l) {
            open.push(l.clone());
        }
    }
    open
}

/// Rewrite `currently_open` to the doc's order, keeping entries the doc does
/// not know (restore's kept-but-unopenable repos) at the end.
fn rewrite_currently_open(s: &mut crate::state::GlobalSettings, open: &[String]) {
    let mut next = repo_groups::flatten_open(&s.repo_groups, open);
    for p in &s.currently_open {
        if !next.contains(p) {
            next.push(p.clone());
        }
    }
    s.currently_open = next;
}

pub(crate) async fn apply_groups_op(
    state: &AppState,
    op: &RepoGroupsOp,
) -> Result<RepoGroupsDoc, AppError> {
    // Hold the sessions read guard across the settings mutation so a
    // concurrent close (repos.write, then its own settings mutation) can
    // never interleave and get resurrected by a stale snapshot.
    let repos_guard = state.repos.read().await;
    let session_locs: Vec<String> =
        repos_guard.values().map(|s| s.locator.to_persist_string()).collect();
    let new_id = uuid::Uuid::new_v4().to_string();
    let mut result: Result<RepoGroupsDoc, AppError> =
        Err(AppError::Settings("repo groups op did not run".into()));
    state
        .mutate_global(|s| {
            let open = open_set(s, &session_locs);
            // A just-opened repo may not be in the doc yet (its background
            // hook races the first op): fold the open set in first.
            let base = repo_groups::normalize(&s.repo_groups, &open);
            match repo_groups::apply_op(&base, op, &open, &new_id) {
                Ok(doc) => {
                    s.repo_groups = doc.clone();
                    rewrite_currently_open(s, &open);
                    result = Ok(doc);
                }
                Err(e) => result = Err(e),
            }
        })
        .await?;
    drop(repos_guard);
    result
}

#[tauri::command]
#[specta::specta]
pub async fn get_repo_groups(
    state: tauri::State<'_, AppState>,
) -> Result<RepoGroupsDoc, AppError> {
    Ok(state.global_settings.read().await.repo_groups.clone())
}

#[tauri::command]
#[specta::specta]
pub async fn apply_repo_groups_op(
    state: tauri::State<'_, AppState>,
    op: RepoGroupsOp,
) -> Result<RepoGroupsDoc, AppError> {
    apply_groups_op(&state, &op).await
}

/// Background hook after a session opens: record the repo's canonical remote
/// key, re-home a pending synced member, and fold the repo into the doc.
/// Must never fail or gate the open.
pub(crate) async fn record_repo_opened(
    state: &AppState,
    app: &tauri::AppHandle,
    session: &Arc<RepoSession>,
) {
    let key = crate::commands::profiles::repo_assignment_key(session).await;
    let locator = session.locator.to_persist_string();
    let repos_guard = state.repos.read().await;
    let session_locs: Vec<String> =
        repos_guard.values().map(|s| s.locator.to_persist_string()).collect();
    let mut doc_changed = false;
    let res = state
        .mutate_global(|s| {
            let before = s.repo_groups.clone();
            let open = open_set(s, &session_locs);
            if let Some(k) = &key {
                s.repo_remote_keys.insert(locator.clone(), k.clone());
            }
            let noted = repo_groups::note_repo_opened(&s.repo_groups, &locator, key.as_deref());
            s.repo_groups = repo_groups::normalize(&noted, &open);
            rewrite_currently_open(s, &open);
            doc_changed = s.repo_groups != before;
        })
        .await;
    drop(repos_guard);
    if let Err(e) = res {
        tracing::warn!(err = %e, "repo groups: recording opened repo failed");
    } else if doc_changed {
        // The strip renders from the frontend's cached doc: broadcast so a
        // just-placed tab (pending claim, submodule-beside-super) shows at
        // its real position, not the append fallback.
        use tauri::Emitter as _;
        let _ = app.emit(crate::commands::persistence::GLOBAL_SETTINGS_CHANGED_EVENT, ());
    }
}

/// A USER-initiated open places a submodule beside its open superproject
/// (joining its group), even over a remembered position - fresh intent wins.
/// Awaited by `probe_and_open` before the command returns, so the frontend
/// never renders the tab at a stale spot; restore never calls this.
pub(crate) async fn place_user_opened(state: &AppState, session: &Arc<RepoSession>) {
    let Ok(Some(superproject)) = session.backend.superproject_path().await else {
        return;
    };
    let locator = session.locator.to_persist_string();
    let repos_guard = state.repos.read().await;
    let session_locs: Vec<String> =
        repos_guard.values().map(|s| s.locator.to_persist_string()).collect();
    let super_locator = {
        use crate::remote::RepoLocator;
        repos_guard
            .values()
            .find(|s2| match (&s2.locator, &session.locator) {
                (RepoLocator::Local { path }, RepoLocator::Local { .. }) => {
                    path.as_path() == superproject.as_path()
                }
                (
                    RepoLocator::Wsl { distro: d2, path: p2 },
                    RepoLocator::Wsl { distro: d1, .. },
                ) => d1 == d2 && std::path::Path::new(p2.0.as_str()) == superproject.as_path(),
                _ => false,
            })
            .map(|s2| s2.locator.to_persist_string())
    };
    let Some(sup) = super_locator else { return };
    let res = state
        .mutate_global(|s| {
            let open = open_set(s, &session_locs);
            s.repo_groups = repo_groups::normalize(&s.repo_groups, &open);
            s.repo_groups = repo_groups::place_after(&s.repo_groups, &locator, &sup);
            rewrite_currently_open(s, &open);
        })
        .await;
    drop(repos_guard);
    if let Err(e) = res {
        tracing::warn!(err = %e, "repo groups: placing submodule beside superproject failed");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repo_groups::{GroupItem, GroupRepoRef, ItemRef, RepoGroup};
    use crate::state::GlobalSettings;
    use std::path::Path;

    fn state_with_open(dir: &Path, open: &[&str]) -> AppState {
        let mut settings = GlobalSettings::default();
        settings.currently_open = open.iter().map(|s| s.to_string()).collect();
        AppState::new(
            std::path::PathBuf::from("git"),
            settings,
            dir.join("global-settings.json"),
            dir.join("repos"),
            dir.join("themes"),
            dir.join("builtin-themes"),
        )
    }

    #[tokio::test]
    async fn apply_op_rewrites_currently_open() {
        let dir = tempfile::tempdir().unwrap();
        let state = state_with_open(dir.path(), &["a", "b", "c"]);
        let doc = apply_groups_op(
            &state,
            &RepoGroupsOp::MergeIntoGroup {
                dragged: ItemRef::Repo { locator: "c".into() },
                target: ItemRef::Repo { locator: "a".into() },
            },
        )
        .await
        .unwrap();
        assert!(matches!(&doc.items[0], GroupItem::Group(g) if g.items.len() == 2));
        let s = state.global_settings.read().await;
        // doc order now: group(a, c), b
        assert_eq!(s.currently_open, vec!["a", "c", "b"]);
        assert_eq!(s.repo_groups, doc);
    }

    #[tokio::test]
    async fn apply_op_error_leaves_doc_and_order_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let state = state_with_open(dir.path(), &["a"]);
        let r = apply_groups_op(
            &state,
            &RepoGroupsOp::Rename { group_id: "missing".into(), name: "x".into() },
        )
        .await;
        assert!(r.is_err());
        let s = state.global_settings.read().await;
        assert_eq!(s.currently_open, vec!["a"]);
        assert!(s.repo_groups.items.is_empty());
    }

    #[tokio::test]
    async fn kept_unopenable_entries_survive_group_ops() {
        // "wsl://Down/repo" has no session and sits in currently_open from a
        // failed restore: an op must not drop it.
        let dir = tempfile::tempdir().unwrap();
        let state = state_with_open(dir.path(), &["a", "wsl://Down/repo", "b"]);
        apply_groups_op(
            &state,
            &RepoGroupsOp::NewGroupWith { item: ItemRef::Repo { locator: "b".into() } },
        )
        .await
        .unwrap();
        let s = state.global_settings.read().await;
        assert!(s.currently_open.contains(&"wsl://Down/repo".to_string()));
    }

    #[tokio::test]
    async fn grouped_membership_survives_close_shape() {
        // The close path's doc maintenance: normalize with the post-close
        // open set keeps grouped members, prunes the ungrouped root item.
        let dir = tempfile::tempdir().unwrap();
        let state = state_with_open(dir.path(), &["a", "b"]);
        state
            .mutate_global(|s| {
                s.repo_groups = RepoGroupsDoc {
                    items: vec![
                        GroupItem::Group(RepoGroup {
                            id: "g".into(),
                            name: "g".into(),
                            color: None,
                            collapsed: false,
                            items: vec![GroupItem::Repo(GroupRepoRef {
                                locator: Some("a".into()),
                                remote_key: None,
                            color: None,
                            })],
                        }),
                        GroupItem::Repo(GroupRepoRef {
                            locator: Some("b".into()),
                            remote_key: None,
                        color: None,
                        }),
                    ],
                };
            })
            .await
            .unwrap();
        state
            .mutate_global(|s| {
                s.currently_open.retain(|p| p != "a" && p != "b");
                let open = s.currently_open.clone();
                s.repo_groups = repo_groups::normalize(&s.repo_groups, &open);
            })
            .await
            .unwrap();
        let s = state.global_settings.read().await;
        assert!(matches!(&s.repo_groups.items[0], GroupItem::Group(g) if g.items.len() == 1));
        assert_eq!(s.repo_groups.items.len(), 1, "ungrouped b is pruned");
    }
}
