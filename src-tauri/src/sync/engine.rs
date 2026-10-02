//! The sync cycles: orchestration of the git sequences (`legit_core::sync`)
//! with the settings merge and theme reconciliation. Tauri-free so the whole
//! core runs against real git in tempdir fixtures; the debounce/event wrapper
//! lives in `tauri_engine`.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use legit_core::sync::{
    first_remote, rebase_in_progress, sync_commit, sync_pull, sync_push, SyncPullOutcome,
    SyncPushOutcome, SYNC_SETTINGS_FILE, SYNC_THEMES_DIR,
};
use legit_core::GitExecutor;
use serde::{Deserialize, Serialize};

use super::model::{export_synced_settings, import_synced_settings, SyncDoc};
use super::state_file::{read_state, write_state, SyncStateFile};
use super::themes::{plan_theme_export, plan_theme_import, safe_theme_name};
use crate::commands::persistence::THEME_EXT;
use crate::state::GlobalSettings;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum SyncStatusKind {
    Disabled,
    InSync,
    Ahead,
    Offline,
    Conflict,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatusPayload {
    pub kind: SyncStatusKind,
    pub message: Option<String>,
    pub last_sync: Option<String>,
}

impl SyncStatusPayload {
    pub fn of(kind: SyncStatusKind) -> Self {
        Self { kind, message: None, last_sync: None }
    }

    pub fn error(message: impl Into<String>) -> Self {
        Self { kind: SyncStatusKind::Error, message: Some(message.into()), last_sync: None }
    }

    fn conflict() -> Self {
        Self {
            kind: SyncStatusKind::Conflict,
            message: Some(
                "the sync repository has a merge conflict; resolve it (Open sync repo), then sync again"
                    .into(),
            ),
            last_sync: None,
        }
    }
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

fn theme_file(dir: &Path, name: &str) -> PathBuf {
    dir.join(format!("{name}{THEME_EXT}"))
}

/// Stems of `*.legit-theme.json` in `dir` (missing dir = none), sorted so
/// manifests compare stably.
async fn theme_names(dir: &Path) -> Vec<String> {
    let mut names = Vec::new();
    let Ok(mut rd) = tokio::fs::read_dir(dir).await else {
        return names;
    };
    while let Ok(Some(entry)) = rd.next_entry().await {
        let file_name = entry.file_name();
        let Some(file_name) = file_name.to_str() else { continue };
        if !file_name.to_lowercase().ends_with(THEME_EXT) {
            continue;
        }
        names.push(file_name[..file_name.len() - THEME_EXT.len()].to_string());
    }
    names.sort_unstable();
    names
}

/// The pulled doc's settings object. The caller re-merges it over the LIVE
/// settings under its write lock: the snapshot `import_cycle` validated
/// against can be seconds stale by then.
pub struct AdoptedSettings(pub serde_json::Value);

pub struct SyncCore {
    pub repo: PathBuf,
    pub user_themes_dir: PathBuf,
    pub state_path: PathBuf,
    pub exec: Arc<dyn GitExecutor>,
}

impl SyncCore {
    pub async fn has_sync_doc(repo: &Path) -> bool {
        tokio::fs::try_exists(repo.join(SYNC_SETTINGS_FILE)).await.unwrap_or(false)
    }

    /// Write the doc + mirror themes + commit what changed. `Err` carries the
    /// ready-to-report status. Shared by the export cycle and the capturing
    /// import.
    async fn write_and_commit(
        &self,
        settings: &GlobalSettings,
    ) -> Result<(Vec<String>, legit_core::sync::SyncCommitOutcome), SyncStatusPayload> {
        let local_names: Vec<String> = theme_names(&self.user_themes_dir)
            .await
            .into_iter()
            .filter(|n| safe_theme_name(n))
            .collect();
        let doc = SyncDoc::new(export_synced_settings(settings), local_names.clone());
        let json = match serde_json::to_string_pretty(&doc) {
            Ok(json) => json,
            Err(e) => return Err(SyncStatusPayload::error(e.to_string())),
        };
        let repo_themes = self.repo.join(SYNC_THEMES_DIR);
        if let Err(e) = async {
            crate::persist::write_atomic(&self.repo.join(SYNC_SETTINGS_FILE), &json).await?;
            let repo_names = theme_names(&repo_themes).await;
            let plan = plan_theme_export(&local_names, &repo_names);
            if !plan.copy.is_empty() {
                tokio::fs::create_dir_all(&repo_themes).await?;
            }
            for name in &plan.copy {
                tokio::fs::copy(
                    theme_file(&self.user_themes_dir, name),
                    theme_file(&repo_themes, name),
                )
                .await?;
            }
            for name in &plan.delete_repo {
                match tokio::fs::remove_file(theme_file(&repo_themes, name)).await {
                    Ok(()) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => return Err(e),
                }
            }
            Ok::<(), std::io::Error>(())
        }
        .await
        {
            return Err(SyncStatusPayload::error(format!(
                "cannot write to the sync repository: {e}"
            )));
        }
        match sync_commit(self.exec.as_ref()).await {
            Ok(outcome) => Ok((local_names, outcome)),
            Err(e) => Err(SyncStatusPayload::error(e.to_string())),
        }
    }

    /// Pull, then merge the repo's settings over `local` and reconcile
    /// themes. `Some(settings)` means the caller must adopt (and persist)
    /// them; every failure leaves local state untouched.
    pub async fn import_cycle(
        &self,
        local: &GlobalSettings,
    ) -> (Option<AdoptedSettings>, SyncStatusPayload) {
        self.import_inner(local, false).await
    }

    /// Like `import_cycle`, but first commits any unexported local state
    /// (doc drift from the debounce window before the last quit, or changes
    /// a kill left staged), so the pull rebases it instead of the adopt
    /// silently reverting it. Not for the initial ADOPT of a repo, where the
    /// repo's content winning is the point.
    pub async fn import_cycle_capturing(
        &self,
        local: &GlobalSettings,
    ) -> (Option<AdoptedSettings>, SyncStatusPayload) {
        self.import_inner(local, true).await
    }

    async fn import_inner(
        &self,
        local: &GlobalSettings,
        capture: bool,
    ) -> (Option<AdoptedSettings>, SyncStatusPayload) {
        match rebase_in_progress(self.exec.as_ref()).await {
            Ok(true) => return (None, SyncStatusPayload::conflict()),
            Ok(false) => {}
            Err(e) => return (None, SyncStatusPayload::error(e.to_string())),
        }
        if capture {
            if let Err(status) = self.write_and_commit(local).await {
                return (None, status);
            }
        }
        match sync_pull(self.exec.as_ref()).await {
            Ok(SyncPullOutcome::Pulled) | Ok(SyncPullOutcome::NoUpstream) => {}
            Ok(SyncPullOutcome::Offline) => {
                return (None, SyncStatusPayload::of(SyncStatusKind::Offline))
            }
            Ok(SyncPullOutcome::Conflict) => return (None, SyncStatusPayload::conflict()),
            Ok(SyncPullOutcome::Failed(e)) => return (None, SyncStatusPayload::error(e)),
            Err(e) => return (None, SyncStatusPayload::error(e.to_string())),
        }
        let doc_path = self.repo.join(SYNC_SETTINGS_FILE);
        let text = match tokio::fs::read_to_string(&doc_path).await {
            Ok(text) => text,
            Err(e) => {
                return (
                    None,
                    SyncStatusPayload::error(format!("cannot read {SYNC_SETTINGS_FILE}: {e}")),
                )
            }
        };
        let doc: SyncDoc = match serde_json::from_str(&text) {
            Ok(doc) => doc,
            Err(e) => {
                return (
                    None,
                    SyncStatusPayload::error(format!("{SYNC_SETTINGS_FILE} is not valid JSON: {e}")),
                )
            }
        };
        // Validation only: the caller re-merges over the live settings.
        if let Err(e) = import_synced_settings(local, &doc.settings) {
            return (None, SyncStatusPayload::error(e.to_string()));
        }
        let adopted = AdoptedSettings(doc.settings);
        let manifest: Vec<String> =
            doc.themes.iter().filter(|n| safe_theme_name(n)).cloned().collect();
        let local_names = theme_names(&self.user_themes_dir).await;
        let state = read_state(&self.state_path).await;
        let plan = plan_theme_import(&manifest, &state.last_manifest, &local_names);
        let repo_themes = self.repo.join(SYNC_THEMES_DIR);
        if let Err(e) = async {
            if !plan.copy.is_empty() {
                tokio::fs::create_dir_all(&self.user_themes_dir).await?;
            }
            for name in &plan.copy {
                let source = theme_file(&repo_themes, name);
                if source.exists() {
                    tokio::fs::copy(&source, theme_file(&self.user_themes_dir, name)).await?;
                }
            }
            for name in &plan.delete_local {
                match tokio::fs::remove_file(theme_file(&self.user_themes_dir, name)).await {
                    Ok(()) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => return Err(e),
                }
            }
            Ok::<(), std::io::Error>(())
        }
        .await
        {
            // Settings merged fine: adopt them, but the theme trouble is
            // never silent.
            return (
                Some(adopted),
                SyncStatusPayload::error(format!("themes only partially synced: {e}")),
            );
        }
        let now = now_iso();
        let state = SyncStateFile { last_manifest: manifest, last_sync: Some(now.clone()) };
        if let Err(e) = write_state(&self.state_path, &state).await {
            return (Some(adopted), SyncStatusPayload::error(e.to_string()));
        }
        (
            Some(adopted),
            SyncStatusPayload {
                kind: SyncStatusKind::InSync,
                message: None,
                last_sync: Some(now),
            },
        )
    }

    /// Write the sync doc + themes, commit, and push best-effort.
    pub async fn export_cycle(&self, settings: &GlobalSettings) -> SyncStatusPayload {
        match rebase_in_progress(self.exec.as_ref()).await {
            Ok(true) => return SyncStatusPayload::conflict(),
            Ok(false) => {}
            Err(e) => return SyncStatusPayload::error(e.to_string()),
        }
        let (local_names, committed) = match self.write_and_commit(settings).await {
            Ok(result) => result,
            Err(status) => return status,
        };
        // Nothing new and nothing left unpushed: skip the push entirely, so
        // a nudge from a never-synced field (e.g. a tab switch) costs no
        // network op and no credential prompt.
        if committed == legit_core::sync::SyncCommitOutcome::NothingToCommit {
            if let Ok(Some(0)) = legit_core::sync::commits_ahead(self.exec.as_ref()).await {
                let state = read_state(&self.state_path).await;
                return SyncStatusPayload {
                    kind: SyncStatusKind::InSync,
                    message: None,
                    last_sync: state.last_sync,
                };
            }
        }
        // The commit holds this manifest regardless of how the push goes.
        let now = now_iso();
        let state = SyncStateFile { last_manifest: local_names, last_sync: Some(now.clone()) };
        if let Err(e) = write_state(&self.state_path, &state).await {
            return SyncStatusPayload::error(e.to_string());
        }
        let remote = match first_remote(self.exec.as_ref()).await {
            Ok(Some(remote)) => remote,
            Ok(None) => return SyncStatusPayload::error("the sync repository has no remote"),
            Err(e) => return SyncStatusPayload::error(e.to_string()),
        };
        let in_sync = SyncStatusPayload {
            kind: SyncStatusKind::InSync,
            message: None,
            last_sync: Some(now),
        };
        match sync_push(self.exec.as_ref(), &remote).await {
            Ok(SyncPushOutcome::Pushed) => in_sync,
            Ok(SyncPushOutcome::Offline) => SyncStatusPayload::of(SyncStatusKind::Offline),
            Ok(SyncPushOutcome::Failed(e)) => SyncStatusPayload::error(e),
            Err(e) => SyncStatusPayload::error(e.to_string()),
            Ok(SyncPushOutcome::Rejected) => match sync_pull(self.exec.as_ref()).await {
                Ok(SyncPullOutcome::Pulled) | Ok(SyncPullOutcome::NoUpstream) => {
                    match sync_push(self.exec.as_ref(), &remote).await {
                        Ok(SyncPushOutcome::Pushed) => in_sync,
                        Ok(SyncPushOutcome::Rejected) => {
                            SyncStatusPayload::of(SyncStatusKind::Ahead)
                        }
                        Ok(SyncPushOutcome::Offline) => {
                            SyncStatusPayload::of(SyncStatusKind::Offline)
                        }
                        Ok(SyncPushOutcome::Failed(e)) => SyncStatusPayload::error(e),
                        Err(e) => SyncStatusPayload::error(e.to_string()),
                    }
                }
                Ok(SyncPullOutcome::Conflict) => SyncStatusPayload::conflict(),
                Ok(SyncPullOutcome::Offline) => SyncStatusPayload::of(SyncStatusKind::Offline),
                Ok(SyncPullOutcome::Failed(e)) => SyncStatusPayload::error(e),
                Err(e) => SyncStatusPayload::error(e.to_string()),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use legit_core::GitRunner;
    use tempfile::TempDir;

    async fn git(cwd: &Path, args: &[&str]) {
        let out = GitRunner::for_repo("git", cwd).run(args).await.expect("spawn git");
        assert!(out.success, "`git {args:?}` failed: {}", out.stderr);
    }

    struct Machine {
        core: SyncCore,
    }

    fn machine(root: &Path, clone: &Path, name: &str) -> Machine {
        let home = root.join(name);
        Machine {
            core: SyncCore {
                repo: clone.to_path_buf(),
                user_themes_dir: home.join("themes"),
                state_path: home.join("sync-state.json"),
                exec: Arc::new(GitRunner::for_repo("git", clone)),
            },
        }
    }

    struct Fixture {
        _dir: TempDir,
        root: PathBuf,
        a: Machine,
        b: Machine,
    }

    /// Bare origin; machine `a` seeds via a real `export_cycle`; machine `b`
    /// clones after the seed.
    async fn fixture(seed: &GlobalSettings) -> Fixture {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().to_path_buf();
        git(&root, &["init", "--bare", "-b", "main", "origin.git"]).await;
        git(&root, &["clone", "origin.git", "a"]).await;
        let a = machine(&root, &root.join("a"), "machine-a");
        let status = a.core.export_cycle(seed).await;
        assert_eq!(status.kind, SyncStatusKind::InSync, "seed failed: {:?}", status.message);
        git(&root, &["clone", "origin.git", "b"]).await;
        let b = machine(&root, &root.join("b"), "machine-b");
        Fixture { _dir: dir, root, a, b }
    }

    #[tokio::test]
    async fn export_then_import_roundtrip() {
        let mut seed = GlobalSettings::default();
        seed.ui_font_size = 17.0;
        let f = fixture(&seed).await;
        let (adopted, status) = f.b.core.import_cycle(&GlobalSettings::default()).await;
        assert_eq!(status.kind, SyncStatusKind::InSync, "{:?}", status.message);
        assert!(status.last_sync.is_some());
        let synced = adopted.expect("settings adopted");
        let merged = import_synced_settings(&GlobalSettings::default(), &synced.0).unwrap();
        assert_eq!(merged.ui_font_size, 17.0);
    }

    #[tokio::test]
    async fn capturing_import_preserves_unexported_local_drift() {
        let f = fixture(&GlobalSettings::default()).await;
        // Remote moves ahead (b pushes a row-height change)...
        let mut b_settings = GlobalSettings::default();
        b_settings.commits_row_height = 40.0;
        assert_eq!(f.b.core.export_cycle(&b_settings).await.kind, SyncStatusKind::InSync);
        // ...while a holds a change its debounce never exported (e.g. the
        // app quit inside the quiet window). A plain import would adopt the
        // repo doc and silently revert it.
        let mut a_settings = GlobalSettings::default();
        a_settings.commit_initials = true;
        let (adopted, status) = f.a.core.import_cycle_capturing(&a_settings).await;
        assert_eq!(status.kind, SyncStatusKind::InSync, "{:?}", status.message);
        let merged =
            import_synced_settings(&GlobalSettings::default(), &adopted.unwrap().0).unwrap();
        assert_eq!(merged.commits_row_height, 40.0);
        assert!(merged.commit_initials);
    }

    #[tokio::test]
    async fn capturing_import_commits_leftover_staged_changes_before_pulling() {
        let f = fixture(&GlobalSettings::default()).await;
        let mut b_settings = GlobalSettings::default();
        b_settings.commits_row_height = 40.0;
        assert_eq!(f.b.core.export_cycle(&b_settings).await.kind, SyncStatusKind::InSync);
        // A kill between add and commit left staged changes behind; the pull
        // would refuse to rebase over them.
        tokio::fs::write(f.a.core.repo.join(SYNC_SETTINGS_FILE), "{\"staged\": true}")
            .await
            .unwrap();
        git(&f.a.core.repo, &["add", "--", SYNC_SETTINGS_FILE]).await;
        let (adopted, status) =
            f.a.core.import_cycle_capturing(&GlobalSettings::default()).await;
        assert_eq!(status.kind, SyncStatusKind::InSync, "{:?}", status.message);
        assert!(adopted.is_some());
    }

    #[tokio::test]
    async fn unchanged_export_skips_the_push() {
        let f = fixture(&GlobalSettings::default()).await;
        // If the unchanged export still tried to push, the broken remote
        // would surface as Offline/Error instead of InSync.
        git(&f.root.join("a"), &["remote", "set-url", "origin", "/nowhere"]).await;
        let status = f.a.core.export_cycle(&GlobalSettings::default()).await;
        assert_eq!(status.kind, SyncStatusKind::InSync, "{:?}", status.message);
    }

    #[tokio::test]
    async fn import_with_garbage_sync_file_is_an_error_and_keeps_local() {
        let f = fixture(&GlobalSettings::default()).await;
        tokio::fs::write(f.a.core.repo.join(SYNC_SETTINGS_FILE), "{not json").await.unwrap();
        assert!(matches!(
            sync_commit(f.a.core.exec.as_ref()).await.unwrap(),
            legit_core::sync::SyncCommitOutcome::Committed
        ));
        assert_eq!(
            sync_push(f.a.core.exec.as_ref(), "origin").await.unwrap(),
            SyncPushOutcome::Pushed
        );
        let (merged, status) = f.b.core.import_cycle(&GlobalSettings::default()).await;
        assert_eq!(status.kind, SyncStatusKind::Error);
        assert!(merged.is_none());
    }

    #[tokio::test]
    async fn theme_sync_propagates_create_and_delete() {
        let f = fixture(&GlobalSettings::default()).await;
        tokio::fs::create_dir_all(&f.a.core.user_themes_dir).await.unwrap();
        tokio::fs::write(theme_file(&f.a.core.user_themes_dir, "X"), "{}\n").await.unwrap();
        assert_eq!(
            f.a.core.export_cycle(&GlobalSettings::default()).await.kind,
            SyncStatusKind::InSync
        );
        let (_, status) = f.b.core.import_cycle(&GlobalSettings::default()).await;
        assert_eq!(status.kind, SyncStatusKind::InSync, "{:?}", status.message);
        assert!(theme_file(&f.b.core.user_themes_dir, "X").exists());
        assert_eq!(read_state(&f.b.core.state_path).await.last_manifest, vec!["X".to_string()]);

        tokio::fs::remove_file(theme_file(&f.a.core.user_themes_dir, "X")).await.unwrap();
        assert_eq!(
            f.a.core.export_cycle(&GlobalSettings::default()).await.kind,
            SyncStatusKind::InSync
        );
        let (_, status) = f.b.core.import_cycle(&GlobalSettings::default()).await;
        assert_eq!(status.kind, SyncStatusKind::InSync, "{:?}", status.message);
        assert!(!theme_file(&f.b.core.user_themes_dir, "X").exists());
    }

    #[tokio::test]
    async fn unsafe_manifest_name_is_skipped() {
        let f = fixture(&GlobalSettings::default()).await;
        let doc = SyncDoc::new(
            export_synced_settings(&GlobalSettings::default()),
            vec!["../evil".to_string()],
        );
        tokio::fs::write(
            f.a.core.repo.join(SYNC_SETTINGS_FILE),
            serde_json::to_string_pretty(&doc).unwrap(),
        )
        .await
        .unwrap();
        assert!(matches!(
            sync_commit(f.a.core.exec.as_ref()).await.unwrap(),
            legit_core::sync::SyncCommitOutcome::Committed
        ));
        assert_eq!(
            sync_push(f.a.core.exec.as_ref(), "origin").await.unwrap(),
            SyncPushOutcome::Pushed
        );
        let (merged, status) = f.b.core.import_cycle(&GlobalSettings::default()).await;
        assert_eq!(status.kind, SyncStatusKind::InSync, "{:?}", status.message);
        assert!(merged.is_some());
        // The escape target next to the themes dir must not exist.
        let escape = theme_file(f.b.core.user_themes_dir.parent().unwrap(), "evil");
        assert!(!escape.exists());
    }

    #[tokio::test]
    async fn rejected_push_retries_after_rebase() {
        let f = fixture(&GlobalSettings::default()).await;
        // a pushes a settings change...
        let mut a_settings = GlobalSettings::default();
        a_settings.ui_font_size = 17.0;
        assert_eq!(f.a.core.export_cycle(&a_settings).await.kind, SyncStatusKind::InSync);
        // ...while b, one commit behind, exports a new theme.
        tokio::fs::create_dir_all(&f.b.core.user_themes_dir).await.unwrap();
        tokio::fs::write(theme_file(&f.b.core.user_themes_dir, "Y"), "{}\n").await.unwrap();
        let status = f.b.core.export_cycle(&GlobalSettings::default()).await;
        assert_eq!(status.kind, SyncStatusKind::InSync, "{:?}", status.message);
        // Both changes are on the remote now.
        let (merged, status) = f.a.core.import_cycle(&a_settings).await;
        assert_eq!(status.kind, SyncStatusKind::InSync, "{:?}", status.message);
        assert!(merged.is_some());
        assert!(theme_file(&f.a.core.user_themes_dir, "Y").exists());
    }

    #[tokio::test]
    async fn conflict_export_reports_conflict_and_import_stays_conflicted() {
        let f = fixture(&GlobalSettings::default()).await;
        let mut a_settings = GlobalSettings::default();
        a_settings.ui_font_size = 17.0;
        assert_eq!(f.a.core.export_cycle(&a_settings).await.kind, SyncStatusKind::InSync);
        let mut b_settings = GlobalSettings::default();
        b_settings.ui_font_size = 19.0;
        let status = f.b.core.export_cycle(&b_settings).await;
        assert_eq!(status.kind, SyncStatusKind::Conflict, "{:?}", status.message);
        let (merged, status) = f.b.core.import_cycle(&b_settings).await;
        assert_eq!(status.kind, SyncStatusKind::Conflict);
        assert!(merged.is_none());
    }

    #[tokio::test]
    async fn no_remote_is_an_error() {
        let f = fixture(&GlobalSettings::default()).await;
        git(&f.root.join("a"), &["remote", "remove", "origin"]).await;
        let mut changed = GlobalSettings::default();
        changed.panel_gap = 4.0;
        let status = f.a.core.export_cycle(&changed).await;
        assert_eq!(status.kind, SyncStatusKind::Error);
        assert!(status.message.unwrap_or_default().contains("remote"));
    }
}
