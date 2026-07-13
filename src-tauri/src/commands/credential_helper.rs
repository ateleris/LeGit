//! Global `credential.helper` as a direct, edit-only mirror, backing Global
//! Settings' "Credential helper (global)" section.
//!
//! The key is multi-valued and ACCUMULATES across scopes (system + global +
//! local helpers are all consulted in order), so this view shows the scopes
//! separately instead of pretending there is one resolved value. The write is
//! a single plain value: never the empty reset entry the per-repo profile
//! apply uses: at global scope that entry would mask system-scope helpers
//! (e.g. Git Credential Manager) for every repo on the machine
//! (design/2026-07-13-global-default-profile.md). `core.sshCommand` remains
//! repo-only via profiles.

use crate::error::AppError;
use crate::state::AppState;
use legit_core::{GitError, GitRunner};
use serde::{Deserialize, Serialize};
use specta::Type;

const KEY: &str = "credential.helper";

/// The effective helper entry per scope (last non-empty entry at that scope;
/// `None` = no helper configured there). Local scope is deliberately absent:
/// this backs a global-settings editor (see `read_config_global_scopes` for
/// why global views must not consult local scope).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct CredentialHelperView {
    pub helper_global: Option<String>,
    pub helper_system: Option<String>,
}

/// Last non-empty line of a `git config --get-all credential.helper` output:
/// later entries win, and empty entries are the "reset" markers the per-repo
/// apply writes, not helpers (pure; unit-tested).
fn last_non_empty(stdout: &str) -> Option<String> {
    stdout
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .last()
        .map(|s| s.to_string())
}

async fn read_helper_at(runner: &GitRunner, flag: &str) -> Option<String> {
    let out = runner.run(&["config", flag, "--get-all", KEY]).await.ok()?;
    if !out.success {
        return None;
    }
    last_non_empty(&out.stdout)
}

async fn build_view(runner: &GitRunner) -> CredentialHelperView {
    CredentialHelperView {
        helper_global: read_helper_at(runner, "--global").await,
        helper_system: read_helper_at(runner, "--system").await,
    }
}

/// Read the global/system credential helpers (no repo required).
#[tauri::command]
#[specta::specta]
pub async fn global_credential_helper_view(
    state: tauri::State<'_, AppState>,
) -> Result<CredentialHelperView, AppError> {
    let git_path = state.git_path.read().await.clone();
    let runner = GitRunner::unbound(&git_path);
    Ok(build_view(&runner).await)
}

/// Write the global `credential.helper` as a single plain value (`None`
/// unsets). Reset-then-add because a plain set fails when multiple entries
/// exist; the exit-code assumptions (`--unset-all` exits 5 when nothing is
/// set or the file is missing, single value round-trips via `--get-all`) are
/// validated against the real binary in legit-core/tests/git_flows.rs.
#[tauri::command]
#[specta::specta]
pub async fn global_write_credential_helper(
    state: tauri::State<'_, AppState>,
    helper: Option<String>,
) -> Result<CredentialHelperView, AppError> {
    let git_path = state.git_path.read().await.clone();
    let runner = GitRunner::unbound(&git_path);

    let unset = runner.run(&["config", "--global", "--unset-all", KEY]).await?;
    if !unset.success && unset.exit_code != Some(5) {
        return Err(AppError::Git(GitError::CommandFailed {
            exit_code: unset.exit_code.unwrap_or(-1),
            stderr: unset.stderr.trim().to_string(),
        }));
    }
    if let Some(v) = helper.as_deref().map(str::trim).filter(|v| !v.is_empty()) {
        let out = runner.run(&["config", "--global", "--add", KEY, v]).await?;
        if !out.success {
            return Err(AppError::Git(GitError::CommandFailed {
                exit_code: out.exit_code.unwrap_or(-1),
                stderr: out.stderr.trim().to_string(),
            }));
        }
    }
    Ok(build_view(&runner).await)
}

// ---------------------------------------------------------------------------
// Helper detection ("which helpers exist on this machine?")
// ---------------------------------------------------------------------------

/// A credential helper found on this machine.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct AvailableHelper {
    /// The value to write into `credential.helper` (e.g. `manager`).
    pub name: String,
    /// Where the executable was found.
    pub path: String,
}

/// The `credential.helper` config value a helper executable corresponds to:
/// `git-credential-<name>[.exe]` -> `<name>`. `None` for unrelated files and
/// for the cache daemon (`git-credential-cache--daemon` is an implementation
/// detail of `cache`, not a configurable helper). Pure; unit-tested.
fn helper_name_from_filename(filename: &str) -> Option<String> {
    let stem = filename.strip_suffix(".exe").unwrap_or(filename);
    let name = stem.strip_prefix("git-credential-")?;
    if name.is_empty() || name.contains("--") {
        return None;
    }
    Some(name.to_string())
}

