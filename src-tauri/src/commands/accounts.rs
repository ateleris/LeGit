//! Connected platform accounts, PAT-based (BACKLOG "Platform integrations",
//! phase 2; scoped to GitHub / GitLab / Azure DevOps).
//!
//! The token is validated against the platform API ("who am I"), then stored
//! in the OS keychain under the credential broker's `https://<host>` key: so
//! `git credential fill` answers HTTPS pushes/pulls with it immediately, and
//! LeGit's settings files hold METADATA ONLY (platform, host, username),
//! never a secret. Disconnecting deletes the keychain entry (which is the
//! same slot a broker-remembered password would use: by design, one secret
//! per host).
//!
//! OAuth device flows are the designed upgrade path but need registered app
//! client IDs; the PAT flow is the universal fallback that works today.

use crate::error::AppError;
use crate::state::{AppState, ConnectedAccountMeta};
use legit_providers::{Platform, ProviderError};

/// The platform's PAT-creation page; GitHub/GitLab prefill the scopes the
/// integration needs (git over HTTPS + SSH-key upload). Fixed map: the
/// frontend passes an id, never a URL.
fn platform_token_url(platform: &str) -> Option<&'static str> {
    match platform {
        "github" => {
            Some("https://github.com/settings/tokens/new?description=LeGit&scopes=repo,admin:public_key")
        }
        "gitlab" => {
            Some("https://gitlab.com/-/user_settings/personal_access_tokens?name=LeGit&scopes=api")
        }
        "azure_devops" => Some("https://dev.azure.com/_usersSettings/tokens"),
        _ => None,
    }
}

fn provider(platform: &str) -> Result<Platform, AppError> {
    Platform::from_id(platform)
        .ok_or_else(|| AppError::Io(format!("unknown platform {platform:?}")))
}

fn provider_err(e: ProviderError) -> AppError {
    AppError::Io(e.to_string())
}

fn broker_key(p: Platform) -> String {
    format!("https://{}", p.git_host())
}

/// A connected account plus whether its token is still in the keychain: a
/// revoked token gets erased by git (the shim honors `erase`), which leaves
/// the metadata behind: the UI flags that as "reconnect needed".
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, specta::Type)]
pub struct ConnectedAccountStatus {
    pub account: ConnectedAccountMeta,
    pub token_present: bool,
}

/// Connected accounts with live keychain presence (metadata from settings;
/// the tokens themselves stay in the keychain).
#[tauri::command]
#[specta::specta]
pub async fn list_connected_accounts(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<ConnectedAccountStatus>, AppError> {
    let metas = state.global_settings.read().await.connected_accounts.clone();
    tauri::async_runtime::spawn_blocking(move || {
        metas
            .into_iter()
            .map(|account| {
                let key = format!("https://{}", account.host);
                let token_present = crate::credentials::keychain_read(&key).is_some();
                ConnectedAccountStatus { account, token_present }
            })
            .collect()
    })
    .await
    .map_err(|e| AppError::Io(format!("keychain task failed: {e}")))
}

/// Validate a PAT against the platform, store it in the OS keychain under
/// the broker's key, and record the account metadata.
#[tauri::command]
#[specta::specta]
pub async fn connect_account_pat(
    state: tauri::State<'_, AppState>,
    platform: String,
    token: String,
) -> Result<ConnectedAccountMeta, AppError> {
    let p = provider(&platform)?;
    let token = token.trim().to_string();
    if token.is_empty() {
        return Err(AppError::Io("the token is empty".to_string()));
    }
    let info = legit_providers::validate_token(p, &token).await.map_err(provider_err)?;

    let key = broker_key(p);
    let username = info.username.clone();
    {
        let key = key.clone();
        tauri::async_runtime::spawn_blocking(move || {
            crate::credentials::keychain_store(&key, &username, &token)
        })
        .await
        .map_err(|e| AppError::Io(format!("keychain task failed: {e}")))?
        .map_err(|e| AppError::Io(format!("cannot store the token in the OS keychain: {e}")))?;
    }
    // The broker consults its session cache BEFORE the keychain: evict any
    // cached credential for this host so the new token is used immediately.
    crate::credentials::forget_session(&key);

    let meta = ConnectedAccountMeta {
        platform: p.id().to_string(),
        host: p.git_host().to_string(),
        username: info.username,
        display_name: info.display_name,
    };
    let stored = meta.clone();
    state
        .mutate_global(move |s| {
            s.connected_accounts.retain(|a| a.platform != stored.platform);
            s.connected_accounts.push(stored.clone());
        })
        .await?;
    Ok(meta)
}

/// Remove the account: delete the keychain entry and the metadata.
#[tauri::command]
#[specta::specta]
pub async fn disconnect_account(
    state: tauri::State<'_, AppState>,
    platform: String,
) -> Result<(), AppError> {
    let p = provider(&platform)?;
    let key = broker_key(p);
    let deleted = {
        let key = key.clone();
        tauri::async_runtime::spawn_blocking(move || crate::credentials::keychain_delete(&key))
            .await
            .map_err(|e| AppError::Io(format!("keychain task failed: {e}")))?
    };
    match deleted {
        Ok(()) | Err(keyring::Error::NoEntry) => {}
        Err(e) => return Err(AppError::Io(format!("cannot remove the keychain entry: {e}"))),
    }
    crate::credentials::forget_session(&key);
    state
        .mutate_global(move |s| s.connected_accounts.retain(|a| a.platform != platform))
        .await
}

/// Add an SSH public key to the connected account (GitHub/GitLab; ADO has no
/// SSH-key API and reports that as an error message).
#[tauri::command]
#[specta::specta]
pub async fn upload_ssh_key_to_platform(
    platform: String,
    title: String,
    public_key: String,
) -> Result<(), AppError> {
    let p = provider(&platform)?;
    let key = broker_key(p);
    let stored =
        tauri::async_runtime::spawn_blocking(move || crate::credentials::keychain_read(&key))
            .await
            .map_err(|e| AppError::Io(format!("keychain task failed: {e}")))?
            .ok_or_else(|| {
                AppError::Io(format!(
                    "no {} account is connected (Global Settings, Connected accounts)",
                    p.label()
                ))
            })?;
    legit_providers::add_ssh_key(p, &stored.1, &title, &public_key)
        .await
        .map_err(provider_err)
}

/// Open the platform's PAT-creation page in the browser.
#[tauri::command]
#[specta::specta]
pub async fn open_platform_token_settings(platform: String) -> Result<(), AppError> {
    let url = platform_token_url(&platform)
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
    fn token_settings_urls_known_and_unknown() {
        // Each URL must point at the platform's PAT-creation page; GitHub and
        // GitLab prefill the scopes the integration needs.
        assert!(platform_token_url("github").unwrap().contains("admin:public_key"));
        assert!(platform_token_url("gitlab").unwrap().contains("scopes=api"));
        assert!(platform_token_url("azure_devops").unwrap().contains("_usersSettings/tokens"));
        assert_eq!(platform_token_url("bitbucket"), None);
    }
}
