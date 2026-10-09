//! Platform API integrations (GitHub / GitLab / Azure DevOps), SSH-first
//! (BACKLOG.md "Platform integrations", phase 2).
//!
//! Scope: account validation ("who am I"), the OAuth device flow where an
//! app client ID is registered (GitHub), and SSH public-key upload where the
//! platform has an API for it. Tokens are NEVER stored by this crate: the
//! app keeps them in the OS keychain (broker format) and passes them per
//! call.

use serde::Deserialize;
use std::time::Duration;

/// The three supported platforms: deliberately only the forges the app's
/// users actually host on, not an open-ended provider list.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    GitHub,
    GitLab,
    AzureDevOps,
}

impl Platform {
    pub fn from_id(id: &str) -> Option<Self> {
        match id {
            "github" => Some(Self::GitHub),
            "gitlab" => Some(Self::GitLab),
            "azure_devops" => Some(Self::AzureDevOps),
            _ => None,
        }
    }

    pub fn id(self) -> &'static str {
        match self {
            Self::GitHub => "github",
            Self::GitLab => "gitlab",
            Self::AzureDevOps => "azure_devops",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::GitHub => "GitHub",
            Self::GitLab => "GitLab",
            Self::AzureDevOps => "Azure DevOps",
        }
    }

    /// The host git dials for HTTPS remotes: the credential broker's keychain
    /// key is `https://<git_host>`, so a token stored under it answers
    /// `git credential fill` directly.
    pub fn git_host(self) -> &'static str {
        match self {
            Self::GitHub => "github.com",
            Self::GitLab => "gitlab.com",
            Self::AzureDevOps => "dev.azure.com",
        }
    }

    /// Whether the platform has a documented "add SSH key to my account" API.
    pub fn supports_key_upload(self) -> bool {
        !matches!(self, Self::AzureDevOps)
    }

    /// OAuth device-flow client ID of the registered LeGit app. A client ID
    /// is a public identifier (the device flow needs no secret), so it is
    /// committed. `None` = no registered app: the UI offers only the PAT
    /// path. GitLab would additionally need refresh-token handling (its
    /// OAuth tokens expire after 2h), ADO an Entra app registration.
    /// Registration requirements and rotation notes:
    /// `design/2026-10-08-github-oauth-device-flow.md`.
    pub fn device_flow_client_id(self) -> Option<&'static str> {
        match self {
            Self::GitHub => Some("Ov23li7pmZgTzR9LHVIt"),
            Self::GitLab | Self::AzureDevOps => None,
        }
    }
}

/// The authenticated account, as validated against the platform API.
/// `username` doubles as the git basic-auth username (the PAT is the
/// password on all three platforms).
#[derive(Debug, Clone)]
pub struct AccountInfo {
    pub username: String,
    pub display_name: Option<String>,
}

/// The codes handed out at device-flow start (RFC 8628 §3.2): `user_code`
/// is what the user types on `verification_uri`; `device_code` is the opaque
/// handle the client polls with.
#[derive(Debug, Clone)]
pub struct DeviceAuthorization {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    /// Minimum seconds between polls.
    pub interval_secs: u64,
    /// Lifetime of the codes; after this the flow must be restarted.
    pub expires_in_secs: u64,
}

/// One device-flow token poll, classified (RFC 8628 §3.5).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DevicePollOutcome {
    /// The user has not finished authorizing: poll again after the interval.
    Pending,
    /// The platform wants a longer interval: add 5 seconds, then poll again.
    SlowDown,
    /// The user declined the authorization.
    Denied,
    /// The codes expired before the user finished: restart the flow.
    Expired,
    AccessToken(String),
}

#[derive(Debug, thiserror::Error)]
pub enum ProviderError {
    /// The platform rejected the token (401/403).
    #[error("the token was rejected: {0}")]
    Auth(String),
    /// The platform answered with a non-success status.
    #[error("{0}")]
    Api(String),
    /// The request never got a usable answer (network, TLS, timeout).
    #[error("cannot reach the platform: {0}")]
    Http(String),
    /// The platform answered 200 with an unexpected body.
    #[error("unexpected API response: {0}")]
    Parse(String),
    #[error("{0}")]
    Unsupported(String),
}

// ---------------------------------------------------------------------------
// Response parsing (pure; unit-tested)
// ---------------------------------------------------------------------------

fn parse_github_user(body: &str) -> Result<AccountInfo, ProviderError> {
    #[derive(Deserialize)]
    struct GithubUser {
        login: Option<String>,
        name: Option<String>,
    }
    let u: GithubUser =
        serde_json::from_str(body).map_err(|e| ProviderError::Parse(e.to_string()))?;
    let username = u
        .login
        .filter(|l| !l.is_empty())
        .ok_or_else(|| ProviderError::Parse("no `login` in the GitHub /user response".into()))?;
    Ok(AccountInfo { username, display_name: u.name.filter(|n| !n.is_empty()) })
}

