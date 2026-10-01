//! Liveness-probe behavior against a scripted fake agent over an in-memory
//! duplex: a transport that stays OPEN but stops answering (a stalled WSL VM,
//! a hung wsl.exe bridge) must be declared dead exactly once - the reader
//! task never sees an EOF there, so without the ping every pending call hangs
//! forever. A responsive connection must never be killed by the probe.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use legit_host::{AgentConnection, AgentPipes, HostConnectOpts, HostSinks, PingOpts};
use legit_proto::{
    decode_frame, encode_frame, ready_line, to_value, Frame, HandshakeInfo, Method, Outcome,
    WireErrorKind, PROTO_VERSION,
};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

/// A fake agent: prints READY, answers the handshake, then answers pings only
/// when `answer_pings` - everything else is swallowed (the wedge).
async fn run_fake_agent(io: tokio::io::DuplexStream, answer_pings: bool) {
    let (r, mut w) = tokio::io::split(io);
    w.write_all(format!("{}\n", ready_line("9.9.9")).as_bytes())
        .await
        .expect("fake agent READY");
    let mut lines = BufReader::new(r).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let Ok(Frame::Req { id, method }) = decode_frame(line.trim()) else {
            continue;
        };
        let value = match method {
            Method::Handshake(_) => to_value(&HandshakeInfo {
                proto_version: PROTO_VERSION,
                agent_version: "9.9.9".into(),
                os: "linux".into(),
                arch: "x86_64".into(),
                home: "/home/u".into(),
            }),
            Method::Ping if answer_pings => to_value(&()),
            _ => continue,
        };
        let frame = encode_frame(&Frame::Res {
            id,
            outcome: Outcome::Ok(value),
        });
        if w.write_all(frame.as_bytes()).await.is_err() {
            return;
        }
        let _ = w.flush().await;
    }
}

async fn connect(
    answer_pings: bool,
    ping: PingOpts,
) -> (
    Arc<AgentConnection>,
    Arc<AtomicUsize>,
    tokio::task::JoinHandle<()>,
) {
    let (client, server) = tokio::io::duplex(64 * 1024);
    let fake = tokio::spawn(run_fake_agent(server, answer_pings));
    let (r, w) = tokio::io::split(client);
    let disconnects = Arc::new(AtomicUsize::new(0));
    let counter = disconnects.clone();
    let mut sinks = HostSinks::ignore();
    sinks.on_disconnect = Box::new(move || {
        counter.fetch_add(1, Ordering::SeqCst);
    });
    let conn = AgentConnection::establish(
        AgentPipes {
            reader: Box::new(r),
            writer: Box::new(w),
        },
        &HostConnectOpts {
            app_version: "test".into(),
            ping: Some(ping),
            ..Default::default()
        },
        sinks,
    )
    .await
    .expect("handshake against fake agent");
    (conn, disconnects, fake)
}

async fn wait_until_dead(conn: &AgentConnection) {
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while conn.is_alive() && std::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn unresponsive_connection_is_declared_dead_and_fails_pending_calls() {
    let (conn, disconnects, fake) = connect(
        false,
        PingOpts {
            interval: Duration::from_millis(50),
            timeout: Duration::from_millis(100),
        },
    )
    .await;

    // A call the fake swallows: it must not hang forever once the ping trips.
    let pending = tokio::spawn({
        let conn = conn.clone();
        async move {
            conn.call::<String>(Method::FsTempPath {
                prefix: "x".into(),
            })
            .await
        }
    });

    wait_until_dead(&conn).await;
    assert!(!conn.is_alive(), "ping must declare the wedged connection dead");
    let err = pending
        .await
        .expect("pending task")
        .expect_err("the wedged call must fail, not hang");
    assert_eq!(err.kind, WireErrorKind::AgentGone);
    assert_eq!(disconnects.load(Ordering::SeqCst), 1);

    // The reader seeing EOF afterwards (bridge finally dying) must not fire a
    // second disconnect - exactly one reconnect gets scheduled.
    fake.abort();
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(disconnects.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn responsive_connection_is_never_killed_by_the_probe() {
    let (conn, disconnects, _fake) = connect(
        true,
        PingOpts {
            interval: Duration::from_millis(30),
            timeout: Duration::from_millis(500),
        },
    )
    .await;
    // Outlive many probe rounds.
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(conn.is_alive());
    assert_eq!(disconnects.load(Ordering::SeqCst), 0);
}
