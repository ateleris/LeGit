//! The on-disk sync document and the settings export/import merge. The
//! classification of every `GlobalSettings` field (synced vs never-synced)
//! lives here, pinned by test.

use serde::{Deserialize, Serialize};

use crate::error::AppError;
use crate::state::{GitProfile, GitProfilesDoc, GlobalSettings};

/// JSON field names that never leave this machine: session state, paths and
/// commands bound to this computer, accounts, and the sync pointer itself.
/// `gitProfiles` is NOT listed: it syncs opt-in, gated per machine by
/// `sync_git_profiles` in `export_synced_settings` / `import_synced_settings`.
pub const GLOBAL_SETTINGS_NEVER_SYNCED: [&str; 17] = [
    "repo_groups",
    "repo_remote_keys",
    "git_path_override",
    "external_editor_command",
    "last_open_repos",
    "currently_open",
    "active_open_repo",
    "last_clone_parent_dir",
    "global_region_size_top",
    "global_region_size_left",
    "global_dock_collapsed",
    "file_history_window_size",
    "work_log_window_size",
    "connected_accounts",
    "platform_key_cache",
    "settings_sync_path",
    "sync_git_profiles",
];

pub(crate) const GIT_PROFILES_KEY: &str = "gitProfiles";

/// The profile-sync keys, gated together by `sync_git_profiles`: the
/// definitions and the remote-URL -> profile-id assignment map.
const PROFILE_SYNC_KEYS: [&str; 2] = [GIT_PROFILES_KEY, "profile_assignments"];

pub const SYNC_FORMAT: &str = "legit-sync";
pub const SYNC_FORMAT_VERSION: u32 = 1;

/// Revision of the SHAPE of the synced settings: raise it whenever a synced
/// setting is added, removed or changes shape at any depth (the pinned
/// shape test fails until then), and when one gains a value older versions
/// cannot read, such as a new enum variant (no test can see that). An instance never writes a doc of a higher
/// revision than its own: it would drop what it cannot represent. It
/// receives only, until it is updated.
pub const SYNC_SETTINGS_REVISION: u32 = 2;

/// Versioned envelope of `legit-sync.json` in the sync repo.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncDoc {
    pub format: String,
    pub format_version: u32,
    /// The LeGit version that wrote this doc, to name it to the user.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app_version: Option<String>,
    /// `SYNC_SETTINGS_REVISION` of the instance that wrote the doc; docs
    /// from before revisions existed read as 0.
    #[serde(default)]
    pub settings_revision: u32,
    pub settings: serde_json::Value,
    /// Manifest of synced theme names; deletion propagation relies on it.
    pub themes: Vec<String>,
}

impl SyncDoc {
    pub fn new(settings: serde_json::Value, themes: Vec<String>, app_version: String) -> Self {
        Self {
            format: SYNC_FORMAT.to_string(),
            format_version: SYNC_FORMAT_VERSION,
            app_version: Some(app_version),
            settings_revision: SYNC_SETTINGS_REVISION,
            settings,
            themes,
        }
    }

    /// Written by an instance with a newer settings shape: this one may
    /// read it (leniently) and must never replace it.
    pub fn from_newer_instance(&self) -> bool {
        self.settings_revision > SYNC_SETTINGS_REVISION
    }

    /// Why this instance must not read or replace the doc, if it must not:
    /// a layout it does not understand would be misread on import and
    /// flattened on export.
    pub fn unsupported_reason(&self) -> Option<String> {
        if self.format != SYNC_FORMAT {
            return Some(format!("the sync repository holds an unknown document format {:?}", self.format));
        }
        (self.format_version > SYNC_FORMAT_VERSION).then(|| {
            format!(
                "the sync repository was written by a newer LeGit (sync format {}); update LeGit on this computer to keep syncing",
                self.format_version
            )
        })
    }
}

pub fn export_synced_settings(s: &GlobalSettings) -> serde_json::Value {
    let serde_json::Value::Object(mut obj) = serde_json::to_value(s).expect("settings serialize")
    else {
        unreachable!("GlobalSettings serializes to an object");
    };
    for key in GLOBAL_SETTINGS_NEVER_SYNCED {
        obj.remove(key);
    }
    if s.sync_git_profiles {
        let home = local_home();
        let doc = portable_profiles_doc(&s.git_profiles_doc, &home);
        obj.insert(
            GIT_PROFILES_KEY.to_string(),
            serde_json::to_value(doc).expect("profiles serialize"),
        );
        // `profile_assignments` is already machine-neutral; it exports as
        // serialized above.
    } else {
        for key in PROFILE_SYNC_KEYS {
            obj.remove(key);
        }
    }
    obj.insert(
        crate::repo_groups::REPO_GROUPS_SYNC_KEY.to_string(),
        crate::repo_groups::export_groups(&s.repo_groups),
    );
    serde_json::Value::Object(obj)
}

/// `export_synced_settings` for a repository that already holds `repo_doc`.
/// A machine that does not take part in profile sync leaves the profile
/// keys other machines put there untouched: dropping them would delete the
/// shared profiles from the repository with every export.
pub fn export_synced_settings_over(
    s: &GlobalSettings,
    repo_doc: Option<&serde_json::Value>,
) -> serde_json::Value {
    let mut exported = export_synced_settings(s);
    if s.sync_git_profiles {
        return exported;
    }
    if let (Some(obj), Some(repo)) = (exported.as_object_mut(), repo_doc.and_then(|d| d.as_object())) {
        for key in PROFILE_SYNC_KEYS {
            if let Some(value) = repo.get(key) {
                obj.insert(key.to_string(), value.clone());
            }
        }
    }
    exported
}

