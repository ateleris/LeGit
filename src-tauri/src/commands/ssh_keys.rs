//! SSH key management: phase 1 of the SSH-first platform integrations
//! (BACKLOG.md "Platform integrations"; scope modeling decided 2026-07-13).
//!
//! - Per-profile keys: generated into `~/.ssh` and wired into the profile's
//!   `auth_ssh_key` (-> `core.sshCommand`) by the frontend.
//! - Global: ssh's own default keys (`~/.ssh/id_ed25519` / `id_rsa`), managed
//!   here as plain files: NOTHING is ever written to git config for them.
//! - Key type is per-platform: Ed25519 for GitHub/GitLab, RSA for Azure
//!   DevOps (ADO accepts only RSA with rsa-sha2 signatures).
//!
//! Keys are still generated WITHOUT a passphrase: the `SSH_ASKPASS` shim
//! (crate::credentials) now prompts in-app when an encrypted key is USED, so
//! user-supplied passphrase-protected keys work - but the generation UI does
//! not offer setting one yet (see BACKLOG "Platform integrations").

use crate::error::AppError;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::{Path, PathBuf};

/// One key pair on disk (private key + `<path>.pub`).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct SshKeyStatus {
    /// Absolute private-key path.
    pub private_key_path: String,
    pub exists: bool,
    /// Content of `<path>.pub`, when readable.
    pub public_key: Option<String>,
}

/// Result of an `ssh -T git@<host>` authentication probe.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SshTestOutcome {
    Authenticated { detail: String },
    Rejected { detail: String },
    CannotConnect { detail: String },
    Unknown { detail: String },
}

// ---------------------------------------------------------------------------
// Pure decision logic (unit-tested)
// ---------------------------------------------------------------------------

/// Classify an `ssh -T` probe from its OUTPUT, never its exit code: the
/// platforms exit differently on success (GitHub exits 1), but each prints a
/// distinctive success line.
fn classify_ssh_probe(output: &str) -> SshTestOutcome {
    let detail = output.trim().to_string();
    let lower = output.to_lowercase();
    if lower.contains("successfully authenticated")
        || lower.contains("welcome to gitlab")
        || lower.contains("shell access is not supported")
    {
        return SshTestOutcome::Authenticated { detail };
    }
    if lower.contains("permission denied") {
        return SshTestOutcome::Rejected { detail };
    }
    if lower.contains("could not resolve hostname")
        || lower.contains("connection timed out")
        || lower.contains("operation timed out")
        || lower.contains("connection refused")
        || lower.contains("network is unreachable")
    {
        return SshTestOutcome::CannotConnect { detail };
    }
    SshTestOutcome::Unknown { detail }
}

/// Key file names are joined under `~/.ssh`: plain names only (no separators
/// or traversal), no dotfiles, and never the `.pub` side.
fn valid_key_file_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && !name.starts_with('.')
        && !name.ends_with(".pub")
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        && !name.contains("..")
}

/// Hosts land in `git@<host>` as a process arg: hostname characters only, so
/// nothing option-like can be smuggled in.
fn valid_ssh_host(host: &str) -> bool {
    !host.is_empty()
        && host.len() <= 253
        && host.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-'))
        && !host.starts_with(['-', '.'])
        && !host.ends_with(['-', '.'])
}

/// The platform's "add an SSH key" settings page. Fixed map (the frontend
/// passes an id, never a URL).
fn platform_add_key_url(platform: &str) -> Option<&'static str> {
    match platform {
        "github" => Some("https://github.com/settings/ssh/new"),
        "gitlab" => Some("https://gitlab.com/-/user_settings/ssh_keys"),
        "azure_devops" => Some("https://dev.azure.com/_usersSettings/keys"),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

fn home_dir() -> Result<PathBuf, AppError> {
    #[cfg(target_os = "windows")]
    let var = "USERPROFILE";
    #[cfg(not(target_os = "windows"))]
    let var = "HOME";
    std::env::var_os(var)
        .map(PathBuf::from)
        .ok_or_else(|| AppError::Io(format!("cannot locate the home directory ({var} unset)")))
}

fn ssh_dir() -> Result<PathBuf, AppError> {
    Ok(home_dir()?.join(".ssh"))
}

/// Expand a leading `~/` so key paths stored in profiles work either way.
fn expand_home(path: &str) -> Result<PathBuf, AppError> {
    if let Some(rest) = path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\")) {
        Ok(home_dir()?.join(rest))
    } else {
        Ok(PathBuf::from(path))
    }
}

async fn read_key_status(private_key: &Path) -> SshKeyStatus {
    let exists = tokio::fs::try_exists(private_key).await.unwrap_or(false);
    let pub_path = PathBuf::from(format!("{}.pub", private_key.display()));
    let public_key = match tokio::fs::read_to_string(&pub_path).await {
        Ok(s) => {
            let t = s.trim().to_string();
            if t.is_empty() { None } else { Some(t) }
        }
        Err(_) => None,
    };
    SshKeyStatus {
        private_key_path: private_key.display().to_string(),
        exists,
        public_key,
    }
}

