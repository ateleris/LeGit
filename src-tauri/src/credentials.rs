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
//! The same broker also answers **ssh askpass** prompts (`SSH_ASKPASS`
//! pointing back at this executable; mode marker `LEGIT_SSH_ASKPASS` because
//! ssh passes no argv flags): key passphrases, first-connect host-key
//! confirmations, and anything else ssh asks. Passphrases are cached in
//! memory for the session only - never the keychain, never disk - and a
//! wrong one is evicted when ssh's "Bad passphrase, try again" retry prompt
//! names its key (ssh has no store/erase confirmation protocol).
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
/// Event asking the UI to show an ssh askpass prompt (passphrase / host-key
/// confirmation / other).
pub const ASKPASS_REQUEST_EVENT: &str = "legit://askpass-request";
/// Event telling the UI a pending askpass prompt is obsolete.
pub const ASKPASS_CLOSED_EVENT: &str = "legit://askpass-closed";

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

/// What an ssh askpass prompt is asking for. Classified backend-side (pure,
/// tested) so the UI can render the right dialog: masked passphrase input,
/// a yes/no host-key confirmation, or a generic input for anything else.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AskpassKind {
    /// "Enter passphrase for [key] '<path>':" - and its "Bad passphrase, try
    /// again" retry form. `retry` MUST evict any session-cached passphrase
    /// for the key, or a wrong cached answer would replay until ssh gives up.
    Passphrase { key_path: String, retry: bool },
    /// A yes/no question, e.g. first-connect host-key verification. The raw
    /// prompt (with the fingerprint) is shown verbatim; the answer is the
    /// literal "yes" or "no".
    Confirmation,
    /// Anything else (e.g. security-key PINs): generic masked input.
    Other,
}

/// Classify an ssh prompt handed to `SSH_ASKPASS` (the prompt text is the
/// shim's argv[1]). Wordings follow OpenSSH; unknown shapes degrade to
/// `Other`, which still works - it just prompts generically.
pub fn classify_askpass_prompt(prompt: &str) -> AskpassKind {
    let quoted_path = |p: &str| -> Option<String> {
        let start = p.find('\'')? + 1;
        let end = start + p[start..].find('\'')?;
        Some(p[start..end].to_string())
    };
    if prompt.starts_with("Enter passphrase for ") {
        if let Some(key_path) = quoted_path(prompt) {
            return AskpassKind::Passphrase { key_path, retry: false };
        }
    }
    if prompt.starts_with("Bad passphrase, try again for ") {
        if let Some(key_path) = quoted_path(prompt) {
            return AskpassKind::Passphrase { key_path, retry: true };
        }
    }
    if prompt.contains("(yes/no") {
        return AskpassKind::Confirmation;
    }
    AskpassKind::Other
}

