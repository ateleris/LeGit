//! `legit-agent` — the repo-side daemon of LeGit's remote-repository support.
//!
//! Deliberately DUMB: it executes git (via the same `GitRunner` the app uses
//! locally), serves repo-side filesystem calls, hosts the filesystem watcher,
//! and spawns detached helper processes. Every parser, composed flow, and
//! error classification stays in the app's `legit-core` — the agent's wire
//! surface (`legit-proto`) is small and stable, so agent redeploys are rare
//! and version-locked to the app.
//!
//! Lifecycle: prints the READY line, then speaks NDJSON on stdio until stdin
//! closes (the app dropping the transport is the kill signal — no orphan
//! daemons). Diagnostics go to stderr only; stdout is exclusively protocol.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

#[cfg(unix)]
mod relay;
#[cfg(unix)]
mod shim;

use legit_core::{
    set_global_base_env, set_invocation_observer, set_progress_observer, GitRunner, GitVersion,
    HostPath, LocalFs, OperationId, RepoFs, RunnerError,
};
use legit_proto::{
    b64_encode, decode_frame, encode_frame, extract_request_id, ready_line, to_value,
    Frame, GitRunParams, GitRunResult, GitStreamDone, GitStreamParams, HandshakeInfo,
    HandshakeParams, Method, Note, Outcome, WireError, WireErrorKind, PROTO_VERSION,
};
use legit_watch::WatcherCore;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;

const AGENT_VERSION: &str = env!("CARGO_PKG_VERSION");

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    // Shim re-execs first (mirrors the app binary's maybe_run_credential_helper):
    // git runs `<agent> --credential-helper <op>`; ssh runs `<agent> <prompt>`
    // with the LEGIT_SSH_ASKPASS env marker (SSH_ASKPASS passes no flags).
    #[cfg(unix)]
    {
        if args.first().map(String::as_str) == Some("--credential-helper") {
            let op = args.get(1).cloned().unwrap_or_default();
            std::process::exit(shim::run_credential_shim(&op));
        }
        if std::env::var_os("LEGIT_SSH_ASKPASS").is_some() {
            if let Some(prompt) = args.first() {
                std::process::exit(shim::run_askpass_shim(prompt));
            }
        }
    }
    match args.first().map(String::as_str) {
        Some("--version") => {
            println!("{AGENT_VERSION}");
        }
        Some("--selftest") => {
            // Deploy validation hook: proves the binary executes on this
            // distro (musl-static, so this is mostly an exec/arch check).
            println!("legit-agent selftest ok v{PROTO_VERSION} {AGENT_VERSION}");
        }
        Some("--stdio") | None => {
            serve_stdio();
        }
        Some(other) => {
            eprintln!("legit-agent: unknown argument '{other}'");
            std::process::exit(2);
        }
    }
}

fn serve_stdio() {
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .init();
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    rt.block_on(serve());
}

/// Per-stream credit window (see `GitStreamParams::window`): the consumer
/// takes one credit per forwarded event and stalls at zero, which backs the
/// pressure up through the bounded channel into git itself. A `Semaphore`,
/// not Mutex+Notify: permits are stored, so an `add` landing between the
/// taker's zero-check and its waiter registration can never be lost (a lost
/// wakeup would stall the stream forever - see `take_never_misses_a_racing_add`).
struct Credits {
    sem: tokio::sync::Semaphore,
}

impl Credits {
    fn new(window: u32) -> Self {
        Self {
            sem: tokio::sync::Semaphore::new(window as usize),
        }
    }

    async fn take(&self) {
        self.sem
            .acquire()
            .await
            .expect("credits semaphore never closed")
            .forget();
    }

    fn add(&self, n: u32) {
        self.sem.add_permits(n as usize);
    }
}

pub(crate) struct Agent {
    out: mpsc::Sender<String>,
    handshaken: AtomicBool,
    /// Runner clones (sharing their running-op maps) for in-flight cancellable
    /// ops — `git.cancel` must reach the exact instance that spawned the child.
    ops: Mutex<HashMap<OperationId, GitRunner>>,
    streams: Mutex<HashMap<u64, Arc<Credits>>>,
    watches: Mutex<HashMap<u64, WatcherCore>>,
    /// Agent-initiated requests (credential relay) awaiting the app's answer.
    pending_reqs:
        Mutex<HashMap<u64, tokio::sync::oneshot::Sender<Result<serde_json::Value, WireError>>>>,
    next_req_id: AtomicU64,
}

impl Agent {
    async fn send_frame(&self, frame: &Frame) {
        let _ = self.out.send(encode_frame(frame)).await;
    }

