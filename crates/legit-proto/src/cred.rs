//! Credential-shim pieces shared by the app's TCP broker and the agent's
//! Unix-socket relay: the git credential protocol's text forms and the
//! wire-crossing answer shape.
//!
//! The flow, remote case: git (in the distro) runs the AGENT binary as its
//! credential helper / ssh askpass → the shim forwards the request over the
//! agent's Unix socket → the agent turns it into a `cred.request` on the
//! control channel → the app answers from its broker (session cache, OS
//! keychain, or a UI prompt) → the answer travels all the way back to git.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// The broker's answer to a shim request. Mirrors the app-internal
/// `ShimResponse`; `cancel` means "contribute nothing / decline".
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CredAnswer {
    pub username: Option<String>,
    pub password: Option<String>,
    pub cancel: bool,
}

/// One request from a shim to its local relay endpoint (JSON line over the
/// agent's Unix socket; same shape the app's TCP broker accepts).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShimRelayRequest {
    pub token: String,
    /// `get` / `store` / `erase` (git credential ops) or `askpass` (ssh).
    pub op: String,
    pub fields: HashMap<String, String>,
    pub cwd: Option<String>,
}

/// The `credential.helper` config value invoking `exe_path` in shim mode.
/// `!` marks a shell command (git runs helpers through `sh`), the path is
/// single-quoted so spaces survive word splitting, embedded single quotes are
/// escaped the POSIX way, and backslashes become forward slashes because
/// Git for Windows' sh resolves those more reliably.
pub fn build_helper_value(exe_path: &str) -> String {
    let normalized = exe_path.replace('\\', "/");
    let quoted = normalized.replace('\'', r"'\''");
    format!("!'{quoted}' --credential-helper")
}

/// Parse git's credential protocol input: `key=value` lines, terminated by a
/// blank line / EOF. Unknown keys are kept (echoing them back is harmless);
/// malformed lines are skipped.
pub fn parse_credential_input(input: &str) -> HashMap<String, String> {
    let mut fields = HashMap::new();
    for line in input.lines() {
        if line.is_empty() {
            break;
        }
        if let Some((key, value)) = line.split_once('=') {
            fields.insert(key.to_string(), value.to_string());
        }
    }
    fields
}

/// Serialize answer fields back to git (credential protocol output).
/// Values containing newlines would corrupt the protocol - skipped.
pub fn format_credential_output(fields: &[(&str, &str)]) -> String {
    let mut out = String::new();
    for (key, value) in fields {
        if value.contains('\n') || value.contains('\0') {
            continue;
        }
        out.push_str(key);
        out.push('=');
        out.push_str(value);
        out.push('\n');
    }
    out
}

/// The env every AGENT-side git invocation carries so shim re-execs of the
/// agent binary reach the agent's Unix-socket relay. Mirrors the app-side
/// `shim_env` (TCP) — the helper is appended LAST via `GIT_CONFIG_*`, so
/// user-configured helpers keep winning; ssh prompts route through
/// `SSH_ASKPASS` with the `LEGIT_SSH_ASKPASS` mode marker.
pub fn agent_shim_env(exe_path: &str, socket_path: &str, token: &str) -> Vec<(String, String)> {
    let helper = build_helper_value(exe_path);
    vec![
        ("LEGIT_CRED_SOCK".to_string(), socket_path.to_string()),
        ("LEGIT_CRED_TOKEN".to_string(), token.to_string()),
        ("GIT_CONFIG_COUNT".to_string(), "1".to_string()),
        ("GIT_CONFIG_KEY_0".to_string(), "credential.helper".to_string()),
        ("GIT_CONFIG_VALUE_0".to_string(), helper),
        ("SSH_ASKPASS".to_string(), exe_path.to_string()),
        ("SSH_ASKPASS_REQUIRE".to_string(), "force".to_string()),
        ("LEGIT_SSH_ASKPASS".to_string(), "1".to_string()),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn helper_value_quotes_and_normalizes() {
        assert_eq!(
            build_helper_value(r"C:\Program Files\LeGit\legit.exe"),
            "!'C:/Program Files/LeGit/legit.exe' --credential-helper"
        );
        assert_eq!(
            build_helper_value("/home/o'brien/agent"),
            r"!'/home/o'\''brien/agent' --credential-helper"
        );
    }

    #[test]
    fn credential_io_round_trips() {
        let fields = parse_credential_input("protocol=https\nhost=github.com\n\nnoise=after-blank");
        assert_eq!(fields.get("protocol").map(String::as_str), Some("https"));
        assert_eq!(fields.get("host").map(String::as_str), Some("github.com"));
        assert!(!fields.contains_key("noise"));
        let out = format_credential_output(&[("username", "u"), ("password", "p\nwned")]);
        assert_eq!(out, "username=u\n");
    }

    #[test]
    fn agent_shim_env_appends_helper_last_and_wires_askpass() {
        let env = agent_shim_env("/opt/agent", "/run/user/1000/legit.sock", "tok");
        let get = |k: &str| env.iter().find(|(key, _)| key == k).map(|(_, v)| v.as_str());
        assert_eq!(get("LEGIT_CRED_SOCK"), Some("/run/user/1000/legit.sock"));
        assert_eq!(get("GIT_CONFIG_VALUE_0"), Some("!'/opt/agent' --credential-helper"));
        assert_eq!(get("SSH_ASKPASS"), Some("/opt/agent"));
        assert_eq!(get("LEGIT_SSH_ASKPASS"), Some("1"));
    }
}
