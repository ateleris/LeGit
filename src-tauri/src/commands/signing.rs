//! Commit-signing config commands.
//!
//! LeGit's signing panel is a direct mirror of the relevant `git config`
//! keys at the requested scope — there is no LeGit-side persistent state.
//! SSH signing is the priority path, so `gpg.ssh.allowedSignersFile` (needed
//! for SSH signatures to verify as trusted) is surfaced alongside the core
//! keys. All reads/writes go through `GitRunner`; system scope is read-only.

use crate::commands::config_util::{
    read_config_all_scopes, write_config_global, write_config_local, ScopedConfig,
};
use crate::error::AppError;
use crate::state::AppState;
use legit_core::GitRunner;
use serde::{Deserialize, Serialize};
use specta::Type;

pub(crate) const KEY_GPGSIGN: &str = "commit.gpgsign";
pub(crate) const KEY_FORMAT: &str = "gpg.format";
pub(crate) const KEY_SIGNING_KEY: &str = "user.signingkey";
pub(crate) const KEY_ALLOWED_SIGNERS: &str = "gpg.ssh.allowedSignersFile";

/// All signing-relevant config keys, each resolved across scopes.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct SigningView {
    /// `commit.gpgsign` — whether commits are signed by default.
    pub gpgsign: ScopedConfig,
    /// `gpg.format` — `openpgp` (default), `ssh`, or `x509`.
    pub format: ScopedConfig,
    /// `user.signingkey` — key id (GPG) or key path / literal key (SSH).
    pub signing_key: ScopedConfig,
    /// `gpg.ssh.allowedSignersFile` — required for SSH signatures to verify
    /// as trusted rather than merely valid.
    pub allowed_signers: ScopedConfig,
}

async fn read_signing_view(runner: &GitRunner) -> SigningView {
    SigningView {
        gpgsign: read_config_all_scopes(runner, KEY_GPGSIGN).await.into(),
        format: read_config_all_scopes(runner, KEY_FORMAT).await.into(),
        signing_key: read_config_all_scopes(runner, KEY_SIGNING_KEY).await.into(),
        allowed_signers: read_config_all_scopes(runner, KEY_ALLOWED_SIGNERS).await.into(),
    }
}

/// Read signing config for the active repo (resolved across local/global/system).
#[tauri::command]
#[specta::specta]
pub async fn repo_signing_config(
    state: tauri::State<'_, AppState>,
    repo_id: String,
) -> Result<SigningView, AppError> {
    let session = state.get_session(&repo_id).await?;
    let runner = session.runner.read().await.clone();
    Ok(read_signing_view(&runner).await)
}

/// Read signing config at global scope (no repo required).
#[tauri::command]
#[specta::specta]
pub async fn global_signing_config(
    state: tauri::State<'_, AppState>,
) -> Result<SigningView, AppError> {
    let git_path = state.git_path.read().await.clone();
    let runner = GitRunner::unbound(&git_path);
    Ok(read_signing_view(&runner).await)
}

/// Write signing config to the repo's `.git/config`. `None` for a field unsets
/// the key at local scope. Returns the refreshed view.
#[tauri::command]
#[specta::specta]
pub async fn repo_write_signing(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    gpgsign: Option<String>,
    format: Option<String>,
    signing_key: Option<String>,
    allowed_signers: Option<String>,
) -> Result<SigningView, AppError> {
    let session = state.get_session(&repo_id).await?;
    let runner = session.runner.read().await.clone();
    write_config_local(&runner, KEY_GPGSIGN, gpgsign.as_deref()).await?;
    write_config_local(&runner, KEY_FORMAT, format.as_deref()).await?;
    write_config_local(&runner, KEY_SIGNING_KEY, signing_key.as_deref()).await?;
    write_config_local(&runner, KEY_ALLOWED_SIGNERS, allowed_signers.as_deref()).await?;
    Ok(read_signing_view(&runner).await)
}

/// Write signing config to `~/.gitconfig`. `None` for a field unsets the key.
/// Returns the refreshed view.
#[tauri::command]
#[specta::specta]
pub async fn global_write_signing(
    state: tauri::State<'_, AppState>,
    gpgsign: Option<String>,
    format: Option<String>,
    signing_key: Option<String>,
    allowed_signers: Option<String>,
) -> Result<SigningView, AppError> {
    let git_path = state.git_path.read().await.clone();
    let runner = GitRunner::unbound(&git_path);
    write_config_global(&runner, KEY_GPGSIGN, gpgsign.as_deref()).await?;
    write_config_global(&runner, KEY_FORMAT, format.as_deref()).await?;
    write_config_global(&runner, KEY_SIGNING_KEY, signing_key.as_deref()).await?;
    write_config_global(&runner, KEY_ALLOWED_SIGNERS, allowed_signers.as_deref()).await?;
    Ok(read_signing_view(&runner).await)
}