/// A `tokio` command with the console window suppressed on Windows (same
/// pattern as the editor/browser spawns).
fn quiet_command(program: &str) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new(program);
    #[cfg(target_os = "windows")]
    {
        // CREATE_NO_WINDOW: no console flash.
        cmd.creation_flags(0x0800_0000);
    }
    cmd.stdin(std::process::Stdio::null());
    cmd.kill_on_drop(true);
    cmd
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Status of one key pair (leading `~/` in the path is expanded).
#[tauri::command]
#[specta::specta]
pub async fn ssh_key_status(private_key_path: String) -> Result<SshKeyStatus, AppError> {
    let path = expand_home(&private_key_path)?;
    Ok(read_key_status(&path).await)
}

/// Status of ssh's default key pairs (`~/.ssh/id_ed25519`, `~/.ssh/id_rsa`):
/// ssh tries these automatically for every connection, so they are the
/// "global" SSH identity: no git config involved.
#[tauri::command]
#[specta::specta]
pub async fn default_ssh_keys_status() -> Result<Vec<SshKeyStatus>, AppError> {
    let dir = ssh_dir()?;
    let mut out = Vec::new();
    for name in ["id_ed25519", "id_rsa"] {
        out.push(read_key_status(&dir.join(name)).await);
    }
    Ok(out)
}

/// Generate a key pair in `~/.ssh` via `ssh-keygen`, without a passphrase
/// (see module doc). Refuses to overwrite an existing key.
#[tauri::command]
#[specta::specta]
pub async fn generate_ssh_key(
    file_name: String,
    key_type: String,
    comment: String,
) -> Result<SshKeyStatus, AppError> {
    if !valid_key_file_name(&file_name) {
        return Err(AppError::Io(format!(
            "invalid key file name {file_name:?}: use letters, digits, '.', '_' or '-'"
        )));
    }
    if key_type != "ed25519" && key_type != "rsa" {
        return Err(AppError::Io(format!("unsupported key type {key_type:?}")));
    }
    let comment = comment.replace(['\n', '\r'], " ").trim().to_string();

    let dir = ssh_dir()?;
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| AppError::Io(format!("create {}: {e}", dir.display())))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
    }

    let key_path = dir.join(&file_name);
    let pub_path = dir.join(format!("{file_name}.pub"));
    if tokio::fs::try_exists(&key_path).await.unwrap_or(false)
        || tokio::fs::try_exists(&pub_path).await.unwrap_or(false)
    {
        return Err(AppError::Io(format!(
            "{} already exists: choose another file name",
            key_path.display()
        )));
    }

    let mut cmd = quiet_command("ssh-keygen");
    cmd.arg("-q").arg("-t").arg(&key_type);
    if key_type == "rsa" {
        cmd.arg("-b").arg("4096");
    }
    if !comment.is_empty() {
        cmd.arg("-C").arg(&comment);
    }
    cmd.arg("-N").arg("").arg("-f").arg(&key_path);

    let run = tokio::time::timeout(std::time::Duration::from_secs(30), cmd.output());
    let out = match run.await {
        Err(_) => return Err(AppError::Io("ssh-keygen timed out".to_string())),
        Ok(Err(e)) => {
            return Err(AppError::Io(format!(
                "cannot run ssh-keygen ({e}): is OpenSSH installed and on PATH?"
            )))
        }
        Ok(Ok(out)) => out,
    };
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(AppError::Io(format!("ssh-keygen failed: {}", stderr.trim())));
    }
    Ok(read_key_status(&key_path).await)
}

/// Probe SSH authentication against a host (`ssh -T git@<host>`), optionally
/// pinned to one key (`-i` + `IdentitiesOnly`, matching what the profile's
/// `core.sshCommand` does). Passphrase prompts route to the in-app askpass
/// dialog via the credential broker (BatchMode only as a fallback when no
/// broker is running); unknown host keys are accepted on first contact
/// (`accept-new`), matching what a first clone would do.
#[tauri::command]
#[specta::specta]
pub async fn test_ssh_auth(
    host: String,
    private_key_path: Option<String>,
) -> Result<SshTestOutcome, AppError> {
    if !valid_ssh_host(&host) {
        return Err(AppError::Io(format!("invalid SSH host {host:?}")));
    }
    let mut cmd = quiet_command("ssh");
    // With the askpass broker running, drop BatchMode and wire SSH_ASKPASS so
    // an encrypted key prompts for its passphrase in-app (and give the human
    // time to type it). Without a broker (should not happen in a running
    // app), keep the old strictly non-interactive behavior.
    let askpass_env = crate::credentials::askpass_child_env();
    let timeout_secs: u64 = if askpass_env.is_some() { 320 } else { 30 };
    cmd.arg("-T");
    match askpass_env {
        Some(env) => {
            for (k, v) in env {
                cmd.env(k, v);
            }
        }
        None => {
            cmd.arg("-o").arg("BatchMode=yes");
        }
    }
    cmd.arg("-o")
        .arg("StrictHostKeyChecking=accept-new")
        .arg("-o")
        .arg("ConnectTimeout=10");
    if let Some(p) = private_key_path.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
        let key = expand_home(p)?;
        cmd.arg("-i").arg(&key).arg("-o").arg("IdentitiesOnly=yes");
    }
    cmd.arg(format!("git@{host}"));

    let run = tokio::time::timeout(std::time::Duration::from_secs(timeout_secs), cmd.output());
    let out = match run.await {
        Err(_) => {
            return Ok(SshTestOutcome::CannotConnect {
                detail: format!("timed out after {timeout_secs} seconds"),
            })
        }
        Ok(Err(e)) => {
            return Err(AppError::Io(format!(
                "cannot run ssh ({e}): is OpenSSH installed and on PATH?"
            )))
        }
        Ok(Ok(out)) => out,
    };
    let combined = format!(
        "{}\n{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    Ok(classify_ssh_probe(&combined))
}