/// Sort key: secure OS-integrated managers first, the plaintext `store` last
/// among known helpers, unknown helpers after everything known. Pure;
/// unit-tested.
fn helper_rank(name: &str) -> u8 {
    match name {
        "manager" => 0,
        "manager-core" => 1,
        "osxkeychain" => 2,
        "libsecret" => 3,
        "wincred" => 4,
        "cache" => 5,
        "store" => 6,
        _ => 7,
    }
}

/// External helpers worth probing on PATH: they are not shipped in git's
/// exec-path (GCM installs its own binary; distros put libsecret elsewhere).
const PATH_CANDIDATES: [&str; 3] = ["manager", "manager-core", "libsecret"];

/// Enumerate the credential helpers installed on this machine: everything in
/// git's exec-path plus known external helpers on PATH. Sorted most- to
/// least-recommended (`helper_rank`).
#[tauri::command]
#[specta::specta]
pub async fn list_available_credential_helpers(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<AvailableHelper>, AppError> {
    let git_path = state.git_path.read().await.clone();
    let runner = GitRunner::unbound(&git_path);

    // name -> path; first find wins (exec-path beats PATH duplicates).
    let mut found: std::collections::BTreeMap<String, String> = std::collections::BTreeMap::new();

    // 1. Helpers bundled with git, in `git --exec-path`.
    if let Ok(out) = runner.run(&["--exec-path"]).await {
        if out.success {
            let exec_dir = std::path::PathBuf::from(out.stdout.trim());
            if let Ok(mut entries) = tokio::fs::read_dir(&exec_dir).await {
                while let Ok(Some(entry)) = entries.next_entry().await {
                    let file_name = entry.file_name();
                    let Some(fname) = file_name.to_str() else { continue };
                    if let Some(name) = helper_name_from_filename(fname) {
                        found
                            .entry(name)
                            .or_insert_with(|| entry.path().to_string_lossy().into_owned());
                    }
                }
            }
        }
    }

    // 2. Known external helpers on PATH (e.g. Git Credential Manager).
    if let Some(path_var) = std::env::var_os("PATH") {
        for candidate in PATH_CANDIDATES {
            if found.contains_key(candidate) {
                continue;
            }
            for dir in std::env::split_paths(&path_var) {
                for fname in [
                    format!("git-credential-{candidate}"),
                    format!("git-credential-{candidate}.exe"),
                ] {
                    let p = dir.join(&fname);
                    if p.is_file() {
                        found.insert(candidate.to_string(), p.to_string_lossy().into_owned());
                        break;
                    }
                }
                if found.contains_key(candidate) {
                    break;
                }
            }
        }
    }

    let mut helpers: Vec<AvailableHelper> = found
        .into_iter()
        .map(|(name, path)| AvailableHelper { name, path })
        .collect();
    helpers.sort_by(|a, b| helper_rank(&a.name).cmp(&helper_rank(&b.name)).then(a.name.cmp(&b.name)));
    Ok(helpers)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn helper_name_from_filename_strips_prefix_and_exe() {
        assert_eq!(helper_name_from_filename("git-credential-cache").as_deref(), Some("cache"));
        assert_eq!(helper_name_from_filename("git-credential-store.exe").as_deref(), Some("store"));
        assert_eq!(
            helper_name_from_filename("git-credential-manager.exe").as_deref(),
            Some("manager")
        );
    }

    #[test]
    fn helper_name_from_filename_excludes_daemon_and_unrelated() {
        // The cache daemon is an implementation detail of `cache`, not a
        // helper a user should configure.
        assert_eq!(helper_name_from_filename("git-credential-cache--daemon"), None);
        assert_eq!(helper_name_from_filename("git-credential-cache--daemon.exe"), None);
        assert_eq!(helper_name_from_filename("git-remote-https"), None);
        assert_eq!(helper_name_from_filename("git.exe"), None);
        assert_eq!(helper_name_from_filename("git-credential-"), None);
    }

    #[test]
    fn helper_rank_prefers_secure_managers() {
        // manager first, plaintext store last, unknown helpers after known ones.
        assert!(helper_rank("manager") < helper_rank("osxkeychain"));
        assert!(helper_rank("osxkeychain") < helper_rank("cache"));
        assert!(helper_rank("cache") < helper_rank("store"));
        assert!(helper_rank("store") < helper_rank("my-exotic-helper"));
    }

    #[test]
    fn last_non_empty_skips_reset_entries_and_takes_last() {
        // The per-repo apply writes an empty reset entry before the helper.
        assert_eq!(last_non_empty("\nmanager\n").as_deref(), Some("manager"));
        // Later entries win.
        assert_eq!(last_non_empty("store\nmanager\n").as_deref(), Some("manager"));
        // Only empty/blank entries = no helper.
        assert_eq!(last_non_empty("\n  \n"), None);
        assert_eq!(last_non_empty(""), None);
    }
}