fn parse_gitlab_user(body: &str) -> Result<AccountInfo, ProviderError> {
    #[derive(Deserialize)]
    struct GitlabUser {
        username: Option<String>,
        name: Option<String>,
    }
    let u: GitlabUser =
        serde_json::from_str(body).map_err(|e| ProviderError::Parse(e.to_string()))?;
    let username = u
        .username
        .filter(|l| !l.is_empty())
        .ok_or_else(|| ProviderError::Parse("no `username` in the GitLab /user response".into()))?;
    Ok(AccountInfo { username, display_name: u.name.filter(|n| !n.is_empty()) })
}

fn parse_ado_profile(body: &str) -> Result<AccountInfo, ProviderError> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct AdoProfile {
        display_name: Option<String>,
        email_address: Option<String>,
    }
    let p: AdoProfile =
        serde_json::from_str(body).map_err(|e| ProviderError::Parse(e.to_string()))?;
    let display = p.display_name.filter(|n| !n.is_empty());
    let username = p
        .email_address
        .filter(|e| !e.is_empty())
        .or_else(|| display.clone())
        .ok_or_else(|| {
            ProviderError::Parse("no identity in the Azure DevOps profile response".into())
        })?;
    Ok(AccountInfo { username, display_name: display })
}

fn parse_device_authorization(body: &str) -> Result<DeviceAuthorization, ProviderError> {
    #[derive(Deserialize)]
    struct Response {
        device_code: Option<String>,
        user_code: Option<String>,
        verification_uri: Option<String>,
        interval: Option<u64>,
        expires_in: Option<u64>,
    }
    let r: Response =
        serde_json::from_str(body).map_err(|e| ProviderError::Parse(e.to_string()))?;
    let field = |v: Option<String>, name: &str| {
        v.filter(|s| !s.is_empty()).ok_or_else(|| {
            ProviderError::Parse(format!("no `{name}` in the device-authorization response"))
        })
    };
    Ok(DeviceAuthorization {
        device_code: field(r.device_code, "device_code")?,
        user_code: field(r.user_code, "user_code")?,
        verification_uri: field(r.verification_uri, "verification_uri")?,
        interval_secs: r.interval.unwrap_or(5),
        expires_in_secs: r.expires_in.unwrap_or(900),
    })
}

/// GitHub answers device-flow polls with HTTP 200 and signals the flow state
/// via an `error` code in the body - classification must read the body, never
/// the status.
fn classify_device_poll(body: &str) -> Result<DevicePollOutcome, ProviderError> {
    #[derive(Deserialize)]
    struct Response {
        access_token: Option<String>,
        error: Option<String>,
        error_description: Option<String>,
    }
    let r: Response =
        serde_json::from_str(body).map_err(|e| ProviderError::Parse(e.to_string()))?;
    if let Some(token) = r.access_token.filter(|t| !t.is_empty()) {
        return Ok(DevicePollOutcome::AccessToken(token));
    }
    match r.error.as_deref() {
        Some("authorization_pending") => Ok(DevicePollOutcome::Pending),
        Some("slow_down") => Ok(DevicePollOutcome::SlowDown),
        Some("access_denied") => Ok(DevicePollOutcome::Denied),
        Some("expired_token") => Ok(DevicePollOutcome::Expired),
        Some(code) => Err(ProviderError::Api(match r.error_description {
            Some(d) if !d.is_empty() => format!("{code}: {d}"),
            _ => code.to_string(),
        })),
        None => Err(ProviderError::Parse(
            "neither a token nor an error code in the device-flow poll response".into(),
        )),
    }
}

// ---------------------------------------------------------------------------
// API calls
// ---------------------------------------------------------------------------

fn client() -> Result<reqwest::Client, ProviderError> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .user_agent("LeGit")
        // Every endpoint is a fixed https URL; a redirect would carry the
        // token header (GitLab's PRIVATE-TOKEN is not one reqwest strips).
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| ProviderError::Http(e.to_string()))
}

async fn read_body(resp: reqwest::Response) -> (reqwest::StatusCode, String) {
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    (status, body)
}

fn status_error(status: reqwest::StatusCode, body: &str) -> ProviderError {
    let detail = api_error_detail(body)
        .unwrap_or_else(|| body.trim().chars().take(300).collect::<String>());
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        ProviderError::Auth(format!("{status}: {detail}"))
    } else {
        ProviderError::Api(format!("{status}: {detail}"))
    }
}

