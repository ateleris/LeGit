//! Agent-side credential relay: a Unix-socket endpoint the shim (this same
//! binary, re-exec'd by git/ssh) connects to. Each shim request becomes a
//! `cred.request` on the control channel; the app's broker answers it. A shim
//! that hangs up mid-prompt (git was killed) produces a `cred.cancel` note so
//! the UI prompt does not outlive git.
//!
//! Trust boundary: same-user, same as the app's TCP broker — the socket lives
//! in a 0700 directory and requests carry a per-agent-run token.

#![cfg(unix)]

use std::path::PathBuf;
use std::sync::Arc;

use legit_proto::cred::ShimRelayRequest;
use legit_proto::{CredAnswer, CredRequestParams, Method, Note};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};

/// Where the relay socket lives: `$XDG_RUNTIME_DIR` (already 0700) or a
/// 0700 directory under /tmp.
fn socket_dir() -> std::io::Result<PathBuf> {
    if let Some(dir) = std::env::var_os("XDG_RUNTIME_DIR") {
        let p = PathBuf::from(dir);
        if p.is_dir() {
            return Ok(p);
        }
    }
    let uid = libc_geteuid();
    let p = PathBuf::from(format!("/tmp/legit-agent-{uid}"));
    std::fs::create_dir_all(&p)?;
    let mut perms = std::fs::metadata(&p)?.permissions();
    std::os::unix::fs::PermissionsExt::set_mode(&mut perms, 0o700);
    std::fs::set_permissions(&p, perms)?;
    Ok(p)
}

// Avoid a libc dependency for one call.
fn libc_geteuid() -> u32 {
    extern "C" {
        fn geteuid() -> u32;
    }
    // SAFETY: geteuid is always safe to call.
    unsafe { geteuid() }
}

/// Start the relay; returns the env entries every agent-side git invocation
/// needs (socket path, token, helper + askpass wiring).
pub fn start(agent: Arc<crate::Agent>) -> std::io::Result<Vec<(String, String)>> {
    let dir = socket_dir()?;
    let socket_path = dir.join(format!("legit-agent-{}.sock", std::process::id()));
    let _ = std::fs::remove_file(&socket_path);
    let listener = UnixListener::bind(&socket_path)?;
    let token = uuid::Uuid::new_v4().to_string();

    let accept_token = token.clone();
    tokio::spawn(async move {
        loop {
            match listener.accept().await {
                Ok((stream, _)) => {
                    let agent = agent.clone();
                    let token = accept_token.clone();
                    tokio::spawn(async move {
                        if let Err(e) = handle_shim(agent, stream, &token).await {
                            tracing::debug!(err = %e, "cred shim connection ended");
                        }
                    });
                }
                Err(e) => {
                    tracing::warn!(err = %e, "cred relay accept failed");
                    break;
                }
            }
        }
    });

    let exe = std::env::current_exe()?;
    Ok(legit_proto::cred::agent_shim_env(
        &exe.to_string_lossy(),
        &socket_path.to_string_lossy(),
        &token,
    ))
}

async fn handle_shim(
    agent: Arc<crate::Agent>,
    stream: UnixStream,
    token: &str,
) -> std::io::Result<()> {
    let (read_half, mut write_half) = stream.into_split();
    let mut reader = BufReader::new(read_half);

    let mut line = String::new();
    reader.read_line(&mut line).await?;
    let request: ShimRelayRequest = match serde_json::from_str(line.trim()) {
        Ok(r) => r,
        Err(_) => return Ok(()),
    };
    if request.token != token {
        tracing::warn!("cred shim connected with a bad token - ignoring");
        return Ok(());
    }

    // Forward over the control channel; the request id doubles as cred_id so
    // a hangup cancel can name it.
    let (cred_id, response_rx) = agent.begin_app_request();
    agent
        .send_request(
            cred_id,
            Method::CredRequest(CredRequestParams {
                cred_id,
                op: request.op.clone(),
                fields: request.fields,
                cwd: request.cwd,
            }),
        )
        .await;

    // Wait for the app's answer — or the shim hanging up (git killed), which
    // must cancel the UI prompt instead of leaving it dangling.
    let mut eof_probe = [0u8; 1];
    let answer: CredAnswer = tokio::select! {
        outcome = response_rx => match outcome {
            Ok(Ok(value)) => legit_proto::from_value(value).unwrap_or(CredAnswer {
                cancel: true,
                ..Default::default()
            }),
            _ => CredAnswer { cancel: true, ..Default::default() },
        },
        _ = reader.read(&mut eof_probe) => {
            agent.forget_app_request(cred_id);
            agent
                .send_note(Note::CredCancel { cred_id })
                .await;
            return Ok(());
        }
    };

    let mut out = serde_json::to_string(&answer).unwrap_or_else(|_| "{}".into());
    out.push('\n');
    write_half.write_all(out.as_bytes()).await?;
    Ok(())
}
