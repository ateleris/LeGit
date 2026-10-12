//! Git identity profiles.
//!
//! A *profile* is a named bundle of git identity/signing/auth config defined
//! once in `GlobalSettings` and selectable per repo. Selecting a profile writes
//! its values into the repo's LOCAL `.git/config` (interoperable with CLI git).
//!
//! Source-of-truth principle: git config is authoritative for behavior; the
//! repo's stored `git_profile_id` is only a *hint* about intent. The active
//! profile is always recomputed by matching the repo's live local config
//! against the profile definitions, so a deleted/edited profile or a hand-edited
//! config degrades gracefully (shown as custom) rather than lying.

use legit_core::config::{self, ConfigScope, WriteScope};
use crate::commands::signing;
use crate::error::AppError;
use crate::state::{AppState, GitProfile};
use legit_core::{GitError, GitExecutor};
use serde::{Deserialize, Serialize};
use specta::Type;
use uuid::Uuid;

const KEY_USER_NAME: &str = "user.name";
const KEY_USER_EMAIL: &str = "user.email";
const KEY_SSH_COMMAND: &str = "core.sshCommand";
const KEY_CREDENTIAL_HELPER: &str = "credential.helper";

// ---------------------------------------------------------------------------
// Types exposed to the frontend
// ---------------------------------------------------------------------------

/// The eight managed git-config keys, projected to plain values. For the auth
/// key this holds the *key path* (parsed out of `core.sshCommand`), not the
/// full command.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct ManagedKeys {
    pub user_name: Option<String>,
    pub user_email: Option<String>,
    pub gpg_format: Option<String>,
    pub signing_key: Option<String>,
    pub commit_gpgsign: Option<String>,
    pub allowed_signers_file: Option<String>,
    pub auth_ssh_key: Option<String>,
    pub credential_helper: Option<String>,
}

/// One differing key between the repo's local config and a profile.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct KeyDiff {
    pub key: String,
    pub local: Option<String>,
    pub profile: Option<String>,
}

/// How the repo's live local config relates to the defined profiles.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ProfileMatch {
    /// No managed keys set locally - repo uses inherited (global) identity.
    Inherit,
    /// Local config exactly equals a profile's projection (the stored
    /// `git_profile_id` only tiebreaks identical profiles).
    Active { profile_id: String },
    /// Local has managed values matching no profile: a deliberate (or
    /// externally made) repo-specific configuration.
    Custom,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct ProfileStatus {
    /// Live LOCAL value of each managed key (None = unset locally).
    pub local: ManagedKeys,
    pub stored_profile_id: Option<String>,
    pub r#match: ProfileMatch,
}

/// The repo section's data: live LOCAL values plus what the repo would
/// inherit without them (global scope, falling back to system).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct ManagedConfigView {
    pub local: ManagedKeys,
    pub inherited: ManagedKeys,
}

// ---------------------------------------------------------------------------
// Projection / read / write of managed keys
// ---------------------------------------------------------------------------