    async fn respond(&self, id: u64, outcome: Outcome) {
        self.send_frame(&Frame::Res { id, outcome }).await;
    }

    pub(crate) async fn send_note(&self, note: Note) {
        self.send_frame(&Frame::Note { note }).await;
    }

    /// Allocate an id + answer slot for an agent→app request.
    pub(crate) fn begin_app_request(
        &self,
    ) -> (
        u64,
        tokio::sync::oneshot::Receiver<Result<serde_json::Value, WireError>>,
    ) {
        let id = self.next_req_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.pending_reqs
            .lock()
            .expect("pending_reqs poisoned")
            .insert(id, tx);
        (id, rx)
    }

    pub(crate) async fn send_request(&self, id: u64, method: Method) {
        self.send_frame(&Frame::Req { id, method }).await;
    }

    pub(crate) fn forget_app_request(&self, id: u64) {
        self.pending_reqs
            .lock()
            .expect("pending_reqs poisoned")
            .remove(&id);
    }
}

async fn serve() {
    // Writer task: sole owner of stdout. Everything (responses, notes,
    // observer forwards) funnels through this channel.
    let (out_tx, mut out_rx) = mpsc::channel::<String>(256);
    let writer = tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        while let Some(line) = out_rx.recv().await {
            if stdout.write_all(line.as_bytes()).await.is_err() {
                break;
            }
            if stdout.flush().await.is_err() {
                break;
            }
        }
    });

    // Observers are process-wide OnceLocks — the agent IS the per-host
    // process, so installing them here scopes them to this host. They are
    // sync callbacks, so they cannot await on the bounded stdout channel; a
    // `try_send` there silently dropped invocation-log/progress notes under
    // load. Instead they push into an unbounded side channel that a small
    // forwarder task drains into the writer, preserving note order.
    let (note_tx, mut note_rx) = mpsc::unbounded_channel::<String>();
    let inv_tx = note_tx.clone();
    set_invocation_observer(Arc::new(move |inv| {
        let _ = inv_tx.send(encode_frame(&Frame::Note {
            note: Note::GitInvocation { inv },
        }));
    }));
    let prog_tx = note_tx;
    set_progress_observer(Arc::new(move |op_id, progress| {
        let _ = prog_tx.send(encode_frame(&Frame::Note {
            note: Note::GitProgress {
                op_id: op_id.clone(),
                progress,
            },
        }));
    }));
    let note_out = out_tx.clone();
    tokio::spawn(async move {
        while let Some(line) = note_rx.recv().await {
            if note_out.send(line).await.is_err() {
                break;
            }
        }
    });

    let agent = Arc::new(Agent {
        out: out_tx.clone(),
        handshaken: AtomicBool::new(false),
        ops: Mutex::new(HashMap::new()),
        streams: Mutex::new(HashMap::new()),
        watches: Mutex::new(HashMap::new()),
        pending_reqs: Mutex::new(HashMap::new()),
        next_req_id: AtomicU64::new(1),
    });

    // READY line: the app discards login-shell banner noise until it sees it.
    let _ = out_tx.send(format!("{}\n", ready_line(AGENT_VERSION))).await;

    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let line = line.trim().to_string();
        if line.is_empty() {
            continue;
        }
        match decode_frame(&line) {
            Ok(Frame::Req { id, method }) => {
                if let Method::Shutdown = method {
                    agent.respond(id, Outcome::Ok(to_value(&()))).await;
                    break;
                }
                let agent = agent.clone();
                tokio::spawn(async move {
                    let outcome = handle(&agent, method).await;
                    agent.respond(id, outcome).await;
                });
            }
            Ok(Frame::Note { note }) => handle_note(&agent, note),
            Ok(Frame::Res { id, outcome }) => {
                // An answer to an agent-initiated request (credential relay).
                let tx = agent
                    .pending_reqs
                    .lock()
                    .expect("pending_reqs poisoned")
                    .remove(&id);
                if let Some(tx) = tx {
                    let _ = tx.send(outcome.into_result());
                }
            }
            Err(e) => {
                // NDJSON resync: answer if the line was recognizably a
                // request, drop it otherwise.
                if let Some(id) = extract_request_id(&line) {
                    agent
                        .respond(
                            id,
                            Outcome::Err(WireError::new(
                                WireErrorKind::UnknownMethod,
                                format!("unknown or malformed method: {e}"),
                            )),
                        )
                        .await;
                } else {
                    tracing::warn!(err = %e, "dropping undecodable line");
                }
            }
        }
    }

    // stdin closed (or Shutdown): tear down. Watches/ops drop with the
    // process; kill_on_drop reaps children.
    drop(agent);
    drop(out_tx);
    let _ = writer.await;
}

