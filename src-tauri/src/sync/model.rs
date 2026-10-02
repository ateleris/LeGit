//! The on-disk sync document and the settings export/import merge. The
//! classification of every `GlobalSettings` field (synced vs never-synced)
//! lives here, pinned by test.

use serde::{Deserialize, Serialize};

use crate::error::AppError;
use crate::state::GlobalSettings;

/// JSON field names that never leave this machine: session state, paths and
/// commands bound to this computer, identities, and the sync pointer itself.
pub const GLOBAL_SETTINGS_NEVER_SYNCED: [&str; 13] = [
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
    "gitProfiles",
    "connected_accounts",
    "settings_sync_path",
];

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
    serde_json::Value::Object(obj)
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
        if GLOBAL_SETTINGS_NEVER_SYNCED.contains(&key.as_str()) || !merged.contains_key(key) {
            continue;
        }
        merged.insert(key.clone(), value.clone());
    }
    let next: GlobalSettings = serde_json::from_value(serde_json::Value::Object(merged))
        .map_err(|e| AppError::Settings(format!("invalid synced settings: {e}")))?;
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
