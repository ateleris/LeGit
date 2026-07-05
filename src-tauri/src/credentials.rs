//! In-app git credential prompt.
//!
//! LeGit acts as its own `git credential` helper: every git invocation runs
//! with an env-injected `credential.helper` pointing back at this executable
//! in shim mode (`legit-app --credential-helper <op>`). The shim forwards
//! git's credential request over a localhost TCP connection to the running
//! app (the *broker*), which answers from the session cache, the OS keychain,
//! or by prompting the user in the UI.
//!
//! The helper is appended AFTER any user/profile-configured helper
//! (`GIT_CONFIG_*` env config applies last), so Git Credential Manager and
//! profile helpers keep winning where configured - LeGit only prompts when
//! nothing else produced credentials.
//!
//! Secret handling: credentials live in memory for the session; they are
//! written to the OS keychain (`keyring` crate) only when the user ticks
//! "remember" AND git confirms them via a `store` callback (wrong passwords
//! never reach the keychain; a git `erase` removes a stale entry). Nothing is
//! ever written to LeGit's settings files.
//!
//! # Trust boundary (same-user)
//!
//! The broker trusts any local process that presents the session token. The
//! token travels in the environment of every git child (`LEGIT_CRED_TOKEN`),
//! so any process running as the same user that can read a child's
//! environment (e.g. `/proc/<pid>/environ`) can impersonate a helper:
//! request credentials the session already holds, or trigger a
//! genuine-looking prompt. This is deliberately the same trust boundary as
//! git's own credential-helper model - a same-user process can equally well
//! run `git credential fill`, read the user's git config, or query the OS
//! keychain as that user - and LeGit does not attempt to defend against a
//! compromised local account. Two mitigations narrow the surface: the token
//! is a per-app-run UUID (a stale port squatter can't satisfy a new run),
//! and the prompt shows the requesting `protocol://host` plus the directory
//! the git operation ran in, so an unexpected prompt is recognizable.

use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tauri::Emitter;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::sync::oneshot;

/// Event asking the UI to show a credential prompt.
pub const CREDENTIAL_REQUEST_EVENT: &str = "legit://credential-request";
/// Event telling the UI a pending prompt is obsolete (git went away).
pub const CREDENTIAL_CLOSED_EVENT: &str = "legit://credential-closed";

/// How long a prompt may sit unanswered before the broker gives up and lets
/// git fail (classified as AuthFailed, same as before this feature existed).
const PROMPT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);

const KEYRING_SERVICE: &str = "LeGit Git Credentials";

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

/// The `credential.helper` config value invoking this executable in shim
/// mode. `!` marks a shell command (git runs helpers through `sh`), the path
/// is single-quoted so spaces survive word splitting (the exact failure mode
/// that breaks full-path helpers passed unquoted), embedded single quotes are
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

/// Cache/keychain key for a credential request: protocol + host (the host
/// field already carries a non-default port, per the credential protocol).
fn cred_key(fields: &HashMap<String, String>) -> Option<String> {
    let protocol = fields.get("protocol")?;
    let host = fields.get("host")?;
    Some(format!("{protocol}://{host}"))
}

/// Poison-proof lock: a panic in one handler must not permanently wedge
/// every later credential operation - the plain data inside stays usable.
fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

// ---------------------------------------------------------------------------
// Shim mode (runs in the short-lived helper process, no Tauri involved)
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize)]
struct ShimRequest {
    token: String,
    op: String,
    fields: HashMap<String, String>,
    /// The shim's working directory. git spawns helpers with its own cwd -
    /// the repo working tree of the triggering operation - so the prompt can
    /// tell the user where the request came from.
    #[serde(default)]
    cwd: Option<String>,
}

#[derive(Serialize, Deserialize, Default)]
struct ShimResponse {
    #[serde(default)]
    username: Option<String>,
    #[serde(default)]
    password: Option<String>,
    #[serde(default)]
    cancel: bool,
}

/// If this process was launched as a credential helper, run the shim and
/// `exit` - never returning to the caller. Must be called at the very top of
/// `run()`, before tracing/Tauri initialization.
pub fn maybe_run_credential_helper() {
    let mut args = std::env::args().skip(1);
    if args.next().as_deref() != Some("--credential-helper") {
        return;
    }
    let op = args.next().unwrap_or_default();
    // Any failure exits 0 with no output: a helper that contributes nothing
    // simply lets git fall through to its existing behavior.
    let code = run_shim(&op).unwrap_or(0);
    std::process::exit(code);
}

