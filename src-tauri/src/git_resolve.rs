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
