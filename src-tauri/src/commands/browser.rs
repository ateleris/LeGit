//! Open a repository's remote hosting page (GitHub, GitLab, Bitbucket, any
//! self-hosted forge) in the default browser.
//!
//! No provider-specific logic: the landing page is just the remote URL
//! translated to its web form. HTTPS remotes are used almost verbatim
//! (credentials stripped — a token must never leak into a browser URL);
//! SSH forms are rewritten to `https://host/path`. Local-path remotes have
//! no web page and translate to `None`.

use crate::error::AppError;
use crate::state::AppState;
use legit_core::Remote;
use std::process::Command;

/// Translate a git remote URL into the hosting provider's web URL, or `None`
/// when the remote has no web page (local paths, `file://`).
fn remote_web_url(remote: &str) -> Option<String> {
    let r = remote.trim();

    // http(s)://[user[:token]@]host/path(.git) — keep the scheme (a plain-http
    // internal forge stays http), drop credentials and the `.git` suffix.
    for scheme in ["https://", "http://"] {
        if let Some(rest) = r.strip_prefix(scheme) {
            let rest = rest.rsplit_once('@').map(|(_, h)| h).unwrap_or(rest);
            let rest = rest.trim_end_matches('/');
            let rest = rest.strip_suffix(".git").unwrap_or(rest);
            if rest.is_empty() {
                return None;
            }
            return Some(format!("{scheme}{rest}"));
        }
    }

    // ssh://[user@]host[:port]/path(.git) and git://host/path(.git) — the
    // port is the SSH port, not the web one, so it is dropped.
    for scheme in ["ssh://", "git://"] {
        if let Some(rest) = r.strip_prefix(scheme) {
            let rest = rest.rsplit_once('@').map(|(_, h)| h).unwrap_or(rest);
            let (host_port, path) = rest.split_once('/')?;
            let host = host_port.split(':').next()?;
            let path = path.trim_end_matches('/');
            let path = path.strip_suffix(".git").unwrap_or(path);
            if host.is_empty() || path.is_empty() {
                return None;
            }
            return Some(format!("https://{host}/{path}"));
        }
    }

    // SCP-style: [user@]host:path(.git), e.g. `git@github.com:org/repo.git`.
    // A Windows drive (`C:\repo`, `C:/repo`) also has a colon — excluded by
    // requiring a host longer than one character and a backslash-free path.
    if !r.contains("://") {
        if let Some((head, path)) = r.split_once(':') {
            let host = head.rsplit_once('@').map(|(_, h)| h).unwrap_or(head);
            let host_ok = host.len() > 1 && !host.contains('/') && !host.contains('\\');
            let path = path.trim_start_matches('/').trim_end_matches('/');
            let path = path.strip_suffix(".git").unwrap_or(path);
            if host_ok && !path.is_empty() && !path.contains('\\') {
                return Some(format!("https://{host}/{path}"));
            }
        }
    }

    None
}

/// The remote whose page to open: `origin` when present, else the first one.
fn pick_remote(remotes: &[Remote]) -> Option<&Remote> {
    remotes
        .iter()
        .find(|r| r.name == "origin")
        .or_else(|| remotes.first())
}

/// Open a URL in the default browser (fire-and-forget).
fn open_url(url: &str) -> Result<(), AppError> {
    let spawn = |mut cmd: Command| -> Result<(), AppError> {
        cmd.spawn()
            .map(|_| ())
            .map_err(|e| AppError::Io(format!("open browser: {e}")))
    };
    #[cfg(target_os = "windows")]
    {
        // `explorer <url>` hands the URL to the default browser without a
        // console window or cmd quoting quirks.
        let mut cmd = Command::new("explorer");
        cmd.arg(url);
        spawn(cmd)
    }
    #[cfg(target_os = "macos")]
    {
        let mut cmd = Command::new("open");
        cmd.arg(url);
        spawn(cmd)
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let mut cmd = Command::new("xdg-open");
        cmd.arg(url);
        spawn(cmd)
    }
}

