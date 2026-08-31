//! Wire protocol between the app and a `legit-agent` process.
//!
//! Transport: a pair of byte-clean pipes (wsl.exe/ssh stdio, or a spawned
//! child in tests). Framing: NDJSON — one JSON object per `\n`-terminated
//! UTF-8 line; binary payloads are base64 fields. NDJSON over LSP-style
//! `Content-Length` framing because it is less code, debuggable by running
//! the agent in a terminal, and resyncs at the next newline after a corrupt
//! line instead of desyncing forever.
//!
//! The stream starts with the agent's READY line (`LEGIT-AGENT-READY v<proto>
//! <agent-version>`); the app discards bytes until it sees it — the agent is
//! spawned through a login shell, which may print banners first.
//!
//! The channel is BIDIRECTIONAL: the app sends requests (git/fs/watch), and
//! the agent both answers them and sends its own (credential relay), plus
//! notifications (invocation log, progress, stream events, watch batches).
//! Version policy: EXACT match of `PROTO_VERSION` and app/agent version —
//! deploy is version-locked, so a mismatch means "redeploy", not "negotiate".

use base64::Engine as _;
use legit_core::{
    FsError, FsProbe, GitInvocation, HostPath, OperationId, RemoteProgress, RunnerError,
    RunnerEvent,
};
use legit_watch::WatchBatch;
use serde::{Deserialize, Serialize};

pub mod cred;
pub use cred::{CredAnswer, ShimRelayRequest};

pub const PROTO_VERSION: u32 = 1;

/// First line the agent prints once it is ready to speak the protocol.
pub const READY_PREFIX: &str = "LEGIT-AGENT-READY ";

pub fn ready_line(agent_version: &str) -> String {
    format!("{READY_PREFIX}v{PROTO_VERSION} {agent_version}")
}

/// Parse a READY line into `(proto_version, agent_version)`.
pub fn parse_ready_line(line: &str) -> Option<(u32, String)> {
    let rest = line.trim().strip_prefix(READY_PREFIX)?;
    let (v, version) = rest.split_once(' ')?;
    let proto = v.strip_prefix('v')?.parse().ok()?;
    Some((proto, version.trim().to_string()))
}

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum Frame {
    Req { id: u64, method: Method },
    Res { id: u64, #[serde(flatten)] outcome: Outcome },
    Note { note: Note },
}

/// A response body: exactly one of `ok` / `err`. Flattened into the `Res`
/// frame so the wire shape is `{"t":"res","id":1,"ok":{...}}` or
/// `{"t":"res","id":1,"err":{...}}`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum Outcome {
    #[serde(rename = "ok")]
    Ok(serde_json::Value),
    #[serde(rename = "err")]
    Err(WireError),
}

impl Outcome {
    pub fn into_result(self) -> Result<serde_json::Value, WireError> {
        match self {
            Outcome::Ok(v) => Ok(v),
            Outcome::Err(e) => Err(e),
        }
    }
}

