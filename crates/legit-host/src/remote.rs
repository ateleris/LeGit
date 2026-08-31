//! The app-side client of a `legit-agent`: connection machinery plus the
//! `RemoteExecutor` / `RemoteFs` / remote `Host` implementations.
//!
//! An [`AgentTransport`] supplies byte pipes to a (re)spawnable agent —
//! wsl.exe stdio in production, a direct child process in tests, ssh later.
//! One connection serves a whole host; repos multiplex over it by request id.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use legit_core::{
    FsDirEntry, FsError, FsProbe, FsStat, GitExecutor, GitInvocation, GitVersion, HostPath,
    OperationId, RemoteProgress, RepoFs, RunOutput, RunOutputBytes, RunnerError, RunnerEvent,
};
use legit_proto::{
    b64_decode, b64_encode, decode_frame, encode_frame, from_value, parse_ready_line, to_value,
    CredAnswer, CredRequestParams, Frame, GitRunParams, GitRunResult, GitStreamDone,
    GitStreamParams, HandshakeInfo, HandshakeParams, Method, Note, Outcome, WireError,
    WireErrorKind, WireProbe, PROTO_VERSION,
};
use legit_watch::{WatchBatch, WatchSink};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot};

use crate::{Host, HostError, HostId, WatchHandle};

/// Byte pipes to a running agent.
pub struct AgentPipes {
    pub reader: Box<dyn AsyncRead + Send + Unpin>,
    pub writer: Box<dyn AsyncWrite + Send + Unpin>,
}

/// Provides pipes to an agent and can re-establish them (reconnect). The WSL
/// implementation spawns `wsl.exe -d <distro> … legit-agent --stdio` (and
/// deploys the agent first if needed); tests spawn the binary directly.
#[async_trait]
pub trait AgentTransport: Send + Sync + 'static {
    async fn connect(&self) -> Result<AgentPipes, HostError>;
}

/// Sinks for agent-pushed information, provided by the app layer.
pub struct HostSinks {
    /// Git invocation log entries (agent-side runs), for the Git Log panel.
    pub on_invocation: Box<dyn Fn(GitInvocation) + Send + Sync>,
    /// Remote progress (fetch/pull/push meters).
    pub on_progress: Box<dyn Fn(&OperationId, RemoteProgress) + Send + Sync>,
    /// Credential relay: answer a `cred.request` from the agent (the app's
    /// broker logic: session cache / keychain / UI prompt). The
    /// `cred_id` in the params correlates a later cancel.
    pub on_cred_request:
        Box<dyn Fn(CredRequestParams) -> tokio::task::JoinHandle<CredAnswer> + Send + Sync>,
    /// A previously relayed credential request was abandoned (git died).
    pub on_cred_cancel: Box<dyn Fn(u64) + Send + Sync>,
    /// The connection died (EOF/transport error) — the app schedules a
    /// reconnect and surfaces host status.
    pub on_disconnect: Box<dyn Fn() + Send + Sync>,
}

impl HostSinks {
    /// Sinks that ignore everything — for tests and probe connections.
    pub fn ignore() -> Self {
        HostSinks {
            on_invocation: Box::new(|_| {}),
            on_progress: Box::new(|_, _| {}),
            on_cred_request: Box::new(|_| {
                tokio::spawn(async {
                    CredAnswer {
                        cancel: true,
                        ..Default::default()
                    }
                })
            }),
            on_cred_cancel: Box::new(|_| {}),
            on_disconnect: Box::new(|| {}),
        }
    }
}

/// Options applied at handshake time.
#[derive(Default, Clone)]
pub struct HostConnectOpts {
    pub app_version: String,
    /// Extra base-env entries the agent installs process-globally before
    /// constructing any runner.
    pub base_env_extra: Vec<(String, String)>,
    /// Have the agent host its Unix-socket credential relay (see
    /// `legit_proto::cred`); requires `HostSinks::on_cred_request` to answer.
    pub enable_cred_relay: bool,
}

struct StreamEntry {
    events: mpsc::UnboundedSender<RunnerEvent>,
}

