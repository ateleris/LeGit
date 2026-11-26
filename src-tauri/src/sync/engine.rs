//! The sync cycles: orchestration of the git sequences (`legit_core::sync`)
//! with the settings merge and theme reconciliation. Tauri-free so the whole
//! core runs against real git in tempdir fixtures; the debounce/event wrapper
//! lives in `tauri_engine`.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use legit_core::sync::{
    first_remote, rebase_in_progress, sync_commit, sync_fetch, sync_pull, sync_push,
    sync_reset_to_upstream, upstream_sync_doc, SyncFetchOutcome, SyncPullOutcome,
    SyncPushOutcome, SYNC_SETTINGS_FILE, SYNC_THEMES_DIR,
};
use legit_core::GitExecutor;
use serde::{Deserialize, Serialize};

use super::model::{
    export_synced_settings_over, import_keeping_unsent, import_synced_settings, ImportMode,
    SyncDoc, SYNC_SETTINGS_REVISION,
};
use super::state_file::{read_state, write_state, SyncStateFile};
use super::themes::{plan_theme_export, plan_theme_import, safe_theme_name};
use crate::commands::persistence::THEME_EXT;
use crate::state::GlobalSettings;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum SyncStatusKind {
    Disabled,
    InSync,
    /// The sync repository holds settings from a newer LeGit: this instance
    /// applies what it can read and sends nothing until it is updated.
    ReceiveOnly,
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
    /// The LeGit version that wrote the sync repository's settings, when
    /// they are from a newer settings revision than this instance's.
    pub newer_app_version: Option<String>,
    /// Settings changed both here and on another machine while this one
    /// could not send, where the other machine's value was taken.
    pub superseded: Vec<String>,
}

impl SyncStatusPayload {
    pub fn of(kind: SyncStatusKind) -> Self {
        Self { kind, message: None, last_sync: None, newer_app_version: None, superseded: Vec::new() }
    }

    pub fn error(message: impl Into<String>) -> Self {
        Self { message: Some(message.into()), ..Self::of(SyncStatusKind::Error) }
    }

    fn in_sync(last_sync: Option<String>) -> Self {
        Self { last_sync, ..Self::of(SyncStatusKind::InSync) }
    }

