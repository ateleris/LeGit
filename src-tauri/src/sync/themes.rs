//! Pure reconcile plans for theme files between the user theme dir and the
//! sync repo's `themes/` dir. The engine applies them; deletion propagation
//! works through the manifest remembered from the last sync.

pub struct ThemeImportPlan {
    pub copy: Vec<String>,
    pub delete_local: Vec<String>,
}

pub struct ThemeExportPlan {
    pub copy: Vec<String>,
    pub delete_repo: Vec<String>,
}

/// Copy everything the repo manifest lists; delete locally only what the
/// LAST synced manifest contained and the repo no longer does (deleted on
/// another machine). A purely local theme is untouched.
pub fn plan_theme_import(
    repo_manifest: &[String],
    last_manifest: &[String],
    local: &[String],
) -> ThemeImportPlan {
    let delete_local = last_manifest
        .iter()
        .filter(|name| !repo_manifest.contains(name) && local.contains(name))
        .cloned()
        .collect();
    ThemeImportPlan { copy: repo_manifest.to_vec(), delete_local }
}

/// The local theme dir is authoritative on export: copy all of it, delete
/// repo themes with no local counterpart.
pub fn plan_theme_export(local: &[String], repo: &[String]) -> ThemeExportPlan {
    let delete_repo = repo.iter().filter(|name| !local.contains(name)).cloned().collect();
    ThemeExportPlan { copy: local.to_vec(), delete_repo }
}

/// A manifest entry is used as a file stem: anything that could leave the
/// themes directory is refused.
pub fn safe_theme_name(name: &str) -> bool {
    // ':' is refused for Windows drive prefixes ("C:evil"), where Path::join
    // REPLACES the base path instead of descending into it.
    !name.is_empty()
        && name != "."
        && name != ".."
        && !name.contains(['/', '\\', ':'])
        && !name.chars().any(char::is_control)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn import_copies_manifest_and_deletes_only_previously_synced() {
        let plan = plan_theme_import(
            &v(&["A", "B"]),
            &v(&["A", "B", "Gone"]),
            &v(&["A", "Gone", "LocalOnly"]),
        );
        assert_eq!(plan.copy, v(&["A", "B"]));
        assert_eq!(plan.delete_local, v(&["Gone"]));
        // "LocalOnly" untouched: never synced, joins the repo on next export.
    }

    #[test]
    fn import_never_deletes_what_the_repo_still_has() {
        let plan = plan_theme_import(&v(&["A"]), &v(&["A"]), &v(&["A"]));
        assert!(plan.delete_local.is_empty());
    }

    #[test]
    fn deleted_theme_does_not_resurrect() {
        // Machine A deleted "Gone" (repo manifest no longer has it). Export
        // from a machine that already imported that deletion must not re-add
        // it, and must remove its leftover repo file.
        let plan = plan_theme_export(&v(&["A"]), &v(&["A"]));
        assert_eq!(plan.copy, v(&["A"]));
        assert!(plan.delete_repo.is_empty());
        let plan = plan_theme_export(&v(&["A"]), &v(&["A", "Gone"]));
        assert_eq!(plan.copy, v(&["A"]));
        assert_eq!(plan.delete_repo, v(&["Gone"]));
    }

    #[test]
    fn unsafe_names_are_rejected() {
        assert!(safe_theme_name("Solar Flare"));
        assert!(!safe_theme_name("../evil"));
        assert!(!safe_theme_name("a/b"));
        assert!(!safe_theme_name("a\\b"));
        assert!(!safe_theme_name(""));
        assert!(!safe_theme_name("."));
        assert!(!safe_theme_name(".."));
        // Windows: a drive-prefixed component REPLACES the base in Path::join,
        // so ':' must be refused even though Linux treats it as ordinary.
        assert!(!safe_theme_name("C:evil"));
        assert!(!safe_theme_name("a\u{7}b"));
    }
}