/// Trim and nullify-empty an optional config value.
fn clean(v: &Option<String>) -> Option<String> {
    v.as_ref().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// Normalize a key path for comparison/synthesis: backslashes → forward slashes
/// (ssh on Windows accepts `/`, and it sidesteps git's command word-splitting).
fn normalize_key_path(p: &str) -> String {
    p.replace('\\', "/")
}

/// The managed-key projection of a profile (what `apply` would write).
fn projection(p: &GitProfile) -> ManagedKeys {
    ManagedKeys {
        user_name: clean(&p.user_name),
        user_email: clean(&p.user_email),
        gpg_format: clean(&p.gpg_format),
        signing_key: clean(&p.signing_key),
        commit_gpgsign: clean(&p.commit_gpgsign),
        allowed_signers_file: clean(&p.allowed_signers_file),
        auth_ssh_key: clean(&p.auth_ssh_key).map(|p| normalize_key_path(&p)),
        credential_helper: clean(&p.credential_helper),
    }
}

/// Clean a frontend draft exactly like a profile projection: trim, treat
/// empty as unset, normalize the auth key path.
fn normalize_draft(mk: &ManagedKeys) -> ManagedKeys {
    ManagedKeys {
        user_name: clean(&mk.user_name),
        user_email: clean(&mk.user_email),
        gpg_format: clean(&mk.gpg_format),
        signing_key: clean(&mk.signing_key),
        commit_gpgsign: clean(&mk.commit_gpgsign),
        allowed_signers_file: clean(&mk.allowed_signers_file),
        auth_ssh_key: clean(&mk.auth_ssh_key).map(|p| normalize_key_path(&p)),
        credential_helper: clean(&mk.credential_helper),
    }
}

/// Read the eight managed keys at one config scope (`--local`, `--global`,
/// or `--system`). For `core.sshCommand`, parse out the key path; if it isn't
/// a LeGit-shaped `ssh -i ...` command, keep the raw command string (so it
/// shows as a mismatch rather than a false match). The credential helper
/// reads via `read_helper_at` (`--get-all` + last non-empty, because the
/// reset-then-set we write leaves two entries and `--get` errors on that).
///
/// Profiles read and write LOCAL scope only, by decision: global scope holds
/// at most a directly edited identity (see `global_identity_view`), never a
/// profile's auth/signing bundle, so a machine-wide `credential.helper` or
/// `core.sshCommand` can't be applied by one click. The global/system reads
/// exist for the repo section's "inherited" view.
async fn read_managed_scope(runner: &dyn GitExecutor, scope: ConfigScope) -> ManagedKeys {
    let at = |key: &'static str| async move { config::read_scope(runner, scope, key).await.value };
    let ssh_raw = at(KEY_SSH_COMMAND).await;
    ManagedKeys {
        user_name: at(KEY_USER_NAME).await,
        user_email: at(KEY_USER_EMAIL).await,
        gpg_format: at(signing::KEY_FORMAT).await,
        signing_key: at(signing::KEY_SIGNING_KEY).await,
        commit_gpgsign: at(signing::KEY_GPGSIGN).await,
        allowed_signers_file: at(signing::KEY_ALLOWED_SIGNERS).await,
        auth_ssh_key: ssh_raw.map(|cmd| {
            parse_ssh_key_from_command(&cmd)
                .map(|p| normalize_key_path(&p))
                .unwrap_or(cmd)
        }),
        credential_helper: crate::commands::credential_helper::read_helper_at(runner, scope).await,
    }
}

async fn read_local_managed(runner: &dyn GitExecutor) -> ManagedKeys {
    read_managed_scope(runner, ConfigScope::Local).await
}

/// Pure: per-key scope precedence for the inherited view (global beats system).
fn coalesce_inherited(global: ManagedKeys, system: ManagedKeys) -> ManagedKeys {
    ManagedKeys {
        user_name: global.user_name.or(system.user_name),
        user_email: global.user_email.or(system.user_email),
        gpg_format: global.gpg_format.or(system.gpg_format),
        signing_key: global.signing_key.or(system.signing_key),
        commit_gpgsign: global.commit_gpgsign.or(system.commit_gpgsign),
        allowed_signers_file: global.allowed_signers_file.or(system.allowed_signers_file),
        auth_ssh_key: global.auth_ssh_key.or(system.auth_ssh_key),
        credential_helper: global.credential_helper.or(system.credential_helper),
    }
}

/// Write the local `credential.helper`, making it authoritative for this repo.
///
/// `credential.helper` is multi-valued and **accumulates across config scopes**,
/// so a single local value wouldn't override a (possibly broken) global/system
/// helper: git would still run that one first. So we reset the local list and,
/// when setting, prepend an **empty value**, which clears all inherited helpers,
/// before adding ours. `None` removes our local entries entirely (back to
/// inheriting the global/system helper).
///
/// Note: the value must be a form the git CLI can run via `sh -c`: a short name
/// like `manager`, not a path containing spaces (which `sh` would word-split).
async fn write_credential_helper(runner: &dyn GitExecutor, value: Option<&str>) -> Result<(), AppError> {
    // The empty entry clears inherited helpers; ours follows it.
    let values: &[&str] = match value {
        Some(v) => &["", v],
        None => &[],
    };
    Ok(config::replace_all(runner, WriteScope::Local, KEY_CREDENTIAL_HELPER, values).await?)
}

/// Write a managed-key set to LOCAL config. `None` for a field unsets it. The
/// auth key is synthesized into a `core.sshCommand`.
async fn write_managed(runner: &dyn GitExecutor, mk: &ManagedKeys) -> Result<(), AppError> {
    config::write(runner, WriteScope::Local, KEY_USER_NAME, mk.user_name.as_deref()).await?;
    config::write(runner, WriteScope::Local, KEY_USER_EMAIL, mk.user_email.as_deref()).await?;
    config::write(runner, WriteScope::Local, signing::KEY_FORMAT, mk.gpg_format.as_deref()).await?;
    config::write(runner, WriteScope::Local, signing::KEY_SIGNING_KEY, mk.signing_key.as_deref()).await?;
    config::write(runner, WriteScope::Local, signing::KEY_GPGSIGN, mk.commit_gpgsign.as_deref()).await?;
    config::write(runner, WriteScope::Local, signing::KEY_ALLOWED_SIGNERS, mk.allowed_signers_file.as_deref()).await?;
    let ssh = mk.auth_ssh_key.as_ref().map(|p| synth_ssh_command(p));
    config::write(runner, WriteScope::Local, KEY_SSH_COMMAND, ssh.as_deref()).await?;
    write_credential_helper(runner, mk.credential_helper.as_deref()).await?;
    Ok(())
}

/// Write one managed key by its git key name. The value is the projected
/// form (key PATH for the auth key; synthesized into `core.sshCommand` here,
/// mirroring `write_managed`).
async fn write_one_managed(
    runner: &dyn GitExecutor,
    key: &str,
    value: Option<&str>,
) -> Result<(), AppError> {
    match key {
        KEY_SSH_COMMAND => {
            let ssh = value.map(synth_ssh_command);
            Ok(config::write(runner, WriteScope::Local, KEY_SSH_COMMAND, ssh.as_deref()).await?)
        }
        KEY_CREDENTIAL_HELPER => write_credential_helper(runner, value).await,
        k => Ok(config::write(runner, WriteScope::Local, k, value).await?),
    }
}

/// Prefix the failing key into a git error so a partial write says where it
/// stopped (the config may be partially written; detection stays honest).
fn note_failed_key(e: AppError, key: &str) -> AppError {
    match e {
        AppError::Git(GitError::CommandFailed { exit_code, stderr }) => {
            AppError::Git(GitError::CommandFailed {
                exit_code,
                stderr: format!("while writing {key}: {stderr}"),
            })
        }
        other => other,
    }
}

/// Labeled (git key, local, profile) tuples for diffing/display, in a stable order.
fn diff_keys(local: &ManagedKeys, proj: &ManagedKeys) -> Vec<KeyDiff> {
    let pairs: [(&str, &Option<String>, &Option<String>); 8] = [
        (KEY_USER_NAME, &local.user_name, &proj.user_name),
        (KEY_USER_EMAIL, &local.user_email, &proj.user_email),
        (signing::KEY_FORMAT, &local.gpg_format, &proj.gpg_format),
        (signing::KEY_SIGNING_KEY, &local.signing_key, &proj.signing_key),
        (signing::KEY_GPGSIGN, &local.commit_gpgsign, &proj.commit_gpgsign),
        (signing::KEY_ALLOWED_SIGNERS, &local.allowed_signers_file, &proj.allowed_signers_file),
        (KEY_SSH_COMMAND, &local.auth_ssh_key, &proj.auth_ssh_key),
        (KEY_CREDENTIAL_HELPER, &local.credential_helper, &proj.credential_helper),
    ];
    pairs
        .into_iter()
        .filter(|(_, l, p)| l != p)
        .map(|(key, l, p)| KeyDiff { key: key.to_string(), local: l.clone(), profile: p.clone() })
        .collect()
}

fn is_all_unset(mk: &ManagedKeys) -> bool {
    mk.user_name.is_none()
        && mk.user_email.is_none()
        && mk.gpg_format.is_none()
        && mk.signing_key.is_none()
        && mk.commit_gpgsign.is_none()
        && mk.allowed_signers_file.is_none()
        && mk.auth_ssh_key.is_none()
        && mk.credential_helper.is_none()
}

/// What a profile edit may do to one repo's local config.
#[derive(Debug, PartialEq)]
enum PropagationAction {
    /// Local config already equals the new projection. `backfill` = no (or a
    /// stale) applied-keys snapshot is recorded; persist one so the next edit
    /// can propagate.
    UpToDate { backfill: bool },
    Reapply,
    /// Local config diverged from what the apply wrote (hand-edited): the
    /// user's config wins and detection shows Custom.
    Skip,
}

/// Decide whether a profile edit may overwrite a repo's local config (pure).
/// `snapshot` is the persisted applied projection; `old_resolved` the pre-edit
/// projection resolved for the repo's host, known only at update time (the
/// stand-in for repos applied before snapshots existed).
fn propagation_decision(
    local: &ManagedKeys,
    snapshot: Option<&ManagedKeys>,
    old_resolved: Option<&ManagedKeys>,
    new_resolved: &ManagedKeys,
) -> PropagationAction {
    if local == new_resolved {
        return PropagationAction::UpToDate { backfill: snapshot != Some(new_resolved) };
    }
    match (snapshot, old_resolved) {
        (Some(s), _) if s == local => PropagationAction::Reapply,
        (Some(_), _) => PropagationAction::Skip,
        (None, Some(o)) if o == local => PropagationAction::Reapply,
        (None, _) => PropagationAction::Skip,
    }
}

/// The (old, new) pairs of profiles that exist in both lists under the same
/// id with different content (pure). Created and deleted profiles have no
/// old state to propagate from.
pub fn changed_profiles(old: &[GitProfile], new: &[GitProfile]) -> Vec<(GitProfile, GitProfile)> {
    new.iter()
        .filter_map(|n| {
            old.iter().find(|o| o.id == n.id).filter(|o| *o != n).map(|o| (o.clone(), n.clone()))
        })
        .collect()
}

/// Compute the active/custom/inherit relationship (pure; unit-tested).
fn compute_match(
    local: &ManagedKeys,
    profiles: &[GitProfile],
    stored_id: Option<&str>,
) -> ProfileMatch {
    if is_all_unset(local) {
        return ProfileMatch::Inherit;
    }
    // Prefer the stored profile when it matches exactly (tiebreaker for
    // profiles with identical definitions).
    if let Some(sid) = stored_id {
        if let Some(p) = profiles.iter().find(|p| p.id == sid) {
            if projection(p) == *local {
                return ProfileMatch::Active { profile_id: sid.to_string() };
            }
        }
    }
    // Any profile matching exactly -> active.
    if let Some(p) = profiles.iter().find(|p| projection(p) == *local) {
        return ProfileMatch::Active { profile_id: p.id.clone() };
    }
    ProfileMatch::Custom
}

// ---------------------------------------------------------------------------
// core.sshCommand synthesis + round-trip parsing
// ---------------------------------------------------------------------------

/// Double-quote a key path for embedding in `core.sshCommand`, escaping `"`/`\`.
fn quote_ssh_path(path: &str) -> String {
    let normalized = normalize_key_path(path);
    let escaped = normalized.replace('\\', "\\\\").replace('"', "\\\"");
    format!("\"{escaped}\"")
}

/// Build the `core.sshCommand` that selects a single auth key.
/// `IdentitiesOnly=yes` stops ssh-agent offering other keys.
fn synth_ssh_command(key_path: &str) -> String {
    format!("ssh -i {} -o IdentitiesOnly=yes", quote_ssh_path(key_path))
}

/// The git-level `-c key=value` overrides that authenticate a `git clone` with a
/// profile's auth: the SSH command (from the auth key) and the credential helper
/// (reset-then-set so an inherited global helper can't interfere). Returned as
/// flat `["-c", "k=v", ...]` tokens to splice before `clone`. These are
/// process-scoped (not written into the new repo) — the profile is applied to the
/// repo separately after the clone, which persists the same settings properly.
pub fn clone_auth_config_args(profile: &GitProfile) -> Vec<String> {
    let mk = projection(profile);
    let mut args = Vec::new();
    if let Some(key) = mk.auth_ssh_key.as_deref() {
        args.push("-c".to_string());
        args.push(format!("core.sshCommand={}", synth_ssh_command(key)));
    }
    if let Some(helper) = mk.credential_helper.as_deref() {
        args.push("-c".to_string());
        args.push("credential.helper=".to_string());
        args.push("-c".to_string());
        args.push(format!("credential.helper={helper}"));
    }
    args
}

/// Apply a profile to an open session: write its managed keys to local config and
/// record it as the repo's selected profile (`git_profile_id`). Shared by
/// `apply_profile_to_repo` and the clone/init flows so a freshly created repo
/// shows the chosen profile as active in Repo Settings.
/// What applying a profile did about its auth key on a REMOTE host: the key
/// is resolved BY FILE NAME into the host's own `~/.ssh` (an app-machine
/// path in `core.sshCommand` would hand the distro's ssh a key it cannot
/// read - and a `/mnt/c` translation is a trap: 0777 permissions, which ssh
/// refuses). `exists` = the resolved file is already in the distro; when it
/// is not, the UI offers copying it over.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, specta::Type)]
pub struct DistroKeyResolution {
    pub distro: String,
    /// The profile's app-machine private-key path (the copy source).
    pub source_path: String,
    /// The resolved distro path `core.sshCommand` now points at.
    pub target_path: String,
    pub exists: bool,
    /// The target exists but holds a DIFFERENT key than the profile's
    /// (public material compared) - pushes would authenticate as whatever
    /// that key is, so the UI offers replacing it. False when either public
    /// half is unreadable (no comparison possible, no false alarm).
    pub mismatch: bool,
}

/// The file-name part of a key path, either separator convention.
fn key_file_basename(path: &str) -> Option<&str> {
    path.rsplit(['/', '\\']).next().filter(|n| !n.is_empty())
}

/// Rewrite the path-valued managed keys for a repo on a WSL host: the auth
/// key always, and - for ssh signing - the signing key and allowed-signers
/// file, each resolved BY FILE NAME into the distro's `~/.ssh`. Returns the
/// rewritten keys plus the auth key's (source, target) pair. Pure.
fn resolve_managed_paths_for_distro(
    keys: &ManagedKeys,
    home: &str,
) -> (ManagedKeys, Option<(String, String)>) {
    let ssh_dir = format!("{}/.ssh", home.trim_end_matches('/'));
    let mut out = keys.clone();
    let mut auth = None;
    if let Some(src) = &keys.auth_ssh_key {
        if let Some(name) = key_file_basename(src) {
            let target = format!("{ssh_dir}/{name}");
            out.auth_ssh_key = Some(target.clone());
            auth = Some((src.clone(), target));
        }
    }
    if keys.gpg_format.as_deref() == Some("ssh") {
        // The signing key is only a PATH when it contains a separator; a
        // literal `ssh-ed25519 AAAA…` or a GPG key id stays untouched.
        if let Some(sk) = &keys.signing_key {
            if sk.contains(['/', '\\']) {
                if let Some(name) = key_file_basename(sk) {
                    out.signing_key = Some(format!("{ssh_dir}/{name}"));
                }
            }
        }
        if let Some(asf) = &keys.allowed_signers_file {
            if let Some(name) = key_file_basename(asf) {
                out.allowed_signers_file = Some(format!("{ssh_dir}/{name}"));
            }
        }
    }
    (out, auth)
}

pub async fn apply_profile_core(
    state: &AppState,
    session: &crate::state::RepoSession,
    profile_id: &str,
) -> Result<Option<DistroKeyResolution>, AppError> {
    let runner = session.runner.read().await.clone();
    let profile = state
        .global_settings
        .read()
        .await
        .git_profiles_doc
        .profiles
        .iter()
        .find(|p| p.id == profile_id)
        .cloned()
        .ok_or_else(|| AppError::UnknownProfile(profile_id.to_string()))?;
    let mut keys = projection(&profile);
    let mut resolution = None;
    if let legit_host::HostId::Wsl { distro } = session.host.id() {
        let home = session.host.home_dir().ok_or_else(|| {
            AppError::Io("the distribution reported no home directory".to_string())
        })?;
        let original = keys.clone();
        let (resolved, auth) = resolve_managed_paths_for_distro(&keys, &home.0);
        keys = resolved;
        let fs = session.host.fs();
        if let Some((source_path, target_path)) = auth {
            let exists =
                matches!(fs.stat(&legit_core::HostPath(target_path.clone())).await, Ok(Some(_)));
            // Same file name does not mean same key: compare public material
            // so a foreign key under the profile's name is flagged instead of
            // silently authenticating as someone else.
            let mismatch = exists
                && match (
                    read_local_public_key(&source_path).await,
                    read_distro_public_key(fs.as_ref(), &target_path).await,
                ) {
                    (Some(src), Some(dst)) => {
                        crate::commands::ssh_keys::key_material(&src)
                            != crate::commands::ssh_keys::key_material(&dst)
                    }
                    _ => false,
                };
            resolution = Some(DistroKeyResolution {
                distro,
                source_path,
                target_path,
                exists,
                mismatch,
            });
        }
        // Best-effort: put the profile's identity into the distro's
        // allowed-signers file, so its ssh signatures verify there. A failure
        // only costs verification (commits still sign), never the apply.
        if let (Some(target_signers), Some(email), Some(sk)) =
            (keys.allowed_signers_file.clone(), keys.user_email.clone(), original.signing_key)
        {
            if original.gpg_format.as_deref() == Some("ssh") && sk.contains(['/', '\\']) {
                if let Some(pub_key) = read_local_public_key_file(&sk).await {
                    let _ =
                        ensure_distro_allowed_signer(fs.as_ref(), &target_signers, &email, &pub_key)
                            .await;
                }
            }
        }
    }
    write_managed(runner.as_ref(), &keys).await?;
    set_repo_profile_selection(state, session, Some(profile_id.to_string()), Some(keys)).await?;
    // Bookkeeping for other machines (suggestion on their clone of the same
    // remote); the apply itself is done, so a recording failure stays silent.
    if let Some(key) = repo_assignment_key(session).await {
        let _ = state
            .mutate_global(|s| {
                s.profile_assignments.insert(key, profile_id.to_string());
            })
            .await;
    }
    Ok(resolution)
}

/// Best-effort machine-neutral key for the repo's picked remote (`None`:
/// no remote, or one without a web form).
async fn repo_assignment_key(session: &crate::state::RepoSession) -> Option<String> {
    let remotes = session.backend.list_remotes().await.ok()?;
    let remote = crate::commands::browser::pick_remote(&remotes)?;
    crate::commands::browser::canonical_remote_key(&remote.fetch_url)
}

/// The `.pub` beside an app-machine PRIVATE key path, when readable.
async fn read_local_public_key(private_key_path: &str) -> Option<String> {
    let path = crate::commands::ssh_keys::expand_home(private_key_path).ok()?;
    let text = tokio::fs::read_to_string(format!("{}.pub", path.display())).await.ok()?;
    let t = text.trim().to_string();
    if t.is_empty() { None } else { Some(t) }
}

/// An app-machine PUBLIC key file's content (the profile's `.pub`-valued
/// signing key), when readable.
async fn read_local_public_key_file(pub_path: &str) -> Option<String> {
    let path = crate::commands::ssh_keys::expand_home(pub_path).ok()?;
    let text = tokio::fs::read_to_string(&path).await.ok()?;
    let t = text.trim().to_string();
    if t.is_empty() { None } else { Some(t) }
}

/// The `.pub` beside a distro private key path, when readable.
async fn read_distro_public_key(fs: &dyn legit_core::RepoFs, private_key_path: &str) -> Option<String> {
    let bytes =
        fs.read(&legit_core::HostPath(format!("{private_key_path}.pub")), Some(64 * 1024)).await.ok()?;
    let t = String::from_utf8_lossy(&bytes).trim().to_string();
    if t.is_empty() { None } else { Some(t) }
}

/// Ensure `<email> <material>` is in the distro's allowed-signers file.
async fn ensure_distro_allowed_signer(
    fs: &dyn legit_core::RepoFs,
    signers_path: &str,
    email: &str,
    public_key: &str,
) -> Result<(), AppError> {
    let line = crate::commands::ssh_keys::allowed_signer_line(email, public_key)
        .ok_or_else(|| AppError::Io("cannot build an allowed-signers entry".to_string()))?;
    let path = legit_core::HostPath(signers_path.to_string());
    let existing = match fs.read(&path, Some(256 * 1024)).await {
        Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
        Err(_) => String::new(),
    };
    if let Some(updated) = crate::commands::ssh_keys::with_signer_line(&existing, &line) {
        fs.write(&path, updated.as_bytes())
            .await
            .map_err(|e| AppError::Io(format!("cannot write {}: {e}", path.0)))?;
    }
    Ok(())
}

/// Quote-aware tokenizer for a `core.sshCommand` string.
fn tokenize(cmd: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut cur = String::new();
    let mut in_quote = false;
    let mut started = false;
    let mut chars = cmd.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' => {
                in_quote = !in_quote;
                started = true;
            }
            '\\' if in_quote => {
                // Escape only `\"` and `\\`; otherwise keep the backslash (so
                // unquoted-style Windows paths inside quotes survive).
                match chars.peek() {
                    Some('"') | Some('\\') => {
                        cur.push(chars.next().unwrap());
                    }
                    _ => cur.push('\\'),
                }
                started = true;
            }
            c if c.is_whitespace() && !in_quote => {
                if started {
                    tokens.push(std::mem::take(&mut cur));
                    started = false;
                }
            }
            c => {
                cur.push(c);
                started = true;
            }
        }
    }
    if started {
        tokens.push(cur);
    }
    tokens
}