/// One live connection to an agent. Dropping it closes the writer, which the
/// agent treats as the kill signal.
pub struct AgentConnection {
    writer_tx: mpsc::Sender<String>,
    next_id: AtomicU64,
    pending: Mutex<HashMap<u64, oneshot::Sender<Result<serde_json::Value, WireError>>>>,
    streams: Mutex<HashMap<u64, StreamEntry>>,
    watches: Mutex<HashMap<u64, Arc<dyn Fn(WatchBatch) + Send + Sync>>>,
    /// Cancellable op ids currently in flight through THIS connection —
    /// `GitExecutor::cancel` is synchronous, so it answers from this set and
    /// fires the cancel RPC in the background.
    inflight_ops: Mutex<std::collections::HashSet<OperationId>>,
    alive: AtomicBool,
    info: std::sync::OnceLock<HandshakeInfo>,
}

impl AgentConnection {
    /// Establish a connection over `pipes`: wait for the READY line
    /// (discarding banner noise), start reader/writer tasks, handshake.
    pub async fn establish(
        pipes: AgentPipes,
        opts: &HostConnectOpts,
        sinks: HostSinks,
    ) -> Result<Arc<AgentConnection>, HostError> {
        let mut reader = BufReader::new(pipes.reader);
        let mut writer = pipes.writer;

        // Discard login-shell banners until the READY line (bounded).
        let (ready_proto, agent_version) = {
            let mut line = String::new();
            let mut seen = 0u32;
            loop {
                line.clear();
                let n = reader
                    .read_line(&mut line)
                    .await
                    .map_err(|e| HostError::HostGone(format!("reading READY line: {e}")))?;
                if n == 0 {
                    return Err(HostError::HostGone(
                        "agent closed the pipe before READY".into(),
                    ));
                }
                if let Some(parsed) = parse_ready_line(&line) {
                    break parsed;
                }
                seen += 1;
                if seen > 256 {
                    return Err(HostError::HostGone(
                        "no READY line within the first 256 lines".into(),
                    ));
                }
            }
        };

        let (writer_tx, mut writer_rx) = mpsc::channel::<String>(256);
        tokio::spawn(async move {
            while let Some(line) = writer_rx.recv().await {
                if writer.write_all(line.as_bytes()).await.is_err() {
                    break;
                }
                if writer.flush().await.is_err() {
                    break;
                }
            }
        });

        let conn = Arc::new(AgentConnection {
            writer_tx: writer_tx.clone(),
            next_id: AtomicU64::new(1),
            pending: Mutex::new(HashMap::new()),
            streams: Mutex::new(HashMap::new()),
            watches: Mutex::new(HashMap::new()),
            inflight_ops: Mutex::new(std::collections::HashSet::new()),
            alive: AtomicBool::new(true),
            info: std::sync::OnceLock::new(),
        });
        tracing::debug!(proto = ready_proto, version = %agent_version, "agent READY");

        // Reader task: route responses to pending calls, notes to sinks.
        let reader_conn = conn.clone();
        tokio::spawn(async move {
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if line.trim().is_empty() {
                    continue;
                }
                match decode_frame(line.trim()) {
                    Ok(frame) => reader_conn.route(frame, &sinks).await,
                    Err(e) => {
                        tracing::warn!(err = %e, "dropping undecodable agent line");
                    }
                }
            }
            reader_conn.mark_dead();
            (sinks.on_disconnect)();
        });

