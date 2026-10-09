//! Connected platform accounts (BACKLOG "Platform integrations", phase 2;
//! scoped to GitHub / GitLab / Azure DevOps).
//!
//! Two connect paths obtain a token: the OAuth device flow where a client ID
//! is registered (GitHub - see `Platform::device_flow_client_id`), and a
//! user-created PAT as the universal fallback. From there both converge
//! (`store_connected_token`): the token is validated against the platform
//! API ("who am I"), then stored in the OS keychain under the credential
//! broker's `https://<host>` key: so `git credential fill` answers HTTPS
//! pushes/pulls with it immediately, and LeGit's settings files hold
//! METADATA ONLY (platform, host, username), never a secret. Disconnecting
//! deletes the keychain entry (which is the same slot a broker-remembered
//! password would use: by design, one secret per host).

use crate::error::AppError;
use crate::state::{AppState, CachedPlatformKey, ConnectedAccountMeta, PlatformKeyCache};
use legit_providers::{Platform, ProviderError};

/// The platform's PAT-creation page; GitHub/GitLab prefill the scopes the
/// integration needs (git over HTTPS + SSH-key upload). Fixed map: the
/// frontend passes an id, never a URL.
fn platform_token_url(platform: &str) -> Option<&'static str> {
    match platform {
        "github" => Some(
            "https://github.com/settings/tokens/new?description=LeGit&scopes=repo,admin:public_key,admin:ssh_signing_key",
        ),
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

/// Validate a token, store it in the OS keychain under the broker's key, and
/// record the account metadata: the shared tail of the PAT and OAuth connect
/// paths.
async fn store_connected_token(
    state: &tauri::State<'_, AppState>,
    p: Platform,
    token: String,
) -> Result<ConnectedAccountMeta, AppError> {
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

/// Connect with a user-created PAT.
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
    store_connected_token(&state, p, token).await
}

/// Device-flow start data for the connect UI. `device_code` is the opaque
/// polling handle (held only by the frontend for the flow's lifetime);
/// `user_code` is what the user enters on the verification page.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, specta::Type)]
pub struct DeviceFlowStart {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub interval_secs: u32,
    pub expires_in_secs: u32,
}

/// One device-flow poll, as data: only `kind: "connected"` ends the flow
/// successfully; `pending`/`slow_down` mean keep polling (slow_down = add 5s
/// to the interval); `denied`/`expired` are terminal.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DeviceFlowPollResult {
    Pending,
    SlowDown,
    Denied,
    Expired,
    Connected { account: ConnectedAccountMeta },
}

/// Platforms with a registered OAuth app, i.e. where the device-flow connect
/// is offered (drives which platforms get a "Connect" button vs PAT-only).
#[tauri::command]
#[specta::specta]
pub async fn list_device_flow_platforms() -> Result<Vec<String>, AppError> {
    Ok([Platform::GitHub, Platform::GitLab, Platform::AzureDevOps]
        .into_iter()
        .filter(|p| p.device_flow_client_id().is_some())
        .map(|p| p.id().to_string())
        .collect())
}

/// Start the OAuth device flow and open the verification page in the
/// browser; the frontend shows the user code and polls to completion.
#[tauri::command]
#[specta::specta]
pub async fn connect_account_oauth_start(platform: String) -> Result<DeviceFlowStart, AppError> {
    let p = provider(&platform)?;
    let auth = legit_providers::device_flow_start(p).await.map_err(provider_err)?;
    crate::commands::browser::open_url(&auth.verification_uri)?;
    Ok(DeviceFlowStart {
        device_code: auth.device_code,
        user_code: auth.user_code,
        verification_uri: auth.verification_uri,
        interval_secs: auth.interval_secs as u32,
        expires_in_secs: auth.expires_in_secs as u32,
    })
}