/// Extract the `-i <key>` path from a `core.sshCommand`, or `None` if the
/// command isn't a recognizable `ssh -i …` form.
fn parse_ssh_key_from_command(cmd: &str) -> Option<String> {
    let tokens = tokenize(cmd);
    let idx = tokens.iter().position(|t| t == "-i")?;
    tokens.get(idx + 1).cloned()
}

// ---------------------------------------------------------------------------
// Shared session helpers
// ---------------------------------------------------------------------------

/// Build a `ProfileStatus` for a repo from its live local config.
async fn status_for(
    state: &AppState,
    runner: &dyn GitExecutor,
    stored_profile_id: Option<String>,
) -> ProfileStatus {
    let local = read_local_managed(runner).await;
    let profiles = state.global_settings.read().await.git_profiles_doc.profiles.clone();
    let r#match = compute_match(&local, &profiles, stored_profile_id.as_deref());
    ProfileStatus { local, stored_profile_id, r#match }
}

/// Persist the repo's `git_profile_id` together with the applied-keys
/// snapshot (what the apply wrote to local config, resolved for the repo's
/// host): the snapshot is what lets a later profile edit tell "still as
/// applied" from "hand-edited" (see `propagation_decision`).
async fn set_repo_profile_selection(
    state: &AppState,
    session: &crate::state::RepoSession,
    profile_id: Option<String>,
    applied_keys: Option<ManagedKeys>,
) -> Result<(), AppError> {
    {
        let mut s = session.settings.write().await;
        s.git_profile_id = profile_id;
        s.applied_profile_keys = applied_keys;
    }
    state.persist_session_settings(session).await
}

/// Persist only the applied-keys snapshot (backfill for repos applied before
/// the snapshot existed, once their config is confirmed current).
async fn record_applied_snapshot(
    state: &AppState,
    session: &crate::state::RepoSession,
    keys: ManagedKeys,
) -> Result<(), AppError> {
    {
        session.settings.write().await.applied_profile_keys = Some(keys);
    }
    state.persist_session_settings(session).await
}

/// A profile's projection as it would be written into this session's local
/// config (path-valued keys resolved into the distro for a WSL host).
fn resolve_projection_for_session(
    session: &crate::state::RepoSession,
    profile: &GitProfile,
) -> Result<ManagedKeys, AppError> {
    let keys = projection(profile);
    match session.host.id() {
        legit_host::HostId::Wsl { .. } => {
            let home = session.host.home_dir().ok_or_else(|| {
                AppError::Io("the distribution reported no home directory".to_string())
            })?;
            Ok(resolve_managed_paths_for_distro(&keys, &home.0).0)
        }
        _ => Ok(keys),
    }
}

/// One repo a profile edit was re-applied to.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct AppliedPropagation {
    /// Repo display name (folder name).
    pub repo: String,
    /// For a repo on a WSL host: how the profile's auth key resolved there
    /// (same offer semantics as `apply_profile_to_repo`).
    pub distro_key: Option<DistroKeyResolution>,
}

