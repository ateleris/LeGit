//! Domain-level errors that cross the `GitBackend` boundary.
//!
//! `GitError` is the contract. `GitCliBackend` maps `git`'s exit codes and
//! stderr patterns into specific variants (DESIGN.md §7.7).

use serde::{Deserialize, Serialize};
use specta::Type;
use thiserror::Error;

#[derive(Debug, Error, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "kind", content = "details")]
pub enum GitError {
    #[error("not a git repository: {0}")]
    NotARepo(String),

    #[error("reference not found: {0}")]
    RefNotFound(String),

    #[error("merge conflict: {0}")]
    MergeConflict(String),

    #[error("authentication failed: {0}")]
    AuthFailed(String),

    #[error("operation cancelled")]
    Cancelled,

    #[error("operation timed out")]
    TimedOut,

    #[error("git command failed (exit {exit_code}): {stderr}")]
    CommandFailed { exit_code: i32, stderr: String },

    #[error("failed to parse git output: {0}")]
    Parse(String),

    #[error("git executable not available: {0}")]
    GitUnavailable(String),

    #[error("operation not yet implemented in v0.1")]
    NotYet,

    #[error("internal error: {0}")]
    Internal(String),
}

#[derive(Debug, Error, Clone, Serialize, Deserialize, Type)]
#[error("parse error: {message} (input snippet: {snippet})")]
pub struct ParseError {
    pub message: String,
    pub snippet: String,
}

impl ParseError {
    pub fn new(message: impl Into<String>, snippet: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            snippet: snippet.into(),
        }
    }
}

impl From<ParseError> for GitError {
    fn from(value: ParseError) -> Self {
        GitError::Parse(value.message)
    }
}
