//! THE remote gate (plan phase B3): the entire real-git flow suite from
//! legit-core, executed through `GitCliBackend<RemoteExecutor>` speaking the
//! full protocol to a spawned agent child. Env hardening, stdin byte-safety,
//! expected-exit-code handling, cancellation, and op_state batching must all
//! hold identically over the wire — a divergence here is a protocol bug.

mod common;

type BackendGuard = common::AgentGuard;

async fn make_backend(
    path: &std::path::Path,
) -> (std::sync::Arc<dyn legit_core::GitBackend>, BackendGuard) {
    // Remote progress arrives via HostSinks (not the process-global runner
    // observer, which lives in the AGENT process) — feed it into the suite's
    // collector so the progress assertions cover the wire path too.
    let mut sinks = legit_host::HostSinks::ignore();
    sinks.on_progress = Box::new(|op_id, progress| {
        let _ = progress_collector()
            .lock()
            .map(|mut v| v.push((op_id.0.clone(), progress)));
    });
    let (conn, guard) = common::connect_agent_with(sinks).await;
    let hc = legit_host::HostConn::new(conn);
    let exec: std::sync::Arc<dyn legit_core::GitExecutor> =
        std::sync::Arc::new(legit_host::RemoteExecutor::new(
            hc.clone(),
            legit_core::HostPath("git".into()),
            Some(legit_core::HostPath::from_path(path)),
        ));
    let backend = legit_core::GitCliBackend::<dyn legit_core::GitExecutor>::new(
        std::sync::Arc::new(tokio::sync::RwLock::new(exec)),
        std::sync::Arc::new(legit_host::RemoteFs::new(hc)),
    );
    (std::sync::Arc::new(backend), guard)
}

include!("../../legit-core/tests/suite/git_flows_suite.rs");