/// What propagating a profile edit did across the open repos.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct ProfilePropagation {
    pub applied: Vec<AppliedPropagation>,
    /// Per-repo propagation failures ("repo: message"); the definition update
    /// itself already succeeded.
    pub errors: Vec<String>,
}

impl ProfilePropagation {
    fn empty() -> Self {
        ProfilePropagation { applied: vec![], errors: vec![] }
    }
}

enum SessionPropagation {
    Applied(Option<DistroKeyResolution>),
    Unchanged,
}

/// Re-apply an edited profile to one session when its local config is still
/// what the apply wrote; backfill a missing snapshot when the config already
/// equals the new projection.
async fn propagate_to_session(
    state: &AppState,
    session: &crate::state::RepoSession,
    old: Option<&GitProfile>,
    new: &GitProfile,
) -> Result<SessionPropagation, AppError> {
    let runner = session.runner.read().await.clone();
    let local = read_local_managed(runner.as_ref()).await;
    let snapshot = session.settings.read().await.applied_profile_keys.clone();
    let old_resolved = match old {
        Some(o) => Some(resolve_projection_for_session(session, o)?),
        None => None,
    };
    let new_resolved = resolve_projection_for_session(session, new)?;
    match propagation_decision(&local, snapshot.as_ref(), old_resolved.as_ref(), &new_resolved) {
        PropagationAction::Reapply => {
            let resolution = apply_profile_core(state, session, &new.id).await?;
            Ok(SessionPropagation::Applied(resolution))
        }
        PropagationAction::UpToDate { backfill: true } => {
            record_applied_snapshot(state, session, new_resolved).await?;
            Ok(SessionPropagation::Unchanged)
        }
        _ => Ok(SessionPropagation::Unchanged),
    }
}

/// Propagate a profile edit to every OPEN session that selects it (closed
/// repos reconcile lazily on their next open). A failing repo never fails the
/// others: failures are reported in the result.
pub async fn propagate_profile_update(
    state: &AppState,
    old: &GitProfile,
    new: &GitProfile,
) -> ProfilePropagation {
    let mut result = ProfilePropagation::empty();
    let sessions: Vec<_> = state.repos.read().await.values().cloned().collect();
    for session in sessions {
        let selected = session.settings.read().await.git_profile_id.clone();
        if selected.as_deref() != Some(new.id.as_str()) {
            continue;
        }
        let repo = session.summary().name;
        match propagate_to_session(state, &session, Some(old), new).await {
            Ok(SessionPropagation::Applied(distro_key)) => {
                result.applied.push(AppliedPropagation { repo, distro_key });
            }
            Ok(SessionPropagation::Unchanged) => {}
            Err(e) => result.errors.push(format!("{repo}: {e}")),
        }
    }
    result
}

/// Catch up a just-opened repo with profile edits made while it was closed:
/// re-apply its selected profile when the local config is still what the last
/// apply wrote but no longer matches the (possibly edited) definition.
pub async fn reconcile_profile_on_open(state: &AppState, session: &crate::state::RepoSession) {
    let Some(profile_id) = session.settings.read().await.git_profile_id.clone() else {
        return;
    };
    let profile = state
        .global_settings
        .read()
        .await
        .git_profiles_doc
        .profiles
        .iter()
        .find(|p| p.id == profile_id)
        .cloned();
    let Some(profile) = profile else { return };
    match propagate_to_session(state, session, None, &profile).await {
        Ok(SessionPropagation::Applied(_)) => {
            tracing::info!(repo = %session.root.0, profile = %profile.name,
                "profile re-applied on open (definition changed while the repo was closed)");
        }
        Ok(SessionPropagation::Unchanged) => {}
        Err(e) => {
            tracing::warn!(repo = %session.root.0, err = %e, "profile reconcile on open failed");
        }
    }
}

/// `update_git_profile`'s body (testable without a tauri handle): replace the
/// definition, then propagate to the open repos that select it.
pub async fn update_git_profile_core(
    state: &AppState,
    profile: GitProfile,
) -> Result<ProfilePropagation, AppError> {
    let old = {
        // Not `mutate_global`: the unknown-profile early return must happen
        // BEFORE anything persists.
        let mut s = state.global_settings.write().await;
        let slot = s
            .git_profiles_doc
            .profiles
            .iter_mut()
            .find(|p| p.id == profile.id)
            .ok_or_else(|| AppError::UnknownProfile(profile.id.clone()))?;
        let old = slot.clone();
        *slot = profile.clone();
        old
    };
    state.persist_global_settings().await?;
    if old == profile {
        return Ok(ProfilePropagation::empty());
    }
    Ok(propagate_profile_update(state, &old, &profile).await)
}

// ---------------------------------------------------------------------------
// Commands — global profile definitions (CRUD)
// ---------------------------------------------------------------------------