/// The env vars every git invocation carries so shim re-execs of this binary
/// can reach the broker: the credential-helper config (appended LAST in the
/// helper chain) and the ssh askpass wiring. `SSH_ASKPASS` is execed by ssh
/// directly (no shell), so it gets the bare normalized path, unquoted;
/// `SSH_ASKPASS_REQUIRE=force` makes ssh use it even with a TTY / without a
/// DISPLAY (OpenSSH >= 8.4, which Git for Windows has shipped for years);
/// `LEGIT_SSH_ASKPASS` is the mode marker - ssh passes no argv flags, so the
/// shim recognizes askpass invocations by env instead.
pub fn shim_env(exe_path: &str, port: u16, token: &str) -> Vec<(String, String)> {
    let helper = build_helper_value(exe_path);
    let askpass_path = exe_path.replace('\\', "/");
    vec![
        ("LEGIT_CRED_PORT".to_string(), port.to_string()),
        ("LEGIT_CRED_TOKEN".to_string(), token.to_string()),
        // Env config applies after all config files, like `-c` - so the shim
        // lands at the END of the helper list and only fires when no other
        // configured helper produced credentials.
        ("GIT_CONFIG_COUNT".to_string(), "1".to_string()),
        ("GIT_CONFIG_KEY_0".to_string(), "credential.helper".to_string()),
        ("GIT_CONFIG_VALUE_0".to_string(), helper),
        ("SSH_ASKPASS".to_string(), askpass_path),
        ("SSH_ASKPASS_REQUIRE".to_string(), "force".to_string()),
        ("LEGIT_SSH_ASKPASS".to_string(), "1".to_string()),
    ]
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

/// If this process was launched as a shim - git's credential helper
/// (`--credential-helper <op>` argv) or ssh's askpass (the `LEGIT_SSH_ASKPASS`
/// env marker, since `SSH_ASKPASS` is a bare program path and ssh passes only
/// the prompt as argv[1]) - run it and `exit`, never returning to the caller.
/// Must be called at the very top of `run()`, before tracing/Tauri init.
pub fn maybe_run_credential_helper() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("--credential-helper") {
        let op = args.get(1).cloned().unwrap_or_default();
        // Any failure exits 0 with no output: a helper that contributes
        // nothing simply lets git fall through to its existing behavior.
        let code = run_shim(&op).unwrap_or(0);
        std::process::exit(code);
    }
    if std::env::var_os("LEGIT_SSH_ASKPASS").is_some() {
        if let Some(prompt) = args.first() {
            // Failure exits 1: unlike the credential helper's fall-through,
            // exit 0 with empty stdout would make ssh treat "" as the
            // passphrase and burn an attempt.
            let code = run_askpass_shim(prompt).unwrap_or(1);
            std::process::exit(code);
        }
    }
}

/// One request/response exchange with the broker over its localhost socket.
/// Timeouts so a foreign process squatting on a stale port can never hang
/// git forever: connect fast, read a little longer than the broker's prompt
/// timeout (a legitimate slow user answer must not be cut off).
fn shim_exchange(
    port: u16,
    token: String,
    op: &str,
    fields: HashMap<String, String>,
) -> Option<ShimResponse> {
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
    serde_json::from_str(response_raw.trim()).ok()
}

fn run_shim(op: &str) -> Option<i32> {
    let port: u16 = std::env::var("LEGIT_CRED_PORT").ok()?.parse().ok()?;
    let token = std::env::var("LEGIT_CRED_TOKEN").ok()?;

    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input).ok()?;
    let fields = parse_credential_input(&input);
    let response = shim_exchange(port, token, op, fields)?;

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

/// ssh askpass mode: forward the prompt (argv[1]) to the broker, print the
/// answer on stdout. Non-zero exit = declined (user cancel, broker gone) -
/// ssh then aborts its prompt instead of trying an empty passphrase.
fn run_askpass_shim(prompt: &str) -> Option<i32> {
    let port: u16 = std::env::var("LEGIT_CRED_PORT").ok()?.parse().ok()?;
    let token = std::env::var("LEGIT_CRED_TOKEN").ok()?;
    let mut fields = HashMap::new();
    fields.insert("prompt".to_string(), prompt.to_string());
    let response = shim_exchange(port, token, "askpass", fields)?;
    if response.cancel {
        return Some(1);
    }
    let answer = response.password.unwrap_or_default();
    if answer.contains('\n') || answer.contains('\0') {
        return Some(1);
    }
    println!("{answer}");
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
    /// SSH key passphrases for this app session, keyed by key path. Memory
    /// ONLY - never the keychain, never disk (unlike HTTPS credentials there
    /// is no "remember" offer; the stores-no-secrets stance applies to
    /// anything that outlives the process). ssh gives no store/erase
    /// confirmation, so a wrong entry is evicted when the "Bad passphrase,
    /// try again" retry prompt names its key.
    askpass_cache: Mutex<HashMap<String, String>>,
    /// The broker's port, for handing the shim env to non-runner children
    /// (the `ssh -T` probe builds its own Command).
    port: u16,
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
        askpass_cache: Mutex::new(HashMap::new()),
        port,
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
    Ok(shim_env(&exe.to_string_lossy(), port, &token))
}

