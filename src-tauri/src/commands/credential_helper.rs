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

use crate::commands::settings_host::{settings_executor, settings_fs, SettingsHost};
use crate::error::AppError;
use crate::state::AppState;
use legit_core::{GitError, GitExecutor, HostPath, RepoFs};
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

pub(crate) async fn read_helper_at(runner: &dyn GitExecutor, flag: &str) -> Option<String> {
    // exit 1 = no helper at this scope: expected, not a failure (Git Log).
    let out = runner.run_expecting(&["config", flag, "--get-all", KEY], &[1]).await.ok()?;
    if !out.success {
        return None;
    }
    last_non_empty(&out.stdout)
}

pub(crate) async fn build_view(runner: &dyn GitExecutor) -> CredentialHelperView {
    CredentialHelperView {
        helper_global: read_helper_at(runner, "--global").await,
        helper_system: read_helper_at(runner, "--system").await,
    }
}

/// Write the host's global `credential.helper` as a single plain value
/// (`None` unsets). Reset-then-add because a plain set fails when multiple
/// entries exist; the exit-code assumptions (`--unset-all` exits 5 when
/// nothing is set or the file is missing, single value round-trips via
/// `--get-all`) are validated against the real binary in
/// legit-core/tests/git_flows.rs.
pub(crate) async fn write_credential_helper_global(
    runner: &dyn GitExecutor,
    helper: Option<&str>,
) -> Result<CredentialHelperView, AppError> {
    let unset = runner.run_expecting(&["config", "--global", "--unset-all", KEY], &[5]).await?;
    if !unset.success && unset.exit_code != Some(5) {
        return Err(AppError::Git(GitError::CommandFailed {
            exit_code: unset.exit_code.unwrap_or(-1),
            stderr: unset.stderr.trim().to_string(),
        }));
    }
    if let Some(v) = helper.map(str::trim).filter(|v| !v.is_empty()) {
        let out = runner.run(&["config", "--global", "--add", KEY, v]).await?;
        if !out.success {
            return Err(AppError::Git(GitError::CommandFailed {
                exit_code: out.exit_code.unwrap_or(-1),
                stderr: out.stderr.trim().to_string(),
            }));
        }
    }
    Ok(build_view(runner).await)
}

