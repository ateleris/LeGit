//! Domain types crossing the `GitBackend` boundary.
//!
//! Types are shaped for the long-term feature set described in DESIGN.md §4.4,
//! even when v0.1 callers only populate a subset of fields. Adding fields
//! later is a cross-cutting refactor; defining them now is one line.

use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::PathBuf;

/// SHA-1 (or SHA-256) hex string identifying a commit.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(transparent)]
pub struct CommitId(pub String);

impl CommitId {
    pub fn new(s: impl Into<String>) -> Self {
        Self(s.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Opaque identifier for a signing key (GPG fingerprint, SSH key path, ...).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(transparent)]
pub struct KeyId(pub String);

/// Author or committer identity recorded on a commit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct Signature {
    pub name: String,
    pub email: String,
    /// Unix timestamp (seconds since epoch).
    pub timestamp: i64,
    /// Timezone offset in minutes (e.g., +120 for UTC+2).
    pub tz_offset_minutes: i32,
}

/// Verification result for a commit signature.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub enum SignatureStatus {
    Good,
    BadSignature,
    UnknownKey,
    Untrusted,
    Expired,
    Revoked,
    NoSignature,
}

/// Signing metadata attached to a commit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct CommitSignature {
    pub status: SignatureStatus,
    pub signer: Option<String>,
    pub key_id: Option<KeyId>,
    pub raw: Option<String>,
}

/// A commit as exposed to the UI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct Commit {
    pub id: CommitId,
    pub parents: Vec<CommitId>,
    pub author: Signature,
    pub committer: Signature,
    pub message: String,
    /// Author timestamp (Unix seconds).
    pub timestamp: i64,
    pub signature: Option<CommitSignature>,
}

/// Sign mode requested when creating a commit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub enum SignMode {
    /// Do not sign (`--no-gpg-sign`).
    None,
    /// Inherit from config (no `-S` and no `--no-gpg-sign`).
    Default,
    /// Sign with an explicit key (`-S <key>`).
    WithKey(KeyId),
}

/// Options for `GitBackend::commit`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct CommitOptions {
    pub message: String,
    pub sign: SignMode,
    pub allow_empty: bool,
    pub amend: bool,
}

impl Default for CommitOptions {
    fn default() -> Self {
        Self {
            message: String::new(),
            sign: SignMode::Default,
            allow_empty: false,
            amend: false,
        }
    }
}

/// Options for `GitBackend::log`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type, Default)]
pub struct LogOptions {
    pub max_count: Option<u32>,
    pub skip: Option<u32>,
    pub revision_range: Option<String>,
    pub paths: Vec<PathBuf>,
}

/// Working-tree / index state of a single path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub enum FileState {
    Modified,
    Added,
    Deleted,
    Renamed,
    Copied,
    Untracked,
    Ignored,
    Conflicted,
    SubmoduleChanged,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct FileStatus {
    pub path: PathBuf,
    pub state: FileState,
    /// Whether the change is staged (in the index). `false` for working-tree-only changes.
    pub staged: bool,
}

/// A hunk in a textual diff.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct DiffHunk {
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    pub header: String,
    pub lines: Vec<DiffLine>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub enum DiffLineKind {
    Context,
    Added,
    Removed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct DiffLine {
    pub kind: DiffLineKind,
    pub content: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct TextDiff {
    pub old_path: Option<PathBuf>,
    pub new_path: Option<PathBuf>,
    pub hunks: Vec<DiffHunk>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct BinaryDiff {
    pub old_path: Option<PathBuf>,
    pub new_path: Option<PathBuf>,
    pub old_size: Option<u64>,
    pub new_size: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct SubmoduleChange {
    pub path: PathBuf,
    pub old_sha: Option<CommitId>,
    pub new_sha: Option<CommitId>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub enum DiffEntry {
    Text(TextDiff),
    Binary(BinaryDiff),
    Submodule(SubmoduleChange),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type, Default)]
pub struct Diff {
    pub entries: Vec<DiffEntry>,
}

/// A local or remote branch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct Branch {
    pub name: String,
    pub is_current: bool,
    pub is_remote: bool,
    pub upstream: Option<String>,
    pub head: Option<CommitId>,
}

/// Submodule entry as recorded in the superproject.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct SubmoduleInfo {
    pub path: PathBuf,
    pub url: Option<String>,
    pub recorded_sha: Option<CommitId>,
    pub initialized: bool,
    pub dirty: bool,
    pub detached: bool,
}