        // Handshake (exact version policy; the deployer reacts to mismatch).
        let info: HandshakeInfo = conn
            .call(Method::Handshake(HandshakeParams {
                proto_version: PROTO_VERSION,
                app_version: opts.app_version.clone(),
                base_env_extra: opts.base_env_extra.clone(),
                enable_cred_relay: opts.enable_cred_relay,
            }))
            .await
            .map_err(|e| match e.kind {
                WireErrorKind::VersionMismatch => HostError::GitProbe(e.message.clone()),
                _ => HostError::HostGone(e.message),
            })?;
        let _ = conn.info.set(info);
        Ok(conn)
    }

    /// The handshake result (set before `establish` returns).
    pub fn info(&self) -> Option<&HandshakeInfo> {
        self.info.get()
    }

    fn mark_dead(&self) {
        self.alive.store(false, Ordering::Release);
        let mut pending = self.pending.lock().expect("pending poisoned");
        for (_, tx) in pending.drain() {
            let _ = tx.send(Err(WireError::new(
                WireErrorKind::AgentGone,
                "agent connection lost",
            )));
        }
        // Streams end: drop senders so consumers see channel close.
        self.streams.lock().expect("streams poisoned").clear();
    }

    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::Acquire)
    }

    async fn route(&self, frame: Frame, sinks: &HostSinks) {
        match frame {
            Frame::Res { id, outcome } => {
                let tx = self.pending.lock().expect("pending poisoned").remove(&id);
                if let Some(tx) = tx {
                    let _ = tx.send(outcome.into_result());
                }
            }
            Frame::Note { note } => match note {
                Note::GitInvocation { inv } => (sinks.on_invocation)(inv),
                Note::GitProgress { op_id, progress } => (sinks.on_progress)(&op_id, progress),
                Note::StreamEvent { stream_id, event } => {
                    let entry = self
                        .streams
                        .lock()
                        .expect("streams poisoned")
                        .get(&stream_id)
                        .map(|e| e.events.clone());
                    if let Some(tx) = entry {
                        let _ = tx.send(event);
                    }
                }
                Note::WatchChanged { watch_id, batch } => {
                    let sink = self
                        .watches
                        .lock()
                        .expect("watches poisoned")
                        .get(&watch_id)
                        .cloned();
                    if let Some(sink) = sink {
                        sink(batch);
                    }
                }
                Note::CredCancel { cred_id } => (sinks.on_cred_cancel)(cred_id),
                Note::StreamAck { .. } => {
                    tracing::warn!("unexpected stream_ack from agent");
                }
            },
            Frame::Req { id, method } => match method {
                // The one agent→app request: credential relay.
                Method::CredRequest(params) => {
                    let handle = (sinks.on_cred_request)(params);
                    let writer = self.writer_tx.clone();
                    tokio::spawn(async move {
                        let outcome = match handle.await {
                            Ok(answer) => Outcome::Ok(to_value(&answer)),
                            Err(e) => Outcome::Err(WireError::new(
                                WireErrorKind::Internal,
                                format!("credential handler panicked: {e}"),
                            )),
                        };
                        let _ = writer
                            .send(encode_frame(&Frame::Res { id, outcome }))
                            .await;
                    });
                }
                _ => {
                    let _ = self
                        .writer_tx
                        .send(encode_frame(&Frame::Res {
                            id,
                            outcome: Outcome::Err(WireError::new(
                                WireErrorKind::UnknownMethod,
                                "the app only accepts cred.request",
                            )),
                        }))
                        .await;
                }
            },
        }
    }

    async fn send_note(&self, note: Note) {
        let _ = self.writer_tx.send(encode_frame(&Frame::Note { note })).await;
    }

    /// One request/response round trip, decoded into `T`.
    pub async fn call<T: for<'de> serde::Deserialize<'de>>(
        &self,
        method: Method,
    ) -> Result<T, WireError> {
        if !self.is_alive() {
            return Err(WireError::new(WireErrorKind::AgentGone, "agent connection lost"));
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().expect("pending poisoned").insert(id, tx);
        if self
            .writer_tx
            .send(encode_frame(&Frame::Req { id, method }))
            .await
            .is_err()
        {
            self.pending.lock().expect("pending poisoned").remove(&id);
            return Err(WireError::new(WireErrorKind::AgentGone, "agent connection lost"));
        }
        let value = rx
            .await
            .map_err(|_| WireError::new(WireErrorKind::AgentGone, "agent connection lost"))??;
        from_value(value).map_err(|e| {
            WireError::new(WireErrorKind::Internal, format!("bad response payload: {e}"))
        })
    }
}

/// Swap-on-reconnect indirection: executors, fs handles, and sessions hold
/// this; a reconnect replaces the inner connection and everything recovers in
/// place (same `RepoSession`, same repo ids).
pub struct HostConn {
    current: std::sync::RwLock<Arc<AgentConnection>>,
}

impl HostConn {
    pub fn new(conn: Arc<AgentConnection>) -> Arc<Self> {
        Arc::new(Self {
            current: std::sync::RwLock::new(conn),
        })
    }

