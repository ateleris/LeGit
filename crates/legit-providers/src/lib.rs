//! Platform API integrations (GitHub / GitLab / Azure DevOps), SSH-first
//! (BACKLOG.md "Platform integrations", phase 2).
//!
//! Scope: PAT-based account validation ("who am I") and SSH public-key
//! upload where the platform has an API for it. Tokens are NEVER stored by
//! this crate: the app keeps them in the OS keychain (broker format) and
//! passes them per call. OAuth device flows are a later step: they need
//! registered app client IDs.

use serde::Deserialize;
use std::time::Duration;

/// The three supported platforms (chosen 2026-07-13: the ones Simon uses).
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
}

/// The authenticated account, as validated against the platform API.
/// `username` doubles as the git basic-auth username (the PAT is the
/// password on all three platforms).
#[derive(Debug, Clone)]
pub struct AccountInfo {
    pub username: String,
    pub display_name: Option<String>,
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
    let detail = body.trim().chars().take(300).collect::<String>();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        ProviderError::Auth(format!("{status}: {detail}"))
    } else {
        ProviderError::Api(format!("{status}: {detail}"))
    }
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

/// Add an SSH public key to the authenticated account (GitHub/GitLab only;
/// ADO has no documented API for it).
pub async fn add_ssh_key(
    platform: Platform,
    token: &str,
    title: &str,
    public_key: &str,
) -> Result<(), ProviderError> {
    if !platform.supports_key_upload() {
        return Err(ProviderError::Unsupported(format!(
            "{} has no SSH-key API: add the key in the browser instead",
            platform.label()
        )));
    }
    let c = client()?;
    let body = serde_json::json!({ "title": title, "key": public_key });
    let req = match platform {
        Platform::GitHub => c
            .post("https://api.github.com/user/keys")
            .bearer_auth(token)
            .header("Accept", "application/vnd.github+json")
            .json(&body),
        Platform::GitLab => c
            .post("https://gitlab.com/api/v4/user/keys")
            .header("PRIVATE-TOKEN", token)
            .json(&body),
        Platform::AzureDevOps => unreachable!("guarded above"),
    };
    let resp = req.send().await.map_err(|e| ProviderError::Http(e.to_string()))?;
    let (status, body) = read_body(resp).await;
    if !status.is_success() {
        return Err(status_error(status, &body));
    }
    Ok(())
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
