//! Protocol edge cases against a real spawned agent: version policy, stream
//! credit-window backpressure, concurrent interleaving, cancellation, and
//! death surfacing. The full flow coverage lives in `remote_git_flows.rs`.

mod common;

use std::sync::Arc;
use std::time::Duration;

use legit_core::{GitExecutor, HostPath, OperationId, RepoFs, RunnerEvent};
use legit_host::{AgentConnection, HostConn, HostConnectOpts, HostSinks, RemoteExecutor, RemoteFs};
use legit_proto::{Method, WireErrorKind};

async fn git_exec(conn: &Arc<AgentConnection>, cwd: &std::path::Path) -> RemoteExecutor {
    RemoteExecutor::new(
        HostConn::new(conn.clone()),
        HostPath("git".into()),
        Some(HostPath::from_path(cwd)),
    )
}

async fn temp_repo(exec: &RemoteExecutor) {
    for args in [
        ["init", "-b", "main"].as_slice(),
        &["config", "user.name", "T"],
        &["config", "user.email", "t@example.invalid"],
        &["config", "commit.gpgsign", "false"],
    ] {
        let out = exec.run(args).await.expect("git runs");
        assert!(out.success, "{args:?}: {}", out.stderr);
    }
}

#[tokio::test]
async fn handshake_rejects_version_mismatch() {
    let (pipes, _guard) = common::spawn_agent();
    let err = match AgentConnection::establish(
        pipes,
        &HostConnectOpts {
            app_version: "0.0.0-not-this".into(),
            base_env_extra: Vec::new(),
            ..Default::default()
        },
        HostSinks::ignore(),
    )
    .await
    {
        Ok(_) => panic!("mismatched app version must be refused"),
        Err(e) => e,
    };
    // The deployer keys redeploys off this failure.
    assert!(err.to_string().contains("does not match"), "{err}");
}

#[tokio::test]
async fn concurrent_requests_interleave_over_one_connection() {
    let (conn, _guard) = common::connect_agent().await;
    let dir = tempfile::tempdir().unwrap();
    let exec = Arc::new(git_exec(&conn, dir.path()).await);
    temp_repo(&exec).await;

    // Many concurrent RPCs of mixed kinds; correlation by id must never
    // cross wires.
    let fs = RemoteFs::new(HostConn::new(conn.clone()));
    let mut handles = Vec::new();
    for i in 0..24 {
        let exec = exec.clone();
        handles.push(tokio::spawn(async move {
            let out = exec.run(&["rev-parse", "--is-inside-work-tree"]).await.unwrap();
            assert_eq!(out.stdout.trim(), "true", "call {i}");
        }));
    }
    for i in 0..8 {
        let p = HostPath::from_path(&dir.path().join(format!("f{i}")));
        fs.write(&p, format!("content {i}").as_bytes()).await.unwrap();
        let back = fs.read(&p, None).await.unwrap();
        assert_eq!(back, format!("content {i}").as_bytes());
    }
    for h in handles {
        h.await.unwrap();
    }
}

#[tokio::test]
async fn stream_respects_credit_window_backpressure() {
    let (conn, _guard) = common::connect_agent().await;
    let dir = tempfile::tempdir().unwrap();
    let exec = git_exec(&conn, dir.path()).await;
    temp_repo(&exec).await;
    // ~2000 output lines via `git config -l` padding? Use rev-list of many
    // commits instead: cheap deterministic bulk output via `git log --help`?
    // Simplest bulk generator: `git config` listing after writing many keys.
    for i in 0..300 {
        let out = exec
            .run(&["config", &format!("test.key{i}"), &format!("value-{i}")])
            .await
            .unwrap();
        assert!(out.success);
    }

    // A tiny channel the test deliberately does NOT drain at first: the agent
    // may send at most `window` unacked events, so the count observed while
    // paused must stay bounded — git itself is blocked meanwhile.
    let (tx, mut rx) = tokio::sync::mpsc::channel::<RunnerEvent>(4);
    let op = OperationId::new();
    let exec = Arc::new(exec);
    let stream_exec = exec.clone();
    let op_for_stream = op.clone();
    let stream = tokio::spawn(async move {
        stream_exec
            .stream(&["config", "--list"], op_for_stream, tx)
            .await
    });

    // Give the pipeline time to move as much as it (wrongly) could.
    tokio::time::sleep(Duration::from_millis(600)).await;
    let mut buffered = 0;
    while rx.try_recv().is_ok() {
        buffered += 1;
    }
    // window (4) + agent-side channel (4) + one in each hop's hand: the exact
    // constant doesn't matter — what matters is it's ~window-sized, not the
    // whole 300+ line output.
    assert!(
        (1..=16).contains(&buffered),
        "expected a bounded, window-sized buffer while paused, got {buffered}"
    );

    // Drain: the stream must now complete and deliver everything + Finished.
    let mut total = buffered;
    let mut finished = false;
    while let Some(ev) = rx.recv().await {
        total += 1;
        if matches!(ev, RunnerEvent::Finished { .. }) {
            finished = true;
        }
    }
    assert!(finished, "Finished event must arrive");
    assert!(total > 300, "expected all config lines, got {total}");
    let exit = stream.await.unwrap().expect("stream ok");
    assert_eq!(exit, 0);
}