#[tauri::command]
#[specta::specta]
pub async fn list_git_profiles(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<GitProfile>, AppError> {
    Ok(state.global_settings.read().await.git_profiles_doc.profiles.clone())
}

/// Create a profile. The incoming `id` is ignored; a fresh UUID is assigned.
#[tauri::command]
#[specta::specta]
pub async fn create_git_profile(
    state: tauri::State<'_, AppState>,
    profile: GitProfile,
) -> Result<GitProfile, AppError> {
    let created = GitProfile { id: Uuid::new_v4().to_string(), ..profile };
    state.mutate_global(|s| {
        s.git_profiles_doc.profiles.push(created.clone());
    })
    .await?;
    Ok(created)
}

/// Replace an existing profile (matched by id) and re-apply it to the open
/// repos that select it and whose config is still what the apply wrote.
#[tauri::command]
#[specta::specta]
pub async fn update_git_profile(
    state: tauri::State<'_, AppState>,
    profile: GitProfile,
) -> Result<ProfilePropagation, AppError> {
    update_git_profile_core(&state, profile).await
}

/// Delete a profile definition. Does NOT touch any repo's `.git/config`.
#[tauri::command]
#[specta::specta]
pub async fn delete_git_profile(
    state: tauri::State<'_, AppState>,
    profile_id: String,
) -> Result<(), AppError> {
    state.mutate_global(|s| {
        s.git_profiles_doc.profiles.retain(|p| p.id != profile_id);
    })
    .await
}

/// Pure: display names (repo folder name) of the repos whose stored selection
/// references `profile_id`. Entries are `(repo_path, stored_profile_id)`.
/// Paths may be Windows-style regardless of host OS (they come from
/// `path.txt`), so separators are normalized before taking the last segment.
fn collect_profile_usage(entries: &[(String, Option<String>)], profile_id: &str) -> Vec<String> {
    let mut names: Vec<String> = entries
        .iter()
        .filter(|(_, stored)| stored.as_deref() == Some(profile_id))
        .map(|(path, _)| {
            let normalized = path.replace('\\', "/");
            normalized
                .rsplit('/')
                .find(|seg| !seg.is_empty())
                .unwrap_or(&normalized)
                .to_string()
        })
        .collect();
    names.sort();
    names.dedup();
    names
}

/// Read-only: which repos currently select `profile_id`. Scans the persisted
/// per-repo settings under `repos/<hash>/` - repo settings persist eagerly on
/// every change, so disk is current even for open repos, and the scan also
/// covers repos that are not open right now. A dir without `path.txt` has
/// never had settings written and is skipped.
#[tauri::command]
#[specta::specta]
pub async fn repos_using_profile(
    state: tauri::State<'_, AppState>,
    profile_id: String,
) -> Result<Vec<String>, AppError> {
    let mut entries: Vec<(String, Option<String>)> = Vec::new();
    let mut dir = match tokio::fs::read_dir(&state.repos_data_dir).await {
        Ok(d) => d,
        Err(_) => return Ok(vec![]), // no repo data yet
    };
    while let Ok(Some(ent)) = dir.next_entry().await {
        let repo_dir = ent.path();
        let Ok(repo_path) = tokio::fs::read_to_string(repo_dir.join("path.txt")).await else {
            continue;
        };
        let settings = crate::state::load_repo_settings_sync(&repo_dir.join("settings.json"));
        entries.push((repo_path.trim().to_string(), settings.git_profile_id));
    }
    Ok(collect_profile_usage(&entries, &profile_id))
}

// ---------------------------------------------------------------------------
// Commands — per-repo apply / detect
// ---------------------------------------------------------------------------

/// Read-only: how the repo's live local config relates to the defined profiles.
#[tauri::command]
#[specta::specta]
pub async fn detect_active_profile_for_repo(
    state: tauri::State<'_, AppState>,
    repo_id: String,
) -> Result<ProfileStatus, AppError> {
    let session = state.get_session(&repo_id).await?;
    let runner = session.runner.read().await.clone();
    let stored = session.settings.read().await.git_profile_id.clone();
    Ok(status_for(&state, runner.as_ref(), stored).await)
}

/// Read-only: local + inherited managed keys, for the repo identity section
/// (Global-mode summary, Custom-editor prefill and placeholders).
#[tauri::command]
#[specta::specta]
pub async fn repo_managed_config_view(
    state: tauri::State<'_, AppState>,
    repo_id: String,
) -> Result<ManagedConfigView, AppError> {
    let session = state.get_session(&repo_id).await?;
    let runner = session.runner.read().await.clone();
    let local = read_managed_scope(runner.as_ref(), ConfigScope::Local).await;
    let global = read_managed_scope(runner.as_ref(), ConfigScope::Global).await;
    let system = read_managed_scope(runner.as_ref(), ConfigScope::System).await;
    Ok(ManagedConfigView { local, inherited: coalesce_inherited(global, system) })
}

/// Read-only: the diff `apply_profile_to_repo` would make for this profile.
#[tauri::command]
#[specta::specta]
pub async fn preview_apply_profile(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    profile_id: String,
) -> Result<Vec<KeyDiff>, AppError> {
    let session = state.get_session(&repo_id).await?;
    let runner = session.runner.read().await.clone();
    let profile = state
        .global_settings
        .read()
        .await
        .git_profiles_doc
        .profiles
        .iter()
        .find(|p| p.id == profile_id)
        .cloned()
        .ok_or_else(|| AppError::UnknownProfile(profile_id.clone()))?;
    let local = read_local_managed(runner.as_ref()).await;
    Ok(diff_keys(&local, &projection(&profile)))
}

/// Apply a profile: write all 8 managed keys to local config and record the
/// selection. Returns the refreshed status (should be `Active`).
#[tauri::command]
#[specta::specta]
pub async fn apply_profile_to_repo(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    profile_id: String,
) -> Result<ProfileApplyResult, AppError> {
    let session = state.get_session(&repo_id).await?;
    let distro_key = apply_profile_core(&state, &session, &profile_id).await?;
    let runner = session.runner.read().await.clone();
    let stored = session.settings.read().await.git_profile_id.clone();
    Ok(ProfileApplyResult { status: status_for(&state, runner.as_ref(), stored).await, distro_key })
}

/// `apply_profile_to_repo`'s result: the refreshed status plus, for a repo on
/// a remote host, how the profile's auth key resolved there.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, specta::Type)]
pub struct ProfileApplyResult {
    pub status: ProfileStatus,
    pub distro_key: Option<DistroKeyResolution>,
}

/// Clear the repo's profile: unset all 8 managed keys locally and drop the
/// stored selection (back to `Inherit`).
#[tauri::command]
#[specta::specta]
pub async fn clear_repo_profile(
    state: tauri::State<'_, AppState>,
    repo_id: String,
) -> Result<ProfileStatus, AppError> {
    let session = state.get_session(&repo_id).await?;
    let runner = session.runner.read().await.clone();
    write_managed(runner.as_ref(), &ManagedKeys::all_unset()).await?;
    set_repo_profile_selection(&state, &session, None, None).await?;
    if let Some(key) = repo_assignment_key(&session).await {
        let _ = state
            .mutate_global(|s| {
                s.profile_assignments.remove(&key);
            })
            .await;
    }
    Ok(status_for(&state, runner.as_ref(), None).await)
}

/// Read-only: the profile the synced assignment map records for this repo's
/// remote - the "on your other machines this clone uses X" suggestion.
/// `None` when the repo has no mappable remote, no entry exists, or the
/// mapped profile does not (or no longer does) exist here.
#[tauri::command]
#[specta::specta]
pub async fn suggested_profile_for_repo(
    state: tauri::State<'_, AppState>,
    repo_id: String,
) -> Result<Option<String>, AppError> {
    let session = state.get_session(&repo_id).await?;
    let Some(key) = repo_assignment_key(&session).await else {
        return Ok(None);
    };
    let s = state.global_settings.read().await;
    Ok(s.profile_assignments
        .get(&key)
        .filter(|id| s.git_profiles_doc.profiles.iter().any(|p| &p.id == *id))
        .cloned())
}

/// Custom-mode save: write only the keys the draft changes (relative to the
/// live local config) and return the refreshed status. Never touches the
/// stored `git_profile_id` (it is only a match tiebreaker).
#[tauri::command]
#[specta::specta]
pub async fn write_repo_managed_config(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    draft: ManagedKeys,
) -> Result<ProfileStatus, AppError> {
    let session = state.get_session(&repo_id).await?;
    let runner = session.runner.read().await.clone();
    let draft = normalize_draft(&draft);
    let current = read_local_managed(runner.as_ref()).await;
    for d in diff_keys(&current, &draft) {
        // KeyDiff's `profile` side carries the draft value here.
        write_one_managed(runner.as_ref(), &d.key, d.profile.as_deref())
            .await
            .map_err(|e| note_failed_key(e, &d.key))?;
    }
    let stored = session.settings.read().await.git_profile_id.clone();
    Ok(status_for(&state, runner.as_ref(), stored).await)
}

/// The identity git would use for a commit in this repo, resolved across all
/// scopes (local > global > system). Both `None` means a commit would fail
/// with git's "Please tell me who you are" error: the UI surfaces that
/// BEFORE the failed commit (commit-box nudge).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct ResolvedIdentity {
    pub user_name: Option<String>,
    pub user_email: Option<String>,
}

#[tauri::command]
#[specta::specta]
pub async fn repo_resolved_identity(
    state: tauri::State<'_, AppState>,
    repo_id: String,
) -> Result<ResolvedIdentity, AppError> {
    let session = state.get_session(&repo_id).await?;
    let runner = session.runner.read().await.clone();
    Ok(ResolvedIdentity {
        user_name: config::read_effective(runner.as_ref(), KEY_USER_NAME).await,
        user_email: config::read_effective(runner.as_ref(), KEY_USER_EMAIL).await,
    })
}

