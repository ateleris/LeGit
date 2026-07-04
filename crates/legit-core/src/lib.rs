//! LeGit core library.
//!
//! Houses the domain types, the `GitBackend` trait, the single `GitRunner`
//! chokepoint that invokes `git`, and the v0.1 `GitCliBackend` implementation.
//! See `DESIGN.md` §3 and §4 for the architectural contract enforced here.

pub mod backend;
pub mod cli_impl;
pub mod error;
pub mod executor;
pub mod progress;
pub mod runner;
pub mod types;

pub use backend::GitBackend;
pub use cli_impl::{classify_remote_error, GitCliBackend};
pub use executor::GitExecutor;
pub use error::{GitError, ParseError};
pub use progress::RemoteProgress;
pub use runner::{
    GitRunner, GitVersion, OperationId, RunOutput, RunnerError, RunnerEvent,
    MIN_SUPPORTED_GIT_VERSION,
};
pub use types::*;