    pub fn get(&self) -> Arc<AgentConnection> {
        self.current.read().expect("host conn poisoned").clone()
    }

    pub fn swap(&self, conn: Arc<AgentConnection>) {
        *self.current.write().expect("host conn poisoned") = conn;
    }

    pub fn is_alive(&self) -> bool {
        self.get().is_alive()
    }
}

// ---------------------------------------------------------------------------
// RemoteExecutor
// ---------------------------------------------------------------------------

pub struct RemoteExecutor {
    conn: Arc<HostConn>,
    git_path: HostPath,
    cwd: Option<HostPath>,
    next_stream_id: AtomicU64,
}

impl RemoteExecutor {
    pub fn new(conn: Arc<HostConn>, git_path: HostPath, cwd: Option<HostPath>) -> Self {
        Self {
            conn,
            git_path,
            cwd,
            next_stream_id: AtomicU64::new(1),
        }
    }

    fn params(&self, args: &[&str]) -> GitRunParams {
        GitRunParams {
            git_path: self.git_path.clone(),
            cwd: self.cwd.clone(),
            args: args.iter().map(|s| s.to_string()).collect(),
            extra_env: Vec::new(),
            ok_exit_codes: Vec::new(),
            op_id: None,
            stdin: None,
            want_stdout_bytes: false,
            progress: false,
        }
    }

    async fn run_params(&self, params: GitRunParams) -> Result<RunOutput, RunnerError> {
        let conn = self.conn.get();
        let tracked_op = params.op_id.clone();
        if let Some(op) = &tracked_op {
            conn.inflight_ops
                .lock()
                .expect("ops poisoned")
                .insert(op.clone());
        }
        let result: Result<GitRunResult, WireError> = conn.call(Method::GitRun(params)).await;
        if let Some(op) = &tracked_op {
            conn.inflight_ops
                .lock()
                .expect("ops poisoned")
                .remove(op);
        }
        let r = result.map_err(wire_to_runner)?;
        Ok(RunOutput {
            stdout: r.stdout,
            stderr: r.stderr,
            exit_code: r.exit_code,
            success: r.success,
            duration_ms: r.duration_ms,
        })
    }
}

fn wire_to_runner(e: WireError) -> RunnerError {
    match e.kind {
        WireErrorKind::GitNotFound => RunnerError::GitNotFound(std::path::PathBuf::from(e.message)),
        WireErrorKind::Spawn => RunnerError::Spawn(std::io::Error::other(e.message)),
        WireErrorKind::DuplicateOperation => {
            // The message carries the id; the variant's payload is cosmetic.
            RunnerError::DuplicateOperation(OperationId(e.message))
        }
        _ => RunnerError::Io(std::io::Error::other(e.message)),
    }
}

#[async_trait]
impl GitExecutor for RemoteExecutor {
    async fn run(&self, args: &[&str]) -> Result<RunOutput, RunnerError> {
        self.run_params(self.params(args)).await
    }

    async fn run_expecting(
        &self,
        args: &[&str],
        ok_exit_codes: &[i32],
    ) -> Result<RunOutput, RunnerError> {
        let mut p = self.params(args);
        p.ok_exit_codes = ok_exit_codes.to_vec();
        self.run_params(p).await
    }

    async fn run_with_op(
        &self,
        args: &[&str],
        op_id: OperationId,
    ) -> Result<RunOutput, RunnerError> {
        let mut p = self.params(args);
        p.op_id = Some(op_id);
        self.run_params(p).await
    }

    async fn run_with_stdin(
        &self,
        args: &[&str],
        stdin_data: &str,
    ) -> Result<RunOutput, RunnerError> {
        let mut p = self.params(args);
        p.stdin = Some(stdin_data.to_string());
        self.run_params(p).await
    }

    async fn run_with_stdin_bytes(
        &self,
        args: &[&str],
        stdin_data: &str,
    ) -> Result<RunOutputBytes, RunnerError> {
        let mut p = self.params(args);
        p.stdin = Some(stdin_data.to_string());
        p.want_stdout_bytes = true;
        let r: GitRunResult = self
            .conn
            .get()
            .call(Method::GitRun(p))
            .await
            .map_err(wire_to_runner)?;
        let stdout = match r.stdout_b64 {
            Some(b64) => b64_decode(&b64)
                .map_err(|e| RunnerError::Io(std::io::Error::other(e.to_string())))?,
            None => r.stdout.into_bytes(),
        };
        Ok(RunOutputBytes {
            stdout,
            stderr: r.stderr,
            exit_code: r.exit_code,
            success: r.success,
            duration_ms: r.duration_ms,
        })
    }

