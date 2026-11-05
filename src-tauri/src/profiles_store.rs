//! The on-disk store for git profiles: `<app-data>/git-profiles.json`.
//!
//! The file is meant to be managed by dotfile tools (chezmoi), so key paths
//! inside are stored machine-neutral (`~/.ssh/<file>`) and a file that fails
//! to load is NEVER rewritten except by an explicit profile mutation - a
//! half-rendered template must not be replaced with an empty doc.

use std::path::{Path, PathBuf};

use crate::error::AppError;
use crate::state::GitProfilesDoc;
use crate::sync::model::{localized_profiles_doc, portable_profiles_doc};

pub const PROFILES_FORMAT: &str = "legit-git-profiles";
pub const PROFILES_FORMAT_VERSION: u32 = 1;

/// Sibling of `global-settings.json`.
pub fn git_profiles_path(global_settings_path: &Path) -> PathBuf {
    global_settings_path.with_file_name("git-profiles.json")
}

#[derive(Debug)]
pub enum ProfilesLoad {
    /// No file; the embedded settings copy (or the default) applies.
    Missing,
    /// Parsed and localized.
    Loaded(GitProfilesDoc),
    /// Present but unusable (I/O error, bad JSON, foreign or newer
    /// envelope). The file must be left untouched.
    Broken(String),
}

pub fn load_profiles_file(path: &Path, home: &str) -> ProfilesLoad {
    // Not `persist::load_json_or_default`: that moves a corrupt file aside,
    // which is exactly the clobbering this store forbids.
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return ProfilesLoad::Missing,
        Err(e) => return ProfilesLoad::Broken(format!("cannot read the file: {e}")),
    };
    let doc: GitProfilesDoc = match serde_json::from_str(&text) {
        Ok(d) => d,
        Err(e) => return ProfilesLoad::Broken(format!("not a valid profiles document: {e}")),
    };
    if doc.format != PROFILES_FORMAT {
        return ProfilesLoad::Broken(format!("unknown format \"{}\"", doc.format));
    }
    if doc.format_version > PROFILES_FORMAT_VERSION {
        return ProfilesLoad::Broken(format!(
            "format version {} is newer than this LeGit understands ({})",
            doc.format_version, PROFILES_FORMAT_VERSION
        ));
    }
    ProfilesLoad::Loaded(localized_profiles_doc(&doc, home))
}

/// Pretty JSON of the doc with key paths in portable form.
pub fn portable_profiles_json(doc: &GitProfilesDoc, home: &str) -> Result<String, AppError> {
    Ok(serde_json::to_string_pretty(&portable_profiles_doc(doc, home))?)
}

/// Serialize global settings for `global-settings.json`: the profiles key
/// is stripped (the doc lives in its own file), EXCEPT while that file is
/// broken - then the embedded copy must survive until a profile edit
/// supersedes the broken file.
pub fn global_settings_disk_json(
    settings: &crate::state::GlobalSettings,
    profiles_file_broken: bool,
) -> Result<String, AppError> {
    let mut value = serde_json::to_value(settings)?;
    if !profiles_file_broken {
        if let Some(obj) = value.as_object_mut() {
            obj.remove(crate::sync::model::GIT_PROFILES_KEY);
        }
    }
    Ok(serde_json::to_string_pretty(&value)?)
}

/// Result of the startup load/migration.
pub struct MigrateOutcome {
    /// User-facing warnings (shown once via the startup notices).
    pub notices: Vec<String>,
    /// The file is present but unusable; the embedded settings copy stays
    /// authoritative (and persisted) until a profile edit supersedes it.
    pub file_broken: bool,
}

/// File's profiles first and unchanged, then each `embedded` profile whose
/// id the file lacks, in embedded order. Returns whether anything was added.
pub fn merge_profiles_by_id(
    file: &GitProfilesDoc,
    embedded: &GitProfilesDoc,
) -> (GitProfilesDoc, bool) {
    let mut merged = file.clone();
    let mut added = false;
    for p in &embedded.profiles {
        if !merged.profiles.iter().any(|f| f.id == p.id) {
            merged.profiles.push(p.clone());
            added = true;
        }
    }
    (merged, added)
}

