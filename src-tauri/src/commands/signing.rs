//! Commit-signing config commands.
//!
//! LeGit's signing panel is a direct mirror of the relevant `git config`
//! keys at the requested scope — there is no LeGit-side persistent state.
//! SSH signing is the priority path, so `gpg.ssh.allowedSignersFile` (needed
//! for SSH signatures to verify as trusted) is surfaced alongside the core
//! keys. All reads/writes go through `GitRunner`; system scope is read-only.
//! Only the GLOBAL scope has commands here: repo-local signing config is
//! managed through git profiles (`profiles.rs` reuses the `KEY_*` constants).

use legit_core::config::{self, ScopedConfig, WriteScope};
use crate::commands::settings_host::{settings_executor, SettingsHost};
use crate::error::AppError;
use crate::state::AppState;
use legit_core::GitExecutor;
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

/// Global-settings variant: global + system scope only. The unbound runner's
/// cwd may lie inside some repo, and an all-scopes read would leak that
/// repo's local config into the view (see `read_config_global_scopes`).
pub(crate) async fn read_signing_view_global(runner: &dyn GitExecutor) -> SigningView {
    SigningView {
        gpgsign: config::read_global_scopes(runner, KEY_GPGSIGN).await,
        format: config::read_global_scopes(runner, KEY_FORMAT).await,
        signing_key: config::read_global_scopes(runner, KEY_SIGNING_KEY).await,
        allowed_signers: config::read_global_scopes(runner, KEY_ALLOWED_SIGNERS).await,
    }
}

/// Write signing config to the host's global git config. `None` for a field
/// unsets the key. Returns the refreshed view.
pub(crate) async fn write_signing_global(
    runner: &dyn GitExecutor,
    gpgsign: Option<&str>,
    format: Option<&str>,
    signing_key: Option<&str>,
    allowed_signers: Option<&str>,
) -> Result<SigningView, AppError> {
    config::write(runner, WriteScope::Global, KEY_GPGSIGN, gpgsign).await?;
    config::write(runner, WriteScope::Global, KEY_FORMAT, format).await?;
    config::write(runner, WriteScope::Global, KEY_SIGNING_KEY, signing_key).await?;
    config::write(runner, WriteScope::Global, KEY_ALLOWED_SIGNERS, allowed_signers).await?;
    Ok(read_signing_view_global(runner).await)
}

/// Read the app machine's signing config at global scope (no repo required).
#[tauri::command]
#[specta::specta]
pub async fn global_signing_config(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<SigningView, AppError> {
    let runner = settings_executor(&app, &state, &SettingsHost::Local).await?;
    Ok(read_signing_view_global(runner.as_ref()).await)
}

/// Write signing config to the app machine's `~/.gitconfig`.
#[tauri::command]
#[specta::specta]
pub async fn global_write_signing(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    gpgsign: Option<String>,
    format: Option<String>,
    signing_key: Option<String>,
    allowed_signers: Option<String>,
) -> Result<SigningView, AppError> {
    let runner = settings_executor(&app, &state, &SettingsHost::Local).await?;
    write_signing_global(
        runner.as_ref(),
        gpgsign.as_deref(),
        format.as_deref(),
        signing_key.as_deref(),
        allowed_signers.as_deref(),
    )
    .await
}