/// This machine's home directory; an unset home degrades to no path
/// rewriting (profiles then sync with their literal paths).
pub(crate) fn local_home() -> String {
    crate::commands::ssh_keys::home_dir()
        .map(|p| p.display().to_string())
        .unwrap_or_default()
}

/// Rewrite `value` to the machine-neutral `~/.ssh/<file>` form when it names
/// a file directly inside `home`'s (or `~`'s) `.ssh` directory. Everything
/// else - custom key locations, literal SSH keys, GPG key ids - passes
/// through verbatim, guarded by the prefix match alone.
fn portable_key_path(value: &str, home: &str) -> String {
    let v = value.replace('\\', "/");
    let home = home.trim_end_matches(['/', '\\']).replace('\\', "/");
    let rest = (!home.is_empty())
        .then(|| v.strip_prefix(&format!("{home}/.ssh/")))
        .flatten()
        .or_else(|| v.strip_prefix("~/.ssh/"));
    match rest {
        Some(rest) if !rest.is_empty() && !rest.contains('/') => format!("~/.ssh/{rest}"),
        _ => value.to_string(),
    }
}

/// Expand a synced `~/.ssh/<file>` value into this machine's `.ssh`
/// directory; everything else passes through verbatim.
fn local_key_path(value: &str, home: &str) -> String {
    match value.replace('\\', "/").strip_prefix("~/.ssh/") {
        Some(rest) if !rest.is_empty() && !rest.contains('/') && !home.is_empty() => {
            std::path::Path::new(home).join(".ssh").join(rest).display().to_string()
        }
        _ => value.to_string(),
    }
}

fn map_profile_key_paths(p: &GitProfile, f: &dyn Fn(&str) -> String) -> GitProfile {
    let map = |v: &Option<String>| v.as_deref().map(f);
    GitProfile {
        auth_ssh_key: map(&p.auth_ssh_key),
        signing_key: map(&p.signing_key),
        allowed_signers_file: map(&p.allowed_signers_file),
        ..p.clone()
    }
}

fn map_profiles_doc(doc: &GitProfilesDoc, f: &dyn Fn(&str) -> String) -> GitProfilesDoc {
    GitProfilesDoc {
        profiles: doc.profiles.iter().map(|p| map_profile_key_paths(p, f)).collect(),
        ..doc.clone()
    }
}

pub fn portable_profiles_doc(doc: &GitProfilesDoc, home: &str) -> GitProfilesDoc {
    map_profiles_doc(doc, &|v| portable_key_path(v, home))
}

pub fn localized_profiles_doc(doc: &GitProfilesDoc, home: &str) -> GitProfilesDoc {
    map_profiles_doc(doc, &|v| local_key_path(v, home))
}

/// Internal merge, deliberately not `with_patch`: command-owned fields are
/// legitimate synced values here; the patch guard only protects the IPC
/// surface. Unknown and never-synced keys are ignored, values are clamped.
pub fn import_synced_settings(
    local: &GlobalSettings,
    synced: &serde_json::Value,
) -> Result<GlobalSettings, AppError> {
    import_settings(local, synced, false)
}

fn import_settings(
    local: &GlobalSettings,
    synced: &serde_json::Value,
    lenient: bool,
) -> Result<GlobalSettings, AppError> {
    let synced = synced
        .as_object()
        .ok_or_else(|| AppError::Settings("synced settings must be a JSON object".into()))?;
    let serde_json::Value::Object(mut merged) =
        serde_json::to_value(local).map_err(|e| AppError::Settings(e.to_string()))?
    else {
        unreachable!("GlobalSettings serializes to an object");
    };
    for (key, value) in synced {
        if GLOBAL_SETTINGS_NEVER_SYNCED.contains(&key.as_str())
            || !merged.contains_key(key)
            || (PROFILE_SYNC_KEYS.contains(&key.as_str()) && !local.sync_git_profiles)
        {
            continue;
        }
        let previous = merged.insert(key.clone(), value.clone());
        if lenient
            && serde_json::from_value::<GlobalSettings>(serde_json::Value::Object(merged.clone()))
                .is_err()
        {
            tracing::warn!(setting = %key, "synced value from a newer LeGit not readable here; kept the local one");
            match previous {
                Some(previous) => merged.insert(key.clone(), previous),
                None => merged.remove(key),
            };
        }
    }
    let mut next: GlobalSettings = serde_json::from_value(serde_json::Value::Object(merged))
        .map_err(|e| AppError::Settings(format!("invalid synced settings: {e}")))?;
    if let Some(groups) = synced.get(crate::repo_groups::REPO_GROUPS_SYNC_KEY) {
        next.repo_groups = crate::repo_groups::import_groups(
            &local.repo_groups,
            groups,
            &local.repo_remote_keys,
        );
        // The strip order follows the doc; realign the open list with the
        // imported structure, keeping entries the doc does not know (e.g.
        // restore's kept-but-unopenable hosts) at the end.
        let mut open =
            crate::repo_groups::flatten_open(&next.repo_groups, &local.currently_open);
        for p in &local.currently_open {
            if !open.contains(p) {
                open.push(p.clone());
            }
        }
        next.currently_open = open;
    }
    if local.sync_git_profiles {
        next.git_profiles_doc = localized_profiles_doc(&next.git_profiles_doc, &local_home());
    }
    Ok(next.normalized())
}