/// The translated web URL for the repo's picked remote, or `None` when no
/// remote is configured or its URL has no web form — drives the toolbar
/// button's enabled state (and its tooltip).
#[tauri::command]
#[specta::specta]
pub async fn repo_remote_web_url(
    state: tauri::State<'_, AppState>,
    repo_id: String,
) -> Result<Option<String>, AppError> {
    let session = state.get_session(&repo_id).await?;
    let remotes = session.backend.list_remotes().await.map_err(AppError::Git)?;
    Ok(pick_remote(&remotes).and_then(|r| remote_web_url(&r.fetch_url)))
}

/// Open the repo's remote hosting page in the browser (`origin` preferred,
/// else the first remote).
#[tauri::command]
#[specta::specta]
pub async fn repo_open_remote_page(
    state: tauri::State<'_, AppState>,
    repo_id: String,
) -> Result<(), AppError> {
    let session = state.get_session(&repo_id).await?;
    let remotes = session.backend.list_remotes().await.map_err(AppError::Git)?;
    let remote = pick_remote(&remotes)
        .ok_or_else(|| AppError::Io("No remotes configured for this repository".to_string()))?;
    let url = remote_web_url(&remote.fetch_url).ok_or_else(|| {
        AppError::Io(format!(
            "Remote \"{}\" has no web page ({})",
            remote.name, remote.fetch_url
        ))
    })?;
    open_url(&url)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn web(url: &str) -> Option<String> {
        remote_web_url(url)
    }

    #[test]
    fn https_strips_git_suffix_and_trailing_slash() {
        assert_eq!(web("https://github.com/org/repo.git"), Some("https://github.com/org/repo".into()));
        assert_eq!(web("https://github.com/org/repo/"), Some("https://github.com/org/repo".into()));
        assert_eq!(web("https://github.com/org/repo"), Some("https://github.com/org/repo".into()));
    }

    #[test]
    fn https_strips_embedded_credentials() {
        // A token must never end up in a browser URL.
        assert_eq!(
            web("https://user:s3cret@gitlab.example.com/group/repo.git"),
            Some("https://gitlab.example.com/group/repo".into())
        );
    }

    #[test]
    fn plain_http_keeps_its_scheme() {
        assert_eq!(
            web("http://forge.internal/team/repo.git"),
            Some("http://forge.internal/team/repo".into())
        );
    }

    #[test]
    fn scp_style_ssh_translates() {
        assert_eq!(web("git@github.com:org/repo.git"), Some("https://github.com/org/repo".into()));
        assert_eq!(web("gitea.example.com:org/repo"), Some("https://gitea.example.com/org/repo".into()));
    }

    #[test]
    fn ssh_scheme_drops_the_port() {
        assert_eq!(
            web("ssh://git@bitbucket.example.com:7999/proj/repo.git"),
            Some("https://bitbucket.example.com/proj/repo".into())
        );
        assert_eq!(
            web("ssh://git@github.com/org/repo.git"),
            Some("https://github.com/org/repo".into())
        );
    }

    #[test]
    fn git_scheme_translates() {
        assert_eq!(web("git://github.com/org/repo.git"), Some("https://github.com/org/repo".into()));
    }

    #[test]
    fn local_paths_have_no_web_page() {
        assert_eq!(web("/srv/git/repo.git"), None);
        assert_eq!(web("../sibling-repo"), None);
        assert_eq!(web(r"C:\repos\thing"), None);
        assert_eq!(web("C:/repos/thing"), None);
        assert_eq!(web("file:///srv/git/repo.git"), None);
    }

    #[test]
    fn picks_origin_over_first() {
        let mk = |name: &str| Remote {
            name: name.into(),
            fetch_url: "x".into(),
            push_url: "x".into(),
        };
        let remotes = vec![mk("upstream"), mk("origin")];
        assert_eq!(pick_remote(&remotes).unwrap().name, "origin");
        let remotes = vec![mk("upstream"), mk("fork")];
        assert_eq!(pick_remote(&remotes).unwrap().name, "upstream");
        assert!(pick_remote(&[]).is_none());
    }
}