fn handle_note(agent: &Arc<Agent>, note: Note) {
    match note {
        Note::StreamAck { stream_id, credits } => {
            if let Some(c) = agent
                .streams
                .lock()
                .expect("streams poisoned")
                .get(&stream_id)
            {
                c.add(credits);
            }
        }
        other => {
            tracing::warn!(?other, "unexpected note for agent");
        }
    }
}

fn require_handshake(agent: &Agent) -> Result<(), WireError> {
    if agent.handshaken.load(Ordering::Acquire) {
        Ok(())
    } else {
        Err(WireError::new(
            WireErrorKind::Internal,
            "handshake required before any other method",
        ))
    }
}

async fn handle(agent: &Arc<Agent>, method: Method) -> Outcome {
    match dispatch(agent, method).await {
        Ok(v) => Outcome::Ok(v),
        Err(e) => Outcome::Err(e),
    }
}

async fn dispatch(agent: &Arc<Agent>, method: Method) -> Result<serde_json::Value, WireError> {
    match method {
        Method::Handshake(p) => handshake(agent, p),
        m => {
            require_handshake(agent)?;
            dispatch_post_handshake(agent, m).await
        }
    }
}

fn handshake(agent: &Arc<Agent>, p: HandshakeParams) -> Result<serde_json::Value, WireError> {
    if p.proto_version != PROTO_VERSION || p.app_version != AGENT_VERSION {
        return Err(WireError::new(
            WireErrorKind::VersionMismatch,
            format!(
                "agent v{AGENT_VERSION} (proto {PROTO_VERSION}) does not match app v{} (proto {})",
                p.app_version, p.proto_version
            ),
        ));
    }
    // Same snapshot-at-construction semantics as the app process: applied
    // once, before any runner exists (the credential relay env rides here).
    let mut base_env_extra = p.base_env_extra;
    #[cfg(unix)]
    if p.enable_cred_relay {
        match relay::start(agent.clone()) {
            Ok(env) => base_env_extra.extend(env),
            Err(e) => {
                // Credentials degrade to non-interactive (as before the
                // feature existed) — never fail the whole connection.
                tracing::warn!(err = %e, "credential relay failed to start");
            }
        }
    }
    if !base_env_extra.is_empty() {
        set_global_base_env(base_env_extra);
    }
    agent.handshaken.store(true, Ordering::Release);
    Ok(to_value(&HandshakeInfo {
        proto_version: PROTO_VERSION,
        agent_version: AGENT_VERSION.to_string(),
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        home: std::env::var("HOME").unwrap_or_default(),
    }))
}

fn runner_for(p_git: &HostPath, cwd: Option<&HostPath>) -> GitRunner {
    match cwd {
        Some(cwd) => GitRunner::for_repo(p_git.as_local(), cwd.as_local()),
        None => GitRunner::unbound(p_git.as_local()),
    }
}