/// The import for a machine JOINING profile sync (opting in, or adopting a
/// repository with the opt-in already on). Everything else imports as usual,
/// but the profile list becomes the union by id of the repository's and this
/// machine's, so a machine with fewer profiles cannot wipe the others' with
/// its first export. The repository's version wins an id collision; the same
/// holds for the assignment map.
pub fn import_joining_profile_sync(
    local: &GlobalSettings,
    synced: &serde_json::Value,
    lenient: bool,
) -> Result<GlobalSettings, AppError> {
    let mut joining = local.clone();
    joining.sync_git_profiles = true;
    let mut next = import_settings(&joining, synced, lenient)?;
    for profile in &local.git_profiles_doc.profiles {
        if !next.git_profiles_doc.profiles.iter().any(|p| p.id == profile.id) {
            next.git_profiles_doc.profiles.push(profile.clone());
        }
    }
    for (remote, profile_id) in &local.profile_assignments {
        next.profile_assignments
            .entry(remote.clone())
            .or_insert_with(|| profile_id.clone());
    }
    Ok(next)
}

/// How an import treats what this machine changed but has not sent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImportMode {
    /// The repository's values replace the local ones: unsent local changes
    /// were committed and merged by git beforehand, or the user chose to
    /// adopt the repository.
    Plain,
    /// The repository is from a newer instance. Nothing can be sent, so
    /// every unsent local change stays in place on this machine.
    ReceiveOnly,
    /// First import at this instance's settings revision. Unsent local
    /// changes are kept where the repository did not change the same
    /// setting, so the export that follows sends them.
    CatchUp,
}

pub struct Imported {
    pub settings: GlobalSettings,
    /// The synced settings this machine and the repository agree on after
    /// this import: the base the next import measures unsent changes from.
    pub base: serde_json::Value,
    /// Settings changed both here and elsewhere, where the repository's
    /// value was taken.
    pub superseded: Vec<String>,
}

/// Import `synced` without losing what this machine changed since `base`
/// (the agreed state after its last sync) but could not send.
pub fn import_keeping_unsent(
    local: &GlobalSettings,
    synced: &serde_json::Value,
    base: Option<&serde_json::Value>,
    mode: ImportMode,
    joining: bool,
) -> Result<Imported, AppError> {
    let lenient = mode == ImportMode::ReceiveOnly;
    let plain = if joining {
        import_joining_profile_sync(local, synced, lenient)?
    } else {
        import_settings(local, synced, lenient)?
    };
    let theirs = export_synced_settings(&plain);
    let (Some(base), false) = (base, mode == ImportMode::Plain) else {
        return Ok(Imported { settings: plain, base: theirs, superseded: Vec::new() });
    };
    // The base in this version's representation: it may have been recorded
    // by an older one.
    let agreed_settings = import_settings(local, base, true)?;
    let agreed = export_synced_settings(&agreed_settings);
    let mine = export_synced_settings(local);
    let local_raw = serde_json::to_value(local).map_err(|e| AppError::Settings(e.to_string()))?;
    let serde_json::Value::Object(mut raw) =
        serde_json::to_value(&plain).map_err(|e| AppError::Settings(e.to_string()))?
    else {
        unreachable!("GlobalSettings serializes to an object");
    };
    let mut next_base = theirs.clone();
    let mut superseded = Vec::new();
    let mut merged_profiles = None;
    for (key, my_value) in mine.as_object().into_iter().flatten() {
        // Repo groups reconcile through their own merge (`import_groups`).
        if key == crate::repo_groups::REPO_GROUPS_SYNC_KEY {
            continue;
        }
        let Some(agreed_value) = agreed.get(key) else { continue };
        let their_value = theirs.get(key);
        if my_value == agreed_value || their_value == Some(my_value) {
            continue;
        }
        if mode == ImportMode::ReceiveOnly || their_value == Some(agreed_value) {
            if let Some(value) = local_raw.get(key) {
                raw.insert(key.clone(), value.clone());
            }
            next_base[key.as_str()] = agreed_value.clone();
        } else if key == GIT_PROFILES_KEY {
            let (profiles, edits_lost) = merge_profile_lists(
                &plain.git_profiles_doc.profiles,
                &local.git_profiles_doc.profiles,
                &agreed_settings.git_profiles_doc.profiles,
            );
            if edits_lost {
                superseded.push(key.clone());
            }
            merged_profiles = Some(profiles);
        } else {
            superseded.push(key.clone());
        }
    }
    let mut settings: GlobalSettings = serde_json::from_value(serde_json::Value::Object(raw))
        .map_err(|e| AppError::Settings(format!("invalid synced settings: {e}")))?;
    if let Some(profiles) = merged_profiles {
        settings.git_profiles_doc.profiles = profiles;
    }
    Ok(Imported { settings: settings.normalized(), base: next_base, superseded })
}

