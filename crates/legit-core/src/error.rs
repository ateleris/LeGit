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
    #[error("reference not found: {0}")]
    RefNotFound(String),

    #[error("authentication failed: {0}")]
    AuthFailed(String),

    #[error("push rejected: {stderr}")]
    PushRejected { stderr: String },

    #[error("push blocked: the superproject references submodule commits that exist on no remote:\n{stderr}")]
    UnpushedSubmodules { stderr: String },

    #[error("switching would overwrite local changes: {0}")]
    WouldOverwriteLocalChanges(String),

    #[error("git command failed (exit {exit_code}): {stderr}")]
    CommandFailed { exit_code: i32, stderr: String },

    /// A clone the user cancelled: an expected outcome the UI stays silent
    /// about - unless removing the partial clone's files failed, in which
    /// case `cleanup_failed` carries the note the user must see (a failed
    /// best-effort cleanup is never silent).
    #[error("clone cancelled")]
    CloneCancelled { cleanup_failed: Option<String> },

    /// A ref / rev / remote name that would land in a POSITIONAL argv slot
    /// while looking like a command-line option (it starts with `-`). Refused
    /// before git runs: see `cli_impl::safe_ref` for why such a name can
    /// reach us from a repository at all, and what it would do.
    /// The payload is the user-facing sentence.
    #[error("{0}")]
    UnsafeArgument(String),

    #[error("failed to parse git output: {0}")]
    Parse(String),

    #[error("git executable not available: {0}")]
    GitUnavailable(String),

    #[error("only the latest commit (HEAD) can be reworded")]
    RewordNotHead,

    #[error("this commit has already been pushed; rewording would rewrite published history")]
    RewordPushed,

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

/// Classify runner-level failures instead of flattening them: a missing git
/// binary must reach the UI as `GitUnavailable` (actionable), everything
/// else as `Internal`. (Cancellation is not an error at this level - the
/// runner reports a killed child as a normal non-zero `RunOutput`.)
impl From<crate::runner::RunnerError> for GitError {
    fn from(value: crate::runner::RunnerError) -> Self {
        use crate::runner::RunnerError;
        match value {
            RunnerError::GitNotFound(path) => {
                GitError::GitUnavailable(path.to_string_lossy().into_owned())
            }
            other => GitError::Internal(other.to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runner::RunnerError;
    use std::path::PathBuf;

    #[test]
    fn runner_git_not_found_maps_to_git_unavailable() {
        let err: GitError = RunnerError::GitNotFound(PathBuf::from("/nope/git")).into();
        assert!(
            matches!(err, GitError::GitUnavailable(_)),
            "GitNotFound must classify as GitUnavailable, got {err:?}"
        );
    }

    #[test]
    fn other_runner_errors_map_to_internal() {
        let spawn = RunnerError::Spawn(std::io::Error::other("boom"));
        let err: GitError = spawn.into();
        assert!(matches!(err, GitError::Internal(_)));
    }
}
