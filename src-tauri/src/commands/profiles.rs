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

use crate::commands::config_util::{read_config_scope, write_config_local};
use crate::commands::signing;
use crate::error::AppError;
use crate::state::{AppState, GitProfile};
use legit_core::{GitError, GitRunner};
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
async fn read_managed_scope(runner: &GitRunner, flag: &'static str) -> ManagedKeys {
    let at = |key: &'static str| async move {
        read_config_scope(runner, key, &[flag]).await.value
    };
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
        credential_helper: crate::commands::credential_helper::read_helper_at(runner, flag).await,
    }
}

async fn read_local_managed(runner: &GitRunner) -> ManagedKeys {
    read_managed_scope(runner, "--local").await
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
async fn write_credential_helper(runner: &GitRunner, value: Option<&str>) -> Result<(), AppError> {
    // Drop any existing local entries first (exit 5 = none set; fine).
    let unset = runner
        .run_expecting(&["config", "--local", "--unset-all", KEY_CREDENTIAL_HELPER], &[5])
        .await?;
    if !unset.success && unset.exit_code != Some(5) {
        return Err(AppError::Git(GitError::CommandFailed {
            exit_code: unset.exit_code.unwrap_or(-1),
            stderr: unset.stderr.trim().to_string(),
        }));
    }
    if let Some(v) = value {
        // Empty reset entry clears inherited helpers; then our helper.
        for arg in ["", v] {
            let out = runner
                .run(&["config", "--local", "--add", KEY_CREDENTIAL_HELPER, arg])
                .await?;
            if !out.success {
                return Err(AppError::Git(GitError::CommandFailed {
                    exit_code: out.exit_code.unwrap_or(-1),
                    stderr: out.stderr.trim().to_string(),
                }));
            }
        }
    }
    Ok(())
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
    write_credential_helper(runner, mk.credential_helper.as_deref()).await?;
    Ok(())
}

/// Write one managed key by its git key name. The value is the projected
/// form (key PATH for the auth key; synthesized into `core.sshCommand` here,
/// mirroring `write_managed`).
async fn write_one_managed(
    runner: &GitRunner,
    key: &str,
    value: Option<&str>,
) -> Result<(), AppError> {
    match key {
        KEY_SSH_COMMAND => {
            let ssh = value.map(synth_ssh_command);
            write_config_local(runner, KEY_SSH_COMMAND, ssh.as_deref()).await
        }
        KEY_CREDENTIAL_HELPER => write_credential_helper(runner, value).await,
        k => write_config_local(runner, k, value).await,
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
pub async fn apply_profile_core(
    state: &AppState,
    session: &crate::state::RepoSession,
    profile_id: &str,
) -> Result<(), AppError> {
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
    write_managed(&runner, &projection(&profile)).await?;
    set_repo_profile_id(state, session, Some(profile_id.to_string())).await?;
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
    {
        let mut s = session.settings.write().await;
        s.git_profile_id = profile_id;
    }
    state.persist_session_settings(session).await
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

/// Replace an existing profile (matched by id).
#[tauri::command]
#[specta::specta]
pub async fn update_git_profile(
    state: tauri::State<'_, AppState>,
    profile: GitProfile,
) -> Result<(), AppError> {
    // Not `mutate_global`: the unknown-profile early return must happen
    // BEFORE anything persists.
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
    Ok(status_for(&state, &runner, stored).await)
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
    let local = read_managed_scope(&runner, "--local").await;
    let global = read_managed_scope(&runner, "--global").await;
    let system = read_managed_scope(&runner, "--system").await;
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
    let local = read_local_managed(&runner).await;
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
) -> Result<ProfileStatus, AppError> {
    let session = state.get_session(&repo_id).await?;
    apply_profile_core(&state, &session, &profile_id).await?;
    let runner = session.runner.read().await.clone();
    let stored = session.settings.read().await.git_profile_id.clone();
    Ok(status_for(&state, &runner, stored).await)
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
    write_managed(&runner, &ManagedKeys::all_unset()).await?;
    set_repo_profile_id(&state, &session, None).await?;
    Ok(status_for(&state, &runner, None).await)
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
    let current = read_local_managed(&runner).await;
    for d in diff_keys(&current, &draft) {
        // KeyDiff's `profile` side carries the draft value here.
        write_one_managed(&runner, &d.key, d.profile.as_deref())
            .await
            .map_err(|e| note_failed_key(e, &d.key))?;
    }
    let stored = session.settings.read().await.git_profile_id.clone();
    Ok(status_for(&state, &runner, stored).await)
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
    // No scope flag: `git config --get` resolves across all scopes.
    Ok(ResolvedIdentity {
        user_name: read_config_scope(&runner, KEY_USER_NAME, &[]).await.value,
        user_email: read_config_scope(&runner, KEY_USER_EMAIL, &[]).await.value,
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
        credential_helper: local.credential_helper.clone(),
    };
    state.mutate_global(|s| {
        s.git_profiles_doc.profiles.push(profile.clone());
    })
    .await?;
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
}
