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
pub struct SignatureVerification {
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
    pub signature: Option<SignatureVerification>,
    #[serde(default)]
    pub decorations: Vec<RefDecoration>,
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

/// Selects which refs are walked by `GitBackend::log`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub enum RefSelector {
    #[default]
    Head,
    AllLocalBranches,
}

/// Options for `GitBackend::log`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type, Default)]
pub struct LogOptions {
    pub max_count: Option<u32>,
    pub skip: Option<u32>,
    pub revision_range: Option<String>,
    pub paths: Vec<PathBuf>,
    pub refs: RefSelector,
}

/// Decoration attached to a commit in `git log --decorate=full` output.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "value", rename_all = "camelCase")]
pub enum RefDecoration {
    /// Bare HEAD (detached).
    Head,
    /// HEAD pointing at a branch, e.g. `HEAD -> refs/heads/main`.
    HeadOf(String),
    /// A local branch ref, e.g. `refs/heads/main`.
    Branch(String),
    /// A tag ref, e.g. `refs/tags/v1.0`.
    Tag(String),
    /// A remote-tracking branch ref, e.g. `refs/remotes/origin/main`.
    Remote(String),
    /// Any other ref (notes, stash, …).
    Other(String),
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

/// A single file changed by a commit, relative to its first parent (or the
/// empty tree for a root commit). Backs the Changed Files panel.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct CommitFileChange {
    /// The file's path after the change (the destination path for renames/copies).
    pub path: PathBuf,
    /// The source path for a rename or copy; `None` otherwise.
    pub old_path: Option<PathBuf>,
    pub change: FileState,
    /// Added lines. `0` for binary files (see `binary`).
    pub additions: u32,
    /// Removed lines. `0` for binary files (see `binary`).
    pub deletions: u32,
    /// True when git reports the file as binary (numstat `-`/`-`).
    pub binary: bool,
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

/// What two sides the Diff panel is comparing for a single file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DiffSource {
    /// Index vs working tree (`git diff`).
    WorkingUnstaged,
    /// HEAD vs index (`git diff --cached`).
    WorkingStaged,
    /// A commit vs its first parent (`git diff <parent> <sha>`).
    Commit { commit_id: CommitId },
}

/// A working-tree operation applied to a single hunk (or line subset).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HunkOp {
    /// Add the hunk to the index (`git apply --cached`).
    Stage,
    /// Remove the hunk from the index (`git apply --cached -R`).
    Unstage,
    /// Drop the hunk from the working tree (`git apply -R`).
    Discard,
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

/// Detailed information for a single commit (Commit Details panel).
///
/// `commit.signature` is populated from `git verify-commit --raw` when the
/// commit object contains a `gpgsig` or similar header; otherwise it is `None`.
/// Verification is intentionally omitted from the log listing (too expensive
/// per row) and only computed on demand here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct CommitDetails {
    pub commit: Commit,
    /// The raw output of `git cat-file -p <sha>` — available for power-user inspection.
    pub raw_object: String,
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
