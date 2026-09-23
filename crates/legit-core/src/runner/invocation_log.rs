//! What every git invocation reports: the command-log observer (with URL
//! credentials redacted), the progress observer, and the tracing log.

use std::path::Path;
use std::time::Instant;

use serde::{Deserialize, Serialize};
use specta::Type;
use tracing::{debug, info};

use super::OperationId;

/// A completed `git` invocation, reported to the process-wide observer (the app
/// forwards these to the UI as a git command log). Excludes stdout (often large)
/// but keeps stderr so failures are diagnosable.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct GitInvocation {
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub exit_code: Option<i32>,
    pub success: bool,
    pub duration_ms: u64,
    pub stderr: String,
    /// Which host ran this (`None` = the app machine). Runners never set it:
    /// the forwarding layer stamps it (a remote host's connection sink tags
    /// its label), so the Git Log panel can tell same-pathed repos on
    /// different hosts apart.
    #[serde(default)]
    pub host: Option<String>,
}

pub type InvocationObserver = std::sync::Arc<dyn Fn(GitInvocation) + Send + Sync>;
static INVOCATION_OBSERVER: std::sync::OnceLock<InvocationObserver> = std::sync::OnceLock::new();

/// Install a process-wide observer notified after every `git` invocation. Set
/// once at startup; the app uses it to forward a git command log to the UI.
pub fn set_invocation_observer(observer: InvocationObserver) {
    let _ = INVOCATION_OBSERVER.set(observer);
}

fn report_invocation(inv: GitInvocation) {
    if let Some(obs) = INVOCATION_OBSERVER.get() {
        obs(inv);
    }
}

pub type ProgressObserver =
    std::sync::Arc<dyn Fn(&OperationId, crate::progress::RemoteProgress) + Send + Sync>;
static PROGRESS_OBSERVER: std::sync::OnceLock<ProgressObserver> = std::sync::OnceLock::new();

/// Install a process-wide observer notified with parsed `--progress` meter
/// updates from invocations run via `run_with_op_progress`, keyed by their
/// `OperationId`. Set once at startup; the app forwards these to the UI.
pub fn set_progress_observer(observer: ProgressObserver) {
    let _ = PROGRESS_OBSERVER.set(observer);
}

pub(super) fn report_progress(op_id: &OperationId, progress: crate::progress::RemoteProgress) {
    if let Some(obs) = PROGRESS_OBSERVER.get() {
        obs(op_id, progress);
    }
}

/// Whether an invocation should be LOGGED as ok: a zero exit, or a non-zero
/// exit the caller declared expected (`run_expecting`) - e.g. `config --get`'s
/// 1 for "key unset" is an answer, not a failure, and must not paint the Git
/// Log panel red. Affects logging only; `RunOutput.success` stays `exit == 0`.
/// Pure; unit-tested.
pub(super) fn logged_ok(success: bool, exit_code: Option<i32>, ok_exit_codes: &[i32]) -> bool {
    success || exit_code.is_some_and(|c| ok_exit_codes.contains(&c))
}

/// Replace the credentials in every `scheme://user:secret@host` URL inside
/// `s` with `***`, leaving everything else untouched.
///
/// A remote URL can legitimately carry a token (`https://<PAT>@github.com/…`
/// is what GitHub's own HTTPS instructions produce), and such a URL turns up
/// both in argv (`clone`, `push`, `remote set-url`) and in git's own error
/// text ("fatal: Authentication failed for 'https://user:pass@host/'"). The
/// Git Log panel renders both verbatim, and bug reports carry screenshots of
/// it, so the secret is stripped at this single chokepoint instead.
///
/// When the userinfo has no colon the WHOLE of it is replaced: a lone
/// userinfo is just as often a token (`https://ghp_…@github.com`) as a user
/// name, and the two cannot be told apart.
pub fn redact_url_credentials(s: &str) -> std::borrow::Cow<'_, str> {
    if !s.contains("://") {
        return std::borrow::Cow::Borrowed(s);
    }
    let mut out = String::new();
    let mut rest = s;
    let mut redacted = false;
    while let Some(scheme_end) = rest.find("://") {
        let after = scheme_end + 3;
        // The authority ends at the path/query/fragment, or at whitespace or a
        // quote when the URL is embedded in a sentence (git's stderr).
        let auth_len = rest[after..]
            .find(|c: char| c.is_whitespace() || matches!(c, '/' | '?' | '#' | '\'' | '"'))
            .unwrap_or(rest.len() - after);
        let authority = &rest[after..after + auth_len];
        match authority.rfind('@') {
            Some(at) => {
                let userinfo = &authority[..at];
                out.push_str(&rest[..after]);
                match userinfo.find(':') {
                    Some(colon) => {
                        out.push_str(&userinfo[..colon]);
                        out.push_str(":***");
                    }
                    None => out.push_str("***"),
                }
                out.push_str(&authority[at..]);
                redacted = true;
            }
            None => out.push_str(&rest[..after + auth_len]),
        }
        rest = &rest[after + auth_len..];
    }
    if !redacted {
        return std::borrow::Cow::Borrowed(s);
    }
    out.push_str(rest);
    std::borrow::Cow::Owned(out)
}