/// Snapshot the repo's current local config into a new profile, and select it.
/// Does NOT change any git-config value — records intent only.
#[tauri::command]
#[specta::specta]
pub async fn create_profile_from_repo(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    name: String,
) -> Result<GitProfile, AppError> {
    let session = state.get_session(&repo_id).await?;
    let runner = session.runner.read().await.clone();
    let local = read_local_managed(runner.as_ref()).await;
    // Re-parse the raw command so we only capture an auth key that round-trips
    // cleanly (a custom, non-`ssh -i` command is dropped rather than stored).
    let ssh_raw = config::read_scope(runner.as_ref(), ConfigScope::Local, KEY_SSH_COMMAND).await.value;
    let auth_ssh_key = ssh_raw
        .as_deref()
        .and_then(parse_ssh_key_from_command)
        .map(|p| normalize_key_path(&p));
    let profile = GitProfile {
        id: Uuid::new_v4().to_string(),
        name,
        user_name: local.user_name.clone(),
        user_email: local.user_email.clone(),
        gpg_format: local.gpg_format.clone(),
        signing_key: local.signing_key.clone(),
        commit_gpgsign: local.commit_gpgsign.clone(),
        allowed_signers_file: local.allowed_signers_file.clone(),
        auth_ssh_key,
        credential_helper: local.credential_helper.clone(),
    };
    state.mutate_global(|s| {
        s.git_profiles_doc.profiles.push(profile.clone());
    })
    .await?;
    // Nothing was written: the snapshot is the live local state the profile
    // was built from.
    set_repo_profile_selection(&state, &session, Some(profile.id.clone()), Some(local)).await?;
    Ok(profile)
}