    async fn run_with_env(
        &self,
        args: &[&str],
        extra_env: &[(&str, &str)],
    ) -> Result<RunOutput, RunnerError> {
        let mut p = self.params(args);
        p.extra_env = extra_env
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        self.run_params(p).await
    }

    async fn run_with_op_progress(
        &self,
        args: &[&str],
        op_id: OperationId,
    ) -> Result<RunOutput, RunnerError> {
        let mut p = self.params(args);
        p.op_id = Some(op_id);
        p.progress = true;
        self.run_params(p).await
    }

    async fn stream(
        &self,
        args: &[&str],
        op_id: OperationId,
        events_tx: mpsc::Sender<RunnerEvent>,
    ) -> Result<i32, RunnerError> {
        let conn = self.conn.get();
        let stream_id = self.next_stream_id.fetch_add(1, Ordering::Relaxed)
            | ((std::process::id() as u64) << 32);
        // Agent-pushed events land in an unbounded buffer (bounded in practice
        // by the credit window) so the connection reader never blocks; the
        // forwarder below applies the caller's REAL backpressure and returns
        // one credit per event the caller accepted.
        let (buf_tx, mut buf_rx) = mpsc::unbounded_channel::<RunnerEvent>();
        conn.streams
            .lock()
            .expect("streams poisoned")
            .insert(stream_id, StreamEntry { events: buf_tx });
        conn.inflight_ops
            .lock()
            .expect("ops poisoned")
            .insert(op_id.clone());

        let window = events_tx.max_capacity().max(1) as u32;
        let forward_conn = conn.clone();
        let forwarder = tokio::spawn(async move {
            while let Some(event) = buf_rx.recv().await {
                if events_tx.send(event).await.is_err() {
                    // Console gone: stop acking; the agent stalls at zero
                    // credits and the stream dies with cancel/kill.
                    break;
                }
                forward_conn
                    .send_note(Note::StreamAck {
                        stream_id,
                        credits: 1,
                    })
                    .await;
            }
        });

        let result: Result<GitStreamDone, WireError> = conn
            .call(Method::GitStream(GitStreamParams {
                stream_id,
                git_path: self.git_path.clone(),
                cwd: self.cwd.clone(),
                args: args.iter().map(|s| s.to_string()).collect(),
                op_id: op_id.clone(),
                window,
            }))
            .await;

        conn.inflight_ops
            .lock()
            .expect("ops poisoned")
            .remove(&op_id);
        conn.streams
            .lock()
            .expect("streams poisoned")
            .remove(&stream_id);
        // Let the forwarder drain what already arrived, then it ends (its
        // sender was just dropped with the streams entry).
        let _ = forwarder.await;

        Ok(result.map_err(wire_to_runner)?.exit_code)
    }

    fn cancel(&self, op_id: &OperationId) -> bool {
        let conn = self.conn.get();
        let known = conn
            .inflight_ops
            .lock()
            .expect("ops poisoned")
            .contains(op_id);
        let op = op_id.clone();
        tokio::spawn(async move {
            let _: Result<bool, _> = conn.call(Method::GitCancel { op_id: op }).await;
        });
        known
    }
}

// ---------------------------------------------------------------------------
// RemoteFs
// ---------------------------------------------------------------------------

pub struct RemoteFs {
    conn: Arc<HostConn>,
}

impl RemoteFs {
    pub fn new(conn: Arc<HostConn>) -> Self {
        Self { conn }
    }

    async fn call<T: for<'de> serde::Deserialize<'de>>(
        &self,
        path: &HostPath,
        method: Method,
    ) -> Result<T, FsError> {
        self.conn
            .get()
            .call(method)
            .await
            .map_err(|e| e.into_fs_error(path))
    }
}

#[async_trait]
impl RepoFs for RemoteFs {
    async fn stat(&self, path: &HostPath) -> Result<Option<FsStat>, FsError> {
        self.call(path, Method::FsStat { path: path.clone() }).await
    }