/// A readable message out of a platform's JSON error body - GitHub's
/// `message` + `errors[].message`, GitLab's string-or-object `message`,
/// OAuth's `error_description`. `None` = no such shape: show the raw body.
/// The user must never be shown a JSON envelope.
fn api_error_detail(body: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(body).ok()?;
    let mut parts: Vec<String> = Vec::new();
    match v.get("message") {
        Some(serde_json::Value::String(m)) if !m.is_empty() => parts.push(m.clone()),
        Some(serde_json::Value::Object(fields)) => {
            for (field, messages) in fields {
                match messages {
                    serde_json::Value::String(m) => parts.push(format!("{field} {m}")),
                    serde_json::Value::Array(list) => parts.extend(
                        list.iter().filter_map(|m| m.as_str()).map(|m| format!("{field} {m}")),
                    ),
                    _ => {}
                }
            }
        }
        _ => {}
    }
    if let Some(errors) = v.get("errors").and_then(|e| e.as_array()) {
        parts.extend(
            errors
                .iter()
                .filter_map(|e| e.get("message").and_then(|m| m.as_str()))
                .map(str::to_string),
        );
    }
    if parts.is_empty() {
        if let Some(d) = v.get("error_description").and_then(|d| d.as_str()).filter(|d| !d.is_empty()) {
            parts.push(d.to_string());
        }
    }
    if parts.is_empty() { None } else { Some(parts.join(": ")) }
}

/// Whether an upload rejection means "this exact key is already registered"
/// (GitHub: "key is already in use"; GitLab: "has already been taken") -
/// platform-wide, so it may belong to this account or to a different one.
fn key_already_registered_error(body: &str) -> bool {
    api_error_detail(body).is_some_and(|d| {
        let d = d.to_lowercase();
        d.contains("key is already in use") || d.contains("has already been taken")
    })
}

/// The identity of an authorized-keys line: type + base64 blob (the trailing
/// comment differs freely between copies of the same key).
fn key_material(public_key: &str) -> Option<(&str, &str)> {
    let mut fields = public_key.split_whitespace();
    Some((fields.next()?, fields.next()?))
}

/// One SSH key registered on the account: the platform's numeric id (needed
/// to revoke it) plus the raw `<type> <blob> [comment]` string.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegisteredSshKey {
    pub id: u64,
    pub key: String,
}

/// What a key registration is for. GitHub keeps authentication and signing
/// keys in separate endpoints; GitLab keeps one key list and separates by
/// `usage_type` ("auth", "signing", "auth_and_signing").
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyUsage {
    Auth,
    Signing,
}

/// Whether a row's `usage_type` (absent on GitHub: its endpoints are already
/// usage-specific) matches the wanted usage; `None` = any usage.
fn usage_matches(usage_type: Option<&str>, wanted: Option<KeyUsage>) -> bool {
    match (wanted, usage_type) {
        (None, _) | (_, None) => true,
        (Some(KeyUsage::Auth), Some(u)) => u == "auth" || u == "auth_and_signing",
        (Some(KeyUsage::Signing), Some(u)) => u == "signing" || u == "auth_and_signing",
    }
}

/// A GitHub/GitLab "my SSH keys" listing (both answer
/// `[{ "id": <n>, "key": "<type> <blob> [comment]", ... }]`), kept to the
/// rows matching `usage` (`None` = all rows).
fn parse_key_list(
    list_body: &str,
    usage: Option<KeyUsage>,
) -> Result<Vec<RegisteredSshKey>, ProviderError> {
    #[derive(Deserialize)]
    struct KeyRow {
        id: Option<u64>,
        key: Option<String>,
        usage_type: Option<String>,
    }
    let rows: Vec<KeyRow> =
        serde_json::from_str(list_body).map_err(|e| ProviderError::Parse(e.to_string()))?;
    Ok(rows
        .into_iter()
        .filter(|r| usage_matches(r.usage_type.as_deref(), usage))
        .filter_map(|r| match (r.id, r.key) {
            (Some(id), Some(key)) => Some(RegisteredSshKey { id, key }),
            _ => None,
        })
        .collect())
}

/// Whether `public_key` appears in a "my SSH keys" listing body, in ANY
/// usage (the own-account check after an "already in use" rejection, which
/// the platforms raise across usages).
fn key_in_list(public_key: &str, list_body: &str) -> Result<bool, ProviderError> {
    let Some(target) = key_material(public_key) else {
        return Ok(false);
    };
    Ok(parse_key_list(list_body, None)?
        .iter()
        .filter_map(|k| key_material(&k.key))
        .any(|material| material == target))
}

