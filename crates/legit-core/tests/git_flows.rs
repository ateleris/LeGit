//! Real-git flow suite over the LOCAL executor (`GitRunner`). The suite body
//! lives in `suite/git_flows_suite.rs` and is shared with
//! `legit-agent/tests/remote_git_flows.rs`, which runs the identical flows
//! through a spawned agent (`RemoteExecutor`).

/// Nothing to keep alive for a local backend.
type BackendGuard = ();

async fn make_backend(
    path: &std::path::Path,
) -> (std::sync::Arc<dyn legit_core::GitBackend>, BackendGuard) {
    let runner = legit_core::GitRunner::for_repo("git", path);
    let backend = legit_core::GitCliBackend::new(
        std::sync::Arc::new(tokio::sync::RwLock::new(std::sync::Arc::new(runner))),
        std::sync::Arc::new(legit_core::LocalFs),
    );
    (std::sync::Arc::new(backend), ())
}

include!("suite/git_flows_suite.rs");