    async fn read(&self, path: &HostPath, cap: Option<u64>) -> Result<Vec<u8>, FsError> {
        let b64: String = self
            .call(path, Method::FsRead { path: path.clone(), cap })
            .await?;
        b64_decode(&b64).map_err(|e| FsError::Io {
            path: path.0.clone(),
            message: e.to_string(),
        })
    }

    async fn probe_many(
        &self,
        paths: &[HostPath],
        cap_each: u64,
    ) -> Result<Vec<FsProbe>, FsError> {
        let anchor = paths.first().cloned().unwrap_or_else(|| HostPath("/".into()));
        let wire: Vec<WireProbe> = self
            .call(
                &anchor,
                Method::FsProbeMany {
                    paths: paths.to_vec(),
                    cap_each,
                },
            )
            .await?;
        wire.into_iter()
            .map(|w| {
                w.into_probe().map_err(|e| FsError::Io {
                    path: anchor.0.clone(),
                    message: e.to_string(),
                })
            })
            .collect()
    }

    async fn write(&self, path: &HostPath, bytes: &[u8]) -> Result<(), FsError> {
        self.call(
            path,
            Method::FsWrite {
                path: path.clone(),
                data_b64: b64_encode(bytes),
            },
        )
        .await
    }

    async fn create_dir_all(&self, path: &HostPath) -> Result<(), FsError> {
        self.call(path, Method::FsMkdirp { path: path.clone() }).await
    }

    async fn remove_file(&self, path: &HostPath) -> Result<(), FsError> {
        self.call(path, Method::FsRemoveFile { path: path.clone() }).await
    }

    async fn remove_dir_all(&self, path: &HostPath) -> Result<(), FsError> {
        self.call(path, Method::FsRemoveDirAll { path: path.clone() }).await
    }

    async fn canonicalize(&self, path: &HostPath) -> Result<HostPath, FsError> {
        self.call(path, Method::FsCanonicalize { path: path.clone() }).await
    }

    async fn read_dir(&self, path: &HostPath) -> Result<Vec<FsDirEntry>, FsError> {
        self.call(path, Method::FsReadDir { path: path.clone() }).await
    }

    async fn temp_path(&self, prefix: &str) -> Result<HostPath, FsError> {
        let anchor = HostPath("/tmp".into());
        self.call(
            &anchor,
            Method::FsTempPath {
                prefix: prefix.to_string(),
            },
        )
        .await
    }
}

// ---------------------------------------------------------------------------
// RemoteHost
// ---------------------------------------------------------------------------

/// Guard that unregisters a remote watch on drop.
struct RemoteWatchGuard {
    host: Arc<RemoteHostInner>,
    watch_id: u64,
}

impl Drop for RemoteWatchGuard {
    fn drop(&mut self) {
        self.host
            .watch_table
            .lock()
            .expect("watch table poisoned")
            .remove(&self.watch_id);
        let conn = self.host.conn.get();
        conn.watches
            .lock()
            .expect("watches poisoned")
            .remove(&self.watch_id);
        let watch_id = self.watch_id;
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move {
                let _: Result<(), _> = conn.call(Method::WatchStop { watch_id }).await;
            });
        }
    }
}

/// One registered watch, kept so a reconnect can re-establish it.
struct WatchSpec {
    worktree: HostPath,
    git_dir: HostPath,
    sink: Arc<dyn Fn(WatchBatch) + Send + Sync>,
}

struct RemoteHostInner {
    id: HostId,
    conn: Arc<HostConn>,
    next_watch_id: AtomicU64,
    watch_table: Mutex<HashMap<u64, WatchSpec>>,
}

pub struct RemoteHost {
    inner: Arc<RemoteHostInner>,
}

impl RemoteHost {
    pub fn new(id: HostId, conn: Arc<AgentConnection>) -> Self {
        Self {
            inner: Arc::new(RemoteHostInner {
                id,
                conn: HostConn::new(conn),
                next_watch_id: AtomicU64::new(1),
                watch_table: Mutex::new(HashMap::new()),
            }),
        }
    }