fn run_shim(op: &str) -> Option<i32> {
    let port: u16 = std::env::var("LEGIT_CRED_PORT").ok()?.parse().ok()?;
    let token = std::env::var("LEGIT_CRED_TOKEN").ok()?;

    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input).ok()?;
    let fields = parse_credential_input(&input);

    // Timeouts so a foreign process squatting on a stale port can never hang
    // git forever: connect fast, read a little longer than the broker's
    // prompt timeout (a legitimate slow user answer must not be cut off).
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream =
        std::net::TcpStream::connect_timeout(&addr, std::time::Duration::from_secs(5)).ok()?;
    stream
        .set_read_timeout(Some(PROMPT_TIMEOUT + std::time::Duration::from_secs(30)))
        .ok()?;
    stream
        .set_write_timeout(Some(std::time::Duration::from_secs(10)))
        .ok()?;
    let cwd = std::env::current_dir()
        .ok()
        .map(|p| p.to_string_lossy().into_owned());
    let request = ShimRequest { token, op: op.to_string(), fields, cwd };
    let mut line = serde_json::to_string(&request).ok()?;
    line.push('\n');
    std::io::Write::write_all(&mut stream, line.as_bytes()).ok()?;

    let mut response_raw = String::new();
    std::io::BufRead::read_line(
        &mut std::io::BufReader::new(&stream),
        &mut response_raw,
    )
    .ok()?;
    let response: ShimResponse = serde_json::from_str(response_raw.trim()).ok()?;

    if op == "get" && !response.cancel {
        let mut fields: Vec<(&str, &str)> = Vec::new();
        if let Some(u) = response.username.as_deref() {
            fields.push(("username", u));
        }
        if let Some(p) = response.password.as_deref() {
            fields.push(("password", p));
        }
        print!("{}", format_credential_output(&fields));
    }
    Some(0)
}

// ---------------------------------------------------------------------------
// Broker (runs inside the app)
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct StoredCred {
    username: String,
    password: String,
}

/// The user's answer to a prompt (or a cancel).
struct UiReply {
    username: String,
    password: String,
    remember: bool,
}

struct Broker {
    app: tauri::AppHandle,
    token: String,
    /// Prompts awaiting a `credential_respond` / `credential_cancel` command.
    pending: Mutex<HashMap<String, oneshot::Sender<Option<UiReply>>>>,
    /// Credentials for this app session (never persisted).
    session_cache: Mutex<HashMap<String, StoredCred>>,
    /// Keys the user asked to remember - written to the keychain only once
    /// git confirms the credentials via `store`.
    remember_intents: Mutex<HashSet<String>>,
}

static BROKER: OnceLock<std::sync::Arc<Broker>> = OnceLock::new();

/// Payload for `CREDENTIAL_REQUEST_EVENT`.
#[derive(Clone, Serialize)]
struct CredentialRequestPayload {
    request_id: String,
    protocol: String,
    host: String,
    username: Option<String>,
    /// Directory the triggering git operation ran in (its repo working
    /// tree), so the user can verify an unexpected prompt. Attribution only
    /// - not used for any decision.
    repo_dir: Option<String>,
}

#[derive(Clone, Serialize)]
struct CredentialClosedPayload {
    request_id: String,
}

/// Bind the localhost broker, spawn its accept loop, and return the env vars
/// every git invocation needs to reach it. Called once at app setup.
pub fn start_broker(app: tauri::AppHandle) -> std::io::Result<Vec<(String, String)>> {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0))?;
    listener.set_nonblocking(true)?;
    let port = listener.local_addr()?.port();
    let token = uuid::Uuid::new_v4().to_string();

    let broker = std::sync::Arc::new(Broker {
        app,
        token: token.clone(),
        pending: Mutex::new(HashMap::new()),
        session_cache: Mutex::new(HashMap::new()),
        remember_intents: Mutex::new(HashSet::new()),
    });
    let _ = BROKER.set(broker.clone());

    tauri::async_runtime::spawn(async move {
        let listener = match tokio::net::TcpListener::from_std(listener) {
            Ok(l) => l,
            Err(e) => {
                tracing::warn!(err = %e, "credential broker listener failed");
                return;
            }
        };
        loop {
            match listener.accept().await {
                Ok((stream, _)) => {
                    let broker = broker.clone();
                    tauri::async_runtime::spawn(async move {
                        if let Err(e) = handle_connection(broker, stream).await {
                            tracing::debug!(err = %e, "credential shim connection ended");
                        }
                    });
                }
                Err(e) => {
                    tracing::warn!(err = %e, "credential broker accept failed");
                    break;
                }
            }
        }
    });

    let exe = std::env::current_exe()?;
    let helper = build_helper_value(&exe.to_string_lossy());
    Ok(vec![
        ("LEGIT_CRED_PORT".to_string(), port.to_string()),
        ("LEGIT_CRED_TOKEN".to_string(), token),
        // Env config applies after all config files, like `-c` - so the shim
        // lands at the END of the helper list and only fires when no other
        // configured helper produced credentials.
        ("GIT_CONFIG_COUNT".to_string(), "1".to_string()),
        ("GIT_CONFIG_KEY_0".to_string(), "credential.helper".to_string()),
        ("GIT_CONFIG_VALUE_0".to_string(), helper),
    ])
}