pub(super) fn log_invocation(
    cwd: Option<&Path>,
    args: &[&str],
    started: Instant,
    exit_code: Option<i32>,
    success: bool,
    stderr: &str,
) {
    let duration_ms = started.elapsed().as_millis() as u64;
    // Credentials never reach a log or the UI (see `redact_url_credentials`).
    let args: Vec<String> = args
        .iter()
        .map(|a| redact_url_credentials(a).into_owned())
        .collect();
    let stderr = redact_url_credentials(stderr);
    let stderr = stderr.as_ref();
    // Log at debug for both outcomes: the runner doesn't know whether a
    // non-zero exit code is expected (e.g. `git config --get` returning 1 for
    // "key not found"). Callers that consider a non-zero result an actual error
    // are responsible for logging at the appropriate level.
    let snippet: String = stderr.lines().take(5).collect::<Vec<_>>().join(" | ");
    debug!(
        duration_ms,
        exit_code = exit_code.unwrap_or(-1),
        success,
        args = ?args,
        stderr = %snippet,
        "git invocation complete",
    );
    // Keep a higher-level info log only for successful long-running ops so
    // progress is visible without enabling full debug output.
    if success {
        info!(duration_ms, args = ?args, "git ok");
    }
    // Forward to the UI command log (if an observer is installed).
    report_invocation(GitInvocation {
        args,
        cwd: cwd.map(|p| p.to_string_lossy().into_owned()),
        exit_code,
        success,
        duration_ms,
        stderr: stderr.to_string(),
        host: None,
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn logged_ok_accepts_declared_expected_exit_codes() {
        // Zero always logs ok; a declared code logs ok; anything else fails.
        assert!(logged_ok(true, Some(0), &[]));
        assert!(logged_ok(false, Some(1), &[1]));
        assert!(logged_ok(false, Some(5), &[1, 5]));
        assert!(!logged_ok(false, Some(128), &[1, 5]));
        assert!(!logged_ok(false, Some(1), &[]));
        // Killed by signal (no exit code) is never "expected".
        assert!(!logged_ok(false, None, &[1]));
    }

    /// The Git Log panel renders every argv verbatim, and a remote URL can
    /// carry a token (`https://<PAT>@github.com/…` is what GitHub's HTTPS
    /// instructions produce). Nothing secret may survive this function.
    #[test]
    fn redaction_strips_url_credentials() {
        let cases = [
            (
                "https://user:ghp_SECRET@github.com/o/r.git",
                "https://user:***@github.com/o/r.git",
            ),
            // Token as the whole userinfo: indistinguishable from a user name,
            // so all of it goes.
            ("https://ghp_SECRET@github.com/o/r.git", "https://***@github.com/o/r.git"),
            ("http://u:p@example.com:8080/x", "http://u:***@example.com:8080/x"),
            // Embedded in git's own error text, quote-terminated.
            (
                "fatal: Authentication failed for 'https://u:p@host/r.git/'",
                "fatal: Authentication failed for 'https://u:***@host/r.git/'",
            ),
            // Two URLs in one string.
            (
                "https://a:b@h1/x and https://c:d@h2/y",
                "https://a:***@h1/x and https://c:***@h2/y",
            ),
            // Nothing to redact: returned untouched.
            ("https://github.com/o/r.git", "https://github.com/o/r.git"),
            ("git@github.com:o/r.git", "git@github.com:o/r.git"),
            ("ssh://git@github.com/o/r.git", "ssh://***@github.com/o/r.git"),
            ("--end-of-options", "--end-of-options"),
            ("", ""),
        ];
        for (input, want) in cases {
            assert_eq!(redact_url_credentials(input), want, "input: {input}");
        }
    }

    /// A string with no credentials is passed through by reference (the hot
    /// path: every argv of every invocation goes through here).
    #[test]
    fn redaction_borrows_when_nothing_to_do() {
        assert!(matches!(
            redact_url_credentials("status --porcelain=v2"),
            std::borrow::Cow::Borrowed(_)
        ));
        assert!(matches!(
            redact_url_credentials("https://github.com/o/r.git"),
            std::borrow::Cow::Borrowed(_)
        ));
        assert!(matches!(
            redact_url_credentials("https://u:p@h/x"),
            std::borrow::Cow::Owned(_)
        ));
    }

    /// Multi-byte content must not panic or corrupt (byte indices are taken
    /// from ASCII delimiters, so they stay on char boundaries).
    #[test]
    fn redaction_handles_non_ascii() {
        assert_eq!(
            redact_url_credentials("https://üser:pä@例え.jp/リポ"),
            "https://üser:***@例え.jp/リポ"
        );
        assert_eq!(redact_url_credentials("日本語 no url"), "日本語 no url");
    }
}