/// Validate a PAT and return the account it belongs to.
pub async fn validate_token(platform: Platform, token: &str) -> Result<AccountInfo, ProviderError> {
    let c = client()?;
    let send = |b: reqwest::RequestBuilder| async {
        b.send().await.map_err(|e| ProviderError::Http(e.to_string()))
    };
    match platform {
        Platform::GitHub => {
            let resp = send(
                c.get("https://api.github.com/user")
                    .bearer_auth(token)
                    .header("Accept", "application/vnd.github+json"),
            )
            .await?;
            let (status, body) = read_body(resp).await;
            if !status.is_success() {
                return Err(status_error(status, &body));
            }
            parse_github_user(&body)
        }
        Platform::GitLab => {
            let resp = send(
                c.get("https://gitlab.com/api/v4/user").header("PRIVATE-TOKEN", token),
            )
            .await?;
            let (status, body) = read_body(resp).await;
            if !status.is_success() {
                return Err(status_error(status, &body));
            }
            parse_gitlab_user(&body)
        }
        Platform::AzureDevOps => {
            // vssps is the ADO identity host; the profile endpoint works with
            // a PAT via basic auth (empty username, PAT as password).
            let resp = send(
                c.get("https://app.vssps.visualstudio.com/_apis/profile/profiles/me?api-version=7.1")
                    .basic_auth("", Some(token)),
            )
            .await?;
            let (status, body) = read_body(resp).await;
            if !status.is_success() {
                return Err(status_error(status, &body));
            }
            // ADO answers 200 with an HTML sign-in page for bad PATs in some
            // setups: a parse failure then reads as a rejected token.
            parse_ado_profile(&body).map_err(|_| {
                ProviderError::Auth("the response was not a profile: check the token".into())
            })
        }
    }
}

struct DeviceFlowConfig {
    client_id: &'static str,
    code_url: &'static str,
    token_url: &'static str,
    /// The scopes the PAT-creation page prefills too: git over HTTPS +
    /// SSH-key upload.
    scope: &'static str,
}

fn device_flow_config(platform: Platform) -> Result<DeviceFlowConfig, ProviderError> {
    let unsupported = || {
        ProviderError::Unsupported(format!(
            "{} has no registered OAuth app: connect with a token instead",
            platform.label()
        ))
    };
    let client_id = platform.device_flow_client_id().ok_or_else(unsupported)?;
    match platform {
        Platform::GitHub => Ok(DeviceFlowConfig {
            client_id,
            code_url: "https://github.com/login/device/code",
            token_url: "https://github.com/login/oauth/access_token",
            scope: "repo admin:public_key admin:ssh_signing_key",
        }),
        Platform::GitLab | Platform::AzureDevOps => Err(unsupported()),
    }
}

/// Start the OAuth device flow (RFC 8628): obtain the user/device code pair.
pub async fn device_flow_start(platform: Platform) -> Result<DeviceAuthorization, ProviderError> {
    let cfg = device_flow_config(platform)?;
    let c = client()?;
    let resp = c
        .post(cfg.code_url)
        .header("Accept", "application/json")
        .form(&[("client_id", cfg.client_id), ("scope", cfg.scope)])
        .send()
        .await
        .map_err(|e| ProviderError::Http(e.to_string()))?;
    let (status, body) = read_body(resp).await;
    if !status.is_success() {
        return Err(status_error(status, &body));
    }
    parse_device_authorization(&body)
}

/// One device-flow token poll; the caller owns the loop and the interval.
pub async fn device_flow_poll(
    platform: Platform,
    device_code: &str,
) -> Result<DevicePollOutcome, ProviderError> {
    let cfg = device_flow_config(platform)?;
    let c = client()?;
    let resp = c
        .post(cfg.token_url)
        .header("Accept", "application/json")
        .form(&[
            ("client_id", cfg.client_id),
            ("device_code", device_code),
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
        ])
        .send()
        .await
        .map_err(|e| ProviderError::Http(e.to_string()))?;
    let (status, body) = read_body(resp).await;
    if !status.is_success() {
        return Err(status_error(status, &body));
    }
    classify_device_poll(&body)
}

/// What adding an SSH key achieved. An upload rejected because the key is
/// already on THIS account reaches the goal state, so it crosses as data,
/// not as an error.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AddSshKeyOutcome {
    Added,
    AlreadyPresent,
}

/// The usage's key collection endpoint. GitLab's one list serves both
/// usages (rows filtered by `usage_type` after parsing).
fn keys_endpoint(platform: Platform, usage: KeyUsage) -> &'static str {
    match (platform, usage) {
        (Platform::GitHub, KeyUsage::Auth) => "https://api.github.com/user/keys",
        (Platform::GitHub, KeyUsage::Signing) => "https://api.github.com/user/ssh_signing_keys",
        (Platform::GitLab, _) => "https://gitlab.com/api/v4/user/keys",
        (Platform::AzureDevOps, _) => unreachable!("guarded by supports_key_upload"),
    }
}

