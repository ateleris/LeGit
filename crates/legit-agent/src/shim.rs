//! Shim mode: this binary re-exec'd by git (credential helper) or ssh
//! (askpass). Forwards the request as one JSON line over the agent's Unix
//! socket (`LEGIT_CRED_SOCK`) and prints the answer in the caller's protocol.
//! Mirrors the app's TCP shim (`src-tauri/src/credentials.rs`); failure modes
//! match it: a helper that can't reach its relay contributes nothing (exit 0),
//! an askpass that can't answer declines (exit 1) so ssh never sees "" as a
//! passphrase.

#![cfg(unix)]

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};

use legit_proto::cred::{format_credential_output, parse_credential_input, ShimRelayRequest};
use legit_proto::CredAnswer;

/// Read timeout a little past the app broker's 300s prompt timeout, so a
/// legitimate slow user answer is not cut off but a wedged relay cannot hang
/// git forever.
const READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(330);

fn relay_exchange(op: &str, fields: HashMap<String, String>) -> Option<CredAnswer> {
    let sock = std::env::var("LEGIT_CRED_SOCK").ok()?;
    let token = std::env::var("LEGIT_CRED_TOKEN").ok()?;
    let stream = std::os::unix::net::UnixStream::connect(&sock).ok()?;
    stream.set_read_timeout(Some(READ_TIMEOUT)).ok()?;
    stream
        .set_write_timeout(Some(std::time::Duration::from_secs(10)))
        .ok()?;
    let cwd = std::env::current_dir()
        .ok()
        .map(|p| p.to_string_lossy().into_owned());
    let request = ShimRelayRequest {
        token,
        op: op.to_string(),
        fields,
        cwd,
    };
    let mut line = serde_json::to_string(&request).ok()?;
    line.push('\n');
    (&stream).write_all(line.as_bytes()).ok()?;

    let mut response_raw = String::new();
    BufReader::new(&stream).read_line(&mut response_raw).ok()?;
    serde_json::from_str(response_raw.trim()).ok()
}

pub fn run_credential_shim(op: &str) -> i32 {
    let mut input = String::new();
    if std::io::stdin().read_to_string(&mut input).is_err() {
        return 0;
    }
    let fields = parse_credential_input(&input);
    let Some(answer) = relay_exchange(op, fields) else {
        return 0;
    };
    if op == "get" && !answer.cancel {
        let mut fields: Vec<(&str, &str)> = Vec::new();
        if let Some(u) = answer.username.as_deref() {
            fields.push(("username", u));
        }
        if let Some(p) = answer.password.as_deref() {
            fields.push(("password", p));
        }
        print!("{}", format_credential_output(&fields));
    }
    0
}

pub fn run_askpass_shim(prompt: &str) -> i32 {
    let mut fields = HashMap::new();
    fields.insert("prompt".to_string(), prompt.to_string());
    let Some(answer) = relay_exchange("askpass", fields) else {
        return 1;
    };
    if answer.cancel {
        return 1;
    }
    let secret = answer.password.unwrap_or_default();
    if secret.contains('\n') || secret.contains('\0') {
        return 1;
    }
    println!("{secret}");
    0
}
