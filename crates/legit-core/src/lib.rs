//! LeGit core library.
//!
//! Houses the domain types, the `GitBackend` trait, the single `GitRunner`
//! chokepoint that invokes `git`, and the v0.1 `GitCliBackend` implementation.
//! See `DESIGN.md` §3 and §4 for the architectural contract enforced here.

pub mod backend;
pub mod cli_impl;
pub mod error;
pub mod executor;
pub mod fs;
pub mod progress;
pub mod runner;
pub mod types;

pub use backend::GitBackend;
pub use cli_impl::{
    checkin_normalizes, classify_line_endings, classify_line_endings_normalized,
    classify_remote_error, convert_line_endings, derive_line_ending_entry,
    is_binary_bytes, mixed_endings_in_bytes, parse_autocrlf, parse_cat_file_batch,
    parse_check_attr_z, BINARY_SNIFF_WINDOW,
    AutocrlfSetting, EolTextAttr, GitCliBackend,
};
pub use executor::GitExecutor;
pub use fs::{FsDirEntry, FsError, FsProbe, FsStat, HostPath, LocalFs, RepoFs};
pub use error::{GitError, ParseError};
pub use progress::RemoteProgress;
pub use runner::{
    set_global_base_env, set_invocation_observer, set_progress_observer, GitInvocation, GitRunner,
    GitVersion, OperationId, RunOutput, RunOutputBytes, RunnerError, RunnerEvent,
    MIN_SUPPORTED_GIT_VERSION,
};
pub use types::*;