/// GitHub answers signing-key calls made with a token that lacks the
/// `admin:ssh_signing_key` scope with 404 (classic PAT) or 403: surface that
/// as "reconnect to grant the permission", not as a dead endpoint.
fn signing_status_error(
    platform: Platform,
    status: reqwest::StatusCode,
    body: &str,
) -> ProviderError {
    if platform == Platform::GitHub
        && (status == reqwest::StatusCode::FORBIDDEN || status == reqwest::StatusCode::NOT_FOUND)
    {
        return ProviderError::Auth(
            "the connected token cannot manage signing keys (it lacks the admin:ssh_signing_key \
             scope): reconnect the account to grant it"
                .into(),
        );
    }
    status_error(status, body)
}

fn usage_status_error(
    platform: Platform,
    usage: KeyUsage,
    status: reqwest::StatusCode,
    body: &str,
) -> ProviderError {
    match usage {
        KeyUsage::Signing => signing_status_error(platform, status, body),
        KeyUsage::Auth => status_error(status, body),
    }
}

/// Add an SSH public key to the authenticated account (GitHub/GitLab only;
/// ADO has no documented API for it). On GitLab a key carries ONE usage for
/// its lifetime, so a signing registration is created as `auth_and_signing`
/// (a fresh key then serves both); a key already registered there for
/// authentication only cannot gain signing - revoke and re-add it.
pub async fn add_ssh_key(
    platform: Platform,
    token: &str,
    title: &str,
    public_key: &str,
    usage: KeyUsage,
) -> Result<AddSshKeyOutcome, ProviderError> {
    if !platform.supports_key_upload() {
        return Err(ProviderError::Unsupported(format!(
            "{} has no SSH-key API: add the key in the browser instead",
            platform.label()
        )));
    }
    let c = client()?;
    let mut body = serde_json::json!({ "title": title, "key": public_key });
    if platform == Platform::GitLab && usage == KeyUsage::Signing {
        body["usage_type"] = "auth_and_signing".into();
    }
    let req = match platform {
        Platform::GitHub => c
            .post(keys_endpoint(platform, usage))
            .bearer_auth(token)
            .header("Accept", "application/vnd.github+json")
            .json(&body),
        Platform::GitLab => {
            c.post(keys_endpoint(platform, usage)).header("PRIVATE-TOKEN", token).json(&body)
        }
        Platform::AzureDevOps => unreachable!("guarded above"),
    };
    let resp = req.send().await.map_err(|e| ProviderError::Http(e.to_string()))?;
    let (status, body) = read_body(resp).await;
    if status.is_success() {
        return Ok(AddSshKeyOutcome::Added);
    }
    // Platforms refuse duplicate keys platform-WIDE, so "already registered"
    // is ambiguous: resolve it against the account's own keys of this usage,
    // then (GitLab's shared list) any usage, then a foreign account.
    if key_already_registered_error(&body) {
        let own = list_ssh_keys_body(platform, token, &c, usage).await?;
        let material = key_material(public_key);
        let in_usage = parse_key_list(&own, Some(usage))?
            .iter()
            .filter_map(|k| key_material(&k.key))
            .any(|m| Some(m) == material);
        if in_usage {
            return Ok(AddSshKeyOutcome::AlreadyPresent);
        }
        if platform == Platform::GitLab && key_in_list(public_key, &own)? {
            return Err(ProviderError::Api(
                "this key is already registered on the account for a different purpose; a GitLab \
                 key has one usage - revoke it and set it up again"
                    .into(),
            ));
        }
        return Err(ProviderError::Api(format!(
            "this key is already registered to a different {} account",
            platform.label()
        )));
    }
    Err(usage_status_error(platform, usage, status, &body))
}

/// The SSH public keys registered on the authenticated account for `usage`
/// (GitHub/GitLab only).
pub async fn list_registered_ssh_keys(
    platform: Platform,
    token: &str,
    usage: KeyUsage,
) -> Result<Vec<RegisteredSshKey>, ProviderError> {
    if !platform.supports_key_upload() {
        return Err(ProviderError::Unsupported(format!(
            "{} has no SSH-key API",
            platform.label()
        )));
    }
    let c = client()?;
    parse_key_list(&list_ssh_keys_body(platform, token, &c, usage).await?, Some(usage))
}