#[tokio::test]
async fn concurrent_streams_from_two_executors_stay_separate() {
    // Two repos on the same connection = two RemoteExecutors (one per
    // session) sharing one agent. Their concurrent streams must neither
    // cross-route output nor stall: stream ids come from the shared
    // connection, not a per-executor counter that would mint the same id
    // twice.
    let (conn, _guard) = common::connect_agent().await;
    let dir_a = tempfile::tempdir().unwrap();
    let dir_b = tempfile::tempdir().unwrap();
    let exec_a = Arc::new(git_exec(&conn, dir_a.path()).await);
    let exec_b = Arc::new(git_exec(&conn, dir_b.path()).await);
    temp_repo(&exec_a).await;
    temp_repo(&exec_b).await;
    for i in 0..100 {
        exec_a.run(&["config", &format!("test.alpha{i}"), "a"]).await.unwrap();
        exec_b.run(&["config", &format!("test.beta{i}"), "b"]).await.unwrap();
    }

    // Tiny undrained channels park both streams at their credit windows, so
    // both are REGISTERED concurrently before either finishes.
    let (tx_a, mut rx_a) = tokio::sync::mpsc::channel::<RunnerEvent>(2);
    let (tx_b, mut rx_b) = tokio::sync::mpsc::channel::<RunnerEvent>(2);
    let sa = {
        let exec = exec_a.clone();
        tokio::spawn(async move { exec.stream(&["config", "--list"], OperationId::new(), tx_a).await })
    };
    let sb = {
        let exec = exec_b.clone();
        tokio::spawn(async move { exec.stream(&["config", "--list"], OperationId::new(), tx_b).await })
    };
    tokio::time::sleep(Duration::from_millis(400)).await;

    let collect = |mut rx: tokio::sync::mpsc::Receiver<RunnerEvent>| async move {
        let mut out = String::new();
        while let Some(ev) = rx.recv().await {
            if let RunnerEvent::Stdout { line } = ev {
                out.push_str(&line);
                out.push('\n');
            }
        }
        out
    };
    let (out_a, out_b) = tokio::time::timeout(Duration::from_secs(10), async {
        tokio::join!(collect(rx_a), collect(rx_b))
    })
    .await
    .expect("both streams must complete - a stalled one means its credits were orphaned");
    let (exit_a, exit_b) = tokio::time::timeout(Duration::from_secs(5), async {
        (sa.await.unwrap().unwrap(), sb.await.unwrap().unwrap())
    })
    .await
    .expect("stream calls resolve");
    assert_eq!((exit_a, exit_b), (0, 0));

    assert!(out_a.contains("test.alpha0=a"), "A lost its own output");
    assert!(out_b.contains("test.beta0=b"), "B lost its own output");
    assert!(!out_a.contains("test.beta"), "B's output cross-routed into A");
    assert!(!out_b.contains("test.alpha"), "A's output cross-routed into B");
}

#[tokio::test]
async fn cancel_kills_a_paused_stream() {
    let (conn, _guard) = common::connect_agent().await;
    let dir = tempfile::tempdir().unwrap();
    let exec = Arc::new(git_exec(&conn, dir.path()).await);
    temp_repo(&exec).await;
    // The output must overflow every buffer between git and the paused
    // consumer (OS pipes are ~64KB), or git finishes before the cancel and
    // exits 0 legitimately: ~300 × 1KB values ≈ 300KB.
    let big = "v".repeat(1024);
    for i in 0..300 {
        exec.run(&["config", &format!("test.key{i}"), &big]).await.unwrap();
    }

    let (tx, mut rx) = tokio::sync::mpsc::channel::<RunnerEvent>(2);
    let op = OperationId::new();
    let stream_exec = exec.clone();
    let op_for_stream = op.clone();
    let stream = tokio::spawn(async move {
        stream_exec.stream(&["config", "--list"], op_for_stream, tx).await
    });
    tokio::time::sleep(Duration::from_millis(300)).await;

    // cancel() is sync: it answers from the in-flight set and fires the RPC.
    assert!(exec.cancel(&op), "op should be known while in flight");

    // Like the Console, keep draining after cancel (locally, GitRunner's
    // Finished send would equally block on a consumer that stopped reading).
    let drainer = tokio::spawn(async move {
        let mut n = 0u32;
        while rx.recv().await.is_some() {
            n += 1;
        }
        n
    });

    // The stream call must resolve promptly (killed child), not after the
    // remaining 200-line output.
    let result = tokio::time::timeout(Duration::from_secs(5), stream)
        .await
        .expect("stream resolves after cancel")
        .unwrap();
    // Killed → non-zero exit (or an error, depending on timing); both fine —
    // what's pinned is prompt termination.
    if let Ok(code) = result {
        assert_ne!(code, 0, "cancelled stream must not report success");
    }
    // Cancel aborts the agent-side readers: only the already-buffered window
    // (plus Finished) drains, not the whole output.
    let drained = drainer.await.unwrap();
    assert!(drained <= 16, "cancel must cut the stream short, drained {drained}");
}

