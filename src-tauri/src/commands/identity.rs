//! Global git identity (`user.name` / `user.email`) as a direct mirror of the
//! config keys, backing Global Settings' "Global identity" section.
//!
//! Deliberately edit-only and identity-only (design/2026-07-13-global-default-
//! profile.md): profiles are never applied at global scope, so a machine-wide
//! `credential.helper` / `core.sshCommand` cannot be set from LeGit at all.
//! Signing has its own global section (`commands/signing.rs`); repos override
//! this identity by applying a profile, and reset to it by clearing one.

use crate::commands::config_util::{read_config_global_scopes, write_config_global, ConfigValue};
use crate::error::AppError;
use crate::state::AppState;
use legit_core::{GitExecutor, GitRunner};
use serde::{Deserialize, Serialize};
use specta::Type;

const KEY_USER_NAME: &str = "user.name";
const KEY_USER_EMAIL: &str = "user.email";

/// `user.name` / `user.email` at global and system scope, plus the value git
/// resolves outside any repo (global > system). No local scope: this backs a
/// global-settings editor, which exists independently of any open repo.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct IdentityView {
    pub name_global: ConfigValue,
    pub name_system: ConfigValue,
    pub name_resolved: ConfigValue,
    pub email_global: ConfigValue,
    pub email_system: ConfigValue,
    pub email_resolved: ConfigValue,
}

async fn build_global_view(runner: &dyn GitExecutor) -> IdentityView {
    // Global + system only: the unbound runner's cwd may lie inside some
    // repo, so an all-scopes read would leak that repo's local config here
    // (see `read_config_global_scopes`).
    let name = read_config_global_scopes(runner, KEY_USER_NAME).await;
    let email = read_config_global_scopes(runner, KEY_USER_EMAIL).await;
    IdentityView {
        name_global: name.global,
        name_system: name.system,
        name_resolved: name.resolved,
        email_global: email.global,
        email_system: email.system,
        email_resolved: email.resolved,
    }
}

/// Read the global identity (no repo required).
#[tauri::command]
#[specta::specta]
pub async fn global_identity_view(
    state: tauri::State<'_, AppState>,
) -> Result<IdentityView, AppError> {
    let git_path = state.git_path.read().await.clone();
    let runner = GitRunner::unbound(&git_path);
    Ok(build_global_view(&runner).await)
}

/// Write `user.name` / `user.email` to `~/.gitconfig`. `None` means unset.
/// Returns the refreshed view. (Exit-code assumptions of the global write
/// path are validated against the real binary in
/// legit-core/tests/git_flows.rs.)
#[tauri::command]
#[specta::specta]
pub async fn global_write_identity(
    state: tauri::State<'_, AppState>,
    name: Option<String>,
    email: Option<String>,
) -> Result<IdentityView, AppError> {
    let git_path = state.git_path.read().await.clone();
    let runner = GitRunner::unbound(&git_path);
    write_config_global(&runner, KEY_USER_NAME, name.as_deref()).await?;
    write_config_global(&runner, KEY_USER_EMAIL, email.as_deref()).await?;
    Ok(build_global_view(&runner).await)
}