/// Open the platform's "add an SSH key" settings page in the browser. Takes a
/// platform id, never a URL, so the frontend cannot open arbitrary pages.
#[tauri::command]
#[specta::specta]
pub async fn open_platform_key_settings(platform: String) -> Result<(), AppError> {
    let url = platform_add_key_url(&platform)
        .ok_or_else(|| AppError::Io(format!("unknown platform {platform:?}")))?;
    crate::commands::browser::open_url(url)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // `ssh -T git@<host>` succeeds with DIFFERENT exit codes and phrasings per
    // platform (GitHub exits 1 on success!), so the outcome is classified from
    // the output text, never the exit code.
    #[test]
    fn classify_github_success() {
        let out = "Hi simonbeck! You've successfully authenticated, but GitHub does not provide shell access.";
        assert!(matches!(classify_ssh_probe(out), SshTestOutcome::Authenticated { .. }));
    }

    #[test]
    fn classify_gitlab_success() {
        let out = "Welcome to GitLab, @simon!";
        assert!(matches!(classify_ssh_probe(out), SshTestOutcome::Authenticated { .. }));
    }

    #[test]
    fn classify_azure_devops_success() {
        // ADO authenticates, then rejects the shell: that IS the success case.
        let out = "remote: Shell access is not supported.";
        assert!(matches!(classify_ssh_probe(out), SshTestOutcome::Authenticated { .. }));
    }

    #[test]
    fn classify_rejected_key() {
        let out = "git@github.com: Permission denied (publickey).";
        assert!(matches!(classify_ssh_probe(out), SshTestOutcome::Rejected { .. }));
    }

    #[test]
    fn classify_network_failures() {
        for out in [
            "ssh: Could not resolve hostname githab.com: Name or service not known",
            "ssh: connect to host github.com port 22: Connection timed out",
            "ssh: connect to host github.com port 22: Connection refused",
            "ssh: connect to host github.com port 22: Network is unreachable",
        ] {
            assert!(
                matches!(classify_ssh_probe(out), SshTestOutcome::CannotConnect { .. }),
                "expected CannotConnect for {out:?}"
            );
        }
    }

    #[test]
    fn classify_unknown_output() {
        assert!(matches!(classify_ssh_probe(""), SshTestOutcome::Unknown { .. }));
        assert!(matches!(
            classify_ssh_probe("something entirely unexpected"),
            SshTestOutcome::Unknown { .. }
        ));
    }

    // File names are joined under ~/.ssh, so they must be plain names: no
    // separators or traversal, no dotfiles, and never the .pub side.
    #[test]
    fn key_file_name_validation() {
        assert!(valid_key_file_name("id_ed25519"));
        assert!(valid_key_file_name("id_rsa"));
        assert!(valid_key_file_name("id_ed25519_work-2"));
        for bad in ["", "../evil", "a/b", "a\\b", ".hidden", "key.pub", "a b"] {
            assert!(!valid_key_file_name(bad), "expected invalid: {bad:?}");
        }
        assert!(!valid_key_file_name(&"a".repeat(100)));
    }

    // Hosts land in `git@<host>` as a process arg: restrict to hostname chars
    // so nothing option-like can be smuggled in.
    #[test]
    fn ssh_host_validation() {
        assert!(valid_ssh_host("github.com"));
        assert!(valid_ssh_host("gitlab.com"));
        assert!(valid_ssh_host("ssh.dev.azure.com"));
        for bad in ["", "-oProxyCommand=x", "host name", "host/path", "git@host", "."] {
            assert!(!valid_ssh_host(bad), "expected invalid: {bad:?}");
        }
    }

    #[test]
    fn platform_urls_known_and_unknown() {
        assert!(platform_add_key_url("github").is_some());
        assert!(platform_add_key_url("gitlab").is_some());
        assert!(platform_add_key_url("azure_devops").is_some());
        assert_eq!(platform_add_key_url("bitbucket"), None);
    }
}