/// Both sides changed the profile list since `agreed`: the repository's
/// profiles win, profiles created here are added. The flag reports a local
/// edit to an existing profile that the repository's version replaced.
fn merge_profile_lists(
    theirs: &[GitProfile],
    mine: &[GitProfile],
    agreed: &[GitProfile],
) -> (Vec<GitProfile>, bool) {
    let find = |list: &[GitProfile], id: &str| list.iter().find(|p| p.id == id).cloned();
    let mut merged = theirs.to_vec();
    let mut edits_lost = false;
    for profile in mine {
        match (find(agreed, &profile.id), find(theirs, &profile.id)) {
            (None, None) => merged.push(profile.clone()),
            (Some(before), Some(their)) => {
                edits_lost |= *profile != before && *profile != their;
            }
            // Deleted elsewhere while edited here.
            (Some(before), None) => edits_lost |= *profile != before,
            (None, Some(_)) => {}
        }
    }
    (merged, edits_lost)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with(change: impl FnOnce(&mut GlobalSettings)) -> GlobalSettings {
        let mut s = GlobalSettings::default();
        change(&mut s);
        s
    }

    #[test]
    fn a_plain_import_takes_the_repositorys_values() {
        let base = export_synced_settings(&GlobalSettings::default());
        let local = with(|s| s.commit_initials = true);
        let doc = export_synced_settings(&with(|s| s.commits_row_height = 40.0));
        let out = import_keeping_unsent(&local, &doc, Some(&base), ImportMode::Plain, false).unwrap();
        assert!(!out.settings.commit_initials);
        assert_eq!(out.settings.commits_row_height, 40.0);
        assert_eq!(out.base, doc);
    }

    #[test]
    fn receive_only_keeps_every_unsent_local_change_in_place() {
        let base = export_synced_settings(&GlobalSettings::default());
        // Changed here: initials and the row height. The newer machine
        // changed the row height too, and the lane width.
        let local = with(|s| {
            s.commit_initials = true;
            s.commits_row_height = 25.0;
        });
        let doc = export_synced_settings(&with(|s| {
            s.commits_row_height = 40.0;
            s.commits_lane_width = 30.0;
        }));
        let out =
            import_keeping_unsent(&local, &doc, Some(&base), ImportMode::ReceiveOnly, false).unwrap();
        assert!(out.settings.commit_initials);
        assert_eq!(out.settings.commits_row_height, 25.0);
        assert_eq!(out.settings.commits_lane_width, 30.0);
        assert!(out.superseded.is_empty());
        // The base moves on only where this machine has nothing unsent, so
        // the next import still knows what is waiting here.
        assert_eq!(out.base["commit_initials"], false);
        assert_eq!(out.base["commits_row_height"], base["commits_row_height"]);
        assert_eq!(out.base["commits_lane_width"], 30.0);
        let again = import_keeping_unsent(
            &out.settings, &doc, Some(&out.base), ImportMode::ReceiveOnly, false,
        )
        .unwrap();
        assert_eq!(export_synced_settings(&again.settings), export_synced_settings(&out.settings));
        assert_eq!(again.base, out.base);
    }

    #[test]
    fn catching_up_keeps_unsent_changes_and_names_the_ones_changed_elsewhere_too() {
        let base = export_synced_settings(&GlobalSettings::default());
        let local = with(|s| {
            s.commit_initials = true;
            s.commits_row_height = 25.0;
        });
        let doc = export_synced_settings(&with(|s| s.commits_row_height = 40.0));
        let out = import_keeping_unsent(&local, &doc, Some(&base), ImportMode::CatchUp, false).unwrap();
        assert!(out.settings.commit_initials, "unchanged elsewhere: kept, to be sent");
        assert_eq!(out.settings.commits_row_height, 40.0);
        assert_eq!(out.superseded, vec!["commits_row_height".to_string()]);
        // A value this instance never chose is not an unsent change.
        let fresh = import_keeping_unsent(
            &GlobalSettings::default(), &doc, Some(&base), ImportMode::CatchUp, false,
        )
        .unwrap();
        assert_eq!(fresh.settings.commits_row_height, 40.0);
        assert!(fresh.superseded.is_empty());
    }

    #[test]
    fn catching_up_never_drops_a_profile_created_here() {
        let shared = with(|s| {
            s.sync_git_profiles = true;
            s.git_profiles_doc.profiles = vec![named_profile("a", "A"), named_profile("b", "B")];
        });
        let base = export_synced_settings(&shared);
        let mut local = shared.clone();
        local.git_profiles_doc.profiles.push(named_profile("mine", "Mine"));
        local.git_profiles_doc.profiles[0].name = "A edited here".into();
        let mut other = shared.clone();
        other.git_profiles_doc.profiles[0].name = "A edited there".into();
        other.git_profiles_doc.profiles.remove(1);
        let doc = export_synced_settings(&other);

        let out = import_keeping_unsent(&local, &doc, Some(&base), ImportMode::CatchUp, false).unwrap();
        let names: Vec<&str> =
            out.settings.git_profiles_doc.profiles.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, vec!["A edited there", "Mine"]);
        assert_eq!(out.superseded, vec![GIT_PROFILES_KEY.to_string()]);
    }

    #[test]
    fn without_a_recorded_base_the_repository_wins() {
        let local = with(|s| s.commit_initials = true);
        let doc = export_synced_settings(&GlobalSettings::default());
        let out = import_keeping_unsent(&local, &doc, None, ImportMode::CatchUp, false).unwrap();
        assert!(!out.settings.commit_initials);
    }

    fn named_profile(id: &str, name: &str) -> GitProfile {
        GitProfile {
            id: id.into(),
            name: name.into(),
            user_name: None,
            user_email: None,
            gpg_format: None,
            signing_key: None,
            commit_gpgsign: None,
            allowed_signers_file: None,
            auth_ssh_key: None,
            credential_helper: None,
        }
    }

    #[test]
    fn joining_profile_sync_unions_profiles_and_assignments() {
        let mut other = GlobalSettings::default();
        other.sync_git_profiles = true;
        other.git_profiles_doc.profiles = vec![named_profile("shared", "Repo name"), named_profile("theirs", "Theirs")];
        other.profile_assignments.insert("host/a".into(), "theirs".into());
        other.profile_assignments.insert("host/both".into(), "theirs".into());
        let doc = export_synced_settings(&other);

        let mut local = GlobalSettings::default();
        local.git_profiles_doc.profiles = vec![named_profile("shared", "Local name"), named_profile("mine", "Mine")];
        local.profile_assignments.insert("host/b".into(), "mine".into());
        local.profile_assignments.insert("host/both".into(), "mine".into());

        let joined = import_joining_profile_sync(&local, &doc, false).unwrap();
        assert!(joined.sync_git_profiles);
        let names: Vec<&str> =
            joined.git_profiles_doc.profiles.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, vec!["Repo name", "Theirs", "Mine"]);
        assert_eq!(joined.profile_assignments["host/a"], "theirs");
        assert_eq!(joined.profile_assignments["host/b"], "mine");
        assert_eq!(joined.profile_assignments["host/both"], "theirs");
    }

    #[test]
    fn a_machine_outside_profile_sync_exports_the_repos_profiles_unchanged() {
        let mut other = GlobalSettings::default();
        other.sync_git_profiles = true;
        other.git_profiles_doc.profiles = vec![named_profile("theirs", "Theirs")];
        other.profile_assignments.insert("host/a".into(), "theirs".into());
        let repo_doc = export_synced_settings(&other);

        let mut local = GlobalSettings::default();
        local.git_profiles_doc.profiles = vec![named_profile("mine", "Mine")];
        let exported = export_synced_settings_over(&local, Some(&repo_doc));
        assert_eq!(exported[GIT_PROFILES_KEY], repo_doc[GIT_PROFILES_KEY]);
        assert_eq!(exported["profile_assignments"], repo_doc["profile_assignments"]);

        // An opted-in machine exports its own list.
        local.sync_git_profiles = true;
        let exported = export_synced_settings_over(&local, Some(&repo_doc));
        assert_eq!(exported[GIT_PROFILES_KEY]["profiles"][0]["id"], "mine");
    }

    #[test]
    fn a_doc_in_a_newer_or_foreign_format_is_refused() {
        let mut doc = SyncDoc::new(serde_json::json!({}), vec![], "1.0.0".into());
        assert_eq!(doc.unsupported_reason(), None);
        doc.format_version = SYNC_FORMAT_VERSION + 1;
        assert!(doc.unsupported_reason().unwrap().contains("newer LeGit"));
        doc.format_version = SYNC_FORMAT_VERSION;
        doc.format = "something-else".into();
        assert!(doc.unsupported_reason().unwrap().contains("unknown document format"));
    }

    #[test]
    fn docs_carry_the_settings_revision_and_old_docs_read_as_zero() {
        let doc = SyncDoc::new(serde_json::json!({}), vec![], "1.0.0".into());
        assert_eq!(doc.settings_revision, SYNC_SETTINGS_REVISION);
        assert!(!doc.from_newer_instance());
        let old: SyncDoc = serde_json::from_str(
            r#"{"format":"legit-sync","formatVersion":1,"settings":{},"themes":[]}"#,
        )
        .unwrap();
        assert_eq!(old.settings_revision, 0);
        let mut newer = doc;
        newer.settings_revision = SYNC_SETTINGS_REVISION + 1;
        assert!(newer.from_newer_instance());
    }

    #[test]
    fn lenient_import_skips_only_the_values_it_cannot_read() {
        let mut doc = export_synced_settings(&GlobalSettings::default());
        let obj = doc.as_object_mut().unwrap();
        obj.insert("commits_row_height".into(), serde_json::json!(40.0));
        obj.insert("ui_font_size".into(), serde_json::json!("large"));
        obj.insert("setting_from_the_future".into(), serde_json::json!(true));

        let local = GlobalSettings::default();
        assert!(import_synced_settings(&local, &doc).is_err(), "strict import stays loud");
        let merged = import_settings(&local, &doc, true).unwrap();
        assert_eq!(merged.commits_row_height, 40.0);
        assert_eq!(merged.ui_font_size, local.ui_font_size);
    }

    /// Recursive key shape of a JSON value: what an older instance would
    /// have to know to round-trip it without loss.
    fn shape(value: &serde_json::Value) -> serde_json::Value {
        use serde_json::Value;
        match value {
            Value::Object(map) => {
                Value::Object(map.iter().map(|(k, v)| (k.clone(), shape(v))).collect())
            }
            Value::Array(items) => {
                let mut shapes: Vec<Value> = Vec::new();
                for item in items {
                    let s = shape(item);
                    if !shapes.contains(&s) {
                        shapes.push(s);
                    }
                }
                Value::Array(shapes)
            }
            Value::Null => Value::String("null".into()),
            Value::Bool(_) => Value::String("bool".into()),
            Value::Number(_) => Value::String("number".into()),
            Value::String(_) => Value::String("string".into()),
        }
    }

    /// Settings with every nested synced value populated, so its inner
    /// shape is visible. A new synced collection needs an entry here.
    fn populated_settings() -> GlobalSettings {
        use crate::repo_groups::{GroupItem, GroupRepoRef, RepoGroup};
        let mut s = GlobalSettings::default();
        s.sync_git_profiles = true;
        s.git_profiles_doc.profiles = vec![named_profile("p", "P")];
        s.profile_assignments.insert("host/repo".into(), "p".into());
        let repo: GroupRepoRef =
            serde_json::from_value(serde_json::json!({"locator": "/r", "remote_key": "host/repo"}))
                .unwrap();
        s.repo_groups.items = vec![GroupItem::Group(RepoGroup {
            id: "g".into(),
            name: "G".into(),
            color: Some("accent".into()),
            collapsed: false,
            items: vec![GroupItem::Repo(repo)],
        })];
        s
    }

    /// Pins the synced settings' shape to `SYNC_SETTINGS_REVISION`. When it
    /// fails, a synced setting changed shape: raise the revision, then
    /// refresh the snapshot with `LEGIT_UPDATE_SYNC_SHAPE=1`. Without the
    /// raise, older instances would overwrite the new shape with theirs.
    #[test]
    fn synced_settings_shape_is_pinned_to_the_revision() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("src/sync/synced_settings_shape.json");
        let current = shape(&export_synced_settings(&populated_settings()));
        let pinned: serde_json::Value = std::fs::read_to_string(&path)
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or(serde_json::Value::Null);
        let pinned_revision = pinned["revision"].as_u64().unwrap_or(0) as u32;
        if pinned["shape"] == current && pinned_revision == SYNC_SETTINGS_REVISION {
            return;
        }
        if std::env::var_os("LEGIT_UPDATE_SYNC_SHAPE").is_some() {
            assert!(
                pinned["shape"] == current || SYNC_SETTINGS_REVISION > pinned_revision,
                "the shape changed: raise SYNC_SETTINGS_REVISION above {pinned_revision} first"
            );
            let doc = serde_json::json!({ "revision": SYNC_SETTINGS_REVISION, "shape": current });
            std::fs::write(&path, serde_json::to_string_pretty(&doc).unwrap() + "\n").unwrap();
            return;
        }
        panic!(
            "the synced settings' shape or SYNC_SETTINGS_REVISION changed: raise the revision \
             if the shape changed, then run with LEGIT_UPDATE_SYNC_SHAPE=1"
        );
    }

    #[test]
    fn joining_a_repository_without_profiles_keeps_the_local_ones() {
        let doc = export_synced_settings(&GlobalSettings::default());
        let mut local = GlobalSettings::default();
        local.git_profiles_doc.profiles = vec![named_profile("mine", "Mine")];
        let joined = import_joining_profile_sync(&local, &doc, false).unwrap();
        assert_eq!(joined.git_profiles_doc.profiles, vec![named_profile("mine", "Mine")]);
    }

    #[test]
    fn never_synced_keys_all_exist_on_the_struct() {
        let obj = serde_json::to_value(GlobalSettings::default()).unwrap();
        let obj = obj.as_object().unwrap();
        for key in GLOBAL_SETTINGS_NEVER_SYNCED {
            assert!(obj.contains_key(key), "unknown never-synced key {key}");
        }
    }

    #[test]
    fn synced_key_list_is_exactly_the_classified_set() {
        // Pins the classification: a new GlobalSettings field fails here
        // until it is consciously added to one of the two lists.
        let exported = export_synced_settings(&GlobalSettings::default());
        let mut keys: Vec<&str> =
            exported.as_object().unwrap().keys().map(|s| s.as_str()).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            vec![
                "active_theme",
                "auto_fetch_enabled",
                "auto_fetch_interval_minutes",
                "auto_push_tags",
                "branch_list_view",
                "changed_files_view_mode",
                "check_updates_on_startup",
                "checkout_new_branch",
                "checkout_remote_fast_forward",
                "column_preferences",
                "commit_avatars",
                "commit_date_absolute",
                "commit_date_format",
                "commit_date_show_time",
                "commit_initials",
                "commits_dot_radius",
                "commits_lane_width",
                "commits_line_width",
                "commits_row_height",
                "confirm_discard",
                "detect_case_renames",
                "diff_syntax_highlighting",
                "file_history_opens_window",
                "files_show_ignored",
                "files_view_mode",
                "global_region_placement",
                "lane_colored_branch_chips",
                "large_file_warn_mb",
                "line_ending_chips_in_changes",
                "panel_border_width",
                "panel_corner_radius",
                "panel_gap",
                "problem_notice_style",
                "pull_strategy",
                "push_recurse_submodules",
                "refs_sort_mode",
                "repoGroups",
                "repo_tab_border_width",
                "repo_tab_corner_radius",
                "repo_tab_gap",
                "repo_tab_height",
                "repo_tab_inset",
                "repo_tab_strip_border_width",
                "repo_tab_style",
                "stash_base_lane_color",
                "stash_include_untracked",
                "submodule_attach_branch",
                "suppressed_auto_open_panels",
                "switch_dirty_behavior",
                "tags_sort_mode",
                "ui_font_size",
                "warn_on_line_ending_commit",
                "watcher_enabled",
                "working_changes_section_order",
            ]
        );
    }

    #[test]
    fn import_overwrites_synced_keys_only_and_clamps() {
        let local = GlobalSettings::default();
        let synced = serde_json::json!({
            "ui_font_size": 900.0,              // out of range: must clamp
            "active_theme": "Cozy",             // command-owned but synced: must land
            "git_path_override": "C:/evil.exe", // never-synced: must be ignored
            "not_a_real_key": true,              // unknown: must be ignored
        });
        let merged = import_synced_settings(&local, &synced).unwrap();
        assert_eq!(merged.ui_font_size, 24.0);
        assert_eq!(merged.active_theme.as_deref(), Some("Cozy"));
        assert_eq!(merged.git_path_override, None);
    }

    fn profile(auth_key: &str, signing: Option<&str>) -> GitProfile {
        GitProfile {
            id: "p1".into(),
            name: "Work".into(),
            user_name: Some("Simon".into()),
            user_email: Some("simon@example.com".into()),
            gpg_format: signing.map(|_| "ssh".into()),
            signing_key: signing.map(Into::into),
            commit_gpgsign: None,
            allowed_signers_file: None,
            auth_ssh_key: Some(auth_key.into()),
            credential_helper: None,
        }
    }

    fn settings_with_profile(p: GitProfile) -> GlobalSettings {
        let mut s = GlobalSettings::default();
        s.sync_git_profiles = true;
        s.git_profiles_doc.profiles.push(p);
        s
    }

    #[test]
    fn profiles_sync_only_when_opted_in() {
        let mut s = GlobalSettings::default();
        s.git_profiles_doc.profiles.push(profile("~/.ssh/id", None));
        s.profile_assignments.insert("https://github.com/org/repo".into(), "p1".into());
        let exported = export_synced_settings(&s);
        assert!(!exported.as_object().unwrap().contains_key("gitProfiles"));
        assert!(!exported.as_object().unwrap().contains_key("profile_assignments"));
        s.sync_git_profiles = true;
        let exported = export_synced_settings(&s);
        assert!(exported.as_object().unwrap().contains_key("gitProfiles"));
        assert_eq!(exported["profile_assignments"]["https://github.com/org/repo"], "p1");
    }

    #[test]
    fn repo_groups_sync_unconditionally() {
        use crate::repo_groups::{GroupItem, GroupRepoRef, RepoGroup};
        let mut sender = GlobalSettings::default();
        sender.sync_git_profiles = false;
        sender.repo_groups.items.push(GroupItem::Group(RepoGroup {
            id: "g1".into(),
            name: "Work".into(),
            color: None,
            collapsed: true,
            items: vec![GroupItem::Repo(GroupRepoRef {
                locator: Some("/sender/path".into()),
                remote_key: Some("https://github.com/Org/Repo".into()),
            color: None,
            })],
        }));
        let exported = export_synced_settings(&sender);
        assert!(!exported.as_object().unwrap().contains_key("repo_groups"));
        assert_eq!(exported["repoGroups"][0]["items"][0], "https://github.com/Org/Repo");

        let mut receiver = GlobalSettings::default();
        receiver
            .repo_remote_keys
            .insert("/receiver/path".into(), "https://github.com/Org/Repo".into());
        let merged = import_synced_settings(&receiver, &exported).unwrap();
        let GroupItem::Group(g) = &merged.repo_groups.items[0] else {
            panic!("expected a group")
        };
        assert_eq!(g.name, "Work");
        assert!(!g.collapsed, "collapsed is machine-local and never arrives via sync");
        assert!(matches!(&g.items[0], GroupItem::Repo(r)
            if r.locator.as_deref() == Some("/receiver/path")));
        // the receiver's bookkeeping map stays its own
        assert!(merged.repo_remote_keys.contains_key("/receiver/path"));
    }

    #[test]
    fn import_realigns_currently_open_with_the_imported_doc_order() {
        use crate::repo_groups::{GroupItem, GroupRepoRef, RepoGroup};
        let mut sender = GlobalSettings::default();
        sender.repo_groups.items.push(GroupItem::Group(RepoGroup {
            id: "g1".into(),
            name: "g1".into(),
            color: None,
            collapsed: false,
            items: vec![GroupItem::Repo(GroupRepoRef {
                locator: Some("/sender/b".into()),
                remote_key: Some("kb".into()),
                color: None,
            })],
        }));
        let mut receiver = GlobalSettings::default();
        // locally b is ordered BEFORE a; the imported doc ends up [a, g1(b)],
        // so currently_open must realign to the doc order (kept-but-unknown
        // entries stay at the end).
        receiver.currently_open = vec!["/r/b".into(), "/r/a".into(), "wsl://Down/kept".into()];
        receiver.repo_remote_keys.insert("/r/b".into(), "kb".into());
        receiver.repo_groups.items.push(GroupItem::Repo(GroupRepoRef {
            locator: Some("/r/a".into()),
            remote_key: None,
            color: None,
        }));
        let merged =
            import_synced_settings(&receiver, &export_synced_settings(&sender)).unwrap();
        assert_eq!(merged.currently_open, vec!["/r/a", "/r/b", "wsl://Down/kept"]);
        // and the doc itself holds b inside g1
        let holds_b = matches!(&merged.repo_groups.items.iter().find_map(|it| match it {
            GroupItem::Group(g) if g.id == "g1" => Some(g.items.clone()),
            _ => None,
        }), Some(items) if matches!(&items[0], GroupItem::Repo(r) if r.locator.as_deref() == Some("/r/b")));
        assert!(holds_b);
    }

    #[test]
    fn portable_key_path_rewrites_ssh_dir_files_only() {
        let home = "C:\\Users\\simon";
        assert_eq!(portable_key_path("C:\\Users\\simon\\.ssh\\id_ed25519_work", home), "~/.ssh/id_ed25519_work");
        assert_eq!(portable_key_path("C:/Users/simon/.ssh/id.pub", home), "~/.ssh/id.pub");
        assert_eq!(portable_key_path("~\\.ssh\\id", home), "~/.ssh/id");
        // Nested dirs, custom locations, literal keys and GPG ids pass through.
        assert_eq!(portable_key_path("C:/Users/simon/.ssh/sub/id", home), "C:/Users/simon/.ssh/sub/id");
        assert_eq!(portable_key_path("D:/keys/id", home), "D:/keys/id");
        assert_eq!(portable_key_path("ssh-ed25519 AAAA/b+c me", home), "ssh-ed25519 AAAA/b+c me");
        assert_eq!(portable_key_path("ABCDEF0123456789", home), "ABCDEF0123456789");
        // An unknown home must not degrade into rewriting foreign paths.
        assert_eq!(portable_key_path("/root/.ssh/id", ""), "/root/.ssh/id");
    }

    #[test]
    fn local_key_path_expands_portable_values_only() {
        let joined = std::path::Path::new("/home/x").join(".ssh").join("id");
        assert_eq!(local_key_path("~/.ssh/id", "/home/x"), joined.display().to_string());
        assert_eq!(local_key_path("/elsewhere/id", "/home/x"), "/elsewhere/id");
        assert_eq!(local_key_path("ssh-ed25519 AAAA/b me", "/home/x"), "ssh-ed25519 AAAA/b me");
        assert_eq!(local_key_path("~/.ssh/id", ""), "~/.ssh/id");
    }

    #[test]
    fn profile_roundtrip_carries_keys_by_ssh_file_name() {
        let home = crate::commands::ssh_keys::home_dir().unwrap();
        let auth = home.join(".ssh").join("id_ed25519_work");
        let signing = format!("{}.pub", auth.display());
        let mut s = settings_with_profile(profile(&auth.display().to_string(), Some(&signing)));
        s.profile_assignments.insert("https://github.com/org/repo".into(), "p1".into());
        let exported = export_synced_settings(&s);
        let doc: GitProfilesDoc =
            serde_json::from_value(exported["gitProfiles"].clone()).unwrap();
        assert_eq!(doc.profiles[0].auth_ssh_key.as_deref(), Some("~/.ssh/id_ed25519_work"));
        assert_eq!(doc.profiles[0].signing_key.as_deref(), Some("~/.ssh/id_ed25519_work.pub"));

        let mut receiver = GlobalSettings::default();
        receiver.sync_git_profiles = true;
        let merged = import_synced_settings(&receiver, &exported).unwrap();
        let p = &merged.git_profiles_doc.profiles[0];
        assert_eq!(p.auth_ssh_key.as_deref(), Some(auth.display().to_string().as_str()));
        assert_eq!(p.user_email.as_deref(), Some("simon@example.com"));
        assert_eq!(
            merged.profile_assignments.get("https://github.com/org/repo").map(String::as_str),
            Some("p1")
        );
    }

    #[test]
    fn import_without_opt_in_keeps_local_profiles() {
        let mut sender = settings_with_profile(profile("~/.ssh/id", None));
        sender.profile_assignments.insert("https://github.com/org/repo".into(), "p1".into());
        let mut receiver = GlobalSettings::default();
        receiver.profile_assignments.insert("https://example.com/x/y".into(), "mine".into());
        let merged = import_synced_settings(&receiver, &export_synced_settings(&sender)).unwrap();
        assert!(merged.git_profiles_doc.profiles.is_empty());
        assert_eq!(merged.profile_assignments.len(), 1);
        assert!(merged.profile_assignments.contains_key("https://example.com/x/y"));
    }

    #[test]
    fn import_rejects_non_object() {
        assert!(
            import_synced_settings(&GlobalSettings::default(), &serde_json::json!("nope"))
                .is_err()
        );
    }

    #[test]
    fn export_import_roundtrip_is_identity() {
        let s = GlobalSettings::default();
        let merged = import_synced_settings(&s, &export_synced_settings(&s)).unwrap();
        assert_eq!(
            serde_json::to_value(&merged).unwrap(),
            serde_json::to_value(&s).unwrap()
        );
    }
}
