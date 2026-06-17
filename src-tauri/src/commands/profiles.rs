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
//! config degrades gracefully (drift/unmanaged) rather than lying.

use crate::commands::config_util::{read_config_scope, write_config_local};
use crate::commands::signing;
use crate::error::AppError;
use crate::state::{persist_repo_settings, AppState, GitProfile};
use legit_core::GitRunner;
use serde::{Deserialize, Serialize};
use specta::Type;
use uuid::Uuid;

const KEY_USER_NAME: &str = "user.name";
const KEY_USER_EMAIL: &str = "user.email";
const KEY_SSH_COMMAND: &str = "core.sshCommand";

// ---------------------------------------------------------------------------
// Types exposed to the frontend
// ---------------------------------------------------------------------------

/// The seven managed git-config keys, projected to plain values. For the auth
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
    /// No managed keys set locally — repo uses inherited (global) identity.
    Inherit,
    /// Local config exactly equals a profile's projection.
    Active { profile_id: String },
    /// Stored id points at an existing profile, but local config diverges.
    Drift { profile_id: String, diffs: Vec<KeyDiff> },
    /// Local has managed values matching no profile and no usable stored id.
    Unmanaged,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct ProfileStatus {
    /// Live LOCAL value of each managed key (None = unset locally).
    pub local: ManagedKeys,
    pub stored_profile_id: Option<String>,
    pub r#match: ProfileMatch,
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
    }
}

/// Read the seven managed keys at LOCAL scope. For `core.sshCommand`, parse out
/// the key path; if it isn't a LeGit-shaped `ssh -i …` command, keep the raw
/// command string (so it shows as a mismatch rather than a false match).
async fn read_local_managed(runner: &GitRunner) -> ManagedKeys {
    let local = |key: &'static str| async move {
        read_config_scope(runner, key, &["--local"]).await.value
    };
    let ssh_raw = local(KEY_SSH_COMMAND).await;
    ManagedKeys {
        user_name: local(KEY_USER_NAME).await,
        user_email: local(KEY_USER_EMAIL).await,
        gpg_format: local(signing::KEY_FORMAT).await,
        signing_key: local(signing::KEY_SIGNING_KEY).await,
        commit_gpgsign: local(signing::KEY_GPGSIGN).await,
        allowed_signers_file: local(signing::KEY_ALLOWED_SIGNERS).await,
        auth_ssh_key: ssh_raw.map(|cmd| {
            parse_ssh_key_from_command(&cmd)
                .map(|p| normalize_key_path(&p))
                .unwrap_or(cmd)
        }),
    }
}

/// Write a managed-key set to LOCAL config. `None` for a field unsets it. The
/// auth key is synthesized into a `core.sshCommand`.
async fn write_managed(runner: &GitRunner, mk: &ManagedKeys) -> Result<(), AppError> {
    write_config_local(runner, KEY_USER_NAME, mk.user_name.as_deref()).await?;
    write_config_local(runner, KEY_USER_EMAIL, mk.user_email.as_deref()).await?;
    write_config_local(runner, signing::KEY_FORMAT, mk.gpg_format.as_deref()).await?;
    write_config_local(runner, signing::KEY_SIGNING_KEY, mk.signing_key.as_deref()).await?;
    write_config_local(runner, signing::KEY_GPGSIGN, mk.commit_gpgsign.as_deref()).await?;
    write_config_local(runner, signing::KEY_ALLOWED_SIGNERS, mk.allowed_signers_file.as_deref()).await?;
    let ssh = mk.auth_ssh_key.as_ref().map(|p| synth_ssh_command(p));
    write_config_local(runner, KEY_SSH_COMMAND, ssh.as_deref()).await?;
    Ok(())
}