/// One device-flow token poll; on success the token is stored exactly like a
/// connected PAT.
#[tauri::command]
#[specta::specta]
pub async fn connect_account_oauth_poll(
    state: tauri::State<'_, AppState>,
    platform: String,
    device_code: String,
) -> Result<DeviceFlowPollResult, AppError> {
    use legit_providers::DevicePollOutcome;
    let p = provider(&platform)?;
    let outcome =
        legit_providers::device_flow_poll(p, &device_code).await.map_err(provider_err)?;
    Ok(match outcome {
        DevicePollOutcome::Pending => DeviceFlowPollResult::Pending,
        DevicePollOutcome::SlowDown => DeviceFlowPollResult::SlowDown,
        DevicePollOutcome::Denied => DeviceFlowPollResult::Denied,
        DevicePollOutcome::Expired => DeviceFlowPollResult::Expired,
        DevicePollOutcome::AccessToken(token) => DeviceFlowPollResult::Connected {
            account: store_connected_token(&state, p, token).await?,
        },
    })
}

async fn delete_platform_token(p: Platform) -> Result<(), AppError> {
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
    Ok(())
}

/// Disconnect the account: delete the keychain token but KEEP the account
/// metadata and the cached key list, so the matrix can keep showing the
/// last-verified state ("as of last check") until the user reconnects or
/// removes the entry.
#[tauri::command]
#[specta::specta]
pub async fn disconnect_account(platform: String) -> Result<(), AppError> {
    let p = provider(&platform)?;
    delete_platform_token(p).await
}

/// Forget the account entirely: token, metadata, and the cached key list.
/// Registered keys on the PLATFORM are never touched - revoking is a
/// separate per-key action.
#[tauri::command]
#[specta::specta]
pub async fn remove_account(
    state: tauri::State<'_, AppState>,
    platform: String,
) -> Result<(), AppError> {
    let p = provider(&platform)?;
    delete_platform_token(p).await?;
    state
        .mutate_global(move |s| {
            s.connected_accounts.retain(|a| a.platform != platform);
            s.platform_key_cache.remove(p.id());
        })
        .await
}

/// What an SSH-key upload achieved: a key that is already on the connected
/// account is the goal state, so it crosses as data, not as an error.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SshKeyUploadResult {
    Added,
    AlreadyPresent,
}

/// Add an SSH public key to the connected account (GitHub/GitLab; ADO has no
/// SSH-key API and reports that as an error message).
#[tauri::command]
#[specta::specta]
pub async fn upload_ssh_key_to_platform(
    platform: String,
    title: String,
    public_key: String,
) -> Result<SshKeyUploadResult, AppError> {
    add_key_with_usage(&platform, &title, &public_key, legit_providers::KeyUsage::Auth).await
}

/// Register an SSH public key as a SIGNING key on the connected account
/// (what makes commits signed with it show as Verified on the forge).
#[tauri::command]
#[specta::specta]
pub async fn upload_ssh_signing_key_to_platform(
    platform: String,
    title: String,
    public_key: String,
) -> Result<SshKeyUploadResult, AppError> {
    add_key_with_usage(&platform, &title, &public_key, legit_providers::KeyUsage::Signing).await
}

async fn add_key_with_usage(
    platform: &str,
    title: &str,
    public_key: &str,
    usage: legit_providers::KeyUsage,
) -> Result<SshKeyUploadResult, AppError> {
    let p = provider(platform)?;
    let token = read_platform_token(p).await?;
    match legit_providers::add_ssh_key(p, &token, title, public_key, usage)
        .await
        .map_err(provider_err)?
    {
        legit_providers::AddSshKeyOutcome::Added => Ok(SshKeyUploadResult::Added),
        legit_providers::AddSshKeyOutcome::AlreadyPresent => Ok(SshKeyUploadResult::AlreadyPresent),
    }
}

/// The connected account's token from the keychain.
async fn read_platform_token(p: Platform) -> Result<String, AppError> {
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
    Ok(stored.1)
}

/// The account's registered SSH keys for the Connected accounts matrix.
/// `live` = fetched from the platform just now; otherwise the keys are the
/// cached last-verified state (`checked_at` says when), served while the
/// account is disconnected or the platform is unreachable.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, specta::Type)]
pub struct PlatformKeysView {
    pub keys: Vec<CachedPlatformKey>,
    /// Registered SIGNING keys; `None` = unknown (the token lacks the
    /// signing scope: reconnecting grants it).
    pub signing_keys: Option<Vec<CachedPlatformKey>>,
    pub live: bool,
    /// RFC 3339; only meaningful when `live` is false.
    pub checked_at: Option<String>,
}

