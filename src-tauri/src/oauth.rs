//! OAuth access-token lifecycle for connected accounts.
//!
//! Device-flow tokens can expire (GitLab: 2 hours, rotating single-use
//! refresh token; GitHub: only when the app enables expiration). The access
//! token lives in the broker's keychain entry (`https://<host>`) like any
//! remembered password; the refresh token and expiry live in a sidecar
//! keychain entry under the same service, so settings files keep holding no
//! secrets and non-expiring tokens (PATs, current GitHub) have no sidecar at
//! all.
//!
//! `ensure_fresh` is the one entry point, called before both token uses: the
//! platform API calls (`accounts::read_platform_token`) and the credential
//! broker's `get` (git over HTTPS). Refreshes are serialized by a global
//! lock and re-checked under it - the refresh token is SINGLE-USE on GitLab,
//! so two concurrent refreshes would race the rotation: the loser's grant is
//! then invalid, which the platform treats as token theft and may answer by
//! revoking the whole token family.

use serde::{Deserialize, Serialize};

use crate::credentials::{
    forget_session, keychain_delete, keychain_read_secret, keychain_store, keychain_store_secret,
};
use legit_providers::{Platform, ProviderError, TokenSet};

/// Refresh this long before the nominal expiry, so a token never dies
/// mid-operation (a push that starts at second 7199 of 7200).
const REFRESH_MARGIN_SECS: u64 = 120;

/// Sidecar entry beside the broker key: `oauth-refresh:https://<host>`.
fn refresh_entry_key(broker_key: &str) -> String {
    format!("oauth-refresh:{broker_key}")
}

/// The persisted refresh state of one account. `username` duplicates the
/// broker entry's username so the access entry can be RECREATED after git
/// erased it (git erases rejected credentials, and an expired token gets
/// rejected).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RefreshRecord {
    pub platform: String,
    pub username: String,
    pub refresh_token: String,
    /// Unix epoch seconds.
    pub expires_at: u64,
}

fn now_epoch_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Whether the access token behind `expires_at` must be refreshed now.
fn needs_refresh(now: u64, expires_at: u64) -> bool {
    now + REFRESH_MARGIN_SECS >= expires_at
}

/// The record a fresh token set persists: `None` when the set carries no
/// refresh token (nothing will ever need refreshing).
fn record_for(
    platform: Platform,
    username: &str,
    tokens: &TokenSet,
    now: u64,
) -> Option<RefreshRecord> {
    let refresh_token = tokens.refresh_token.clone()?;
    Some(RefreshRecord {
        platform: platform.id().to_string(),
        username: username.to_string(),
        refresh_token,
        // A refresh token without a lifetime is treated as already due: the
        // next use refreshes once and learns the real expiry from the answer.
        expires_at: now + tokens.expires_in_secs.unwrap_or(0),
    })
}

fn load_record(broker_key: &str) -> Option<RefreshRecord> {
    let secret = keychain_read_secret(&refresh_entry_key(broker_key))?;
    serde_json::from_str(&secret).ok()
}

fn save_record(broker_key: &str, record: &RefreshRecord) -> Result<(), String> {
    let secret = serde_json::to_string(record).map_err(|e| e.to_string())?;
    keychain_store_secret(&refresh_entry_key(broker_key), &secret).map_err(|e| e.to_string())
}

/// Persist both halves of a token set: the access token into the broker
/// entry, the refresh state into the sidecar (removed when the set carries
/// none, so a reconnect with a non-expiring token leaves no stale sidecar).
/// Blocking (keyring): call from `spawn_blocking`.
pub fn store_token_set(
    broker_key: &str,
    platform: Platform,
    username: &str,
    tokens: &TokenSet,
) -> Result<(), String> {
    keychain_store(broker_key, username, &tokens.access_token).map_err(|e| e.to_string())?;
    match record_for(platform, username, tokens, now_epoch_secs()) {
        Some(record) => save_record(broker_key, &record)?,
        None => clear_refresh(broker_key),
    }
    Ok(())
}

/// Drop the sidecar entry (disconnect/remove, or a dead refresh token).
/// Blocking (keyring): call from `spawn_blocking`.
pub fn clear_refresh(broker_key: &str) {
    let _ = keychain_delete(&refresh_entry_key(broker_key));
}