#[tokio::test]
async fn agent_death_fails_pending_calls_with_agent_gone() {
    let (conn, guard) = common::connect_agent().await;
    drop(guard); // kill the agent
    tokio::time::sleep(Duration::from_millis(200)).await;
    let err = conn
        .call::<serde_json::Value>(Method::FsTempPath { prefix: "x".into() })
        .await
        .expect_err("dead agent must error");
    assert_eq!(err.kind, WireErrorKind::AgentGone);
}

#[tokio::test]
async fn watch_events_cross_the_wire() {
    let (conn, _guard) = common::connect_agent().await;
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join(".git")).unwrap();

    let host = legit_host::RemoteHost::new(
        legit_host::HostId::Wsl { distro: "loopback".into() },
        conn.clone(),
    );
    let (tx, rx) = std::sync::mpsc::channel::<legit_watch::WatchBatch>();
    let handle = legit_host::Host::watch(
        &host,
        &HostPath::from_path(dir.path()),
        &HostPath::from_path(&dir.path().join(".git")),
        Box::new(move |b| {
            let _ = tx.send(b);
        }),
    )
    .await
    .expect("remote watch starts");

    std::fs::write(dir.path().join("file.txt"), "x").unwrap();
    let batch = tokio::task::spawn_blocking(move || rx.recv_timeout(Duration::from_secs(5)))
        .await
        .unwrap()
        .expect("watch batch arrives over the wire");
    assert!(batch.domains.contains(&legit_watch::ChangeDomain::Status));
    drop(handle);
}

#[cfg(unix)]
#[tokio::test]
async fn credential_relay_round_trips_through_real_git() {
    // End-to-end: `git credential fill` (spawned BY THE AGENT with its
    // relay-wired base env) re-execs the agent as its helper → Unix socket →
    // `cred.request` over the control channel → these sinks answer → git
    // prints the credentials. Covers the whole remote credential path except
    // wsl.exe itself.
    let mut sinks = HostSinks::ignore();
    sinks.on_cred_request = Box::new(|params| {
        tokio::spawn(async move {
            assert_eq!(params.op, "get");
            assert_eq!(
                params.fields.get("host").map(String::as_str),
                Some("example.invalid")
            );
            legit_proto::CredAnswer {
                username: Some("relay-user".into()),
                password: Some("relay-secret".into()),
                cancel: false,
            }
        })
    });
    let (pipes, _guard) = common::spawn_agent();
    let conn = AgentConnection::establish(
        pipes,
        &HostConnectOpts {
            app_version: env!("CARGO_PKG_VERSION").to_string(),
            base_env_extra: Vec::new(),
            enable_cred_relay: true,
        },
        sinks,
    )
    .await
    .expect("agent handshake");

    let dir = tempfile::tempdir().unwrap();
    let exec = git_exec(&conn, dir.path()).await;
    temp_repo(&exec).await;
    let out = exec
        .run_with_stdin(
            &["credential", "fill"],
            "protocol=https\nhost=example.invalid\n\n",
        )
        .await
        .expect("credential fill runs");
    assert!(out.success, "stderr: {}", out.stderr);
    assert!(out.stdout.contains("username=relay-user"), "{}", out.stdout);
    assert!(out.stdout.contains("password=relay-secret"), "{}", out.stdout);
}

#[tokio::test]
async fn unknown_method_gets_an_error_response_not_a_hang() {
    // Speak raw protocol: send a bogus method line and expect an
    // UnknownMethod response for OUR id.
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    let mut child = tokio::process::Command::new(env!("CARGO_BIN_EXE_legit-agent"))
        .arg("--stdio")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    // Skip READY.
    let ready = lines.next_line().await.unwrap().unwrap();
    assert!(legit_proto::parse_ready_line(&ready).is_some());
    stdin
        .write_all(b"{\"t\":\"req\",\"id\":99,\"method\":{\"m\":\"no_such_method\"}}\n")
        .await
        .unwrap();
    stdin.flush().await.unwrap();
    let res = tokio::time::timeout(Duration::from_secs(5), lines.next_line())
        .await
        .expect("agent answers")
        .unwrap()
        .unwrap();
    assert!(res.contains("\"id\":99") && res.contains("unknown_method"), "{res}");
}