/// The askpass/broker env for child processes that do NOT go through the
/// runner (the `ssh -T` probe builds its own Command). None while the broker
/// isn't running (then such children stay non-interactive, as before).
pub fn askpass_child_env() -> Option<Vec<(String, String)>> {
    let broker = BROKER.get()?;
    let exe = std::env::current_exe().ok()?;
    Some(shim_env(&exe.to_string_lossy(), broker.port, &broker.token))
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
        "askpass" => {
            handle_askpass(&broker, &request.fields, request.cwd.as_deref(), &mut reader).await
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
            lock(&broker.session_cache).insert(key, hit.clone());
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
    lock(&broker.pending).insert(request_id.clone(), tx);
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

/// Payload for `ASKPASS_REQUEST_EVENT`. `kind` drives the dialog shape;
/// `prompt` is ssh's raw text (shown verbatim for confirmations - the
/// host-key fingerprint must reach the user unaltered).
#[derive(Clone, Serialize)]
struct AskpassRequestPayload {
    request_id: String,
    prompt: String,
    /// "passphrase" | "confirmation" | "other"
    kind: &'static str,
    key_path: Option<String>,
    /// A repeat after a wrong passphrase (the dialog says so).
    retry: bool,
    repo_dir: Option<String>,
}

/// `askpass`: an ssh prompt forwarded by the askpass shim. Passphrases are
/// answered from the in-memory session cache when possible; everything else
/// prompts the user. The answer travels back in `password`.
async fn handle_askpass(
    broker: &std::sync::Arc<Broker>,
    fields: &HashMap<String, String>,
    cwd: Option<&str>,
    reader: &mut BufReader<tokio::net::tcp::OwnedReadHalf>,
) -> ShimResponse {
    let cancel = ShimResponse { cancel: true, ..Default::default() };
    let Some(prompt) = fields.get("prompt") else { return cancel };
    let kind = classify_askpass_prompt(prompt);

    let (kind_str, key_path, retry) = match &kind {
        AskpassKind::Passphrase { key_path, retry } => {
            if *retry {
                // The cached passphrase was wrong - evict it, or it would be
                // replayed until ssh gives up.
                lock(&broker.askpass_cache).remove(key_path);
            } else if let Some(hit) = lock(&broker.askpass_cache).get(key_path) {
                return ShimResponse {
                    username: None,
                    password: Some(hit.clone()),
                    cancel: false,
                };
            }
            ("passphrase", Some(key_path.clone()), *retry)
        }
        AskpassKind::Confirmation => ("confirmation", None, false),
        AskpassKind::Other => ("other", None, false),
    };

    let request_id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = oneshot::channel();
    lock(&broker.pending).insert(request_id.clone(), tx);
    let _ = broker.app.emit(
        ASKPASS_REQUEST_EVENT,
        AskpassRequestPayload {
            request_id: request_id.clone(),
            prompt: prompt.clone(),
            kind: kind_str,
            key_path: key_path.clone(),
            retry,
            repo_dir: cwd.map(str::to_string),
        },
    );

    // Same 3-way wait as handle_get: answer, shim hangup (ssh/git killed),
    // or timeout.
    let mut eof_probe = [0u8; 1];
    let reply = tokio::select! {
        reply = rx => reply.ok().flatten(),
        _ = reader.read(&mut eof_probe) => None,
        _ = tokio::time::sleep(PROMPT_TIMEOUT) => None,
    };
    lock(&broker.pending).remove(&request_id);

    match reply {
        Some(reply) => {
            // Session-cache passphrases only: confirmations/other answers are
            // one-shot by nature.
            if let (Some(path), "passphrase") = (key_path, kind_str) {
                lock(&broker.askpass_cache).insert(path, reply.password.clone());
            }
            ShimResponse { username: None, password: Some(reply.password), cancel: false }
        }
        None => {
            let _ = broker
                .app
                .emit(ASKPASS_CLOSED_EVENT, CredentialClosedPayload { request_id });
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

/// Does git's `erase` name the credential we hold? git erases the credential
/// it REJECTED, which may have come from an earlier helper in the chain, so a
/// differing username/password must leave ours alone (git-credential-store
/// applies the same rule). Fields git omits are not constraints.
fn erase_applies(stored: &StoredCred, fields: &HashMap<String, String>) -> bool {
    fields.get("username").is_none_or(|u| *u == stored.username)
        && fields.get("password").is_none_or(|p| *p == stored.password)
}

/// `erase`: git rejected the credentials. Drop them everywhere so the next
/// attempt prompts fresh instead of replaying a bad secret.
fn handle_erase(broker: &Broker, fields: &HashMap<String, String>) {
    let Some(key) = cred_key(fields) else { return };
    let mut cache = lock(&broker.session_cache);
    if cache.get(&key).is_some_and(|c| !erase_applies(c, fields)) {
        return;
    }
    cache.remove(&key);
    drop(cache);
    lock(&broker.remember_intents).remove(&key);
    let fields = fields.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if keyring_load(&key).is_some_and(|stored| !erase_applies(&stored, &fields)) {
            return;
        }
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
// Connected-accounts interop (commands/accounts.rs)
// ---------------------------------------------------------------------------
// A connected account's token is stored under the SAME service/key/format as
// broker-remembered passwords, so `git credential fill` answers with it
// without any broker change. All three are blocking (keyring): call them
// from spawn_blocking.

pub(crate) fn keychain_store(
    key: &str,
    username: &str,
    password: &str,
) -> Result<(), keyring::Error> {
    keyring_save(
        key,
        &StoredCred { username: username.to_string(), password: password.to_string() },
    )
}

pub(crate) fn keychain_read(key: &str) -> Option<(String, String)> {
    keyring_load(key).map(|c| (c.username, c.password))
}

pub(crate) fn keychain_delete(key: &str) -> Result<(), keyring::Error> {
    keyring::Entry::new(KEYRING_SERVICE, key)?.delete_credential()
}

/// Evict a host's session-cache entry so the next `fill` re-reads the
/// keychain. Needed when a connected account replaces or removes the stored
/// secret: the session cache is consulted BEFORE the keychain, so a stale
/// entry would shadow the new token until the app restarts.
pub(crate) fn forget_session(key: &str) {
    if let Some(broker) = BROKER.get() {
        lock(&broker.session_cache).remove(key);
    }
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

    // git sends `erase` for the credential it REJECTED, which may have come
    // from an earlier helper in the chain (a stale store entry). Like
    // credential-store, only an entry matching every supplied field is
    // dropped, so a rejected stale token cannot evict LeGit's own entry.
    #[test]
    fn erase_only_drops_the_credential_git_actually_rejected() {
        let stored = StoredCred { username: "simon".into(), password: "ghp_new".into() };
        let fields = |pairs: &[(&str, &str)]| -> HashMap<String, String> {
            pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
        };
        assert!(erase_applies(&stored, &fields(&[("username", "simon"), ("password", "ghp_new")])));
        assert!(erase_applies(&stored, &fields(&[("username", "simon")])));
        assert!(erase_applies(&stored, &fields(&[])));
        assert!(!erase_applies(&stored, &fields(&[("username", "simon"), ("password", "ghp_stale")])));
        assert!(!erase_applies(&stored, &fields(&[("username", "other"), ("password", "ghp_new")])));
        assert!(!erase_applies(&stored, &fields(&[("username", "other")])));
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
    fn askpass_classifies_passphrase_prompts_and_extracts_the_key_path() {
        assert_eq!(
            classify_askpass_prompt("Enter passphrase for key '/home/u/.ssh/id_ed25519': "),
            AskpassKind::Passphrase {
                key_path: "/home/u/.ssh/id_ed25519".into(),
                retry: false,
            }
        );
        // Some ssh builds omit the word "key".
        assert_eq!(
            classify_askpass_prompt("Enter passphrase for 'C:/Users/u/.ssh/id_rsa': "),
            AskpassKind::Passphrase {
                key_path: "C:/Users/u/.ssh/id_rsa".into(),
                retry: false,
            }
        );
    }

    #[test]
    fn askpass_classifies_bad_passphrase_retries() {
        // The retry prompt MUST be recognized: it evicts the session-cached
        // passphrase, otherwise a wrong cached answer would be replayed until
        // ssh gives up.
        assert_eq!(
            classify_askpass_prompt("Bad passphrase, try again for '/home/s/.ssh/id_ed25519': "),
            AskpassKind::Passphrase { key_path: "/home/s/.ssh/id_ed25519".into(), retry: true }
        );
    }

    #[test]
    fn askpass_classifies_host_key_confirmations() {
        assert_eq!(
            classify_askpass_prompt(
                "The authenticity of host 'github.com (140.82.121.4)' can't be established.\n\
                 ED25519 key fingerprint is SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU.\n\
                 Are you sure you want to continue connecting (yes/no/[fingerprint])? "
            ),
            AskpassKind::Confirmation
        );
    }

    #[test]
    fn askpass_unknown_prompts_are_other() {
        assert_eq!(classify_askpass_prompt("PIN for authenticator: "), AskpassKind::Other);
        assert_eq!(classify_askpass_prompt(""), AskpassKind::Other);
    }

    #[test]
    fn shim_env_wires_helper_and_askpass() {
        let env = shim_env(r"C:\Program Files\LeGit\legit-app.exe", 4321, "tok-1");
        let get = |k: &str| {
            env.iter()
                .find(|(key, _)| key == k)
                .map(|(_, v)| v.as_str())
                .unwrap_or_else(|| panic!("missing env {k}"))
        };
        assert_eq!(get("LEGIT_CRED_PORT"), "4321");
        assert_eq!(get("LEGIT_CRED_TOKEN"), "tok-1");
        assert_eq!(
            get("GIT_CONFIG_VALUE_0"),
            "!'C:/Program Files/LeGit/legit-app.exe' --credential-helper"
        );
        // ssh execs SSH_ASKPASS directly (no shell): bare path, slashes
        // normalized, NO quoting.
        assert_eq!(get("SSH_ASKPASS"), "C:/Program Files/LeGit/legit-app.exe");
        // force: askpass must be used even without a DISPLAY / with a TTY.
        assert_eq!(get("SSH_ASKPASS_REQUIRE"), "force");
        // The mode marker: SSH_ASKPASS passes no argv flags, so the shim
        // recognizes askpass invocations by this env var instead.
        assert_eq!(get("LEGIT_SSH_ASKPASS"), "1");
    }

    #[test]
    fn shim_exchange_round_trips_an_askpass_request() {
        // A scripted one-connection broker: accept, read the request line,
        // assert shape, answer. Exercises the real client I/O path.
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut reader = std::io::BufReader::new(stream.try_clone().unwrap());
            let mut line = String::new();
            std::io::BufRead::read_line(&mut reader, &mut line).unwrap();
            let req: ShimRequest = serde_json::from_str(line.trim()).unwrap();
            assert_eq!(req.token, "tok");
            assert_eq!(req.op, "askpass");
            assert_eq!(req.fields.get("prompt").unwrap(), "Enter passphrase for key '/k': ");
            let mut stream = stream;
            std::io::Write::write_all(
                &mut stream,
                b"{\"password\":\"sesame\",\"cancel\":false}\n",
            )
            .unwrap();
        });

        let mut fields = HashMap::new();
        fields.insert("prompt".to_string(), "Enter passphrase for key '/k': ".to_string());
        let response = shim_exchange(port, "tok".into(), "askpass", fields).unwrap();
        assert_eq!(response.password.as_deref(), Some("sesame"));
        assert!(!response.cancel);
        server.join().unwrap();
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