/// Labeled (git key, local, profile) tuples for diffing/display, in a stable order.
fn diff_keys(local: &ManagedKeys, proj: &ManagedKeys) -> Vec<KeyDiff> {
    let pairs: [(&str, &Option<String>, &Option<String>); 7] = [
        (KEY_USER_NAME, &local.user_name, &proj.user_name),
        (KEY_USER_EMAIL, &local.user_email, &proj.user_email),
        (signing::KEY_FORMAT, &local.gpg_format, &proj.gpg_format),
        (signing::KEY_SIGNING_KEY, &local.signing_key, &proj.signing_key),
        (signing::KEY_GPGSIGN, &local.commit_gpgsign, &proj.commit_gpgsign),
        (signing::KEY_ALLOWED_SIGNERS, &local.allowed_signers_file, &proj.allowed_signers_file),
        (KEY_SSH_COMMAND, &local.auth_ssh_key, &proj.auth_ssh_key),
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
}

/// Compute the active/drift/unmanaged/inherit relationship (pure; unit-tested).
fn compute_match(
    local: &ManagedKeys,
    profiles: &[GitProfile],
    stored_id: Option<&str>,
) -> ProfileMatch {
    if is_all_unset(local) {
        return ProfileMatch::Inherit;
    }
    // Prefer the stored profile when it matches exactly.
    if let Some(sid) = stored_id {
        if let Some(p) = profiles.iter().find(|p| p.id == sid) {
            if projection(p) == *local {
                return ProfileMatch::Active { profile_id: sid.to_string() };
            }
        }
    }
    // Any profile matching exactly → active.
    if let Some(p) = profiles.iter().find(|p| projection(p) == *local) {
        return ProfileMatch::Active { profile_id: p.id.clone() };
    }
    // Stored id exists but config diverged → drift.
    if let Some(sid) = stored_id {
        if let Some(p) = profiles.iter().find(|p| p.id == sid) {
            return ProfileMatch::Drift {
                profile_id: sid.to_string(),
                diffs: diff_keys(local, &projection(p)),
            };
        }
    }
    ProfileMatch::Unmanaged
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
    runner: &GitRunner,
    stored_profile_id: Option<String>,
) -> ProfileStatus {
    let local = read_local_managed(runner).await;
    let profiles = state.global_settings.read().await.git_profiles_doc.profiles.clone();
    let r#match = compute_match(&local, &profiles, stored_profile_id.as_deref());
    ProfileStatus { local, stored_profile_id, r#match }
}

/// Persist the repo's `git_profile_id` and return the updated settings.
async fn set_repo_profile_id(
    state: &AppState,
    session: &crate::state::RepoSession,
    profile_id: Option<String>,
) -> Result<(), AppError> {
    let settings = {
        let mut s = session.settings.write().await;
        s.git_profile_id = profile_id;
        s.clone()
    };
    let (repo_dir, _) = state.repo_data_paths(&session.path);
    persist_repo_settings(&settings, &repo_dir, &session.settings_path, &session.path).await
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
    {
        let mut s = state.global_settings.write().await;
        s.git_profiles_doc.profiles.push(created.clone());
    }
    state.persist_global_settings().await?;
    Ok(created)
}

/// Replace an existing profile (matched by id).
#[tauri::command]
#[specta::specta]
pub async fn update_git_profile(
    state: tauri::State<'_, AppState>,
    profile: GitProfile,
) -> Result<(), AppError> {
    {
        let mut s = state.global_settings.write().await;
        let slot = s
            .git_profiles_doc
            .profiles
            .iter_mut()
            .find(|p| p.id == profile.id)
            .ok_or_else(|| AppError::UnknownProfile(profile.id.clone()))?;
        *slot = profile;
    }
    state.persist_global_settings().await
}

/// Delete a profile definition. Does NOT touch any repo's `.git/config`.
#[tauri::command]
#[specta::specta]
pub async fn delete_git_profile(
    state: tauri::State<'_, AppState>,
    profile_id: String,
) -> Result<(), AppError> {
    {
        let mut s = state.global_settings.write().await;
        s.git_profiles_doc.profiles.retain(|p| p.id != profile_id);
    }
    state.persist_global_settings().await
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
    Ok(status_for(&state, &runner, stored).await)
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
    let local = read_local_managed(&runner).await;
    Ok(diff_keys(&local, &projection(&profile)))
}

/// Apply a profile: write all 7 managed keys to local config and record the
/// selection. Returns the refreshed status (should be `Active`).
#[tauri::command]
#[specta::specta]
pub async fn apply_profile_to_repo(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    profile_id: String,
) -> Result<ProfileStatus, AppError> {
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
    write_managed(&runner, &projection(&profile)).await?;
    set_repo_profile_id(&state, &session, Some(profile_id)).await?;
    let stored = session.settings.read().await.git_profile_id.clone();
    Ok(status_for(&state, &runner, stored).await)
}

/// Clear the repo's profile: unset all 7 managed keys locally and drop the
/// stored selection (back to `Inherit`).
#[tauri::command]
#[specta::specta]
pub async fn clear_repo_profile(
    state: tauri::State<'_, AppState>,
    repo_id: String,
) -> Result<ProfileStatus, AppError> {
    let session = state.get_session(&repo_id).await?;
    let runner = session.runner.read().await.clone();
    write_managed(&runner, &ManagedKeys::all_unset()).await?;
    set_repo_profile_id(&state, &session, None).await?;
    Ok(status_for(&state, &runner, None).await)
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
    let local = read_local_managed(&runner).await;
    // Re-parse the raw command so we only capture an auth key that round-trips
    // cleanly (a custom, non-`ssh -i` command is dropped rather than stored).
    let ssh_raw = read_config_scope(&runner, KEY_SSH_COMMAND, &["--local"]).await.value;
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
    };
    {
        let mut s = state.global_settings.write().await;
        s.git_profiles_doc.profiles.push(profile.clone());
    }
    state.persist_global_settings().await?;
    set_repo_profile_id(&state, &session, Some(profile.id.clone())).await?;
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
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

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
        let p = r"C:\Users\simon\.ssh\id_ed25519";
        let cmd = synth_ssh_command(p);
        // Backslashes normalized to forward slashes.
        assert!(cmd.contains("C:/Users/simon/.ssh/id_ed25519"));
        assert_eq!(
            parse_ssh_key_from_command(&cmd).as_deref(),
            Some("C:/Users/simon/.ssh/id_ed25519")
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
    fn match_drift_when_stored_diverges() {
        let profiles = vec![signing_profile("p1", "work@x.com")];
        let local = email_only_local(Some("personal@y.com"));
        let m = compute_match(&local, &profiles, Some("p1"));
        match m {
            ProfileMatch::Drift { profile_id, diffs } => {
                assert_eq!(profile_id, "p1");
                assert_eq!(diffs.len(), 1);
                assert_eq!(diffs[0].key, KEY_USER_EMAIL);
                assert_eq!(diffs[0].local.as_deref(), Some("personal@y.com"));
                assert_eq!(diffs[0].profile.as_deref(), Some("work@x.com"));
            }
            other => panic!("expected drift, got {other:?}"),
        }
    }

    #[test]
    fn match_unmanaged_when_no_profile_and_no_stored() {
        let profiles = vec![signing_profile("p1", "work@x.com")];
        let local = email_only_local(Some("nobody@z.com"));
        let m = compute_match(&local, &profiles, None);
        assert!(matches!(m, ProfileMatch::Unmanaged));
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
    fn match_stale_stored_id_falls_back() {
        // Stored id references a deleted profile; local matches no profile.
        let profiles = vec![signing_profile("p1", "work@x.com")];
        let local = email_only_local(Some("orphan@z.com"));
        let m = compute_match(&local, &profiles, Some("deleted-id"));
        assert!(matches!(m, ProfileMatch::Unmanaged));
    }
}
