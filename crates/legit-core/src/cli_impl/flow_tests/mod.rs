//! Composed-flow tests for `GitCliBackend` against a scripted `FakeExecutor`.
//!
//! These encode the backend's assumptions about *which git commands run, in
//! which order, and how their outputs are reacted to* - without a real git
//! binary. The fake asserts each invocation's exact argument vector against a
//! FIFO script and returns a canned `RunOutput`; an unexpected or missing
//! invocation fails the test. Complementary to `tests/git_flows.rs`, which
//! validates the same flows against the real binary.

use super::*;
use crate::test_support::{fail, ok, out, FakeExecutor};
use crate::types::{BlobBytes, CaseDriftEntry, KeyId, SubmoduleAutoUpdateStatus, WorktreeAddMode};

/// Build a backend over a scripted executor; the returned Arc lets the test
/// call `assert_done` after exercising the flow.
fn backend(script: FakeExecutor) -> (GitCliBackend<FakeExecutor>, Arc<FakeExecutor>) {
    let exec = Arc::new(script);
    let lock = Arc::new(RwLock::new(exec.clone()));
    (GitCliBackend::new(lock, Arc::new(crate::fs::LocalFs)), exec)
}

const STASH_PUSH_MSG: &str = "legit: auto-stash before switching to feature";

mod arg_safety;
mod branch;
mod case_drift;
mod changes;
mod commits;
mod conflicts;
mod history;
mod lfs;
mod remote;
mod sequencer;
mod stash;
mod submodules;
mod worktrees;