fn to_cached(keys: Vec<legit_providers::RegisteredSshKey>) -> Vec<CachedPlatformKey> {
    keys.into_iter().map(|k| CachedPlatformKey { id: k.id.to_string(), key: k.key }).collect()
}

async fn fetch_and_cache_keys(
    state: &tauri::State<'_, AppState>,
    p: Platform,
) -> Result<(Vec<CachedPlatformKey>, Option<Vec<CachedPlatformKey>>), AppError> {
    use legit_providers::KeyUsage;
    let token = read_platform_token(p).await?;
    let keys = to_cached(
        legit_providers::list_registered_ssh_keys(p, &token, KeyUsage::Auth)
            .await
            .map_err(provider_err)?,
    );
    // The auth list is required; the signing list degrades to "unknown" (an
    // older token without the signing scope must not break the matrix).
    let signing_keys = legit_providers::list_registered_ssh_keys(p, &token, KeyUsage::Signing)
        .await
        .ok()
        .map(to_cached);
    let entry = PlatformKeyCache {
        keys: keys.clone(),
        signing_keys: signing_keys.clone(),
        checked_at: chrono::Utc::now().to_rfc3339(),
    };
    let platform_id = p.id().to_string();
    state
        .mutate_global(move |s| {
            s.platform_key_cache.insert(platform_id, entry);
        })
        .await?;
    Ok((keys, signing_keys))
}

/// The SSH public keys registered on the connected account - drives the
/// per-identity "connected" state in the Connected accounts section
/// (GitHub/GitLab; ADO has no SSH-key API). A live fetch updates the cache;
/// when the account has no token (disconnected) or the fetch fails, the
/// cached last-verified state answers instead.
#[tauri::command]
#[specta::specta]
pub async fn platform_registered_keys(
    state: tauri::State<'_, AppState>,
    platform: String,
) -> Result<PlatformKeysView, AppError> {
    let p = provider(&platform)?;
    match fetch_and_cache_keys(&state, p).await {
        Ok((keys, signing_keys)) => {
            Ok(PlatformKeysView { keys, signing_keys, live: true, checked_at: None })
        }
        Err(fetch_err) => {
            let cached = state.global_settings.read().await.platform_key_cache.get(p.id()).cloned();
            match cached {
                Some(c) => Ok(PlatformKeysView {
                    keys: c.keys,
                    signing_keys: c.signing_keys,
                    live: false,
                    checked_at: Some(c.checked_at),
                }),
                None => Err(fetch_err),
            }
        }
    }
}

async fn revoke_key_with_usage(
    state: &tauri::State<'_, AppState>,
    platform: &str,
    key_id: &str,
    usage: legit_providers::KeyUsage,
) -> Result<PlatformKeysView, AppError> {
    let p = provider(platform)?;
    let id: u64 =
        key_id.parse().map_err(|_| AppError::Io(format!("invalid key id {key_id:?}")))?;
    let token = read_platform_token(p).await?;
    legit_providers::delete_ssh_key(p, &token, id, usage).await.map_err(provider_err)?;
    let (keys, signing_keys) = fetch_and_cache_keys(state, p).await?;
    Ok(PlatformKeysView { keys, signing_keys, live: true, checked_at: None })
}

/// Remove a registered authentication key from the connected account, then
/// return the refreshed (live) key lists.
#[tauri::command]
#[specta::specta]
pub async fn revoke_platform_key(
    state: tauri::State<'_, AppState>,
    platform: String,
    key_id: String,
) -> Result<PlatformKeysView, AppError> {
    revoke_key_with_usage(&state, &platform, &key_id, legit_providers::KeyUsage::Auth).await
}

/// Remove a registered SIGNING key from the connected account, then return
/// the refreshed (live) key lists.
#[tauri::command]
#[specta::specta]
pub async fn revoke_platform_signing_key(
    state: tauri::State<'_, AppState>,
    platform: String,
    key_id: String,
) -> Result<PlatformKeysView, AppError> {
    revoke_key_with_usage(&state, &platform, &key_id, legit_providers::KeyUsage::Signing).await
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
