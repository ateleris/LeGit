//! LeGit core library.
//!
//! Houses the domain types, the `GitBackend` trait, the single `GitRunner`
//! chokepoint that invokes `git`, and the v0.1 `GitCliBackend` implementation.
//! See `DESIGN.md` §3 and §4 for the architectural contract enforced here.

pub mod backend;
pub mod cli_impl;
pub mod config;
pub mod error;
pub mod executor;
pub mod fs;
pub mod progress;
pub mod runner;
pub mod types;

#[cfg(any(test, feature = "test-support"))]
pub mod test_support;

pub use backend::GitBackend;
pub use cli_impl::{
    classify_line_endings, classify_remote_error, convert_line_endings, is_binary_bytes,
    lfs_stubs_from_stderr, line_ending_candidates, GitCliBackend, LineEndingInput,
    BINARY_SNIFF_WINDOW, MAX_LINE_ENDING_BYTES,
};
pub use executor::GitExecutor;
pub use fs::{FsDirEntry, FsError, FsProbe, FsStat, HostPath, LocalFs, RepoFs};
pub use error::{GitError, ParseError};
pub use progress::RemoteProgress;
pub use runner::{
    GitRequest,
    set_global_base_env, set_invocation_observer, set_progress_observer, GitInvocation, GitRunner,
    GitVersion, OperationId, RunOutput, RunOutputBytes, RunnerError, RunnerEvent,
    MIN_SUPPORTED_GIT_VERSION,
};
pub use types::*;