    fn conflict() -> Self {
        Self {
            message: Some(
                "the sync repository has a merge conflict; resolve it (Open sync repo), then sync again"
                    .into(),
            ),
            ..Self::of(SyncStatusKind::Conflict)
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
pub struct AdoptedSettings {
    pub settings: serde_json::Value,
    pub mode: ImportMode,
    /// The agreed state before this import (`import_keeping_unsent`).
    pub base: Option<serde_json::Value>,
}

fn content_hash(bytes: &[u8]) -> String {
    use sha2::Digest as _;
    sha2::Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

/// A free name for the copy kept of a locally edited theme that an import
/// is about to replace.
fn local_copy_name(name: &str, taken: &[String]) -> String {
    let first = format!("{name} (local copy)");
    if !taken.contains(&first) {
        return first;
    }
    (2u32..)
        .map(|n| format!("{name} (local copy {n})"))
        .find(|candidate| !taken.contains(candidate))
        .expect("an unused number exists")
}

/// What `write_and_commit` put into the checkout.
struct Written {
    themes: Vec<String>,
    theme_hashes: std::collections::BTreeMap<String, String>,
    settings: serde_json::Value,
    committed: legit_core::sync::SyncCommitOutcome,
}

pub struct SyncCore {
    pub repo: PathBuf,
    pub user_themes_dir: PathBuf,
    pub builtin_themes_dir: PathBuf,
    pub state_path: PathBuf,
    pub exec: Arc<dyn GitExecutor>,
    /// The running LeGit's version, stamped on exports.
    pub app_version: String,
}

impl SyncCore {
    pub async fn has_sync_doc(repo: &Path) -> bool {
        tokio::fs::try_exists(repo.join(SYNC_SETTINGS_FILE)).await.unwrap_or(false)
    }

    /// This machine's bookkeeping for THIS checkout; what it recorded for
    /// another repository reads as a fresh start.
    async fn state(&self) -> SyncStateFile {
        let state = read_state(&self.state_path).await;
        if state.repo.as_deref() == Some(self.repo_id().as_str()) {
            state
        } else {
            SyncStateFile::default()
        }
    }

    fn repo_id(&self) -> String {
        self.repo.display().to_string()
    }

    /// Whether this instance has completed an import at its current
    /// settings revision. Before that, its values for settings it did not
    /// know earlier are defaults nobody chose, and must not be sent.
    fn imported_at_this_revision(state: &SyncStateFile) -> bool {
        state.settings_revision == SYNC_SETTINGS_REVISION
    }

    /// The doc currently in the checkout; `None` when missing or unreadable.
    async fn repo_doc(&self) -> Option<SyncDoc> {
        let text = tokio::fs::read_to_string(self.repo.join(SYNC_SETTINGS_FILE)).await.ok()?;
        serde_json::from_str(&text).ok()
    }

    /// `status`, naming the writer when the checkout's doc is from a newer
    /// instance.
    async fn noting_newer_writer(&self, mut status: SyncStatusPayload) -> SyncStatusPayload {
        status.newer_app_version = self
            .repo_doc()
            .await
            .filter(SyncDoc::from_newer_instance)
            .map(|doc| doc.app_version.unwrap_or_else(|| "a newer version".into()));
        status
    }

    /// Whether the upstream's doc (as of the last fetch) is from a newer
    /// instance.
    async fn upstream_is_newer(&self) -> Result<bool, SyncStatusPayload> {
        match upstream_sync_doc(self.exec.as_ref()).await {
            Ok(text) => Ok(text
                .and_then(|text| serde_json::from_str::<SyncDoc>(&text).ok())
                .is_some_and(|doc| doc.from_newer_instance())),
            Err(e) => Err(SyncStatusPayload::error(e.to_string())),
        }
    }

    /// Give up everything local in the checkout for the upstream's state:
    /// an older instance must not rebase its own sync commits onto a doc it
    /// cannot fully represent.
    async fn yield_to_upstream(&self) -> Result<(), SyncStatusPayload> {
        sync_reset_to_upstream(self.exec.as_ref())
            .await
            .map_err(|e| SyncStatusPayload::error(e.to_string()))
    }

    /// Write the doc + mirror themes + commit what changed. `Err` carries the
    /// ready-to-report status. Shared by the export cycle and the capturing
    /// import.
    async fn write_and_commit(
        &self,
        settings: &GlobalSettings,
    ) -> Result<Written, SyncStatusPayload> {
        let state = self.state().await;
        // An unreadable or vanished themes folder is not "the user deleted
        // every theme": exporting that would delete them on every machine.
        let themes_missing = match tokio::fs::read_dir(&self.user_themes_dir).await {
            Ok(_) => false,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => true,
            Err(e) => {
                return Err(SyncStatusPayload::error(format!(
                    "cannot read the themes folder ({e}); nothing was synced"
                )))
            }
        };
        if themes_missing && !state.last_manifest.is_empty() {
            return Err(SyncStatusPayload::error(format!(
                "the themes folder {} is missing; nothing was synced, so the themes on your other computers are kept",
                self.user_themes_dir.display()
            )));
        }
        let local_names: Vec<String> = theme_names(&self.user_themes_dir)
            .await
            .into_iter()
            .filter(|n| safe_theme_name(n))
            .collect();
        let doc_path = self.repo.join(SYNC_SETTINGS_FILE);
        let repo_doc = self.repo_doc().await;
        // Never replace what cannot be read: a file that does not parse, or
        // holds a value this instance does not understand, is someone's data.
        if repo_doc.is_none() && tokio::fs::try_exists(&doc_path).await.unwrap_or(true) {
            return Err(SyncStatusPayload::error(format!(
                "{SYNC_SETTINGS_FILE} in the sync repository cannot be read; it was left untouched"
            )));
        }
        if let Some(doc) = repo_doc.as_ref().filter(|d| !d.from_newer_instance()) {
            if let Err(e) = import_synced_settings(settings, &doc.settings) {
                return Err(SyncStatusPayload::error(format!(
                    "{SYNC_SETTINGS_FILE} holds a value this LeGit cannot read ({e}); it was left untouched"
                )));
            }
        }
        if let Some(reason) = repo_doc.as_ref().and_then(SyncDoc::unsupported_reason) {
            return Err(SyncStatusPayload::error(reason));
        }
        if repo_doc.as_ref().is_some_and(SyncDoc::from_newer_instance) {
            return Err(SyncStatusPayload::of(SyncStatusKind::ReceiveOnly));
        }
        // An empty repository is seeded from this machine; one that holds a
        // doc is read before it is written.
        if repo_doc.is_some() && !Self::imported_at_this_revision(&state) {
            return Err(SyncStatusPayload::of(SyncStatusKind::Ahead));
        }
        let doc = SyncDoc::new(
            export_synced_settings_over(settings, repo_doc.as_ref().map(|d| &d.settings)),
            local_names.clone(),
            self.app_version.clone(),
        );
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
        let mut theme_hashes = std::collections::BTreeMap::new();
        for name in &local_names {
            if let Ok(bytes) = tokio::fs::read(theme_file(&self.user_themes_dir, name)).await {
                theme_hashes.insert(name.clone(), content_hash(&bytes));
            }
        }
        match sync_commit(self.exec.as_ref()).await {
            Ok(committed) => {
                Ok(Written { themes: local_names, theme_hashes, settings: doc.settings, committed })
            }
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
        let (adopted, status) = self.import_inner(local, false).await;
        (adopted, self.noting_newer_writer(status).await)
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
        let (adopted, status) = self.import_inner(local, true).await;
        (adopted, self.noting_newer_writer(status).await)
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
        // Look before writing anything: whether this instance may commit
        // depends on what the upstream holds.
        match sync_fetch(self.exec.as_ref()).await {
            Ok(SyncFetchOutcome::Fetched) => {}
            Ok(SyncFetchOutcome::Offline) => {
                return (None, SyncStatusPayload::of(SyncStatusKind::Offline))
            }
            Ok(SyncFetchOutcome::Failed(e)) => return (None, SyncStatusPayload::error(e)),
            Err(e) => return (None, SyncStatusPayload::error(e.to_string())),
        }
        let upstream_newer = match self.upstream_is_newer().await {
            Ok(newer) => newer,
            Err(status) => return (None, status),
        };
        let state = self.state().await;
        // Whether this machine's unsent changes went into git before the
        // pull. Where they did not, the import itself has to keep them.
        let mut captured = false;
        if upstream_newer {
            if let Err(status) = self.yield_to_upstream().await {
                return (None, status);
            }
        } else {
            if capture && Self::imported_at_this_revision(&state) {
                if let Err(status) = self.write_and_commit(local).await {
                    return (None, status);
                }
                captured = true;
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
        if let Some(reason) = doc.unsupported_reason() {
            return (None, SyncStatusPayload::error(reason));
        }
        let from_newer = doc.from_newer_instance();
        let mode = if from_newer {
            ImportMode::ReceiveOnly
        } else if captured || state.base.is_none() {
            ImportMode::Plain
        } else {
            ImportMode::CatchUp
        };
        // The caller re-merges over the live settings; this pass validates
        // and yields the agreed base to record.
        let imported =
            match import_keeping_unsent(local, &doc.settings, state.base.as_ref(), mode, false) {
                Ok(imported) => imported,
                Err(e) => return (None, SyncStatusPayload::error(e.to_string())),
            };
        let adopted =
            AdoptedSettings { settings: doc.settings, mode, base: state.base.clone() };
        // A theme named like a built-in would shadow it (themes share one
        // name namespace): never import one. The machine that still has it
        // renames it on startup and re-syncs under the new name.
        let builtin: std::collections::HashSet<String> = theme_names(&self.builtin_themes_dir)
            .await
            .into_iter()
            .map(|n| n.to_lowercase())
            .collect();
        let manifest: Vec<String> = doc
            .themes
            .iter()
            .filter(|n| safe_theme_name(n) && !builtin.contains(&n.to_lowercase()))
            .cloned()
            .collect();
        let mut local_names = theme_names(&self.user_themes_dir).await;
        let plan = plan_theme_import(&manifest, &state.last_manifest, &local_names);
        let repo_themes = self.repo.join(SYNC_THEMES_DIR);
        let mut theme_hashes = std::collections::BTreeMap::new();
        // A local theme that differs from what was last synced was edited
        // here. Unless git already holds that edit (`captured`), it is
        // never overwritten or deleted: the edit stays as its own theme.
        let edited_here = |name: &str, local: &[u8]| {
            !captured && state.theme_hashes.get(name) != Some(&content_hash(local))
        };
        if let Err(e) = async {
            if !plan.copy.is_empty() {
                tokio::fs::create_dir_all(&self.user_themes_dir).await?;
            }
            for name in &plan.copy {
                let Ok(incoming) = tokio::fs::read(theme_file(&repo_themes, name)).await else {
                    continue;
                };
                let target = theme_file(&self.user_themes_dir, name);
                if let Ok(existing) = tokio::fs::read(&target).await {
                    if existing != incoming && edited_here(name, &existing) {
                        let copy = local_copy_name(name, &local_names);
                        tokio::fs::write(theme_file(&self.user_themes_dir, &copy), &existing)
                            .await?;
                        local_names.push(copy);
                    }
                }
                tokio::fs::write(&target, &incoming).await?;
                theme_hashes.insert(name.clone(), content_hash(&incoming));
            }
            for name in &plan.delete_local {
                let target = theme_file(&self.user_themes_dir, name);
                match tokio::fs::read(&target).await {
                    Ok(existing) if edited_here(name, &existing) => continue,
                    Ok(_) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                    Err(e) => return Err(e),
                }
                tokio::fs::remove_file(&target).await?;
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
        let state = SyncStateFile {
            last_manifest: manifest,
            last_sync: Some(now.clone()),
            repo: Some(self.repo_id()),
            // Receiving only is not an import at this instance's revision
            // in the sense that matters: the newer settings were skipped.
            settings_revision: if from_newer { state.settings_revision } else { SYNC_SETTINGS_REVISION },
            base: Some(imported.base),
            theme_hashes,
        };
        if let Err(e) = write_state(&self.state_path, &state).await {
            return (Some(adopted), SyncStatusPayload::error(e.to_string()));
        }
        (
            Some(adopted),
            SyncStatusPayload {
                kind: if from_newer { SyncStatusKind::ReceiveOnly } else { SyncStatusKind::InSync },
                superseded: imported.superseded,
                ..SyncStatusPayload::in_sync(Some(now))
            },
        )
    }

    /// Write the sync doc + themes, commit, and push best-effort.
    pub async fn export_cycle(&self, settings: &GlobalSettings) -> SyncStatusPayload {
        let status = self.export_inner(settings).await;
        self.noting_newer_writer(status).await
    }

    async fn export_inner(&self, settings: &GlobalSettings) -> SyncStatusPayload {
        match rebase_in_progress(self.exec.as_ref()).await {
            Ok(true) => return SyncStatusPayload::conflict(),
            Ok(false) => {}
            Err(e) => return SyncStatusPayload::error(e.to_string()),
        }
        let written = match self.write_and_commit(settings).await {
            Ok(written) => written,
            Err(status) => return status,
        };
        // Nothing new and nothing left unpushed: skip the push entirely, so
        // a nudge from a never-synced field (e.g. a tab switch) costs no
        // network op and no credential prompt.
        if written.committed == legit_core::sync::SyncCommitOutcome::NothingToCommit {
            if let Ok(Some(0)) = legit_core::sync::commits_ahead(self.exec.as_ref()).await {
                return SyncStatusPayload::in_sync(self.state().await.last_sync);
            }
        }
        // The commit holds this manifest regardless of how the push goes.
        let now = now_iso();
        let state = SyncStateFile {
            last_manifest: written.themes,
            last_sync: Some(now.clone()),
            repo: Some(self.repo_id()),
            settings_revision: SYNC_SETTINGS_REVISION,
            base: Some(written.settings),
            theme_hashes: written.theme_hashes,
        };
        if let Err(e) = write_state(&self.state_path, &state).await {
            return SyncStatusPayload::error(e.to_string());
        }
        let remote = match first_remote(self.exec.as_ref()).await {
            Ok(Some(remote)) => remote,
            Ok(None) => return SyncStatusPayload::error("the sync repository has no remote"),
            Err(e) => return SyncStatusPayload::error(e.to_string()),
        };
        let in_sync = SyncStatusPayload::in_sync(Some(now));
        match sync_push(self.exec.as_ref(), &remote).await {
            Ok(SyncPushOutcome::Pushed) => in_sync,
            Ok(SyncPushOutcome::Offline) => SyncStatusPayload::of(SyncStatusKind::Offline),
            Ok(SyncPushOutcome::Failed(e)) => SyncStatusPayload::error(e),
            Err(e) => SyncStatusPayload::error(e.to_string()),
            Ok(SyncPushOutcome::Rejected) => {
                // The upstream moved. If a newer instance moved it, this
                // commit must not be rebased onto its doc.
                match sync_fetch(self.exec.as_ref()).await {
                    Ok(SyncFetchOutcome::Fetched) => {}
                    Ok(SyncFetchOutcome::Offline) => {
                        return SyncStatusPayload::of(SyncStatusKind::Offline)
                    }
                    Ok(SyncFetchOutcome::Failed(e)) => return SyncStatusPayload::error(e),
                    Err(e) => return SyncStatusPayload::error(e.to_string()),
                }
                match self.upstream_is_newer().await {
                    Ok(false) => {}
                    Ok(true) => {
                        return match self.yield_to_upstream().await {
                            Ok(()) => SyncStatusPayload::of(SyncStatusKind::ReceiveOnly),
                            Err(status) => status,
                        }
                    }
                    Err(status) => return status,
                }
                self.pull_and_push_again(&remote, in_sync).await
            }
        }
    }

    async fn pull_and_push_again(
        &self,
        remote: &str,
        in_sync: SyncStatusPayload,
    ) -> SyncStatusPayload {
        match sync_pull(self.exec.as_ref()).await {
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
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::model::{export_synced_settings, import_joining_profile_sync};
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
                builtin_themes_dir: home.join("builtin-themes"),
                state_path: home.join("sync-state.json"),
                exec: Arc::new(GitRunner::for_repo("git", clone)),
                app_version: "1.0.0".into(),
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
        // b is an established machine too: it has synced at this revision.
        let (_, status) = b.core.import_cycle(seed).await;
        assert_eq!(status.kind, SyncStatusKind::InSync, "b's first import failed: {:?}", status.message);
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
        let merged = import_synced_settings(&GlobalSettings::default(), &synced.settings).unwrap();
        assert_eq!(merged.ui_font_size, 17.0);
    }

    #[tokio::test]
    async fn profiles_cross_machines_opted_in_by_ssh_file_name() {
        let home = crate::commands::ssh_keys::home_dir().unwrap();
        let mut seed = GlobalSettings::default();
        seed.sync_git_profiles = true;
        seed.git_profiles_doc.profiles.push(crate::state::GitProfile {
            id: "p1".into(),
            name: "Work".into(),
            user_name: Some("Simon".into()),
            user_email: Some("simon@example.com".into()),
            gpg_format: None,
            signing_key: None,
            commit_gpgsign: None,
            allowed_signers_file: None,
            auth_ssh_key: Some(home.join(".ssh").join("id_work").display().to_string()),
            credential_helper: None,
        });
        let f = fixture(&seed).await;
        let mut receiver = GlobalSettings::default();
        receiver.sync_git_profiles = true;
        let (adopted, status) = f.b.core.import_cycle(&receiver).await;
        assert_eq!(status.kind, SyncStatusKind::InSync, "{:?}", status.message);
        let merged = import_synced_settings(&receiver, &adopted.unwrap().settings).unwrap();
        let p = &merged.git_profiles_doc.profiles[0];
        assert_eq!(
            p.auth_ssh_key.as_deref(),
            Some(home.join(".ssh").join("id_work").display().to_string().as_str())
        );
        // The same doc adopted without the opt-in leaves profiles alone.
        let merged =
            import_synced_settings(&GlobalSettings::default(), &export_synced_settings(&seed))
                .unwrap();
        assert!(merged.git_profiles_doc.profiles.is_empty());
    }

    fn work_profile() -> crate::state::GitProfile {
        crate::state::GitProfile {
            id: "p1".into(),
            name: "Work".into(),
            user_name: Some("Simon".into()),
            user_email: Some("simon@example.com".into()),
            gpg_format: None,
            signing_key: None,
            commit_gpgsign: None,
            allowed_signers_file: None,
            auth_ssh_key: None,
            credential_helper: None,
        }
    }

    #[tokio::test]
    async fn opting_in_on_a_second_machine_keeps_the_first_machines_profiles() {
        let mut a_settings = GlobalSettings::default();
        a_settings.sync_git_profiles = true;
        a_settings.git_profiles_doc.profiles.push(work_profile());
        let f = fixture(&a_settings).await;
        // b has one profile of its own and only now opts in: it pulls and
        // joins before its first profile export.
        let mut b_settings = GlobalSettings::default();
        let mut home_profile = work_profile();
        home_profile.id = "p2".into();
        home_profile.name = "Home".into();
        b_settings.git_profiles_doc.profiles.push(home_profile.clone());
        let (adopted, status) = f.b.core.import_cycle_capturing(&b_settings).await;
        assert_eq!(status.kind, SyncStatusKind::InSync, "{:?}", status.message);
        let b_joined = import_joining_profile_sync(&b_settings, &adopted.unwrap().settings, false).unwrap();
        assert_eq!(b_joined.git_profiles_doc.profiles, vec![work_profile(), home_profile.clone()]);
        assert_eq!(f.b.core.export_cycle(&b_joined).await.kind, SyncStatusKind::InSync);
        // a's next startup sync.
        let (adopted, status) = f.a.core.import_cycle_capturing(&a_settings).await;
        assert_eq!(status.kind, SyncStatusKind::InSync, "{:?}", status.message);
        let merged = import_synced_settings(&a_settings, &adopted.unwrap().settings).unwrap();
        assert_eq!(
            merged.git_profiles_doc.profiles,
            vec![work_profile(), home_profile],
            "b joining must add its profile, never wipe a's"
        );
    }

    #[tokio::test]
    async fn a_machine_outside_profile_sync_does_not_remove_the_repos_profiles() {
        let mut a_settings = GlobalSettings::default();
        a_settings.sync_git_profiles = true;
        a_settings.git_profiles_doc.profiles.push(work_profile());
        let f = fixture(&a_settings).await;
        let mut b_settings = GlobalSettings::default();
        b_settings.commits_row_height = 40.0;
        assert_eq!(f.b.core.export_cycle(&b_settings).await.kind, SyncStatusKind::InSync);
        let (adopted, status) = f.a.core.import_cycle(&GlobalSettings::default()).await;
        assert_eq!(status.kind, SyncStatusKind::InSync, "{:?}", status.message);
        let doc = adopted.unwrap().settings;
        assert_eq!(doc["commits_row_height"], 40.0);
        assert_eq!(doc["gitProfiles"]["profiles"][0]["id"], "p1");
    }

    /// Rewrite the doc in `clone` and push it, as another instance would.
    async fn push_doc_edit(clone: &Path, edit: impl FnOnce(&mut serde_json::Value)) {
        let path = clone.join(SYNC_SETTINGS_FILE);
        let mut doc: serde_json::Value =
            serde_json::from_str(&tokio::fs::read_to_string(&path).await.unwrap()).unwrap();
        edit(&mut doc);
        tokio::fs::write(&path, serde_json::to_string_pretty(&doc).unwrap()).await.unwrap();
        git(clone, &["add", "-A"]).await;
        git(
            clone,
            &["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--no-gpg-sign", "-m", "edit"],
        )
        .await;
        git(clone, &["push"]).await;
    }

    /// What a newer LeGit on machine `a` leaves in the repository: a higher
    /// settings revision, a setting and a nested field this build does not
    /// know, a value it cannot read and one it can.
    async fn push_newer_instance_doc(f: &Fixture) -> String {
        push_doc_edit(&f.a.core.repo, |doc| {
            doc["appVersion"] = "99.0.0".into();
            doc["settingsRevision"] = 99.into();
            doc["settings"]["setting_from_the_future"] = serde_json::json!({"nested": true});
            doc["settings"]["ui_font_size"] = "large".into();
            doc["settings"]["commits_row_height"] = 30.into();
        })
        .await;
        tokio::fs::read_to_string(f.a.core.repo.join(SYNC_SETTINGS_FILE)).await.unwrap()
    }

    async fn origin_doc(f: &Fixture) -> String {
        git(&f.a.core.repo, &["pull"]).await;
        tokio::fs::read_to_string(f.a.core.repo.join(SYNC_SETTINGS_FILE)).await.unwrap()
    }

    #[tokio::test]
    async fn an_older_instance_receives_but_never_writes() {
        let f = fixture(&GlobalSettings::default()).await;
        let newer_doc = push_newer_instance_doc(&f).await;
        // b holds a change it never exported; a capture would commit it.
        let mut b_settings = GlobalSettings::default();
        b_settings.commit_initials = true;

        let (adopted, status) = f.b.core.import_cycle_capturing(&b_settings).await;
        assert_eq!(status.kind, SyncStatusKind::ReceiveOnly, "{:?}", status.message);
        assert_eq!(status.newer_app_version.as_deref(), Some("99.0.0"));
        let adopted = adopted.expect("readable settings are still adopted");
        assert_eq!(adopted.mode, ImportMode::ReceiveOnly);
        let merged = import_keeping_unsent(
            &b_settings, &adopted.settings, adopted.base.as_ref(), adopted.mode, false,
        )
        .unwrap()
        .settings;
        assert_eq!(merged.commits_row_height, 30.0);
        assert_eq!(merged.ui_font_size, b_settings.ui_font_size, "unreadable value skipped");

        let status = f.b.core.export_cycle(&merged).await;
        assert_eq!(status.kind, SyncStatusKind::ReceiveOnly, "{:?}", status.message);
        assert_eq!(status.newer_app_version.as_deref(), Some("99.0.0"));
        assert_eq!(origin_doc(&f).await, newer_doc, "the newer doc must be untouched");
    }

    #[tokio::test]
    async fn an_unpushed_commit_is_dropped_when_a_newer_instance_moved_the_upstream() {
        let f = fixture(&GlobalSettings::default()).await;
        let newer_doc = push_newer_instance_doc(&f).await;
        // b has not synced since and exports a change of its own: the push
        // is rejected, and rebasing its commit onto the newer doc would be
        // an older instance writing into it.
        let mut b_settings = GlobalSettings::default();
        b_settings.commits_row_height = 40.0;
        let status = f.b.core.export_cycle(&b_settings).await;
        assert_eq!(status.kind, SyncStatusKind::ReceiveOnly, "{:?}", status.message);
        assert_eq!(status.newer_app_version.as_deref(), Some("99.0.0"));
        assert_eq!(origin_doc(&f).await, newer_doc);
        let b_doc =
            tokio::fs::read_to_string(f.b.core.repo.join(SYNC_SETTINGS_FILE)).await.unwrap();
        assert_eq!(b_doc, newer_doc, "b's checkout follows the upstream");
    }

    #[tokio::test]
    async fn the_first_sync_at_a_new_settings_revision_sends_no_local_values() {
        let mut seed = GlobalSettings::default();
        seed.commits_row_height = 30.0;
        let f = fixture(&seed).await;
        // b was just updated: it has never synced at this revision, so what
        // it holds for a setting may be a default it never chose. A capture
        // would commit that over a's value.
        tokio::fs::remove_file(&f.b.core.state_path).await.unwrap();
        let b_settings = GlobalSettings::default();
        let (adopted, status) = f.b.core.import_cycle_capturing(&b_settings).await;
        assert_eq!(status.kind, SyncStatusKind::InSync, "{:?}", status.message);
        let merged = import_synced_settings(&b_settings, &adopted.unwrap().settings).unwrap();
        assert_eq!(merged.commits_row_height, 30.0);
        assert_eq!(f.b.core.export_cycle(&merged).await.kind, SyncStatusKind::InSync);
        let doc: SyncDoc = serde_json::from_str(&origin_doc(&f).await).unwrap();
        assert_eq!(doc.settings["commits_row_height"], 30.0);
    }

    #[tokio::test]
    async fn an_export_before_the_first_import_at_this_revision_writes_nothing() {
        let mut seed = GlobalSettings::default();
        seed.commits_row_height = 30.0;
        let f = fixture(&seed).await;
        tokio::fs::remove_file(&f.b.core.state_path).await.unwrap();
        let before = origin_doc(&f).await;
        let status = f.b.core.export_cycle(&GlobalSettings::default()).await;
        assert_eq!(status.kind, SyncStatusKind::Ahead, "{:?}", status.message);
        assert_eq!(origin_doc(&f).await, before);
    }

    #[tokio::test]
    async fn the_manifest_of_another_sync_repository_deletes_no_local_theme() {
        let f = fixture(&GlobalSettings::default()).await;
        // b synced a theme "Old" with a DIFFERENT repository before; this
        // repository never had it, which is not a deletion.
        tokio::fs::create_dir_all(&f.b.core.user_themes_dir).await.unwrap();
        tokio::fs::write(theme_file(&f.b.core.user_themes_dir, "Old"), "{}").await.unwrap();
        let foreign = SyncStateFile {
            last_manifest: vec!["Old".into()],
            repo: Some("/some/other/checkout".into()),
            ..SyncStateFile::default()
        };
        write_state(&f.b.core.state_path, &foreign).await.unwrap();
        let (_, status) = f.b.core.import_cycle(&GlobalSettings::default()).await;
        assert_eq!(status.kind, SyncStatusKind::InSync, "{:?}", status.message);
        assert!(theme_file(&f.b.core.user_themes_dir, "Old").exists());
    }

    #[tokio::test]
    async fn a_receive_only_machine_keeps_its_own_changes_and_sends_them_once_updated() {
        let f = fixture(&GlobalSettings::default()).await;
        let newer_doc = push_newer_instance_doc(&f).await;
        // Changed on b, never sent.
        let mut b_settings = GlobalSettings::default();
        b_settings.commit_initials = true;

        let (adopted, status) = f.b.core.import_cycle_capturing(&b_settings).await;
        assert_eq!(status.kind, SyncStatusKind::ReceiveOnly, "{:?}", status.message);
        let adopted = adopted.unwrap();
        let received = import_keeping_unsent(
            &b_settings, &adopted.settings, adopted.base.as_ref(), adopted.mode, false,
        )
        .unwrap()
        .settings;
        assert!(received.commit_initials, "b's own change must stay");
        assert_eq!(received.commits_row_height, 30.0, "and the newer machine's arrives");
        assert_eq!(origin_doc(&f).await, newer_doc);

        // b is updated. A test cannot raise the build's own revision, so the
        // same situation is set up from the other side: the doc is of this
        // build's revision, and b has not imported at it yet.
        push_doc_edit(&f.a.core.repo, |doc| {
            doc["settingsRevision"] = crate::sync::model::SYNC_SETTINGS_REVISION.into();
            doc["settings"]["ui_font_size"] = 12.into();
            doc["settings"].as_object_mut().unwrap().remove("setting_from_the_future");
        })
        .await;
        let mut state = read_state(&f.b.core.state_path).await;
        state.settings_revision = 0;
        write_state(&f.b.core.state_path, &state).await.unwrap();
        let (adopted, status) = f.b.core.import_cycle_capturing(&received).await;
        assert_eq!(status.kind, SyncStatusKind::InSync, "{:?}", status.message);
        let adopted = adopted.unwrap();
        assert_eq!(adopted.mode, ImportMode::CatchUp);
        let caught_up = import_keeping_unsent(
            &received, &adopted.settings, adopted.base.as_ref(), adopted.mode, false,
        )
        .unwrap();
        assert!(caught_up.settings.commit_initials);
        assert!(caught_up.superseded.is_empty());
        assert_eq!(f.b.core.export_cycle(&caught_up.settings).await.kind, SyncStatusKind::InSync);
        let doc: SyncDoc = serde_json::from_str(&origin_doc(&f).await).unwrap();
        assert_eq!(doc.settings["commit_initials"], true, "sent once b could write again");
        assert_eq!(doc.settings["commits_row_height"], 30.0);
    }

    #[tokio::test]
    async fn a_theme_edited_on_a_machine_that_cannot_send_is_kept_as_a_copy() {
        let f = fixture(&GlobalSettings::default()).await;
        // Both machines share theme X.
        tokio::fs::create_dir_all(&f.a.core.user_themes_dir).await.unwrap();
        tokio::fs::write(theme_file(&f.a.core.user_themes_dir, "X"), "shared").await.unwrap();
        assert_eq!(f.a.core.export_cycle(&GlobalSettings::default()).await.kind, SyncStatusKind::InSync);
        let (_, status) = f.b.core.import_cycle(&GlobalSettings::default()).await;
        assert_eq!(status.kind, SyncStatusKind::InSync, "{:?}", status.message);
        // b edits X; a (now newer) changes X too and deletes nothing.
        tokio::fs::write(theme_file(&f.b.core.user_themes_dir, "X"), "edited on b").await.unwrap();
        tokio::fs::write(theme_file(&f.a.core.user_themes_dir, "X"), "edited on a").await.unwrap();
        assert_eq!(f.a.core.export_cycle(&GlobalSettings::default()).await.kind, SyncStatusKind::InSync);
        push_doc_edit(&f.a.core.repo, |doc| doc["settingsRevision"] = 99.into()).await;

        let (_, status) = f.b.core.import_cycle_capturing(&GlobalSettings::default()).await;
        assert_eq!(status.kind, SyncStatusKind::ReceiveOnly, "{:?}", status.message);
        let read = |name: &str| std::fs::read_to_string(theme_file(&f.b.core.user_themes_dir, name));
        assert_eq!(read("X").unwrap(), "edited on a");
        assert_eq!(read("X (local copy)").unwrap(), "edited on b");
        // A second sync makes no further copy.
        let (_, status) = f.b.core.import_cycle_capturing(&GlobalSettings::default()).await;
        assert_eq!(status.kind, SyncStatusKind::ReceiveOnly, "{:?}", status.message);
        assert!(read("X (local copy 2)").is_err());
    }

    #[tokio::test]
    async fn a_sync_file_that_cannot_be_read_is_never_replaced() {
        let f = fixture(&GlobalSettings::default()).await;
        let path = f.b.core.repo.join(SYNC_SETTINGS_FILE);
        tokio::fs::write(&path, "<<<<<<< not json").await.unwrap();
        let status = f.b.core.export_cycle(&GlobalSettings::default()).await;
        assert_eq!(status.kind, SyncStatusKind::Error);
        assert_eq!(tokio::fs::read_to_string(&path).await.unwrap(), "<<<<<<< not json");
    }

    #[tokio::test]
    async fn a_sync_file_with_a_value_this_build_cannot_read_is_never_replaced() {
        let f = fixture(&GlobalSettings::default()).await;
        // Same revision, but a value from a build that forgot to raise it.
        push_doc_edit(&f.a.core.repo, |doc| doc["settings"]["ui_font_size"] = "large".into()).await;
        let before = origin_doc(&f).await;
        git(&f.b.core.repo, &["pull"]).await;
        let mut b_settings = GlobalSettings::default();
        b_settings.commit_initials = true;
        let status = f.b.core.export_cycle(&b_settings).await;
        assert_eq!(status.kind, SyncStatusKind::Error);
        assert_eq!(origin_doc(&f).await, before);
    }

    #[tokio::test]
    async fn a_vanished_themes_folder_deletes_no_theme_elsewhere() {
        let f = fixture(&GlobalSettings::default()).await;
        tokio::fs::create_dir_all(&f.a.core.user_themes_dir).await.unwrap();
        tokio::fs::write(theme_file(&f.a.core.user_themes_dir, "X"), "{}").await.unwrap();
        assert_eq!(f.a.core.export_cycle(&GlobalSettings::default()).await.kind, SyncStatusKind::InSync);
        tokio::fs::remove_dir_all(&f.a.core.user_themes_dir).await.unwrap();
        let status = f.a.core.export_cycle(&GlobalSettings::default()).await;
        assert_eq!(status.kind, SyncStatusKind::Error);
        assert!(theme_file(&f.a.core.repo.join(SYNC_THEMES_DIR), "X").exists());
    }

    #[tokio::test]
    async fn a_doc_in_a_newer_sync_format_is_neither_imported_nor_replaced() {
        let f = fixture(&GlobalSettings::default()).await;
        push_doc_edit(&f.a.core.repo, |doc| doc["formatVersion"] = 2.into()).await;
        let (adopted, status) = f.b.core.import_cycle(&GlobalSettings::default()).await;
        assert!(adopted.is_none());
        assert_eq!(status.kind, SyncStatusKind::Error);
        assert!(status.message.unwrap().contains("newer LeGit"));

        let mut b_settings = GlobalSettings::default();
        b_settings.commits_row_height = 40.0;
        let status = f.b.core.export_cycle(&b_settings).await;
        assert_eq!(status.kind, SyncStatusKind::Error);
        assert_eq!(f.b.core.repo_doc().await.unwrap().format_version, 2);
    }

    #[tokio::test]
    async fn exports_are_stamped_with_the_running_version() {
        let f = fixture(&GlobalSettings::default()).await;
        let doc = f.a.core.repo_doc().await.unwrap();
        assert_eq!(doc.app_version.as_deref(), Some("1.0.0"));
        assert_eq!(doc.settings_revision, crate::sync::model::SYNC_SETTINGS_REVISION);
        let (_, status) = f.b.core.import_cycle(&GlobalSettings::default()).await;
        assert_eq!(status.newer_app_version, None);
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
            import_synced_settings(&GlobalSettings::default(), &adopted.unwrap().settings).unwrap();
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
        let mut interrupted = GlobalSettings::default();
        interrupted.commit_initials = true;
        let staged =
            SyncDoc::new(export_synced_settings(&interrupted), vec![], "1.0.0".into());
        tokio::fs::write(
            f.a.core.repo.join(SYNC_SETTINGS_FILE),
            serde_json::to_string_pretty(&staged).unwrap(),
        )
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
            "1.0.0".into(),
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