/// Read the app machine's global/system credential helpers (no repo required).
#[tauri::command]
#[specta::specta]
pub async fn global_credential_helper_view(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<CredentialHelperView, AppError> {
    let runner = settings_executor(&app, &state, &SettingsHost::Local).await?;
    Ok(build_view(runner.as_ref()).await)
}

/// Write the app machine's global `credential.helper`.
#[tauri::command]
#[specta::specta]
pub async fn global_write_credential_helper(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    helper: Option<String>,
) -> Result<CredentialHelperView, AppError> {
    let runner = settings_executor(&app, &state, &SettingsHost::Local).await?;
    write_credential_helper_global(runner.as_ref(), helper.as_deref()).await
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

/// Directories to scan for helper executables, given git's exec-path. The
/// exec-path alone is not enough: Git for Windows ships GCM in
/// `<prefix>/mingw64/bin` and `<prefix>/usr/bin` holds shell helpers - dirs
/// git prepends to its children's PATH, so `helper = manager` resolves for
/// git while being invisible to an exec-path-only scan (and to LeGit's own
/// PATH, which only sees `Git/cmd`). Derived lexically from the exec-path
/// (`<exec>/../../bin`, `<exec>/../../../usr/bin`); on Linux/macOS both
/// collapse to `/usr/bin`, a harmless extra scan. Pure; unit-tested.
fn helper_scan_dirs(exec_dir: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut dirs = vec![exec_dir.to_path_buf()];
    if let Some(prefix) = exec_dir.parent().and_then(|p| p.parent()) {
        dirs.push(prefix.join("bin"));
        if let Some(root) = prefix.parent() {
            dirs.push(root.join("usr").join("bin"));
        }
    }
    dirs
}

/// Directories to probe for `PATH_CANDIDATES` on a REMOTE host. The app
/// process's `PATH` describes the app machine, so it says nothing about a
/// distro; these are the standard locations a Linux distribution installs
/// git credential helpers into. (On Debian/Ubuntu `libsecret` lives in git's
/// exec-path, which the exec-path scan already covers - this is the belt to
/// that braces.) Pure; unit-tested.
fn remote_helper_dirs() -> Vec<String> {
    vec![
        "/usr/bin".to_string(),
        "/usr/local/bin".to_string(),
        "/usr/lib/git-core".to_string(),
    ]
}

/// Enumerate the credential helpers installed on `host`: everything in git's
/// exec-path (read through the host's filesystem, so a WSL distro reports its
/// own helpers rather than Windows') plus known external helpers. Sorted
/// most- to least-recommended (`helper_rank`).
async fn list_helpers_on(
    runner: &dyn GitExecutor,
    fs: &dyn RepoFs,
    local: bool,
) -> Vec<AvailableHelper> {
    // name -> path; first find wins (exec-path beats PATH duplicates).
    let mut found: std::collections::BTreeMap<String, String> = std::collections::BTreeMap::new();

    // 1. Helpers bundled with git: its exec-path plus the sibling bin dirs
    //    git itself puts on its children's PATH (see `helper_scan_dirs`).
    if let Ok(out) = runner.run(&["--exec-path"]).await {
        if out.success {
            let exec_dir = std::path::PathBuf::from(out.stdout.trim());
            for dir in helper_scan_dirs(&exec_dir) {
                let Ok(entries) = fs.read_dir(&HostPath::from_path(&dir)).await else { continue };
                for entry in entries {
                    if let Some(name) = helper_name_from_filename(&entry.name) {
                        found
                            .entry(name)
                            .or_insert_with(|| format!("{}/{}", dir.display(), entry.name));
                    }
                }
            }
        }
    }

    // 2. Known external helpers (e.g. Git Credential Manager). The app
    //    process's PATH only describes the app machine, so a remote host gets
    //    the standard-directory probe instead.
    let dirs: Vec<std::path::PathBuf> = if local {
        std::env::var_os("PATH")
            .map(|p| std::env::split_paths(&p).collect())
            .unwrap_or_default()
    } else {
        remote_helper_dirs().into_iter().map(Into::into).collect()
    };
    for candidate in PATH_CANDIDATES {
        if found.contains_key(candidate) {
            continue;
        }
        'dirs: for dir in &dirs {
            for fname in [
                format!("git-credential-{candidate}"),
                format!("git-credential-{candidate}.exe"),
            ] {
                let p = dir.join(&fname);
                if matches!(fs.stat(&HostPath::from_path(&p)).await, Ok(Some(st)) if !st.is_dir) {
                    found.insert(candidate.to_string(), p.to_string_lossy().into_owned());
                    break 'dirs;
                }
            }
        }
    }

    let mut helpers: Vec<AvailableHelper> = found
        .into_iter()
        .map(|(name, path)| AvailableHelper { name, path })
        .collect();
    helpers.sort_by(|a, b| helper_rank(&a.name).cmp(&helper_rank(&b.name)).then(a.name.cmp(&b.name)));
    helpers
}

/// The credential helpers installed on the app machine.
#[tauri::command]
#[specta::specta]
pub async fn list_available_credential_helpers(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<Vec<AvailableHelper>, AppError> {
    let host = SettingsHost::Local;
    let runner = settings_executor(&app, &state, &host).await?;
    let fs = settings_fs(&app, &state, &host).await?;
    Ok(list_helpers_on(runner.as_ref(), fs.as_ref(), true).await)
}

/// The credential helpers installed INSIDE a WSL distribution.
pub(crate) async fn list_helpers_for_host(
    app: &tauri::AppHandle,
    state: &AppState,
    host: &SettingsHost,
) -> Result<Vec<AvailableHelper>, AppError> {
    let runner = settings_executor(app, state, host).await?;
    let fs = settings_fs(app, state, host).await?;
    Ok(list_helpers_on(runner.as_ref(), fs.as_ref(), matches!(host, SettingsHost::Local)).await)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

    // The remote probe must never lean on the app process's PATH (that is
    // Windows'); it names distro-standard directories with absolute POSIX
    // paths.
    #[test]
    fn remote_helper_dirs_are_absolute_posix() {
        let dirs = remote_helper_dirs();
        assert!(!dirs.is_empty());
        assert!(dirs.iter().all(|d| d.starts_with('/')));
        assert!(dirs.iter().any(|d| d == "/usr/lib/git-core"));
    }

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
    fn helper_scan_dirs_covers_git_for_windows_bin_dirs() {
        // Git for Windows: exec-path is <prefix>/mingw64/libexec/git-core, but
        // GCM ships in <prefix>/mingw64/bin - a dir git prepends to child PATH,
        // so `helper = manager` works while an exec-path-only scan misses it.
        let exec = Path::new("C:/Program Files/Git/mingw64/libexec/git-core");
        let dirs = helper_scan_dirs(exec);
        assert_eq!(dirs[0], exec.to_path_buf());
        assert!(dirs.contains(&PathBuf::from("C:/Program Files/Git/mingw64/bin")));
        assert!(dirs.contains(&PathBuf::from("C:/Program Files/Git/usr/bin")));
    }

    #[test]
    fn helper_scan_dirs_handles_shallow_exec_path() {
        // A short exec-path must not panic or produce bogus dirs.
        let dirs = helper_scan_dirs(Path::new("git-core"));
        assert_eq!(dirs, vec![PathBuf::from("git-core")]);
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
