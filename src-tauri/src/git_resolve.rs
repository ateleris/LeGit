//! Resolve the path to the system `git` executable (DESIGN.md §7.6).
//!
//! Order:
//!   1. User-specified path from settings (passed in).
//!   2. `which`-based PATH search.
//!   3. Common install locations per OS.
//!   4. Fallback: the literal string `"git"` and let the OS try.

use std::path::PathBuf;

pub fn resolve_git_path(user_override: Option<&PathBuf>) -> PathBuf {
    if let Some(p) = user_override {
        if p.exists() || p.as_os_str() == "git" {
            return p.clone();
        }
        tracing::warn!(
            override_path = ?p,
            "configured git path does not exist on disk — falling back to auto-detect"
        );
    }

    if let Ok(found) = which::which("git") {
        return found;
    }

    for candidate in COMMON_INSTALL_LOCATIONS {
        let p = PathBuf::from(candidate);
        if p.exists() {
            return p;
        }
    }

    PathBuf::from("git")
}

const COMMON_INSTALL_LOCATIONS: &[&str] = &[
    "/usr/bin/git",
    "/usr/local/bin/git",
    "/opt/homebrew/bin/git",
    "/opt/local/bin/git",
    "C:\\Program Files\\Git\\cmd\\git.exe",
    "C:\\Program Files\\Git\\bin\\git.exe",
    "C:\\Program Files (x86)\\Git\\cmd\\git.exe",
    "C:\\Program Files (x86)\\Git\\bin\\git.exe",
];

#[cfg(test)]
mod tests {
    use super::*;

    // The override-priority decision is the testable part; PATH/common-location
    // probing depends on the machine and is exercised implicitly.

    #[test]
    fn existing_override_wins_verbatim() {
        let dir = tempfile::tempdir().unwrap();
        let fake_git = dir.path().join("git-binary");
        std::fs::write(&fake_git, b"").unwrap();
        assert_eq!(resolve_git_path(Some(&fake_git)), fake_git);
    }

    #[test]
    fn literal_git_override_skips_the_existence_check() {
        // "git" delegates resolution to the OS; it must pass through even
        // though no file named "git" exists relative to the cwd.
        let name = PathBuf::from("git");
        assert_eq!(resolve_git_path(Some(&name)), name);
    }

    #[test]
    fn missing_override_falls_back_to_auto_detect() {
        let bogus = PathBuf::from("/definitely/not/a/real/git-path/git");
        let resolved = resolve_git_path(Some(&bogus));
        assert_ne!(resolved, bogus, "a dangling override must never be used");
    }
}
