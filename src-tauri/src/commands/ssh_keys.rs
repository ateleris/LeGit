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
use crate::state::AppState;
use legit_core::{HostPath, RepoFs};
use legit_host::Host;
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

/// The private-key file names of the key pairs among `~/.ssh` entries: every
/// `<name>.pub` with a valid key-file base name (the private side may be
/// missing; the status reports that). A private key without a `.pub` is not
/// listed: nothing could be copied or uploaded from it. Defaults first, then
/// alphabetical.
fn key_pair_names(file_names: &[String]) -> Vec<String> {
    let mut names: Vec<&str> = file_names
        .iter()
        .filter_map(|n| n.strip_suffix(".pub"))
        .filter(|base| valid_key_file_name(base))
        .collect();
    names.sort_by_key(|n| {
        let rank = match *n {
            "id_ed25519" => 0,
            "id_rsa" => 1,
            _ => 2,
        };
        (rank, n.to_string())
    });
    names.into_iter().map(str::to_string).collect()
}

/// A `<principal> <type> <blob>` allowed-signers line, or `None` when the
/// email or key cannot be written safely (whitespace or a comma in the
/// principal would corrupt the file's syntax).
/// The identity of an authorized-keys line: type + base64 blob (comments
/// differ freely between copies of the same key).
pub(crate) fn key_material(public_key: &str) -> Option<(String, String)> {
    let mut fields = public_key.split_whitespace();
    Some((fields.next()?.to_string(), fields.next()?.to_string()))
}

pub(crate) fn allowed_signer_line(email: &str, public_key: &str) -> Option<String> {
    let email = email.trim();
    if email.is_empty() || email.chars().any(|c| c.is_whitespace()) || email.contains(',') {
        return None;
    }
    let mut fields = public_key.split_whitespace();
    let kind = fields.next()?;
    let blob = fields.next()?;
    Some(format!("{email} {kind} {blob}"))
}