/// Serializes refreshes (see the module doc on single-use refresh tokens).
/// One global lock instead of per-key: refreshes are rare (hours apart) and
/// never long (one HTTPS round trip), so cross-account contention is noise.
static REFRESH_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Make sure the access token stored under `broker_key` is not (about to be)
/// expired: when a due refresh record exists, exchange it and re-store both
/// entries. Best-effort by design - on failure the stale token stays and the
/// following use fails with the platform's own auth error, which the callers
/// already classify ("reconnect"); only a dead refresh token (invalid_grant)
/// also drops the sidecar so the account stops re-trying a hopeless grant.
pub async fn ensure_fresh(broker_key: &str) {
    let probe_key = broker_key.to_string();
    let record = tauri::async_runtime::spawn_blocking(move || load_record(&probe_key))
        .await
        .ok()
        .flatten();
    let Some(record) = record else { return };
    if !needs_refresh(now_epoch_secs(), record.expires_at) {
        return;
    }

    let _serial = REFRESH_LOCK.lock().await;
    // Re-load under the lock: a concurrent caller may have rotated the
    // refresh token while this one waited.
    let probe_key = broker_key.to_string();
    let record = tauri::async_runtime::spawn_blocking(move || load_record(&probe_key))
        .await
        .ok()
        .flatten();
    let Some(record) = record else { return };
    if !needs_refresh(now_epoch_secs(), record.expires_at) {
        return;
    }
    let Some(platform) = Platform::from_id(&record.platform) else {
        return;
    };

    match legit_providers::refresh_oauth_token(platform, &record.refresh_token).await {
        Ok(tokens) => {
            let key = broker_key.to_string();
            let stored = tauri::async_runtime::spawn_blocking(move || {
                store_token_set(&key, platform, &record.username, &tokens)
            })
            .await;
            match stored {
                Ok(Ok(())) => {
                    // The broker's session cache may hold the old token.
                    forget_session(broker_key);
                    tracing::info!(host = broker_key, "refreshed the OAuth access token");
                }
                Ok(Err(e)) => {
                    tracing::warn!(host = broker_key, err = %e, "refreshed token could not be stored");
                }
                Err(e) => {
                    tracing::warn!(host = broker_key, err = %e, "keychain task failed storing the refreshed token");
                }
            }
        }
        Err(ProviderError::Auth(e)) => {
            // The refresh token itself is dead: stop re-trying it. The stale
            // access token stays; its next rejection surfaces the reconnect
            // message through the normal classification.
            tracing::warn!(host = broker_key, err = %e, "OAuth refresh token rejected");
            let key = broker_key.to_string();
            let _ = tauri::async_runtime::spawn_blocking(move || clear_refresh(&key)).await;
        }
        Err(e) => {
            // Offline/transient: keep everything and let the caller's own
            // request fail (or succeed, if the platform is lenient).
            tracing::debug!(host = broker_key, err = %e, "OAuth token refresh failed");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refresh_is_due_only_inside_the_margin() {
        assert!(!needs_refresh(1_000, 2_000));
        assert!(needs_refresh(1_000, 1_000 + REFRESH_MARGIN_SECS));
        assert!(needs_refresh(1_000, 1_050));
        assert!(needs_refresh(2_000, 1_000)); // long expired
    }

    #[test]
    fn record_mirrors_the_token_set_and_skips_non_expiring_tokens() {
        let set = TokenSet {
            access_token: "a".into(),
            refresh_token: Some("r".into()),
            expires_in_secs: Some(7200),
        };
        let rec = record_for(Platform::GitLab, "oauth2", &set, 1_000).unwrap();
        assert_eq!(rec.platform, "gitlab");
        assert_eq!(rec.username, "oauth2");
        assert_eq!(rec.refresh_token, "r");
        assert_eq!(rec.expires_at, 8_200);
        // No refresh token = nothing to persist (PATs, non-expiring GitHub).
        let set = TokenSet { access_token: "a".into(), refresh_token: None, expires_in_secs: None };
        assert!(record_for(Platform::GitHub, "simon", &set, 1_000).is_none());
        // A refresh token without a lifetime counts as immediately due.
        let set = TokenSet {
            access_token: "a".into(),
            refresh_token: Some("r".into()),
            expires_in_secs: None,
        };
        assert_eq!(record_for(Platform::GitLab, "oauth2", &set, 1_000).unwrap().expires_at, 1_000);
    }

    #[test]
    fn record_round_trips_through_its_keychain_json() {
        let rec = RefreshRecord {
            platform: "gitlab".into(),
            username: "oauth2".into(),
            refresh_token: "glrt-x".into(),
            expires_at: 42,
        };
        let json = serde_json::to_string(&rec).unwrap();
        assert_eq!(serde_json::from_str::<RefreshRecord>(&json).unwrap(), rec);
    }

    #[test]
    fn sidecar_key_is_namespaced_beside_the_broker_key() {
        assert_eq!(refresh_entry_key("https://gitlab.com"), "oauth-refresh:https://gitlab.com");
    }
}