impl ManagedKeys {
    fn all_unset() -> Self {
        ManagedKeys {
            user_name: None,
            user_email: None,
            gpg_format: None,
            signing_key: None,
            commit_gpgsign: None,
            allowed_signers_file: None,
            auth_ssh_key: None,
            credential_helper: None,
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn distro_path_resolution_rewrites_paths_only() {
        let keys = ManagedKeys {
            user_name: Some("Simon".into()),
            user_email: Some("s@x.ch".into()),
            gpg_format: Some("ssh".into()),
            signing_key: Some("C:/Users/s/.ssh/id_ed25519_work.pub".into()),
            commit_gpgsign: Some("true".into()),
            allowed_signers_file: Some("C:/Users/s/.ssh/allowed_signers".into()),
            auth_ssh_key: Some("C:/Users/s/.ssh/id_ed25519_work".into()),
            credential_helper: None,
        };
        let (out, auth) = resolve_managed_paths_for_distro(&keys, "/home/u/");
        assert_eq!(out.auth_ssh_key.as_deref(), Some("/home/u/.ssh/id_ed25519_work"));
        assert_eq!(out.signing_key.as_deref(), Some("/home/u/.ssh/id_ed25519_work.pub"));
        assert_eq!(out.allowed_signers_file.as_deref(), Some("/home/u/.ssh/allowed_signers"));
        assert_eq!(
            auth,
            Some((
                "C:/Users/s/.ssh/id_ed25519_work".to_string(),
                "/home/u/.ssh/id_ed25519_work".to_string()
            ))
        );
        // Identity fields pass through untouched.
        assert_eq!(out.user_email, keys.user_email);
    }

    #[test]
    fn distro_path_resolution_leaves_non_path_signing_values_alone() {
        // A GPG key id and a literal ssh public key are not paths.
        let gpg = ManagedKeys {
            gpg_format: Some("openpgp".into()),
            signing_key: Some("ABC123DEF".into()),
            allowed_signers_file: Some("C:/s/allowed".into()),
            auth_ssh_key: None,
            user_name: None,
            user_email: None,
            commit_gpgsign: None,
            credential_helper: None,
        };
        let (out, auth) = resolve_managed_paths_for_distro(&gpg, "/home/u");
        assert_eq!(out.signing_key.as_deref(), Some("ABC123DEF"));
        // Non-ssh formats keep their allowed-signers value too.
        assert_eq!(out.allowed_signers_file.as_deref(), Some("C:/s/allowed"));
        assert_eq!(auth, None);

        let literal = ManagedKeys {
            gpg_format: Some("ssh".into()),
            signing_key: Some("ssh-ed25519 AAAAC3NzaC1lZDI1 s@x.ch".into()),
            ..gpg.clone()
        };
        let (out, _) = resolve_managed_paths_for_distro(&literal, "/home/u");
        assert_eq!(out.signing_key.as_deref(), Some("ssh-ed25519 AAAAC3NzaC1lZDI1 s@x.ch"));
    }

    #[test]
    fn key_file_basename_handles_both_separators() {
        assert_eq!(key_file_basename("C:/Users/s/.ssh/id_ed25519_work"), Some("id_ed25519_work"));
        assert_eq!(key_file_basename(r"C:\Users\s\.ssh\id_rsa"), Some("id_rsa"));
        assert_eq!(key_file_basename("/home/u/.ssh/key"), Some("key"));
        assert_eq!(key_file_basename("bare_name"), Some("bare_name"));
        assert_eq!(key_file_basename("ends/with/"), None);
        assert_eq!(key_file_basename(""), None);
    }

    fn profile(id: &str, name: &str) -> GitProfile {
        GitProfile {
            id: id.to_string(),
            name: name.to_string(),
            user_name: None,
            user_email: None,
            gpg_format: None,
            signing_key: None,
            commit_gpgsign: None,
            allowed_signers_file: None,
            auth_ssh_key: None,
            credential_helper: None,
        }
    }

    #[test]
    fn ssh_command_round_trip_unix() {
        let p = "/home/u/.ssh/id_ed25519";
        let cmd = synth_ssh_command(p);
        assert_eq!(cmd, "ssh -i \"/home/u/.ssh/id_ed25519\" -o IdentitiesOnly=yes");
        assert_eq!(parse_ssh_key_from_command(&cmd).as_deref(), Some(p));
    }

    #[test]
    fn ssh_command_round_trip_windows_backslashes() {
        let p = r"C:\Users\u\.ssh\id_ed25519";
        let cmd = synth_ssh_command(p);
        // Backslashes normalized to forward slashes.
        assert!(cmd.contains("C:/Users/u/.ssh/id_ed25519"));
        assert_eq!(
            parse_ssh_key_from_command(&cmd).as_deref(),
            Some("C:/Users/u/.ssh/id_ed25519")
        );
    }

    #[test]
    fn ssh_command_round_trip_path_with_space() {
        let p = "C:/Users/Si mon/.ssh/key";
        let cmd = synth_ssh_command(p);
        assert_eq!(parse_ssh_key_from_command(&cmd).as_deref(), Some(p));
    }

    #[test]
    fn ssh_command_round_trip_embedded_quote() {
        let p = r#"/home/a"b/key"#;
        let cmd = synth_ssh_command(p);
        assert_eq!(parse_ssh_key_from_command(&cmd).as_deref(), Some(p));
    }

    #[test]
    fn parse_non_ssh_command_returns_none() {
        assert_eq!(parse_ssh_key_from_command("/usr/bin/weird-wrapper"), None);
        assert_eq!(parse_ssh_key_from_command(""), None);
    }

    fn signing_profile(id: &str, email: &str) -> GitProfile {
        GitProfile { user_email: Some(email.to_string()), ..profile(id, id) }
    }

    fn email_only_local(email: Option<&str>) -> ManagedKeys {
        ManagedKeys { user_email: email.map(String::from), ..ManagedKeys::all_unset() }
    }

    #[test]
    fn credential_helper_projects_and_diffs() {
        let p = GitProfile { credential_helper: Some("manager".into()), ..profile("p1", "p1") };
        // projection carries it through (trimmed).
        assert_eq!(projection(&p).credential_helper.as_deref(), Some("manager"));
        // a local config without it shows the key as a diff.
        let diffs = diff_keys(&ManagedKeys::all_unset(), &projection(&p));
        let d = diffs.iter().find(|d| d.key == KEY_CREDENTIAL_HELPER).expect("helper diff");
        assert_eq!(d.local, None);
        assert_eq!(d.profile.as_deref(), Some("manager"));
    }

    #[test]
    fn clone_auth_args_none_when_no_auth() {
        assert!(clone_auth_config_args(&profile("p1", "p1")).is_empty());
    }

    #[test]
    fn clone_auth_args_ssh_only() {
        let p = GitProfile { auth_ssh_key: Some("/home/u/.ssh/id".into()), ..profile("p1", "p1") };
        let args = clone_auth_config_args(&p);
        assert_eq!(args[0], "-c");
        assert_eq!(args[1], "core.sshCommand=ssh -i \"/home/u/.ssh/id\" -o IdentitiesOnly=yes");
        assert_eq!(args.len(), 2);
    }

    #[test]
    fn clone_auth_args_helper_resets_then_sets() {
        let p = GitProfile { credential_helper: Some("manager".into()), ..profile("p1", "p1") };
        assert_eq!(
            clone_auth_config_args(&p),
            vec!["-c", "credential.helper=", "-c", "credential.helper=manager"]
        );
    }

    #[test]
    fn clone_auth_args_ssh_and_helper() {
        let p = GitProfile {
            auth_ssh_key: Some("/k".into()),
            credential_helper: Some("store".into()),
            ..profile("p1", "p1")
        };
        let args = clone_auth_config_args(&p);
        // ssh first, then the helper reset+set.
        assert_eq!(args[0], "-c");
        assert!(args[1].starts_with("core.sshCommand=ssh -i"));
        assert_eq!(&args[2..], &["-c", "credential.helper=", "-c", "credential.helper=store"]);
    }

    #[test]
    fn match_inherit_when_all_unset() {
        let m = compute_match(&ManagedKeys::all_unset(), &[], None);
        assert!(matches!(m, ProfileMatch::Inherit));
    }

    #[test]
    fn match_active_when_local_equals_projection() {
        let profiles = vec![signing_profile("p1", "work@x.com")];
        let local = email_only_local(Some("work@x.com"));
        let m = compute_match(&local, &profiles, None);
        assert!(matches!(m, ProfileMatch::Active { profile_id } if profile_id == "p1"));
    }

    #[test]
    fn match_custom_when_stored_profile_diverges() {
        // Formerly "drift": the config matches no profile, so it IS custom.
        let profiles = vec![signing_profile("p1", "work@x.com")];
        let local = email_only_local(Some("personal@y.com"));
        let m = compute_match(&local, &profiles, Some("p1"));
        assert!(matches!(m, ProfileMatch::Custom));
    }

    #[test]
    fn match_custom_when_no_profile_and_no_stored() {
        let profiles = vec![signing_profile("p1", "work@x.com")];
        let local = email_only_local(Some("nobody@z.com"));
        let m = compute_match(&local, &profiles, None);
        assert!(matches!(m, ProfileMatch::Custom));
    }

    #[test]
    fn match_prefers_stored_among_duplicates() {
        let profiles = vec![
            signing_profile("p1", "same@x.com"),
            signing_profile("p2", "same@x.com"),
        ];
        let local = email_only_local(Some("same@x.com"));
        let m = compute_match(&local, &profiles, Some("p2"));
        assert!(matches!(m, ProfileMatch::Active { profile_id } if profile_id == "p2"));
    }

    #[test]
    fn profile_usage_filters_and_names() {
        let entries = vec![
            ("/work/alpha".to_string(), Some("p1".to_string())),
            ("/work/beta".to_string(), Some("p2".to_string())),
            ("/work/gamma".to_string(), None),
            (r"C:\work\delta".to_string(), Some("p1".to_string())),
        ];
        assert_eq!(collect_profile_usage(&entries, "p1"), vec!["alpha", "delta"]);
        assert_eq!(collect_profile_usage(&entries, "p2"), vec!["beta"]);
        assert!(collect_profile_usage(&entries, "p9").is_empty());
    }

    #[test]
    fn normalize_draft_trims_and_normalizes_key_path() {
        let raw = ManagedKeys {
            user_name: Some("  Name  ".into()),
            user_email: Some("   ".into()), // whitespace-only -> unset
            auth_ssh_key: Some(r"C:\Users\s\.ssh\id".into()),
            ..ManagedKeys::all_unset()
        };
        let n = normalize_draft(&raw);
        assert_eq!(n.user_name.as_deref(), Some("Name"));
        assert_eq!(n.user_email, None);
        assert_eq!(n.auth_ssh_key.as_deref(), Some("C:/Users/s/.ssh/id"));
    }

    #[test]
    fn mixed_draft_diffs_exactly_the_changed_keys() {
        // One key set, one unset, six untouched -> exactly two diffs.
        let current = ManagedKeys {
            user_email: Some("old@x.com".into()),
            signing_key: Some("KEEP".into()),
            ..ManagedKeys::all_unset()
        };
        let draft = ManagedKeys {
            user_name: Some("New Name".into()), // set
            user_email: None,                   // unset
            signing_key: Some("KEEP".into()),   // untouched
            ..ManagedKeys::all_unset()
        };
        let diffs = diff_keys(&current, &draft);
        let keys: Vec<&str> = diffs.iter().map(|d| d.key.as_str()).collect();
        assert_eq!(keys, vec![KEY_USER_NAME, KEY_USER_EMAIL]);
        assert_eq!(diffs[0].profile.as_deref(), Some("New Name"));
        assert_eq!(diffs[1].profile, None);
    }

    #[test]
    fn inherited_coalescing_global_beats_system() {
        let global = ManagedKeys {
            user_name: Some("Global Name".into()),
            ..ManagedKeys::all_unset()
        };
        let system = ManagedKeys {
            user_name: Some("System Name".into()),
            credential_helper: Some("manager".into()),
            ..ManagedKeys::all_unset()
        };
        let merged = coalesce_inherited(global, system);
        // Global wins where both are set; system fills the gaps.
        assert_eq!(merged.user_name.as_deref(), Some("Global Name"));
        assert_eq!(merged.credential_helper.as_deref(), Some("manager"));
        assert_eq!(merged.user_email, None);
    }

    #[test]
    fn match_stale_stored_id_is_custom() {
        // Stored id references a deleted profile; local matches no profile.
        let profiles = vec![signing_profile("p1", "work@x.com")];
        let local = email_only_local(Some("orphan@z.com"));
        let m = compute_match(&local, &profiles, Some("deleted-id"));
        assert!(matches!(m, ProfileMatch::Custom));
    }

    // --- propagation decision ---

    #[test]
    fn propagation_up_to_date_when_local_equals_new_projection() {
        let keys = email_only_local(Some("new@x.com"));
        let d = propagation_decision(&keys, Some(&keys), None, &keys);
        assert_eq!(d, PropagationAction::UpToDate { backfill: false });
    }

    #[test]
    fn propagation_backfills_snapshot_when_missing_but_current() {
        // Repo applied before snapshots existed, config still current: record
        // the snapshot so the NEXT edit can propagate.
        let keys = email_only_local(Some("new@x.com"));
        let d = propagation_decision(&keys, None, None, &keys);
        assert_eq!(d, PropagationAction::UpToDate { backfill: true });
    }

    #[test]
    fn propagation_reapplies_when_local_matches_snapshot() {
        let old = email_only_local(Some("old@x.com"));
        let new = email_only_local(Some("new@x.com"));
        let d = propagation_decision(&old, Some(&old), None, &new);
        assert_eq!(d, PropagationAction::Reapply);
    }

    #[test]
    fn propagation_reapplies_without_snapshot_when_local_matches_old_projection() {
        // Pre-snapshot repo: at update time the pre-edit projection is known
        // and stands in for the snapshot.
        let old = email_only_local(Some("old@x.com"));
        let new = email_only_local(Some("new@x.com"));
        let d = propagation_decision(&old, None, Some(&old), &new);
        assert_eq!(d, PropagationAction::Reapply);
    }

    #[test]
    fn propagation_skips_hand_edited_local() {
        // Local diverged from what the apply wrote: the user's config wins.
        let applied = email_only_local(Some("old@x.com"));
        let edited = email_only_local(Some("mine@y.com"));
        let new = email_only_local(Some("new@x.com"));
        assert_eq!(
            propagation_decision(&edited, Some(&applied), Some(&applied), &new),
            PropagationAction::Skip
        );
        // Without a snapshot and no old-projection match: ambiguous, never
        // overwrite.
        assert_eq!(propagation_decision(&edited, None, None, &new), PropagationAction::Skip);
        assert_eq!(
            propagation_decision(&edited, None, Some(&applied), &new),
            PropagationAction::Skip
        );
    }

    mod propagation_flow {
        use super::*;
        use crate::state::{AppState, GlobalSettings, RepoSession, RepoSettings};
        use crate::remote::RepoLocator;
        use legit_core::test_support::{fail, ok, FakeExecutor};
        use legit_host::LocalHost;
        use std::path::Path;
        use std::sync::Arc;

        fn old_profile() -> GitProfile {
            GitProfile {
                user_name: Some("Old Name".into()),
                user_email: Some("old@x.com".into()),
                ..profile("p1", "Work")
            }
        }

        fn edited_profile() -> GitProfile {
            GitProfile { user_email: Some("new@x.com".into()), ..old_profile() }
        }

        fn state_with_profile(dir: &Path, p: GitProfile) -> AppState {
            let mut settings = GlobalSettings::default();
            settings.git_profiles_doc.profiles.push(p);
            AppState::new(
                std::path::PathBuf::from("git"),
                settings,
                dir.join("global-settings.json"),
                dir.join("repos"),
                dir.join("themes"),
                dir.join("builtin-themes"),
            )
        }

        async fn insert_session(
            state: &AppState,
            dir: &Path,
            exec: Arc<FakeExecutor>,
            settings: RepoSettings,
        ) -> Arc<RepoSession> {
            let session = Arc::new(RepoSession::new(
                RepoLocator::local(dir.join("repo")),
                Arc::new(LocalHost),
                exec,
                settings,
                dir.join("settings.json"),
            ));
            state.repos.write().await.insert(session.id.clone(), session.clone());
            session
        }

        /// Script `read_local_managed`: name/email as given, everything else
        /// unset.
        fn script_local_read(exec: &FakeExecutor, name: &str, email: &str) {
            exec.expect(&["config", "--local", "--get", "core.sshCommand"], fail(1, ""))
                .expect(&["config", "--local", "--get", "user.name"], ok(&format!("{name}\n")))
                .expect(&["config", "--local", "--get", "user.email"], ok(&format!("{email}\n")))
                .expect(&["config", "--local", "--get", "gpg.format"], fail(1, ""))
                .expect(&["config", "--local", "--get", "user.signingkey"], fail(1, ""))
                .expect(&["config", "--local", "--get", "commit.gpgsign"], fail(1, ""))
                .expect(&["config", "--local", "--get", "gpg.ssh.allowedSignersFile"], fail(1, ""))
                .expect(&["config", "--local", "--get-all", "credential.helper"], fail(1, ""));
        }

        /// Script `write_managed` for a name+email-only key set.
        fn script_apply_write(exec: &FakeExecutor, name: &str, email: &str) {
            exec.expect(&["config", "--local", "user.name", name], ok(""))
                .expect(&["config", "--local", "user.email", email], ok(""))
                .expect(&["config", "--local", "--unset", "gpg.format"], fail(5, ""))
                .expect(&["config", "--local", "--unset", "user.signingkey"], fail(5, ""))
                .expect(&["config", "--local", "--unset", "commit.gpgsign"], fail(5, ""))
                .expect(
                    &["config", "--local", "--unset", "gpg.ssh.allowedSignersFile"],
                    fail(5, ""),
                )
                .expect(&["config", "--local", "--unset", "core.sshCommand"], fail(5, ""))
                .expect(&["config", "--local", "--unset-all", "credential.helper"], fail(5, ""));
        }

        fn selected(applied: Option<ManagedKeys>) -> RepoSettings {
            RepoSettings {
                git_profile_id: Some("p1".into()),
                applied_profile_keys: applied,
                ..RepoSettings::default()
            }
        }

        #[tokio::test]
        async fn profile_edit_reapplies_to_open_repo_still_on_the_applied_keys() {
            let dir = tempfile::tempdir().unwrap();
            let state = state_with_profile(dir.path(), old_profile());
            let exec = Arc::new(FakeExecutor::default());
            script_local_read(&exec, "Old Name", "old@x.com");
            script_apply_write(&exec, "Old Name", "new@x.com");
            // apply_profile_core's best-effort assignment bookkeeping.
            exec.expect(&["remote", "-v"], ok(""));
            let session =
                insert_session(&state, dir.path(), exec.clone(), selected(Some(projection(&old_profile())))).await;

            let result = update_git_profile_core(&state, edited_profile()).await.unwrap();

            assert_eq!(result.applied.len(), 1);
            assert_eq!(result.applied[0].repo, "repo");
            assert!(result.errors.is_empty());
            exec.assert_done();
            assert_eq!(
                session.settings.read().await.applied_profile_keys,
                Some(projection(&edited_profile()))
            );
        }

        #[tokio::test]
        async fn profile_edit_reapplies_without_snapshot_when_local_matches_old_projection() {
            // Repo applied before snapshots existed: the pre-edit projection
            // stands in.
            let dir = tempfile::tempdir().unwrap();
            let state = state_with_profile(dir.path(), old_profile());
            let exec = Arc::new(FakeExecutor::default());
            script_local_read(&exec, "Old Name", "old@x.com");
            script_apply_write(&exec, "Old Name", "new@x.com");
            exec.expect(&["remote", "-v"], ok(""));
            insert_session(&state, dir.path(), exec.clone(), selected(None)).await;

            let result = update_git_profile_core(&state, edited_profile()).await.unwrap();

            assert_eq!(result.applied.len(), 1);
            exec.assert_done();
        }

        #[tokio::test]
        async fn profile_edit_leaves_hand_edited_repo_config_alone() {
            let dir = tempfile::tempdir().unwrap();
            let state = state_with_profile(dir.path(), old_profile());
            let exec = Arc::new(FakeExecutor::default());
            // Local config diverged from the applied snapshot: no writes follow.
            script_local_read(&exec, "Old Name", "mine@y.com");
            let session =
                insert_session(&state, dir.path(), exec.clone(), selected(Some(projection(&old_profile())))).await;

            let result = update_git_profile_core(&state, edited_profile()).await.unwrap();

            assert!(result.applied.is_empty());
            assert!(result.errors.is_empty());
            exec.assert_done();
            // The stale snapshot stays; detection shows Custom.
            assert_eq!(
                session.settings.read().await.applied_profile_keys,
                Some(projection(&old_profile()))
            );
        }

        #[tokio::test]
        async fn profile_edit_ignores_repos_selecting_another_profile() {
            let dir = tempfile::tempdir().unwrap();
            let state = state_with_profile(dir.path(), old_profile());
            let exec = Arc::new(FakeExecutor::default());
            let settings = RepoSettings {
                git_profile_id: Some("other".into()),
                ..RepoSettings::default()
            };
            insert_session(&state, dir.path(), exec.clone(), settings).await;

            let result = update_git_profile_core(&state, edited_profile()).await.unwrap();

            assert!(result.applied.is_empty());
            exec.assert_done();
        }

        #[tokio::test]
        async fn reconcile_on_open_reapplies_a_stale_profile() {
            let dir = tempfile::tempdir().unwrap();
            // The DEFINITION already holds the new email; the repo's config
            // still holds what the apply wrote (the snapshot).
            let state = state_with_profile(dir.path(), edited_profile());
            let exec = Arc::new(FakeExecutor::default());
            script_local_read(&exec, "Old Name", "old@x.com");
            script_apply_write(&exec, "Old Name", "new@x.com");
            exec.expect(&["remote", "-v"], ok(""));
            let session =
                insert_session(&state, dir.path(), exec.clone(), selected(Some(projection(&old_profile())))).await;

            reconcile_profile_on_open(&state, &session).await;

            exec.assert_done();
            assert_eq!(
                session.settings.read().await.applied_profile_keys,
                Some(projection(&edited_profile()))
            );
        }

        #[tokio::test]
        async fn reconcile_on_open_backfills_the_snapshot_when_config_is_current() {
            let dir = tempfile::tempdir().unwrap();
            let state = state_with_profile(dir.path(), edited_profile());
            let exec = Arc::new(FakeExecutor::default());
            script_local_read(&exec, "Old Name", "new@x.com");
            let session = insert_session(&state, dir.path(), exec.clone(), selected(None)).await;

            reconcile_profile_on_open(&state, &session).await;

            exec.assert_done();
            assert_eq!(
                session.settings.read().await.applied_profile_keys,
                Some(projection(&edited_profile()))
            );
        }

        #[tokio::test]
        async fn reconcile_on_open_leaves_hand_edited_config_alone() {
            let dir = tempfile::tempdir().unwrap();
            let state = state_with_profile(dir.path(), edited_profile());
            let exec = Arc::new(FakeExecutor::default());
            script_local_read(&exec, "Old Name", "mine@y.com");
            let session =
                insert_session(&state, dir.path(), exec.clone(), selected(Some(projection(&old_profile())))).await;

            reconcile_profile_on_open(&state, &session).await;

            exec.assert_done();
        }
    }

    #[test]
    fn changed_profiles_pairs_edits_by_id() {
        let old = vec![signing_profile("p1", "a@x.com"), signing_profile("p2", "b@x.com")];
        let new = vec![
            signing_profile("p1", "a@x.com"),      // unchanged
            signing_profile("p2", "edited@x.com"), // edited
            signing_profile("p3", "c@x.com"),      // created (nothing to propagate from)
        ];
        let changed = changed_profiles(&old, &new);
        assert_eq!(changed.len(), 1);
        assert_eq!(changed[0].0.user_email.as_deref(), Some("b@x.com"));
        assert_eq!(changed[0].1.user_email.as_deref(), Some("edited@x.com"));
    }
}