async fn dispatch_post_handshake(
    agent: &Arc<Agent>,
    method: Method,
) -> Result<serde_json::Value, WireError> {
    let fs = LocalFs;
    match method {
        Method::Handshake(_) | Method::Shutdown => unreachable!("handled by caller"),
        Method::GitRun(p) => git_run(agent, p).await,
        Method::GitStream(p) => git_stream(agent, p).await,
        Method::GitCancel { op_id } => {
            let runner = agent.ops.lock().expect("ops poisoned").get(&op_id).cloned();
            let killed = runner.map(|r| r.cancel(&op_id)).unwrap_or(false);
            Ok(to_value(&killed))
        }
        Method::FsStat { path } => Ok(to_value(&fs.stat(&path).await.map_err(we)?)),
        Method::FsRead { path, cap } => {
            let bytes = fs.read(&path, cap).await.map_err(we)?;
            Ok(to_value(&b64_encode(&bytes)))
        }
        Method::FsProbeMany { paths, cap_each } => {
            let probes = fs.probe_many(&paths, cap_each).await.map_err(we)?;
            let wire: Vec<legit_proto::WireProbe> =
                probes.into_iter().map(Into::into).collect();
            Ok(to_value(&wire))
        }
        Method::FsWrite { path, data_b64 } => {
            let bytes = legit_proto::b64_decode(&data_b64)
                .map_err(|e| WireError::new(WireErrorKind::Internal, e.to_string()))?;
            fs.write(&path, &bytes).await.map_err(we)?;
            Ok(to_value(&()))
        }
        Method::FsMkdirp { path } => {
            fs.create_dir_all(&path).await.map_err(we)?;
            Ok(to_value(&()))
        }
        Method::FsRemoveFile { path } => {
            fs.remove_file(&path).await.map_err(we)?;
            Ok(to_value(&()))
        }
        Method::FsRemoveDirAll { path } => {
            fs.remove_dir_all(&path).await.map_err(we)?;
            Ok(to_value(&()))
        }
        Method::FsCanonicalize { path } => Ok(to_value(&fs.canonicalize(&path).await.map_err(we)?)),
        Method::FsReadDir { path } => Ok(to_value(&fs.read_dir(&path).await.map_err(we)?)),
        Method::FsTempPath { prefix } => Ok(to_value(&fs.temp_path(&prefix).await.map_err(we)?)),
        Method::WatchStart {
            watch_id,
            worktree,
            git_dir,
        } => {
            let out = agent.out.clone();
            let core = WatcherCore::start(
                worktree.as_local(),
                git_dir.as_local(),
                Box::new(move |batch| {
                    // Watch batches are tiny and pre-debounced; a full pipe
                    // (unlikely) drops one refresh hint, never data.
                    let _ = out.try_send(encode_frame(&Frame::Note {
                        note: Note::WatchChanged { watch_id, batch },
                    }));
                }),
            )
            .map_err(|e| WireError::new(WireErrorKind::Internal, e.to_string()))?;
            agent
                .watches
                .lock()
                .expect("watches poisoned")
                .insert(watch_id, core);
            Ok(to_value(&()))
        }
        Method::WatchStop { watch_id } => {
            agent
                .watches
                .lock()
                .expect("watches poisoned")
                .remove(&watch_id);
            Ok(to_value(&()))
        }
        Method::HostSpawn { program, args, cwd } => {
            let mut cmd = tokio::process::Command::new(&program);
            cmd.args(&args);
            if let Some(cwd) = cwd {
                cmd.current_dir(cwd.as_local());
            }
            let mut child = cmd
                .spawn()
                .map_err(|e| WireError::new(WireErrorKind::Spawn, e.to_string()))?;
            // Reap the child when it exits — a fire-and-forget spawn (editor,
            // helper) must not sit as a zombie until the agent itself exits.
            tokio::spawn(async move {
                let _ = child.wait().await;
            });
            Ok(to_value(&()))
        }
        Method::GitProbe { git_path } => {
            let runner = runner_for(&git_path, None);
            let out = runner.run(&["--version"]).await.map_err(|e| we2(&e))?;
            if !out.success {
                return Err(WireError::new(
                    WireErrorKind::GitNotFound,
                    out.stderr.trim().to_string(),
                ));
            }
            let v = GitVersion::parse(out.stdout.trim()).ok_or_else(|| {
                WireError::new(
                    WireErrorKind::Internal,
                    format!("unparseable git version: {}", out.stdout.trim()),
                )
            })?;
            Ok(to_value(&v))
        }
        Method::CredRequest(_) => Err(WireError::new(
            WireErrorKind::UnknownMethod,
            "cred.request flows agent → app, not app → agent",
        )),
    }
}

fn we(e: legit_core::FsError) -> WireError {
    (&e).into()
}

fn we2(e: &RunnerError) -> WireError {
    e.into()
}

async fn git_run(agent: &Arc<Agent>, p: GitRunParams) -> Result<serde_json::Value, WireError> {
    let runner = runner_for(&p.git_path, p.cwd.as_ref());
    // Register cancellable ops so git.cancel can reach this runner instance
    // (clones share the running-op map).
    if let Some(op_id) = &p.op_id {
        agent
            .ops
            .lock()
            .expect("ops poisoned")
            .insert(op_id.clone(), runner.clone());
    }
    let args: Vec<&str> = p.args.iter().map(String::as_str).collect();
    let result = run_shape(&runner, &p, &args).await;
    if let Some(op_id) = &p.op_id {
        agent.ops.lock().expect("ops poisoned").remove(op_id);
    }
    result
}