async fn handle_connection(
    broker: std::sync::Arc<Broker>,
    stream: tokio::net::TcpStream,
) -> std::io::Result<()> {
    let (read_half, mut write_half) = stream.into_split();
    let mut reader = BufReader::new(read_half);

    let mut line = String::new();
    reader.read_line(&mut line).await?;
    let request: ShimRequest = match serde_json::from_str(line.trim()) {
        Ok(r) => r,
        Err(_) => return Ok(()),
    };
    if request.token != broker.token {
        tracing::warn!("credential shim connected with a bad token - ignoring");
        return Ok(());
    }

    let response = match request.op.as_str() {
        "get" => handle_get(&broker, &request.fields, request.cwd.as_deref(), &mut reader).await,
        "store" => {
            handle_store(&broker, &request.fields);
            ShimResponse::default()
        }
        "erase" => {
            handle_erase(&broker, &request.fields);
            ShimResponse::default()
        }
        _ => ShimResponse { cancel: true, ..Default::default() },
    };

    let mut out = serde_json::to_string(&response).unwrap_or_else(|_| "{}".into());
    out.push('\n');
    write_half.write_all(out.as_bytes()).await?;
    Ok(())
}

async fn handle_get(
    broker: &std::sync::Arc<Broker>,
    fields: &HashMap<String, String>,
    cwd: Option<&str>,
    reader: &mut BufReader<tokio::net::tcp::OwnedReadHalf>,
) -> ShimResponse {
    let cancel = ShimResponse { cancel: true, ..Default::default() };
    let Some(key) = cred_key(fields) else { return cancel };
    let wanted_user = fields.get("username").cloned();

    // 1. Session cache (this app run).
    if let Some(hit) = lock(&broker.session_cache).get(&key) {
        if wanted_user.as_deref().is_none_or(|u| u == hit.username) {
            return ShimResponse {
                username: Some(hit.username.clone()),
                password: Some(hit.password.clone()),
                cancel: false,
            };
        }
    }

    // 2. OS keychain (remembered in an earlier run). Blocking API.
    let keyring_key = key.clone();
    let stored = tauri::async_runtime::spawn_blocking(move || keyring_load(&keyring_key))
        .await
        .ok()
        .flatten();
    if let Some(hit) = stored {
        if wanted_user.as_deref().is_none_or(|u| u == hit.username) {
            broker
                .session_cache
                .lock()
                .unwrap()
                .insert(key, hit.clone());
            return ShimResponse {
                username: Some(hit.username),
                password: Some(hit.password),
                cancel: false,
            };
        }
    }

    // 3. Prompt the user.
    let request_id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = oneshot::channel();
    broker
        .pending
        .lock()
        .unwrap()
        .insert(request_id.clone(), tx);
    let _ = broker.app.emit(
        CREDENTIAL_REQUEST_EVENT,
        CredentialRequestPayload {
            request_id: request_id.clone(),
            protocol: fields.get("protocol").cloned().unwrap_or_default(),
            host: fields.get("host").cloned().unwrap_or_default(),
            username: wanted_user,
            repo_dir: cwd.map(str::to_string),
        },
    );

    // Wait for the answer - but also notice the shim hanging up (the git
    // process was cancelled/killed), so the UI prompt doesn't outlive git.
    let mut eof_probe = [0u8; 1];
    let reply = tokio::select! {
        reply = rx => reply.ok().flatten(),
        _ = reader.read(&mut eof_probe) => None, // EOF or unexpected chatter
        _ = tokio::time::sleep(PROMPT_TIMEOUT) => None,
    };
    lock(&broker.pending).remove(&request_id);

    match reply {
        Some(reply) => {
            lock(&broker.session_cache).insert(
                key.clone(),
                StoredCred {
                    username: reply.username.clone(),
                    password: reply.password.clone(),
                },
            );
            if reply.remember {
                lock(&broker.remember_intents).insert(key);
            }
            ShimResponse {
                username: Some(reply.username),
                password: Some(reply.password),
                cancel: false,
            }
        }
        None => {
            // Tell the UI the prompt is moot (git gone / timed out / cancel).
            let _ = broker
                .app
                .emit(CREDENTIAL_CLOSED_EVENT, CredentialClosedPayload { request_id });
            cancel
        }
    }
}