/// Apply the startup load rules (design/2026-11-05-git-profiles-separate-file.md)
/// to `settings.git_profiles_doc`, writing `path` when they demand it.
pub fn load_and_migrate_profiles(
    settings: &mut crate::state::GlobalSettings,
    path: &Path,
    home: &str,
) -> MigrateOutcome {
    let mut notices = Vec::new();
    // On failure the outcome must report the file as broken: the baseline is
    // seeded from the post-migrate doc, so without the flag no retry would
    // happen and the strip would drop the embedded copy - the profiles that
    // never reached the file would be lost at the next restart.
    let write_doc = |doc: &GitProfilesDoc, notices: &mut Vec<String>| -> bool {
        let res = portable_profiles_json(doc, home)
            .map_err(|e| e.to_string())
            .and_then(|json| {
                crate::persist::write_atomic_sync(path, json).map_err(|e| e.to_string())
            });
        if let Err(e) = res {
            tracing::warn!(path = %path.display(), err = %e, "cannot write the git profiles file");
            notices.push(format!(
                "Could not write the git profiles file {}: {e}. The profiles stay in the app \
                 settings until a profile edit retries the write.",
                path.display()
            ));
            return false;
        }
        true
    };
    match load_profiles_file(path, home) {
        ProfilesLoad::Missing => {
            let written = settings.git_profiles_doc.profiles.is_empty()
                || write_doc(&settings.git_profiles_doc.clone(), &mut notices);
            MigrateOutcome { notices, file_broken: !written }
        }
        ProfilesLoad::Loaded(file_doc) => {
            let (merged, added) = merge_profiles_by_id(&file_doc, &settings.git_profiles_doc);
            settings.git_profiles_doc = merged;
            let written = !added || write_doc(&settings.git_profiles_doc.clone(), &mut notices);
            MigrateOutcome { notices, file_broken: !written }
        }
        ProfilesLoad::Broken(reason) => {
            tracing::warn!(path = %path.display(), reason = %reason, "git profiles file is unusable");
            notices.push(format!(
                "The git profiles file {} could not be loaded: {reason}. The file was left \
                 untouched; the previously known profiles stay active until it is fixed or a \
                 profile is edited.",
                path.display()
            ));
            MigrateOutcome { notices, file_broken: true }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::GitProfile;

    fn profile(id: &str, key: Option<String>) -> GitProfile {
        GitProfile {
            id: id.into(),
            name: format!("p-{id}"),
            user_name: Some("U".into()),
            user_email: Some("u@example.com".into()),
            gpg_format: None,
            signing_key: None,
            commit_gpgsign: None,
            allowed_signers_file: None,
            auth_ssh_key: key,
            credential_helper: None,
        }
    }

    fn doc(profiles: Vec<GitProfile>) -> GitProfilesDoc {
        GitProfilesDoc { profiles, ..GitProfilesDoc::default() }
    }

    const HOME: &str = "/home/tester";

    #[test]
    fn path_is_settings_sibling() {
        assert_eq!(
            git_profiles_path(Path::new("/x/global-settings.json")),
            PathBuf::from("/x/git-profiles.json")
        );
    }

    #[test]
    fn missing_file_is_missing() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("git-profiles.json");
        assert!(matches!(load_profiles_file(&p, HOME), ProfilesLoad::Missing));
    }

    #[test]
    fn valid_file_loads_localized() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("git-profiles.json");
        let local_key = format!("{HOME}/.ssh/id_ed25519");
        let json =
            portable_profiles_json(&doc(vec![profile("a", Some(local_key.clone()))]), HOME).unwrap();
        assert!(json.contains("~/.ssh/id_ed25519"), "portable form expected in {json}");
        std::fs::write(&p, json).unwrap();
        let ProfilesLoad::Loaded(loaded) = load_profiles_file(&p, HOME) else {
            panic!("expected Loaded");
        };
        assert_eq!(loaded.profiles[0].auth_ssh_key.as_deref(), Some(local_key.as_str()));
    }

    #[test]
    fn garbage_is_broken_and_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("git-profiles.json");
        std::fs::write(&p, "not json").unwrap();
        assert!(matches!(load_profiles_file(&p, HOME), ProfilesLoad::Broken(_)));
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "not json");
    }

    #[test]
    fn empty_file_is_broken() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("git-profiles.json");
        std::fs::write(&p, "").unwrap();
        assert!(matches!(load_profiles_file(&p, HOME), ProfilesLoad::Broken(_)));
    }

    #[test]
    fn unreadable_path_is_broken() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("git-profiles.json");
        std::fs::create_dir(&p).unwrap();
        assert!(matches!(load_profiles_file(&p, HOME), ProfilesLoad::Broken(_)));
    }

    #[test]
    fn wrong_format_is_broken() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("git-profiles.json");
        let mut v: serde_json::Value =
            serde_json::from_str(&portable_profiles_json(&doc(vec![]), HOME).unwrap()).unwrap();
        v["format"] = "something-else".into();
        std::fs::write(&p, v.to_string()).unwrap();
        assert!(matches!(load_profiles_file(&p, HOME), ProfilesLoad::Broken(_)));
    }

    #[test]
    fn newer_version_is_broken() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("git-profiles.json");
        let mut v: serde_json::Value =
            serde_json::from_str(&portable_profiles_json(&doc(vec![]), HOME).unwrap()).unwrap();
        v["formatVersion"] = 2.into();
        std::fs::write(&p, v.to_string()).unwrap();
        assert!(matches!(load_profiles_file(&p, HOME), ProfilesLoad::Broken(_)));
    }

    fn settings_with(profiles: Vec<GitProfile>) -> crate::state::GlobalSettings {
        let mut s = crate::state::GlobalSettings::default();
        s.git_profiles_doc = doc(profiles);
        s
    }

    #[test]
    fn disk_json_strips_the_profiles_key() {
        let s = settings_with(vec![profile("a", None)]);
        let direct = serde_json::to_string(&s).unwrap();
        assert!(direct.contains("\"gitProfiles\""), "wire key changed? {direct}");
        let stripped = global_settings_disk_json(&s, false).unwrap();
        assert!(!stripped.contains("\"gitProfiles\""));
        let kept = global_settings_disk_json(&s, true).unwrap();
        assert!(kept.contains("\"gitProfiles\""), "broken state keeps the embedded copy");
    }

    #[test]
    fn merge_file_wins_per_id_and_appends_unknown() {
        let mut edited = profile("a", None);
        edited.user_name = Some("machine-local edit".into());
        let file = doc(vec![profile("a", None)]);
        let embedded = doc(vec![edited, profile("b", None)]);
        let (merged, added) = merge_profiles_by_id(&file, &embedded);
        assert!(added);
        assert_eq!(
            merged.profiles.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(),
            vec!["a", "b"]
        );
        assert_eq!(merged.profiles[0], profile("a", None), "file's version wins per id");
    }

    #[test]
    fn merge_identical_adds_nothing() {
        let file = doc(vec![profile("a", None), profile("b", None)]);
        let embedded = doc(vec![profile("b", None)]);
        let (merged, added) = merge_profiles_by_id(&file, &embedded);
        assert!(!added);
        assert_eq!(merged.profiles, file.profiles);
    }

    #[test]
    fn load_missing_with_embedded_writes_migration() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("git-profiles.json");
        let mut s = settings_with(vec![profile("a", Some(format!("{HOME}/.ssh/k")))]);
        let out = load_and_migrate_profiles(&mut s, &p, HOME);
        assert!(out.notices.is_empty());
        assert!(!out.file_broken);
        assert_eq!(s.git_profiles_doc.profiles.len(), 1);
        let on_disk = std::fs::read_to_string(&p).unwrap();
        assert!(on_disk.contains("~/.ssh/k"), "portable form expected in {on_disk}");
    }

    #[test]
    fn load_missing_without_profiles_writes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("git-profiles.json");
        let mut s = settings_with(vec![]);
        let out = load_and_migrate_profiles(&mut s, &p, HOME);
        assert!(out.notices.is_empty());
        assert!(!p.exists());
    }

    #[test]
    fn load_file_wins_and_merges() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("git-profiles.json");
        std::fs::write(&p, portable_profiles_json(&doc(vec![profile("a", None)]), HOME).unwrap())
            .unwrap();
        let mut edited = profile("a", None);
        edited.user_name = Some("machine-local edit".into());
        let mut s = settings_with(vec![edited, profile("b", None)]);
        let out = load_and_migrate_profiles(&mut s, &p, HOME);
        assert!(out.notices.is_empty());
        assert_eq!(
            s.git_profiles_doc.profiles.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(),
            vec!["a", "b"]
        );
        assert_eq!(s.git_profiles_doc.profiles[0], profile("a", None));
        let rewritten: GitProfilesDoc =
            serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap();
        assert_eq!(rewritten.profiles.len(), 2, "recovered profile propagates to the file");
    }

    #[test]
    fn load_file_only_does_not_rewrite() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("git-profiles.json");
        let json = portable_profiles_json(&doc(vec![profile("a", None)]), HOME).unwrap();
        std::fs::write(&p, &json).unwrap();
        let mut s = settings_with(vec![]);
        let out = load_and_migrate_profiles(&mut s, &p, HOME);
        assert!(out.notices.is_empty());
        assert_eq!(s.git_profiles_doc.profiles.len(), 1);
        assert_eq!(std::fs::read_to_string(&p).unwrap(), json, "file untouched");
    }

    #[test]
    fn load_broken_keeps_embedded_and_flags() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("git-profiles.json");
        std::fs::write(&p, "not json").unwrap();
        let mut s = settings_with(vec![profile("a", None)]);
        let out = load_and_migrate_profiles(&mut s, &p, HOME);
        assert!(out.file_broken);
        assert_eq!(out.notices.len(), 1);
        assert!(out.notices[0].contains("git-profiles.json"), "notice names the file: {}", out.notices[0]);
        assert_eq!(s.git_profiles_doc.profiles.len(), 1, "embedded profiles keep working");
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "not json", "file untouched");
    }

    #[test]
    fn failed_migration_write_flags_broken() {
        // A parent that does not exist: the read reports Missing, the
        // migration write fails. Without the broken flag the baseline would
        // assume the write succeeded and the strip would drop the embedded
        // copy - permanent loss after a restart.
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("no-such-dir").join("git-profiles.json");
        let mut s = settings_with(vec![profile("a", None)]);
        let out = load_and_migrate_profiles(&mut s, &p, HOME);
        assert!(out.file_broken, "failed write must keep the embedded copy persisted");
        assert_eq!(out.notices.len(), 1);
        assert_eq!(s.git_profiles_doc.profiles.len(), 1);
    }

    #[test]
    fn load_ok_is_not_flagged_broken() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("git-profiles.json");
        std::fs::write(&p, portable_profiles_json(&doc(vec![profile("a", None)]), HOME).unwrap())
            .unwrap();
        let mut s = settings_with(vec![]);
        let out = load_and_migrate_profiles(&mut s, &p, HOME);
        assert!(!out.file_broken);
        assert!(out.notices.is_empty());
    }

    #[test]
    fn unknown_extra_fields_still_load() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("git-profiles.json");
        let mut v: serde_json::Value =
            serde_json::from_str(&portable_profiles_json(&doc(vec![profile("a", None)]), HOME).unwrap())
                .unwrap();
        v["futureField"] = "whatever".into();
        std::fs::write(&p, v.to_string()).unwrap();
        assert!(matches!(load_profiles_file(&p, HOME), ProfilesLoad::Loaded(_)));
    }
}