    pub fn conn(&self) -> Arc<HostConn> {
        self.inner.conn.clone()
    }

    pub fn is_alive(&self) -> bool {
        self.inner.conn.is_alive()
    }

    /// Swap in a fresh connection (reconnect) and re-establish every
    /// registered watch on it. Sessions recover in place: their executors and
    /// fs handles all go through the shared `HostConn`.
    pub async fn reattach(&self, conn: Arc<AgentConnection>) -> Result<(), HostError> {
        self.inner.conn.swap(conn.clone());
        let specs: Vec<(u64, HostPath, HostPath, Arc<dyn Fn(WatchBatch) + Send + Sync>)> = {
            let table = self.inner.watch_table.lock().expect("watch table poisoned");
            table
                .iter()
                .map(|(id, s)| (*id, s.worktree.clone(), s.git_dir.clone(), s.sink.clone()))
                .collect()
        };
        for (watch_id, worktree, git_dir, sink) in specs {
            conn.watches
                .lock()
                .expect("watches poisoned")
                .insert(watch_id, sink);
            let result: Result<(), WireError> = conn
                .call(Method::WatchStart {
                    watch_id,
                    worktree,
                    git_dir,
                })
                .await;
            if let Err(e) = result {
                tracing::warn!(watch_id, err = %e, "failed to re-establish watch after reconnect");
            }
        }
        Ok(())
    }
}

#[async_trait]
impl Host for RemoteHost {
    fn id(&self) -> HostId {
        self.inner.id.clone()
    }

    fn fs(&self) -> Arc<dyn RepoFs> {
        Arc::new(RemoteFs::new(self.inner.conn.clone()))
    }

    fn executor_for(&self, git_path: &HostPath, cwd: Option<&HostPath>) -> Arc<dyn GitExecutor> {
        Arc::new(RemoteExecutor::new(
            self.inner.conn.clone(),
            git_path.clone(),
            cwd.cloned(),
        ))
    }

    async fn watch(
        &self,
        worktree: &HostPath,
        git_dir: &HostPath,
        sink: WatchSink,
    ) -> Result<WatchHandle, HostError> {
        let watch_id = self.inner.next_watch_id.fetch_add(1, Ordering::Relaxed);
        let sink: Arc<dyn Fn(WatchBatch) + Send + Sync> = Arc::from(sink);
        self.inner
            .watch_table
            .lock()
            .expect("watch table poisoned")
            .insert(
                watch_id,
                WatchSpec {
                    worktree: worktree.clone(),
                    git_dir: git_dir.clone(),
                    sink: sink.clone(),
                },
            );
        let conn = self.inner.conn.get();
        conn.watches
            .lock()
            .expect("watches poisoned")
            .insert(watch_id, sink);
        let result: Result<(), WireError> = conn
            .call(Method::WatchStart {
                watch_id,
                worktree: worktree.clone(),
                git_dir: git_dir.clone(),
            })
            .await;
        match result {
            Ok(()) => Ok(WatchHandle::new(RemoteWatchGuard {
                host: self.inner.clone(),
                watch_id,
            })),
            Err(e) => {
                self.inner
                    .watch_table
                    .lock()
                    .expect("watch table poisoned")
                    .remove(&watch_id);
                conn.watches
                    .lock()
                    .expect("watches poisoned")
                    .remove(&watch_id);
                Err(HostError::Watch(e.message))
            }
        }
    }

    async fn spawn_detached(
        &self,
        program: &str,
        args: &[String],
        cwd: Option<&HostPath>,
    ) -> Result<(), HostError> {
        let result: Result<(), WireError> = self
            .inner
            .conn
            .get()
            .call(Method::HostSpawn {
                program: program.to_string(),
                args: args.to_vec(),
                cwd: cwd.cloned(),
            })
            .await;
        result.map_err(|e| HostError::Spawn {
            program: program.to_string(),
            message: e.message,
        })
    }

    async fn probe_git(&self, git_path: &HostPath) -> Result<GitVersion, HostError> {
        let result: Result<GitVersion, WireError> = self
            .inner
            .conn
            .get()
            .call(Method::GitProbe {
                git_path: git_path.clone(),
            })
            .await;
        result.map_err(|e| HostError::GitProbe(e.message))
    }
}