/// The file content with `line` ensured, or `None` when an entry with the
/// same principal and key material is already there (trailing comments on
/// hand-written lines are ignored for the comparison).
pub(crate) fn with_signer_line(existing: &str, line: &str) -> Option<String> {
    let material = |l: &str| l.split_whitespace().take(3).collect::<Vec<_>>().join(" ");
    let target = material(line);
    if existing.lines().any(|l| material(l) == target) {
        return None;
    }
    let mut out = existing.to_string();
    if !out.is_empty() && !out.ends_with('\n') {
        out.push('\n');
    }
    out.push_str(line);
    out.push('\n');
    Some(out)
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

/// Argv for the `ssh -T git@<host>` probe.
///
/// With the askpass broker wired up, `StrictHostKeyChecking` stays at ssh's
/// default `ask`, so an unknown host key reaches the in-app confirmation
/// dialog (fingerprint and all) exactly like every git-spawned ssh. Only the
/// no-broker fallback must stay non-interactive, and there a prompt would
/// hang the probe - hence `accept-new` in that branch alone.
fn build_probe_args(
    host: &str,
    key: Option<&Path>,
    broker: bool,
) -> Vec<std::ffi::OsString> {
    let mut args: Vec<std::ffi::OsString> = vec!["-T".into()];
    if !broker {
        args.push("-o".into());
        args.push("BatchMode=yes".into());
        args.push("-o".into());
        args.push("StrictHostKeyChecking=accept-new".into());
    }
    args.push("-o".into());
    args.push("ConnectTimeout=10".into());
    if let Some(key) = key {
        args.push("-i".into());
        args.push(key.into());
        args.push("-o".into());
        args.push("IdentitiesOnly=yes".into());
    }
    args.push(format!("git@{host}").into());
    args
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

pub(crate) fn home_dir() -> Result<PathBuf, AppError> {
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
pub(crate) fn expand_home(path: &str) -> Result<PathBuf, AppError> {
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

/// Every key pair found in `~/.ssh` (see `key_pair_names`), for the
/// SSH keys settings section. A missing `~/.ssh` is an empty list, not an
/// error.
#[tauri::command]
#[specta::specta]
pub async fn scan_ssh_keys() -> Result<Vec<SshKeyStatus>, AppError> {
    let dir = ssh_dir()?;
    let mut file_names: Vec<String> = Vec::new();
    if let Ok(mut rd) = tokio::fs::read_dir(&dir).await {
        while let Ok(Some(entry)) = rd.next_entry().await {
            if let Ok(name) = entry.file_name().into_string() {
                file_names.push(name);
            }
        }
    }
    let mut out = Vec::new();
    for name in key_pair_names(&file_names) {
        out.push(read_key_status(&dir.join(name)).await);
    }
    Ok(out)
}

/// Ensure `<email> <type> <blob>` is in `~/.ssh/allowed_signers` (created
/// when missing) and return the file's path: the file
/// `gpg.ssh.allowedSignersFile` points at, which local verification of SSH
/// signatures needs.
#[tauri::command]
#[specta::specta]
pub async fn register_allowed_signer(
    email: String,
    public_key: String,
) -> Result<String, AppError> {
    let line = allowed_signer_line(&email, &public_key).ok_or_else(|| {
        AppError::Io("cannot build an allowed-signers entry from this identity".to_string())
    })?;
    let dir = ssh_dir()?;
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| AppError::Io(format!("cannot create ~/.ssh: {e}")))?;
    let path = dir.join("allowed_signers");
    let existing = tokio::fs::read_to_string(&path).await.unwrap_or_default();
    if let Some(updated) = with_signer_line(&existing, &line) {
        tokio::fs::write(&path, updated)
            .await
            .map_err(|e| AppError::Io(format!("cannot write {}: {e}", path.display())))?;
    }
    Ok(path.display().to_string())
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
    // With the askpass broker running, drop BatchMode and wire SSH_ASKPASS so
    // an encrypted key prompts for its passphrase in-app (and give the human
    // time to type it). Without a broker (should not happen in a running
    // app), keep the old strictly non-interactive behavior.
    let askpass_env = crate::credentials::askpass_child_env();
    let broker = askpass_env.is_some();
    let timeout_secs: u64 = if broker { 320 } else { 30 };
    let mut cmd = quiet_command("ssh");
    if let Some(env) = askpass_env {
        for (k, v) in env {
            cmd.env(k, v);
        }
    }
    let key = match private_key_path.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
        Some(p) => Some(expand_home(p)?),
        None => None,
    };
    cmd.args(build_probe_args(&host, key.as_deref(), broker));

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

// ---------------------------------------------------------------------------
// Distro-side (WSL) variants: the same pure logic, with fs and helper spawns
// routed through the distro's Host. Deliberately a parallel `wsl_*` surface
// (the settings-host fail-closed pattern): these commands take a required
// distro and have no local branch to fall into.
// ---------------------------------------------------------------------------

async fn wsl_host(
    app: &tauri::AppHandle,
    state: &AppState,
    distro: &str,
) -> Result<std::sync::Arc<legit_host::RemoteHost>, AppError> {
    let distro = distro.trim();
    if distro.is_empty() {
        return Err(AppError::ParseArgs("a WSL distribution name is required".into()));
    }
    crate::remote::connection::ensure_wsl_host(app, state, distro).await
}

/// `~/.ssh` on the host, from the home directory it reported.
fn host_ssh_dir(host: &dyn Host) -> Result<HostPath, AppError> {
    let home = host
        .home_dir()
        .ok_or_else(|| AppError::Io("the host reported no home directory".to_string()))?;
    Ok(HostPath(format!("{}/.ssh", home.0.trim_end_matches('/'))))
}

async fn read_key_status_host(fs: &dyn RepoFs, private_key: &HostPath) -> SshKeyStatus {
    let exists = matches!(fs.stat(private_key).await, Ok(Some(_)));
    let pub_path = HostPath(format!("{}.pub", private_key.0));
    let public_key = match fs.read(&pub_path, Some(64 * 1024)).await {
        Ok(bytes) => {
            let t = String::from_utf8_lossy(&bytes).trim().to_string();
            if t.is_empty() { None } else { Some(t) }
        }
        Err(_) => None,
    };
    SshKeyStatus { private_key_path: private_key.0.clone(), exists, public_key }
}

/// Every key pair in the distro's `~/.ssh`; a missing directory is an empty
/// list, not an error.
#[tauri::command]
#[specta::specta]
pub async fn wsl_scan_ssh_keys(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    distro: String,
) -> Result<Vec<SshKeyStatus>, AppError> {
    let host = wsl_host(&app, &state, &distro).await?;
    let dir = host_ssh_dir(host.as_ref())?;
    let fs = host.fs();
    let file_names: Vec<String> = match fs.read_dir(&dir).await {
        Ok(entries) => entries.into_iter().filter(|e| !e.is_dir).map(|e| e.name).collect(),
        Err(_) => return Ok(vec![]),
    };
    let mut out = Vec::new();
    for name in key_pair_names(&file_names) {
        out.push(read_key_status_host(fs.as_ref(), &HostPath(format!("{}/{name}", dir.0))).await);
    }
    Ok(out)
}

/// Generate a key pair in the distro's `~/.ssh` via its own `ssh-keygen`.
/// Same contract as the local command: no passphrase, never overwrites.
#[tauri::command]
#[specta::specta]
pub async fn wsl_generate_ssh_key(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    distro: String,
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

    let host = wsl_host(&app, &state, &distro).await?;
    let dir = host_ssh_dir(host.as_ref())?;
    let fs = host.fs();
    fs.create_dir_all(&dir).await.map_err(|e| AppError::Io(format!("create {}: {e}", dir.0)))?;
    // ssh refuses a group/world-accessible ~/.ssh; the agent's mkdir takes
    // the umask, so tighten explicitly (best-effort).
    let _ = host.run_captured("chmod", &["700".into(), dir.0.clone()], None, &[], 10).await;

    let key_path = HostPath(format!("{}/{file_name}", dir.0));
    let pub_path = HostPath(format!("{}.pub", key_path.0));
    if matches!(fs.stat(&key_path).await, Ok(Some(_)))
        || matches!(fs.stat(&pub_path).await, Ok(Some(_)))
    {
        return Err(AppError::Io(format!("{} already exists: choose another file name", key_path.0)));
    }

    let mut args: Vec<String> = vec!["-q".into(), "-t".into(), key_type.clone()];
    if key_type == "rsa" {
        args.push("-b".into());
        args.push("4096".into());
    }
    if !comment.is_empty() {
        args.push("-C".into());
        args.push(comment);
    }
    args.extend(["-N".into(), "".into(), "-f".into(), key_path.0.clone()]);

    let out = host
        .run_captured("ssh-keygen", &args, None, &[], 30)
        .await
        .map_err(|e| AppError::Io(format!("cannot run ssh-keygen in {distro}: {e}")))?;
    if out.timed_out {
        return Err(AppError::Io("ssh-keygen timed out".to_string()));
    }
    if !out.success {
        return Err(AppError::Io(format!("ssh-keygen failed: {}", out.stderr.trim())));
    }
    Ok(read_key_status_host(fs.as_ref(), &key_path).await)
}

/// `ssh -T git@<host>` run INSIDE the distro, so it probes with the distro's
/// keys and known_hosts. Prompts relay through the agent's askpass shim.
#[tauri::command]
#[specta::specta]
pub async fn wsl_test_ssh_auth(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    distro: String,
    host_name: String,
    private_key_path: Option<String>,
) -> Result<SshTestOutcome, AppError> {
    if !valid_ssh_host(&host_name) {
        return Err(AppError::Io(format!("invalid SSH host {host_name:?}")));
    }
    let host = wsl_host(&app, &state, &distro).await?;
    let key = match private_key_path.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
        Some(p) => Some(PathBuf::from(p)),
        None => None,
    };
    // The agent's base env carries the askpass relay (its handshake sets it
    // up), so the broker=true argument shape applies: no BatchMode, and the
    // human gets time to answer a passphrase or host-key prompt.
    let args: Vec<String> = build_probe_args(&host_name, key.as_deref(), true)
        .into_iter()
        .map(|a| a.to_string_lossy().into_owned())
        .collect();
    let out = host
        .run_captured("ssh", &args, None, &[], 320)
        .await
        .map_err(|e| AppError::Io(format!("cannot run ssh in {distro}: {e}")))?;
    if out.timed_out {
        return Ok(SshTestOutcome::CannotConnect { detail: "timed out after 320 seconds".into() });
    }
    Ok(classify_ssh_probe(&format!("{}\n{}", out.stdout, out.stderr)))
}

/// Ensure `<email> <type> <blob>` is in the DISTRO's `~/.ssh/allowed_signers`
/// and return that file's distro path (for the distro's
/// `gpg.ssh.allowedSignersFile`).
#[tauri::command]
#[specta::specta]
pub async fn wsl_register_allowed_signer(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    distro: String,
    email: String,
    public_key: String,
) -> Result<String, AppError> {
    let line = allowed_signer_line(&email, &public_key).ok_or_else(|| {
        AppError::Io("cannot build an allowed-signers entry from this identity".to_string())
    })?;
    let host = wsl_host(&app, &state, &distro).await?;
    let dir = host_ssh_dir(host.as_ref())?;
    let fs = host.fs();
    fs.create_dir_all(&dir).await.map_err(|e| AppError::Io(format!("create {}: {e}", dir.0)))?;
    let path = HostPath(format!("{}/allowed_signers", dir.0));
    let existing = match fs.read(&path, Some(256 * 1024)).await {
        Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
        Err(_) => String::new(),
    };
    if let Some(updated) = with_signer_line(&existing, &line) {
        fs.write(&path, updated.as_bytes())
            .await
            .map_err(|e| AppError::Io(format!("cannot write {}: {e}", path.0)))?;
    }
    Ok(path.0)
}

/// Copy an app-machine key pair into the distro's `~/.ssh` (the "Copy key
/// into the distribution" offer after a profile apply resolved to a missing
/// key). A deliberate, confirmed transfer to a machine the user owns.
/// Refuses to overwrite an existing key in the distro unless `overwrite` -
/// the confirmed "Replace key" choice when a DIFFERENT key sits under the
/// profile's file name there.
#[tauri::command]
#[specta::specta]
pub async fn wsl_install_ssh_key(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    distro: String,
    source_private_key_path: String,
    overwrite: bool,
) -> Result<SshKeyStatus, AppError> {
    let source = expand_home(source_private_key_path.trim())?;
    let name = source
        .file_name()
        .and_then(|n| n.to_str())
        .filter(|n| valid_key_file_name(n))
        .ok_or_else(|| AppError::Io(format!("invalid key path {source_private_key_path:?}")))?
        .to_string();
    let private = tokio::fs::read(&source)
        .await
        .map_err(|e| AppError::Io(format!("cannot read {}: {e}", source.display())))?;
    let public = tokio::fs::read(format!("{}.pub", source.display()))
        .await
        .map_err(|e| AppError::Io(format!("cannot read {}.pub: {e}", source.display())))?;

    let host = wsl_host(&app, &state, &distro).await?;
    let dir = host_ssh_dir(host.as_ref())?;
    let fs = host.fs();
    fs.create_dir_all(&dir).await.map_err(|e| AppError::Io(format!("create {}: {e}", dir.0)))?;
    let _ = host.run_captured("chmod", &["700".into(), dir.0.clone()], None, &[], 10).await;

    let target = HostPath(format!("{}/{name}", dir.0));
    let target_pub = HostPath(format!("{}.pub", target.0));
    if !overwrite && matches!(fs.stat(&target).await, Ok(Some(_))) {
        return Err(AppError::Io(format!("{} already exists in {distro}", target.0)));
    }
    fs.write(&target, &private)
        .await
        .map_err(|e| AppError::Io(format!("cannot write {}: {e}", target.0)))?;
    fs.write(&target_pub, &public)
        .await
        .map_err(|e| AppError::Io(format!("cannot write {}: {e}", target_pub.0)))?;
    // ssh refuses a private key readable by others; the agent's write takes
    // the umask, so tighten explicitly. The private key's chmod must succeed.
    let out = host
        .run_captured("chmod", &["600".into(), target.0.clone()], None, &[], 10)
        .await
        .map_err(|e| AppError::Io(format!("cannot chmod the copied key: {e}")))?;
    if !out.success {
        return Err(AppError::Io(format!("chmod 600 failed: {}", out.stderr.trim())));
    }
    let _ = host.run_captured("chmod", &["644".into(), target_pub.0.clone()], None, &[], 10).await;
    Ok(read_key_status_host(fs.as_ref(), &target).await)
}

/// A short label for THIS computer, used in platform key titles so uploads
/// of same-named keys from different machines stay tellable apart.
#[tauri::command]
#[specta::specta]
pub async fn machine_label() -> Result<String, AppError> {
    for var in ["COMPUTERNAME", "HOSTNAME"] {
        if let Ok(name) = std::env::var(var) {
            let name = name.trim().to_string();
            if !name.is_empty() {
                return Ok(name);
            }
        }
    }
    // Unix shells export HOSTNAME, non-interactive processes often don't.
    if let Ok(contents) = tokio::fs::read_to_string("/etc/hostname").await {
        let name = contents.trim().to_string();
        if !name.is_empty() {
            return Ok(name);
        }
    }
    Ok("unknown-host".to_string())
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

    #[test]
    fn allowed_signer_line_builds_safe_entries_only() {
        assert_eq!(
            allowed_signer_line("s@x.ch", "ssh-ed25519 AAAA simon@home").as_deref(),
            Some("s@x.ch ssh-ed25519 AAAA")
        );
        // Whitespace or a comma in the principal would corrupt the file.
        assert_eq!(allowed_signer_line("a b@x.ch", "ssh-ed25519 AAAA"), None);
        assert_eq!(allowed_signer_line("a,b@x.ch", "ssh-ed25519 AAAA"), None);
        assert_eq!(allowed_signer_line("", "ssh-ed25519 AAAA"), None);
        assert_eq!(allowed_signer_line("s@x.ch", "garbage"), None);
    }

    #[test]
    fn with_signer_line_is_idempotent_and_newline_safe() {
        let line = "s@x.ch ssh-ed25519 AAAA";
        assert_eq!(with_signer_line("", line).as_deref(), Some("s@x.ch ssh-ed25519 AAAA\n"));
        // Appends to a file missing its final newline without merging lines.
        assert_eq!(
            with_signer_line("other@x.ch ssh-rsa BBBB", line).as_deref(),
            Some("other@x.ch ssh-rsa BBBB\ns@x.ch ssh-ed25519 AAAA\n")
        );
        // Already present: exact, and with a trailing comment on the line.
        assert_eq!(with_signer_line("s@x.ch ssh-ed25519 AAAA\n", line), None);
        assert_eq!(with_signer_line("s@x.ch ssh-ed25519 AAAA laptop\n", line), None);
        // Same email, different key: a second entry is correct.
        assert!(with_signer_line("s@x.ch ssh-ed25519 OTHER\n", line).is_some());
    }

    #[test]
    fn key_pair_names_filters_and_orders() {
        let names: Vec<String> = [
            "known_hosts",
            "config",
            "id_rsa",             // private side alone: paired via its .pub below
            "id_rsa.pub",
            "work_key.pub",
            "id_ed25519.pub",
            ".hidden.pub",        // dotfile: rejected
            "weird name.pub",     // space: rejected
            "double.pub.pub",     // base ends in .pub: rejected
            "orphan_private",     // no .pub: not a listable pair
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        // Defaults first, then alphabetical.
        assert_eq!(key_pair_names(&names), vec!["id_ed25519", "id_rsa", "work_key"]);
        assert!(key_pair_names(&[]).is_empty());
    }

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

    // With the askpass broker present, an unknown host key must reach the
    // in-app confirmation dialog (ssh's default `ask`) exactly like every
    // git-spawned ssh does; auto-accepting is only for the no-broker
    // fallback, where a prompt would hang the probe.
    #[test]
    fn probe_routes_host_key_confirmation_through_the_broker() {
        let joined = |args: &[std::ffi::OsString]| {
            args.iter().map(|a| a.to_string_lossy().into_owned()).collect::<Vec<_>>().join(" ")
        };

        let with_broker = joined(&build_probe_args("github.com", None, true));
        assert!(!with_broker.contains("StrictHostKeyChecking"), "{with_broker}");
        assert!(!with_broker.contains("BatchMode"), "{with_broker}");
        assert!(with_broker.starts_with("-T "), "{with_broker}");
        assert!(with_broker.ends_with(" git@github.com"), "{with_broker}");

        let without = joined(&build_probe_args("gitlab.com", Some(Path::new("/k/id")), false));
        assert!(without.contains("-o BatchMode=yes"), "{without}");
        assert!(without.contains("-o StrictHostKeyChecking=accept-new"), "{without}");
        assert!(without.contains("-i /k/id -o IdentitiesOnly=yes"), "{without}");
        assert!(without.ends_with(" git@gitlab.com"), "{without}");
    }
}