/// Remove a registered SSH key from the authenticated account
/// (GitHub/GitLab only).
pub async fn delete_ssh_key(
    platform: Platform,
    token: &str,
    key_id: u64,
    usage: KeyUsage,
) -> Result<(), ProviderError> {
    if !platform.supports_key_upload() {
        return Err(ProviderError::Unsupported(format!(
            "{} has no SSH-key API",
            platform.label()
        )));
    }
    let c = client()?;
    let url = format!("{}/{key_id}", keys_endpoint(platform, usage));
    let req = match platform {
        Platform::GitHub => {
            c.delete(url).bearer_auth(token).header("Accept", "application/vnd.github+json")
        }
        Platform::GitLab => c.delete(url).header("PRIVATE-TOKEN", token),
        Platform::AzureDevOps => unreachable!("guarded above"),
    };
    let resp = req.send().await.map_err(|e| ProviderError::Http(e.to_string()))?;
    let (status, body) = read_body(resp).await;
    if !status.is_success() {
        return Err(usage_status_error(platform, usage, status, &body));
    }
    Ok(())
}

async fn list_ssh_keys_body(
    platform: Platform,
    token: &str,
    c: &reqwest::Client,
    usage: KeyUsage,
) -> Result<String, ProviderError> {
    let url = format!("{}?per_page=100", keys_endpoint(platform, usage));
    let req = match platform {
        Platform::GitHub => {
            c.get(url).bearer_auth(token).header("Accept", "application/vnd.github+json")
        }
        Platform::GitLab => c.get(url).header("PRIVATE-TOKEN", token),
        Platform::AzureDevOps => unreachable!("guarded by supports_key_upload"),
    };
    let resp = req.send().await.map_err(|e| ProviderError::Http(e.to_string()))?;
    let (status, body) = read_body(resp).await;
    if !status.is_success() {
        return Err(usage_status_error(platform, usage, status, &body));
    }
    Ok(body)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn platform_ids_round_trip() {
        for id in ["github", "gitlab", "azure_devops"] {
            let p = Platform::from_id(id).expect(id);
            assert_eq!(p.id(), id);
        }
        assert!(Platform::from_id("bitbucket").is_none());
    }

    #[test]
    fn platform_git_hosts() {
        // The host is the broker's keychain key (`https://<host>`), so it must
        // be the host git dials for HTTPS remotes, not the API host.
        assert_eq!(Platform::GitHub.git_host(), "github.com");
        assert_eq!(Platform::GitLab.git_host(), "gitlab.com");
        assert_eq!(Platform::AzureDevOps.git_host(), "dev.azure.com");
    }

    #[test]
    fn key_upload_support_per_platform() {
        assert!(Platform::GitHub.supports_key_upload());
        assert!(Platform::GitLab.supports_key_upload());
        // ADO has no documented SSH-key API: copy + deep link stays.
        assert!(!Platform::AzureDevOps.supports_key_upload());
    }

    // The exact GitHub 422 answered for a key that is already registered.
    const GITHUB_KEY_IN_USE: &str = r#"{"message":"Validation Failed","errors":[{"resource":"PublicKey","code":"custom","field":"key","message":"key is already in use"}],"documentation_url":"https://docs.github.com/rest/users/keys#ca-public-ssh-key-for-the-authenticated-user","status":"422"}"#;

    #[test]
    fn api_error_detail_github_message_and_errors() {
        assert_eq!(
            api_error_detail(GITHUB_KEY_IN_USE).as_deref(),
            Some("Validation Failed: key is already in use")
        );
    }

    #[test]
    fn api_error_detail_gitlab_shapes() {
        // GitLab's `message` is a string or a field -> [messages] object.
        assert_eq!(
            api_error_detail(r#"{"message":"401 Unauthorized"}"#).as_deref(),
            Some("401 Unauthorized")
        );
        assert_eq!(
            api_error_detail(r#"{"message":{"key":["has already been taken"]}}"#).as_deref(),
            Some("key has already been taken")
        );
    }

    #[test]
    fn api_error_detail_falls_back_to_none() {
        assert_eq!(api_error_detail("<html>502</html>"), None);
        assert_eq!(api_error_detail(r#"{"unrelated":true}"#), None);
        // status_error then shows the raw body, so nothing is lost.
        assert!(status_error(reqwest::StatusCode::BAD_GATEWAY, "<html>502</html>")
            .to_string()
            .contains("<html>502</html>"));
        // ... and a parseable body is shown as its message, not as JSON.
        let e = status_error(reqwest::StatusCode::UNPROCESSABLE_ENTITY, GITHUB_KEY_IN_USE);
        assert!(e.to_string().contains("Validation Failed: key is already in use"));
        assert!(!e.to_string().contains("documentation_url"));
    }

    #[test]
    fn key_already_registered_detection() {
        assert!(key_already_registered_error(GITHUB_KEY_IN_USE));
        assert!(key_already_registered_error(
            r#"{"message":{"fingerprint_sha256":["has already been taken"]}}"#
        ));
        assert!(!key_already_registered_error(r#"{"message":"Validation Failed","errors":[{"message":"key is invalid"}]}"#));
        assert!(!key_already_registered_error("not json"));
    }

    #[test]
    fn key_in_list_matches_on_type_and_blob() {
        let list = r#"[
            {"id":1,"key":"ssh-rsa AAAAB3NzaC1yc2E other-key"},
            {"id":2,"key":"ssh-ed25519 AAAAC3NzaC1lZDI1 work laptop"}
        ]"#;
        // The comment differs between the local file and the platform copy.
        assert!(key_in_list("ssh-ed25519 AAAAC3NzaC1lZDI1 simon@home", list).unwrap());
        assert!(!key_in_list("ssh-ed25519 AAAAC3NzaC1OTHER simon@home", list).unwrap());
        // Same blob under a different type is a different key.
        assert!(!key_in_list("sk-ssh-ed25519@openssh.com AAAAC3NzaC1lZDI1", list).unwrap());
        assert!(!key_in_list("garbage", list).unwrap());
        assert!(key_in_list("ssh-ed25519 AAAA", "not json").is_err());
        // Rows without an id or key are skipped, not an error.
        assert_eq!(
            parse_key_list(
                r#"[{"id":1},{"key":"ssh-rsa AAAA y"},{"id":2,"key":"ssh-rsa AAAAB3 x"}]"#,
                None
            )
            .unwrap(),
            vec![RegisteredSshKey { id: 2, key: "ssh-rsa AAAAB3 x".to_string() }]
        );
    }

    #[test]
    fn parse_key_list_filters_gitlab_usage_types() {
        // GitLab keeps ONE key list and separates auth/signing by usage_type;
        // GitHub rows carry no usage_type (its endpoints are usage-specific)
        // and must pass either filter.
        let gitlab = r#"[
            {"id":1,"key":"ssh-ed25519 AUTH a","usage_type":"auth"},
            {"id":2,"key":"ssh-ed25519 SIGN s","usage_type":"signing"},
            {"id":3,"key":"ssh-ed25519 BOTH b","usage_type":"auth_and_signing"}
        ]"#;
        let ids = |usage| {
            parse_key_list(gitlab, usage)
                .unwrap()
                .iter()
                .map(|k| k.id)
                .collect::<Vec<_>>()
        };
        assert_eq!(ids(Some(KeyUsage::Auth)), vec![1, 3]);
        assert_eq!(ids(Some(KeyUsage::Signing)), vec![2, 3]);
        assert_eq!(ids(None), vec![1, 2, 3]);

        let github = r#"[{"id":9,"key":"ssh-ed25519 X"}]"#;
        assert_eq!(parse_key_list(github, Some(KeyUsage::Auth)).unwrap().len(), 1);
        assert_eq!(parse_key_list(github, Some(KeyUsage::Signing)).unwrap().len(), 1);
    }

    #[test]
    fn github_signing_scope_miss_reads_as_reconnect() {
        // GitHub answers 404 (classic PAT) or 403 for a token without the
        // admin:ssh_signing_key scope: the user must be told to reconnect,
        // not shown "Not Found".
        for status in [reqwest::StatusCode::NOT_FOUND, reqwest::StatusCode::FORBIDDEN] {
            let e = signing_status_error(Platform::GitHub, status, r#"{"message":"Not Found"}"#);
            assert!(matches!(e, ProviderError::Auth(_)));
            assert!(e.to_string().contains("reconnect"));
        }
        // GitLab's `api` scope covers signing keys: no remapping there.
        let e = signing_status_error(
            Platform::GitLab,
            reqwest::StatusCode::NOT_FOUND,
            r#"{"message":"404 Not Found"}"#,
        );
        assert!(!e.to_string().contains("reconnect"));
    }

    #[test]
    fn device_flow_registered_per_platform() {
        assert!(Platform::GitHub.device_flow_client_id().is_some());
        // No registered apps yet; GitLab would also need refresh-token
        // handling before this flips.
        assert!(Platform::GitLab.device_flow_client_id().is_none());
        assert!(Platform::AzureDevOps.device_flow_client_id().is_none());
    }

    #[test]
    fn parse_device_authorization_github_shape() {
        let json = r#"{
            "device_code": "3584d83530557fdd1f46af8289938c8ef79f9dc5",
            "user_code": "WDJB-MJHT",
            "verification_uri": "https://github.com/login/device",
            "expires_in": 900,
            "interval": 5
        }"#;
        let a = parse_device_authorization(json).unwrap();
        assert_eq!(a.user_code, "WDJB-MJHT");
        assert_eq!(a.verification_uri, "https://github.com/login/device");
        assert_eq!(a.interval_secs, 5);
        assert_eq!(a.expires_in_secs, 900);
    }

    #[test]
    fn parse_device_authorization_defaults_and_missing_fields() {
        // interval/expires_in get RFC-default values when absent.
        let a = parse_device_authorization(
            r#"{"device_code":"d","user_code":"u","verification_uri":"https://x"}"#,
        )
        .unwrap();
        assert_eq!(a.interval_secs, 5);
        assert_eq!(a.expires_in_secs, 900);
        for broken in [
            r#"{"user_code":"u","verification_uri":"https://x"}"#,
            r#"{"device_code":"","user_code":"u","verification_uri":"https://x"}"#,
            "not json",
        ] {
            assert!(matches!(
                parse_device_authorization(broken),
                Err(ProviderError::Parse(_))
            ));
        }
    }

    #[test]
    fn classify_device_poll_flow_states() {
        // GitHub sends these as HTTP 200 bodies: the error CODE carries the
        // flow state, so classification must never rely on the status.
        let case = |body: &str| classify_device_poll(body).unwrap();
        assert_eq!(
            case(r#"{"error":"authorization_pending","error_description":"..."}"#),
            DevicePollOutcome::Pending
        );
        assert_eq!(case(r#"{"error":"slow_down","interval":10}"#), DevicePollOutcome::SlowDown);
        assert_eq!(case(r#"{"error":"access_denied"}"#), DevicePollOutcome::Denied);
        assert_eq!(case(r#"{"error":"expired_token"}"#), DevicePollOutcome::Expired);
        assert_eq!(
            case(r#"{"access_token":"gho_16C7e42F292c6912E7710c838347Ae178B4a","token_type":"bearer","scope":"repo,admin:public_key"}"#),
            DevicePollOutcome::AccessToken("gho_16C7e42F292c6912E7710c838347Ae178B4a".into())
        );
    }

    #[test]
    fn classify_device_poll_real_errors() {
        // Terminal misconfigurations surface as errors with the description.
        let e = classify_device_poll(
            r#"{"error":"device_flow_disabled","error_description":"Device Flow must be explicitly enabled"}"#,
        )
        .unwrap_err();
        assert!(e.to_string().contains("device_flow_disabled"));
        assert!(e.to_string().contains("explicitly enabled"));
        assert!(matches!(
            classify_device_poll(r#"{"token_type":"bearer"}"#),
            Err(ProviderError::Parse(_))
        ));
        // An empty token must never classify as success.
        assert!(classify_device_poll(r#"{"access_token":""}"#).is_err());
    }

    #[test]
    fn parse_github_user_extracts_login_and_name() {
        let json = r#"{"login":"simonbeck","id":123,"name":"Simon Beck","company":null}"#;
        let a = parse_github_user(json).expect("parses");
        assert_eq!(a.username, "simonbeck");
        assert_eq!(a.display_name.as_deref(), Some("Simon Beck"));
    }

    #[test]
    fn parse_github_user_without_login_is_error() {
        assert!(parse_github_user(r#"{"message":"Bad credentials"}"#).is_err());
        assert!(parse_github_user("not json").is_err());
    }

    #[test]
    fn parse_gitlab_user_extracts_username() {
        let json = r#"{"id":42,"username":"simon","name":"Simon Beck","state":"active"}"#;
        let a = parse_gitlab_user(json).expect("parses");
        assert_eq!(a.username, "simon");
        assert_eq!(a.display_name.as_deref(), Some("Simon Beck"));
    }

    #[test]
    fn parse_ado_profile_prefers_email_for_git_username() {
        // ADO git basic-auth uses the PAT as password; the email is the most
        // recognizable username for display and auth.
        let json = r#"{"displayName":"Simon Beck","emailAddress":"simon.beck@ateleris.ch","id":"guid"}"#;
        let a = parse_ado_profile(json).expect("parses");
        assert_eq!(a.username, "simon.beck@ateleris.ch");
        assert_eq!(a.display_name.as_deref(), Some("Simon Beck"));
    }

    #[test]
    fn parse_ado_profile_falls_back_to_display_name() {
        let json = r#"{"displayName":"Simon Beck","id":"guid"}"#;
        let a = parse_ado_profile(json).expect("parses");
        assert_eq!(a.username, "Simon Beck");
    }

    #[test]
    fn parse_ado_profile_without_identity_is_error() {
        assert!(parse_ado_profile(r#"{"id":"guid"}"#).is_err());
    }
}