/// Mirror of the `GitExecutor` surface: each trait method maps to one flag
/// combination, dispatched here (the client sets exactly one shape).
async fn run_shape(
    runner: &GitRunner,
    p: &GitRunParams,
    args: &[&str],
) -> Result<serde_json::Value, WireError> {
    if let Some(stdin) = &p.stdin {
        if p.want_stdout_bytes {
            let out = runner
                .run_with_stdin_bytes(args, stdin)
                .await
                .map_err(|e| we2(&e))?;
            return Ok(to_value(&GitRunResult {
                stdout: String::new(),
                stdout_b64: Some(b64_encode(&out.stdout)),
                stderr: out.stderr,
                exit_code: out.exit_code,
                success: out.success,
                duration_ms: out.duration_ms,
            }));
        }
        let out = runner
            .run_with_stdin(args, stdin)
            .await
            .map_err(|e| we2(&e))?;
        return Ok(to_value(&from_run_output(out)));
    }
    let out = if let Some(op_id) = &p.op_id {
        if p.progress {
            runner.run_with_op_progress(args, op_id.clone()).await
        } else {
            runner.run_with_op(args, op_id.clone()).await
        }
    } else if !p.extra_env.is_empty() {
        let env: Vec<(&str, &str)> = p
            .extra_env
            .iter()
            .map(|(k, v)| (k.as_str(), v.as_str()))
            .collect();
        runner.run_with_env(args, &env).await
    } else if !p.ok_exit_codes.is_empty() {
        runner.run_expecting(args, &p.ok_exit_codes).await
    } else {
        runner.run(args).await
    }
    .map_err(|e| we2(&e))?;
    Ok(to_value(&from_run_output(out)))
}

fn from_run_output(out: legit_core::RunOutput) -> GitRunResult {
    GitRunResult {
        stdout: out.stdout,
        stdout_b64: None,
        stderr: out.stderr,
        exit_code: out.exit_code,
        success: out.success,
        duration_ms: out.duration_ms,
    }
}

async fn git_stream(
    agent: &Arc<Agent>,
    p: GitStreamParams,
) -> Result<serde_json::Value, WireError> {
    let runner = runner_for(&p.git_path, p.cwd.as_ref());
    let credits = Arc::new(Credits::new(p.window));
    agent
        .streams
        .lock()
        .expect("streams poisoned")
        .insert(p.stream_id, credits.clone());
    agent
        .ops
        .lock()
        .expect("ops poisoned")
        .insert(p.op_id.clone(), runner.clone());

    // Bounded channel of the client's declared capacity: at zero credits the
    // consumer stops draining, the channel fills, GitRunner's reader tasks
    // block on send, the OS pipe fills, git blocks — pager semantics, one hop
    // removed.
    let (tx, mut rx) = mpsc::channel(p.window.max(1) as usize);
    let consumer_out = agent.out.clone();
    let stream_id = p.stream_id;
    let consumer_credits = credits.clone();
    let consumer = tokio::spawn(async move {
        while let Some(event) = rx.recv().await {
            consumer_credits.take().await;
            let _ = consumer_out
                .send(encode_frame(&Frame::Note {
                    note: Note::StreamEvent { stream_id, event },
                }))
                .await;
        }
    });

    let args: Vec<&str> = p.args.iter().map(String::as_str).collect();
    let result = runner.stream(&args, p.op_id.clone(), tx).await;

    agent.ops.lock().expect("ops poisoned").remove(&p.op_id);
    let _ = consumer.await;
    agent
        .streams
        .lock()
        .expect("streams poisoned")
        .remove(&p.stream_id);

    let exit_code = result.map_err(|e| we2(&e))?;
    Ok(to_value(&GitStreamDone { exit_code }))
}

#[cfg(test)]
mod tests {
    use super::Credits;
    use std::sync::Arc;

    /// `take()`/`add()` must never lose a wakeup. The adder grants exactly one
    /// credit per completed take (never a second one that could paper over a
    /// missed first - the production host acks one credit per delivered
    /// event), from a spinning OS thread so the grant lands nanoseconds after
    /// the taker re-enters `take()` and blocks at zero. A lost wakeup parks
    /// the taker forever, which in production stalls a remote stream
    /// unrecoverably.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn take_never_misses_a_racing_add() {
        use std::sync::atomic::{AtomicU32, Ordering};

        const ROUNDS: u32 = 200_000;
        let credits = Arc::new(Credits::new(0));
        let took = Arc::new(AtomicU32::new(0));

        let adder = {
            let credits = credits.clone();
            let took = took.clone();
            std::thread::spawn(move || {
                for i in 0..ROUNDS {
                    while took.load(Ordering::Acquire) < i {
                        std::hint::spin_loop();
                    }
                    credits.add(1);
                }
            })
        };
        let taker = {
            let credits = credits.clone();
            let took = took.clone();
            tokio::spawn(async move {
                for _ in 0..ROUNDS {
                    credits.take().await;
                    took.fetch_add(1, Ordering::Release);
                }
            })
        };

        tokio::time::timeout(std::time::Duration::from_secs(30), taker)
            .await
            .expect("deadlock: take() missed an add() and parked forever")
            .expect("taker panicked");
        adder.join().expect("adder panicked");
    }
}
