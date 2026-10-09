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
pub const GLOBAL_SETTINGS_NEVER_SYNCED: [&str; 14] = [
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
    "connected_accounts",
    "platform_key_cache",
    "settings_sync_path",
    "sync_git_profiles",
];

const GIT_PROFILES_KEY: &str = "gitProfiles";

/// The profile-sync keys, gated together by `sync_git_profiles`: the
/// definitions and the remote-URL -> profile-id assignment map.
const PROFILE_SYNC_KEYS: [&str; 2] = [GIT_PROFILES_KEY, "profile_assignments"];

/// Versioned envelope of `legit-sync.json` in the sync repo.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncDoc {
    pub format: String,
    pub format_version: u32,
    pub settings: serde_json::Value,
    /// Manifest of synced theme names; deletion propagation relies on it.
    pub themes: Vec<String>,
}

impl SyncDoc {
    pub fn new(settings: serde_json::Value, themes: Vec<String>) -> Self {
        Self {
            format: "legit-sync".to_string(),
            format_version: 1,
            settings,
            themes,
        }
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
    serde_json::Value::Object(obj)
}

/// This machine's home directory; an unset home degrades to no path
/// rewriting (profiles then sync with their literal paths).
fn local_home() -> String {
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
        merged.insert(key.clone(), value.clone());
    }
    let mut next: GlobalSettings = serde_json::from_value(serde_json::Value::Object(merged))
        .map_err(|e| AppError::Settings(format!("invalid synced settings: {e}")))?;
    if local.sync_git_profiles {
        next.git_profiles_doc = localized_profiles_doc(&next.git_profiles_doc, &local_home());
    }
    Ok(next.normalized())
}

#[cfg(test)]
mod tests {
    use super::*;

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
                "line_ending_chips_in_changes",
                "panel_border_width",
                "panel_corner_radius",
                "panel_gap",
                "pull_strategy",
                "push_recurse_submodules",
                "refs_sort_mode",
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
