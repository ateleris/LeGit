//! Application-layer error: wraps `GitError` plus Tauri-command concerns.
//!
//! `GitError` (domain) lives in `legit-core`. `AppError` adds command-layer
//! variants like "unknown repo id" and "forbidden console argument", as
//! described in DESIGN.md §7.7. It is `Serialize` so it crosses the IPC
//! boundary cleanly.

use legit_core::{GitError, RunnerError};
use serde::{Deserialize, Serialize};
use specta::Type;
use thiserror::Error;

#[derive(Debug, Error, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "kind", content = "details")]
pub enum AppError {
    #[error("unknown repo id: {0}")]
    UnknownRepo(String),

    #[error("path is not a git repository: {0}")]
    NotARepo(String),

    #[error("io error: {0}")]
    Io(String),

    #[error("git: {0}")]
    Git(GitError),

    #[error("git executable not available: {0}")]
    GitUnavailable(String),

    #[error("forbidden console argument: {0}")]
    ForbiddenArg(String),

    #[error("invalid theme: {0}")]
    InvalidTheme(String),

    #[error("settings error: {0}")]
    Settings(String),

    #[error("invalid command arguments: {0}")]
    ParseArgs(String),

    #[error("lane index {0} exceeds maximum of 64")]
    InvalidLockIndex(u32),

    #[error("unknown git profile id: {0}")]
    UnknownProfile(String),
}

impl From<GitError> for AppError {
    fn from(value: GitError) -> Self {
        AppError::Git(value)
    }
}

impl From<RunnerError> for AppError {
    fn from(value: RunnerError) -> Self {
        match value {
            RunnerError::GitNotFound(p) => {
                AppError::GitUnavailable(format!("not found: {}", p.display()))
            }
            other => AppError::Io(other.to_string()),
        }
    }
}

impl From<std::io::Error> for AppError {
    fn from(value: std::io::Error) -> Self {
        AppError::Io(value.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(value: serde_json::Error) -> Self {
        AppError::Settings(format!("json: {value}"))
    }
}