/// Extract the `id` of a request line whose `method` failed to parse (unknown
/// or malformed), so the receiver can still answer with an error instead of
/// leaving the caller hanging.
pub fn extract_request_id(line: &str) -> Option<u64> {
    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    (v.get("t")? == "req").then(|| v.get("id")?.as_u64())?
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WireErrorKind {
    /// Handshake proto/app version mismatch: the deployer must redeploy.
    VersionMismatch,
    /// The receiver does not know the method (or could not parse the frame).
    UnknownMethod,
    GitNotFound,
    Spawn,
    DuplicateOperation,
    FsNotFound,
    FsTooLarge,
    Io,
    /// The connection died with the call in flight (client-synthesized).
    AgentGone,
    Internal,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WireError {
    pub kind: WireErrorKind,
    pub message: String,
}

impl WireError {
    pub fn new(kind: WireErrorKind, message: impl Into<String>) -> Self {
        Self { kind, message: message.into() }
    }
}

impl std::fmt::Display for WireError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl From<&RunnerError> for WireError {
    fn from(e: &RunnerError) -> Self {
        let kind = match e {
            RunnerError::Spawn(_) => WireErrorKind::Spawn,
            RunnerError::Io(_) => WireErrorKind::Io,
            RunnerError::GitNotFound(_) => WireErrorKind::GitNotFound,
            RunnerError::DuplicateOperation(_) => WireErrorKind::DuplicateOperation,
        };
        WireError::new(kind, e.to_string())
    }
}

impl From<&FsError> for WireError {
    fn from(e: &FsError) -> Self {
        let kind = match e {
            FsError::NotFound { .. } => WireErrorKind::FsNotFound,
            FsError::TooLarge { .. } => WireErrorKind::FsTooLarge,
            FsError::Io { .. } => WireErrorKind::Io,
            FsError::HostGone(_) => WireErrorKind::AgentGone,
        };
        WireError::new(kind, e.to_string())
    }
}

impl WireError {
    /// Client-side reconstruction of a typed `FsError` (the `RepoFs` contract).
    pub fn into_fs_error(self, path: &HostPath) -> FsError {
        match self.kind {
            WireErrorKind::FsNotFound => FsError::NotFound { path: path.0.clone() },
            WireErrorKind::AgentGone => FsError::HostGone(self.message),
            _ => FsError::Io {
                path: path.0.clone(),
                message: self.message,
            },
        }
    }
}

// ---------------------------------------------------------------------------
// Methods (requests)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "m", rename_all = "snake_case")]
pub enum Method {
    // App → agent.
    Handshake(HandshakeParams),
    GitRun(GitRunParams),
    GitStream(GitStreamParams),
    GitCancel { op_id: OperationId },
    FsStat { path: HostPath },
    FsRead { path: HostPath, cap: Option<u64> },
    FsProbeMany { paths: Vec<HostPath>, cap_each: u64 },
    FsWrite { path: HostPath, data_b64: String },
    FsMkdirp { path: HostPath },
    FsRemoveFile { path: HostPath },
    FsRemoveDirAll { path: HostPath },
    FsCanonicalize { path: HostPath },
    FsReadDir { path: HostPath },
    FsTempPath { prefix: String },
    WatchStart { watch_id: u64, worktree: HostPath, git_dir: HostPath },
    WatchStop { watch_id: u64 },
    HostSpawn { program: String, args: Vec<String>, cwd: Option<HostPath> },
    GitProbe { git_path: HostPath },
    Shutdown,
    // Agent → app (credential relay; see `credentials.rs`).
    CredRequest(CredRequestParams),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HandshakeParams {
    pub proto_version: u32,
    pub app_version: String,
    /// Extra process-global base-env entries the agent applies (after the
    /// hardened defaults) before constructing any runner — the same
    /// snapshot-at-construction semantics as `set_global_base_env`.
    pub base_env_extra: Vec<(String, String)>,
    /// Have the agent host a Unix-socket credential relay and point every git
    /// invocation's helper/askpass at itself, forwarding requests over this
    /// connection as `cred.request` (see `cred` module).
    #[serde(default)]
    pub enable_cred_relay: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HandshakeInfo {
    pub proto_version: u32,
    pub agent_version: String,
    pub os: String,
    pub arch: String,
    /// The agent user's home directory — the app expands a typed `~/...`
    /// repo path against it before probing.
    #[serde(default)]
    pub home: String,
}

/// One method covers every `GitExecutor` run shape — they are one process
/// shape with flags, and a tiny wire surface is the point of the executor cut.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitRunParams {
    pub git_path: HostPath,
    pub cwd: Option<HostPath>,
    pub args: Vec<String>,
    #[serde(default)]
    pub extra_env: Vec<(String, String)>,
    /// Expected non-zero exit codes (invocation-log cosmetics on the agent).
    #[serde(default)]
    pub ok_exit_codes: Vec<i32>,
    #[serde(default)]
    pub op_id: Option<OperationId>,
    #[serde(default)]
    pub stdin: Option<String>,
    /// Return stdout as base64 bytes (`run_with_stdin_bytes` byte-safety).
    #[serde(default)]
    pub want_stdout_bytes: bool,
    /// Parse `--progress` meter output agent-side and send `GitProgress`
    /// notes (meter redraw noise never crosses the wire).
    #[serde(default)]
    pub progress: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitRunResult {
    /// Lossy-UTF-8 stdout, unless `want_stdout_bytes` put it in `stdout_b64`.
    #[serde(default)]
    pub stdout: String,
    #[serde(default)]
    pub stdout_b64: Option<String>,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub success: bool,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitStreamParams {
    /// Client-chosen stream id; `StreamEvent` notes carry it back.
    pub stream_id: u64,
    pub git_path: HostPath,
    pub cwd: Option<HostPath>,
    pub args: Vec<String>,
    pub op_id: OperationId,
    /// Credit window = the client's channel capacity: the agent sends at most
    /// this many events beyond what `StreamAck` has acknowledged, then stops
    /// consuming its bounded channel — git blocks exactly like a pager.
    pub window: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitStreamDone {
    pub exit_code: i32,
}

/// Wire form of `FsProbe` — file bytes as base64, not a JSON int array.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "k", rename_all = "snake_case")]
pub enum WireProbe {
    Missing,
    Dir,
    File { b64: String },
}

impl From<FsProbe> for WireProbe {
    fn from(p: FsProbe) -> Self {
        match p {
            FsProbe::Missing => WireProbe::Missing,
            FsProbe::Dir => WireProbe::Dir,
            FsProbe::File(bytes) => WireProbe::File { b64: b64_encode(&bytes) },
        }
    }
}

impl WireProbe {
    pub fn into_probe(self) -> Result<FsProbe, base64::DecodeError> {
        Ok(match self {
            WireProbe::Missing => FsProbe::Missing,
            WireProbe::Dir => FsProbe::Dir,
            WireProbe::File { b64 } => FsProbe::File(b64_decode(&b64)?),
        })
    }
}

/// Result type: [`CredAnswer`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CredRequestParams {
    /// Correlates a later `CredCancel` note (helper hangup) with the request.
    pub cred_id: u64,
    /// `get` / `store` / `erase` (git credential ops) or `askpass` (ssh).
    pub op: String,
    /// Parsed request fields (credential protocol keys, or `prompt` for
    /// askpass).
    pub fields: std::collections::HashMap<String, String>,
    /// Working directory of the git process, for prompt attribution.
    pub cwd: Option<String>,
}

// ---------------------------------------------------------------------------
// Notes (notifications)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "n", rename_all = "snake_case")]
pub enum Note {
    // Agent → app.
    GitInvocation { inv: GitInvocation },
    GitProgress { op_id: OperationId, progress: RemoteProgress },
    StreamEvent { stream_id: u64, event: RunnerEvent },
    WatchChanged { watch_id: u64, batch: WatchBatch },
    /// The credential helper's stdin/socket peer hung up (git was killed):
    /// abandon the prompt for `cred_id`.
    CredCancel { cred_id: u64 },
    // App → agent.
    /// Replenish `credits` for a stream (the console drained events).
    StreamAck { stream_id: u64, credits: u32 },
}

// ---------------------------------------------------------------------------
// Codec
// ---------------------------------------------------------------------------

/// One frame as one NDJSON line (with trailing newline).
pub fn encode_frame(frame: &Frame) -> String {
    let mut s = serde_json::to_string(frame).expect("frames always serialize");
    s.push('\n');
    s
}

/// Decode one line. Callers resync by simply moving to the next line on error.
pub fn decode_frame(line: &str) -> Result<Frame, serde_json::Error> {
    serde_json::from_str(line)
}

pub fn b64_encode(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

pub fn b64_decode(s: &str) -> Result<Vec<u8>, base64::DecodeError> {
    base64::engine::general_purpose::STANDARD.decode(s)
}

/// Typed helpers for building result payloads (`Outcome::Ok(to_value(..))`).
pub fn to_value<T: Serialize>(v: &T) -> serde_json::Value {
    serde_json::to_value(v).expect("results always serialize")
}

pub fn from_value<T: for<'de> Deserialize<'de>>(
    v: serde_json::Value,
) -> Result<T, serde_json::Error> {
    serde_json::from_value(v)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_round_trip_including_binary_fields() {
        let req = Frame::Req {
            id: 7,
            method: Method::GitRun(GitRunParams {
                git_path: HostPath("/usr/bin/git".into()),
                cwd: Some(HostPath("/home/u/repo".into())),
                args: vec!["apply".into(), "--cached".into()],
                extra_env: vec![("GIT_EDITOR".into(), "true".into())],
                ok_exit_codes: vec![1],
                op_id: Some(OperationId("op-1".into())),
                stdin: Some("patch text \u{1F980}".into()),
                want_stdout_bytes: true,
                progress: false,
            }),
        };
        let line = encode_frame(&req);
        assert!(line.ends_with('\n') && !line[..line.len() - 1].contains('\n'));
        let back = decode_frame(line.trim_end()).unwrap();
        let Frame::Req { id, method: Method::GitRun(p) } = back else {
            panic!("wrong frame")
        };
        assert_eq!(id, 7);
        assert_eq!(p.stdin.as_deref(), Some("patch text \u{1F980}"));
    }

    #[test]
    fn response_ok_and_err_shapes() {
        let ok = Frame::Res { id: 1, outcome: Outcome::Ok(to_value(&GitStreamDone { exit_code: 0 })) };
        let line = encode_frame(&ok);
        assert!(line.contains("\"ok\""));
        let err = Frame::Res {
            id: 2,
            outcome: Outcome::Err(WireError::new(WireErrorKind::VersionMismatch, "redeploy")),
        };
        let line = encode_frame(&err);
        assert!(line.contains("\"err\"") && line.contains("version_mismatch"));
        match decode_frame(line.trim_end()).unwrap() {
            Frame::Res { outcome: Outcome::Err(e), .. } => {
                assert_eq!(e.kind, WireErrorKind::VersionMismatch)
            }
            _ => panic!("wrong frame"),
        }
    }

    #[test]
    fn unknown_method_still_yields_the_request_id() {
        // A newer client sends a method this agent doesn't know: the frame
        // fails to decode, but the id must be recoverable so the agent can
        // answer UnknownMethod instead of leaving the call hanging.
        let line = r#"{"t":"req","id":42,"method":{"m":"git.hologram","x":1}}"#;
        assert!(decode_frame(line).is_err());
        assert_eq!(extract_request_id(line), Some(42));
        // Non-request garbage yields None.
        assert_eq!(extract_request_id(r#"{"t":"note","id":9}"#), None);
        assert_eq!(extract_request_id("not json"), None);
    }

    #[test]
    fn ready_line_round_trips_and_rejects_noise() {
        let line = ready_line("1.2.3");
        assert_eq!(parse_ready_line(&line), Some((PROTO_VERSION, "1.2.3".into())));
        // Login-shell banner noise before the READY line must not parse.
        assert_eq!(parse_ready_line("Welcome to Ubuntu 24.04!"), None);
        assert_eq!(parse_ready_line(""), None);
    }

    #[test]
    fn wire_probe_round_trips() {
        let probes = vec![
            FsProbe::Missing,
            FsProbe::Dir,
            FsProbe::File(vec![0, 159, 146, 150]),
        ];
        let wire: Vec<WireProbe> = probes.iter().cloned().map(Into::into).collect();
        let json = serde_json::to_string(&wire).unwrap();
        assert!(!json.contains("[0,159"), "bytes must be b64, not int arrays: {json}");
        let back: Vec<WireProbe> = serde_json::from_str(&json).unwrap();
        let restored: Vec<FsProbe> =
            back.into_iter().map(|w| w.into_probe().unwrap()).collect();
        assert!(matches!(&restored[2], FsProbe::File(b) if *b == vec![0, 159, 146, 150]));
    }

    #[test]
    fn resync_after_garbage_line() {
        // NDJSON's recovery property: a corrupt line fails alone; the next
        // line decodes normally.
        let good = encode_frame(&Frame::Note { note: Note::StreamAck { stream_id: 3, credits: 16 } });
        let stream = format!("{{corrupt\n{good}");
        let mut lines = stream.lines();
        assert!(decode_frame(lines.next().unwrap()).is_err());
        let ok = decode_frame(lines.next().unwrap()).unwrap();
        assert!(matches!(ok, Frame::Note { note: Note::StreamAck { stream_id: 3, credits: 16 } }));
    }

    #[test]
    fn runner_and_fs_errors_map_to_wire_kinds() {
        let we: WireError = (&RunnerError::GitNotFound("/x/git".into())).into();
        assert_eq!(we.kind, WireErrorKind::GitNotFound);
        let we: WireError = (&FsError::NotFound { path: "/a".into() }).into();
        assert_eq!(we.kind, WireErrorKind::FsNotFound);
        let p = HostPath("/a".into());
        assert!(matches!(we.into_fs_error(&p), FsError::NotFound { .. }));
    }
}