/// `store`: git confirmed the credentials worked. Refresh the session cache
/// and persist to the keychain when the user asked to remember them.
fn handle_store(broker: &Broker, fields: &HashMap<String, String>) {
    let Some(key) = cred_key(fields) else { return };
    let (Some(username), Some(password)) = (fields.get("username"), fields.get("password"))
    else {
        return;
    };
    lock(&broker.session_cache).insert(
        key.clone(),
        StoredCred { username: username.clone(), password: password.clone() },
    );
    if lock(&broker.remember_intents).remove(&key) {
        let cred = StoredCred { username: username.clone(), password: password.clone() };
        tauri::async_runtime::spawn_blocking(move || {
            if let Err(e) = keyring_save(&key, &cred) {
                tracing::warn!(err = %e, "failed to save credentials to the OS keychain");
            }
        });
    }
}

/// `erase`: git rejected the credentials. Drop them everywhere so the next
/// attempt prompts fresh instead of replaying a bad secret.
fn handle_erase(broker: &Broker, fields: &HashMap<String, String>) {
    let Some(key) = cred_key(fields) else { return };
    lock(&broker.session_cache).remove(&key);
    lock(&broker.remember_intents).remove(&key);
    tauri::async_runtime::spawn_blocking(move || {
        let _ = keyring::Entry::new(KEYRING_SERVICE, &key).and_then(|e| e.delete_credential());
    });
}

// ---------------------------------------------------------------------------
// Keychain (secret = JSON {username, password}, one entry per protocol+host)
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize)]
struct KeychainSecret {
    username: String,
    password: String,
}

fn keyring_load(key: &str) -> Option<StoredCred> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, key).ok()?;
    let secret = entry.get_password().ok()?;
    let parsed: KeychainSecret = serde_json::from_str(&secret).ok()?;
    Some(StoredCred { username: parsed.username, password: parsed.password })
}

fn keyring_save(key: &str, cred: &StoredCred) -> Result<(), keyring::Error> {
    let secret = serde_json::to_string(&KeychainSecret {
        username: cred.username.clone(),
        password: cred.password.clone(),
    })
    .expect("keychain secret serializes");
    keyring::Entry::new(KEYRING_SERVICE, key)?.set_password(&secret)
}

// ---------------------------------------------------------------------------
// UI-facing entry points (called by the credential commands)
// ---------------------------------------------------------------------------

/// Complete a pending prompt with the user's credentials. Returns false when
/// the prompt no longer exists (git already went away or it timed out).
pub fn respond(request_id: &str, username: String, password: String, remember: bool) -> bool {
    let Some(broker) = BROKER.get() else { return false };
    let Some(tx) = lock(&broker.pending).remove(request_id) else {
        return false;
    };
    tx.send(Some(UiReply { username, password, remember })).is_ok()
}

/// Cancel a pending prompt (the user dismissed the dialog).
pub fn cancel(request_id: &str) -> bool {
    let Some(broker) = BROKER.get() else { return false };
    let Some(tx) = lock(&broker.pending).remove(request_id) else {
        return false;
    };
    tx.send(None).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn helper_value_quotes_and_normalizes_the_exe_path() {
        assert_eq!(
            build_helper_value(r"C:\Program Files\LeGit\legit-app.exe"),
            "!'C:/Program Files/LeGit/legit-app.exe' --credential-helper",
        );
        // Embedded single quote: POSIX close-escape-reopen.
        assert_eq!(
            build_helper_value("/opt/le'git/app"),
            r"!'/opt/le'\''git/app' --credential-helper",
        );
    }

    #[test]
    fn parses_credential_protocol_input() {
        let fields = parse_credential_input(
            "protocol=https\nhost=github.com\nusername=simon\n\nignored=after-blank\n",
        );
        assert_eq!(fields.get("protocol").unwrap(), "https");
        assert_eq!(fields.get("host").unwrap(), "github.com");
        assert_eq!(fields.get("username").unwrap(), "simon");
        assert!(!fields.contains_key("ignored"));
    }

    #[test]
    fn parses_values_containing_equals() {
        let fields = parse_credential_input("password=a=b=c\n");
        assert_eq!(fields.get("password").unwrap(), "a=b=c");
    }

    #[test]
    fn formats_output_and_skips_protocol_breaking_values() {
        let out = format_credential_output(&[
            ("username", "simon"),
            ("password", "p=w:d"),
            ("evil", "a\nb"),
        ]);
        assert_eq!(out, "username=simon\npassword=p=w:d\n");
    }

    #[test]
    fn cred_key_needs_protocol_and_host() {
        let mut fields = HashMap::new();
        fields.insert("protocol".to_string(), "https".to_string());
        assert_eq!(cred_key(&fields), None);
        fields.insert("host".to_string(), "example.com:8443".to_string());
        assert_eq!(cred_key(&fields).unwrap(), "https://example.com:8443");
    }
}
