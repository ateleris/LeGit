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
    /// Presence-only: the raw commit object carries a signature header
    /// (`gpgsig`/`gpgsig-sha256`/`mergetag`). Detected by the commit list's
    /// batched header scan - NOT a verification result (`signature` is, and
    /// stays on-demand; the bulk log must never verify, see LOG_FORMAT).
    #[serde(default)]
    pub has_signature: bool,
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
    /// Local branches plus remote-tracking refs (`--branches --remotes`):
    /// the full-graph view when "show remote branches" is on.
    AllBranchesAndRemotes,
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
    /// A stash entry, carrying its reflog selector (e.g. `stash@{0}`). Synthesized
    /// for the commit-graph display; not produced by `git log --decorate`.
    Stash(String),
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
    /// A submodule whose recorded pointer moved (staged or working-tree) - a
    /// real, committable superproject change.
    SubmoduleChanged,
    /// A submodule with uncommitted changes INSIDE its worktree but an
    /// unmoved pointer. Informational: nothing here is stageable or
    /// committable from the superproject - the changes live in the
    /// submodule's own repo.
    SubmoduleDirty,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct FileStatus {
    pub path: PathBuf,
    pub state: FileState,
    /// Whether the change is staged (in the index). `false` for working-tree-only changes.
    pub staged: bool,
    /// Added lines for this entry's own diff (index diff when staged, worktree
    /// diff when not). `None` when git reports no counts for the path
    /// (untracked, conflicted, binary) — distinct from a genuine `0`.
    pub additions: Option<u32>,
    /// Removed lines; same semantics as `additions`.
    pub deletions: Option<u32>,
    /// True when git reports the file as binary (numstat `-`/`-`).
    pub binary: bool,
}

impl FileStatus {
    /// A status entry with no line counts yet (the parser's output; counts are
    /// merged in afterwards from `git diff --numstat`).
    pub fn new(path: impl Into<PathBuf>, state: FileState, staged: bool) -> Self {
        Self {
            path: path.into(),
            state,
            staged,
            additions: None,
            deletions: None,
            binary: false,
        }
    }
}

/// How git regards a file in the repo-wide Files tree. The three classes are
/// disjoint by git's own definition: a path is either in the index (tracked),
/// or an "other" file that is either ignored or not.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum RepoFileKind {
    /// In the index (`git ls-files`).
    Tracked,
    /// Present in the working tree, not tracked, not ignored.
    Untracked,
    /// Matched by a gitignore rule.
    Ignored,
}

/// A single file in the repo-wide Files tree (`list_repo_files`,
/// `list_files_at_revision`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct RepoFileEntry {
    pub path: PathBuf,
    pub kind: RepoFileKind,
    /// The entry is not a blob: a tracked gitlink (mode 160000 / ls-tree type
    /// `commit`) or an untracked nested git repo (`ls-files --others` lists it
    /// as `dir/`). No file content exists at this path in the object store,
    /// so blob actions (View, Blame) don't apply.
    #[serde(default)]
    pub submodule: bool,
}

/// The line-ending style of a file's (or blob's) text — the small indicator
/// shown in the Diff / File View / Blame panels.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum LineEndingKind {
    /// Only `\n`.
    Lf,
    /// Only `\r\n`.
    Crlf,
    /// Only lone `\r`.
    Cr,
    /// A mix of more than one of the above.
    Mixed,
    /// No line breaks at all (empty or single line).
    None,
    /// Binary content — no meaningful line endings.
    Binary,
}

/// A line-ending change between two sides of a changed file (old -> new).
/// Backs the Working Changes chips and the commit warning.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct LineEndingTransition {
    pub from: LineEndingKind,
    pub to: LineEndingKind,
}

/// Line-ending summary for one changed file (`repo_line_ending_status`).
/// `unstaged` compares the index against what `git add` would store
/// (check-in normalization applied - policy-aware, so autocrlf conversions
/// are not flagged); `staged` compares HEAD against the index: exactly what
/// a commit records, immune to autocrlf by construction.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct LineEndingStatusEntry {
    pub path: String,
    pub unstaged: Option<LineEndingTransition>,
    pub staged: Option<LineEndingTransition>,
    /// The working file has mixed CRLF+LF endings.
    pub mixed: bool,
    /// Raw on-disk kind of the working file - the chip label never lies
    /// about disk state. `None` when there is no readable working side.
    pub working_raw: Option<LineEndingKind>,
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
    /// The submodule worktree has uncommitted content on top of `new_sha`
    /// (git's `-dirty` suffix on the `Subproject commit` line).
    pub dirty: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub enum DiffEntry {
    Text(TextDiff),
    Binary(BinaryDiff),
    Submodule(SubmoduleChange),
}

/// One commit in a single file's history (`git log --follow`), with the
/// file's path AS OF THAT COMMIT - pre-rename commits carry the old name, so
/// "view/blame/diff at this commit" can address the file that actually
/// existed there.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct FileHistoryEntry {
    pub commit_id: CommitId,
    pub summary: String,
    pub author: String,
    /// Author date, unix seconds.
    pub timestamp: i64,
    /// The file's repo-relative path at this commit.
    pub path: String,
    /// Set only on the commit that renamed the file (its previous name).
    pub old_path: Option<String>,
}

/// A file's content at a revision: text, or a binary classification (NUL
/// sniff, git's own heuristic) with the blob's exact size so the UI can say
/// "binary file, N bytes" instead of rendering mojibake.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub enum FileAtRevision {
    Text(String),
    Binary { size_bytes: u64 },
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
    /// Two arbitrary revs (`git diff <from> <to>`) — the Compare view. The
    /// fields accept any rev spec (branch names, `HEAD~3`, shas), carried in
    /// `CommitId` for IPC uniformity.
    CommitRange { from: CommitId, to: CommitId },
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
    /// Commits ahead of the upstream (`%(upstream:track)`); `None` when in
    /// sync, without an upstream, or for remote branches.
    pub ahead: Option<u32>,
    /// Commits behind the upstream; `None` under the same conditions.
    pub behind: Option<u32>,
    /// The configured upstream ref no longer exists (`[gone]`).
    pub upstream_gone: bool,
    /// `%(creatordate:unix)`: the tip commit's committer date (Unix seconds).
    /// Drives the user-selectable ref sort order; 0 when git returned none.
    #[serde(default)]
    pub created_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SwitchOutcome {
    Clean,
    /// The switch succeeded and (per `StashAndKeep`) the uncommitted changes
    /// were deliberately left parked in the stash.
    ChangesStashed,
    /// The switch succeeded and the auto-stash was reapplied, but with merge
    /// conflicts: the changes are in the working tree with conflict markers and
    /// the stash entry was kept (git's pop-on-conflict behavior).
    StashPopConflicts { message: String },
    /// The switch succeeded but the auto-stash could not be applied at all —
    /// the changes remain parked in the stash entry.
    StashPopFailed { message: String },
}

/// Result of `git add --renormalize`: the files git restaged through the
/// clean filter (captured via the dry run immediately beforehand). Empty
/// means the repo was already normalized: an outcome, not an error.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct RenormalizeOutcome {
    pub restaged: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "snake_case")]
pub enum SwitchDirtyBehavior {
    /// Let git decide: a non-conflicting dirty tree carries over, a
    /// conflicting one fails (`WouldOverwriteLocalChanges`).
    #[default]
    TryDirectly,
    /// Stash, switch, pop: the changes travel to the target branch.
    AutoStash,
    /// Stash, switch, and leave the stash entry parked: the target branch
    /// starts clean and the WIP stays retrievable from the stash list.
    StashAndKeep,
}

/// Fast-forward behavior for `merge`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "snake_case")]
pub enum FfMode {
    /// git's default: fast-forward when possible, else a merge commit.
    #[default]
    Auto,
    NoFf,
    FfOnly,
}

/// Options for `merge`. `squash: true` ignores `ff` (git `--squash` never
/// creates a commit); the UI's menu items never combine them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, Default)]
pub struct MergeOptions {
    pub ff: FfMode,
    pub squash: bool,
}

/// Outcome of `merge` / `merge_continue`. Conflicts are an outcome, not an
/// error: the merge is in progress and the user resolves + continues/aborts.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MergeOutcome {
    FastForwarded,
    Merged,
    /// `--squash`: changes staged, no commit created; the user commits.
    Squashed,
    AlreadyUpToDate,
    Conflicts { message: String },
}

/// Outcome of `rebase` / `rebase_continue` / `rebase_skip`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RebaseOutcome {
    Completed,
    AlreadyUpToDate,
    Conflicts { message: String },
    /// The rebase itself finished, but reapplying the `--autostash` produced
    /// conflicts; git keeps the stash entry (mirrors `StashPopConflicts`).
    CompletedWithStashConflicts { message: String },
}

/// Which multi-step git operation the repository is currently in, if any.
/// Cherry-pick/revert are detected (the banner machinery is shared) even
/// though their UI triggers ship later.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RepoOpState {
    None,
    Merge {
        /// Branch named in MERGE_MSG ("Merge branch 'x' …"), when parseable.
        branch: Option<String>,
        /// The prepared merge message (MERGE_MSG), for commit prefill.
        message: Option<String>,
    },
    Rebase {
        /// Short SHA of the commit being rebased onto.
        onto: Option<String>,
        /// Short branch name being rebased (rebase-merge/head-name).
        head_name: Option<String>,
        current_step: Option<u32>,
        total_steps: Option<u32>,
    },
    CherryPick { sha: String },
    Revert { sha: String },
}

/// How a path conflicts, from the index's unmerged stages
/// (1 = base, 2 = ours, 3 = theirs).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum ConflictKind {
    BothModified,
    BothAdded,
    DeletedByUs,
    DeletedByThem,
}

/// A conflicted path and how it conflicts (`git ls-files -u`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct ConflictEntry {
    pub path: String,
    pub kind: ConflictKind,
}

/// Which side of a conflict to take for a whole file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum ConflictSide {
    Ours,
    Theirs,
}

/// A local tag from `git for-each-ref refs/tags`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct TagInfo {
    /// Short tag name (no `refs/tags/` prefix).
    pub name: String,
    /// The commit the tag points at (peeled for annotated tags).
    pub target_sha: CommitId,
    /// Annotated (tag object) vs lightweight (plain ref to a commit).
    pub annotated: bool,
    /// Annotation subject line (annotated tags only).
    pub message: Option<String>,
    /// The tagged commit is reachable from a remote-tracking ref. Pushing a
    /// tag whose target is NOT on the remote would upload commits no remote
    /// branch references, so the UI disables it (push the branch first).
    pub target_on_remote: bool,
    /// `%(creatordate:unix)` (Unix seconds): the tag object's creation date
    /// for annotated tags, the tagged commit's committer date for lightweight
    /// ones. Drives the user-selectable ref sort order; 0 when absent.
    #[serde(default)]
    pub created_at: i64,
}

/// A tag as it exists on a remote (`git ls-remote --tags`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct RemoteTag {
    /// Short tag name (no `refs/tags/` prefix).
    pub name: String,
    /// The commit the remote tag points at (peeled when available).
    pub target_sha: CommitId,
}

/// A single entry from `git stash list`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct StashEntry {
    /// The `N` in `stash@{N}` (0 is the most recent).
    pub index: u32,
    /// The reflog selector, e.g. `stash@{0}`. Display-only: it is positional
    /// and shifts as stashes are added/removed, so apply/pop/drop/rename
    /// address the stash by `stash_sha` instead (resolved back to the current
    /// selector at action time).
    pub selector: String,
    /// The reflog subject, e.g. `On main: my message` or `WIP on main: 1a2b3c …`.
    pub message: String,
    /// The stash's own commit SHA (a real git object — usable as a commit id,
    /// e.g. for showing its diff). The stable handle for stash mutations.
    pub stash_sha: CommitId,
    /// The base commit the stash was created from (its first parent).
    pub base_sha: CommitId,
    pub author: Signature,
    /// Author timestamp (Unix seconds).
    pub timestamp: i64,
}

/// Outcome of `git stash push`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum StashOutcome {
    Created,
    /// The working tree was clean — nothing to stash.
    NothingToStash,
}

/// Outcome of `git stash apply` / `git stash pop`. A merge conflict is reported
/// as `Conflicts` (not `Err`) because the apply itself partially succeeded and
/// the user must resolve the working tree.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum StashApplyOutcome {
    Clean,
    Conflicts { message: String },
}

/// Mode for `git reset <target>` — what happens to the index and worktree.
/// `Soft` moves HEAD only (changes stay staged), `Mixed` also resets the
/// index (changes become unstaged), `Hard` additionally resets the worktree
/// (destructive — uncommitted changes are lost).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum ResetMode {
    Soft,
    Mixed,
    Hard,
}

/// Outcome of `revert` / `cherry_pick` (and their `--continue` / `--skip`).
/// Both drive git's sequencer, so they share one outcome shape. Conflicts are
/// an outcome, not an error: the sequencer is paused and the user resolves,
/// then continues/skips/aborts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SequenceOutcome {
    Completed,
    Conflicts { message: String },
}

/// One blame hunk: a run of consecutive lines last touched by the same
/// commit. Carries the line contents (git's porcelain output includes them),
/// so the Blame view needs no separate file read and can never misalign.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct BlameHunk {
    /// The blamed commit; all-zeros for uncommitted working-tree lines.
    pub sha: CommitId,
    pub author: String,
    /// Author timestamp (Unix seconds).
    pub timestamp: i64,
    /// The commit's subject line.
    pub summary: String,
    /// 1-based first line number in the blamed file.
    pub start_line: u32,
    /// The hunk's line contents, in file order.
    pub lines: Vec<String>,
    /// Whether the blamed commit has a prior version of the file (git's
    /// porcelain `previous` header). False for the commit that introduced the
    /// file (or a root commit): blaming its parent would fail, so the "blame
    /// parent" affordance is hidden.
    pub has_previous: bool,
    /// The `previous` header's parent commit - the right revision to re-blame
    /// at (git picks the correct parent for merges, unlike a naive `<sha>^`).
    pub previous_sha: Option<CommitId>,
    /// The file's path AT `previous_sha` - the OLD name when the blamed
    /// commit renamed the file. Re-blaming must use this path: the current
    /// name does not exist in the parent after a rename.
    pub previous_path: Option<String>,
}

/// What a commit search matches against. `Message`/`Author` are
/// case-insensitive regexes (git `--grep`/`--author`); `Content` is the
/// pickaxe (`-S`): commits that change the number of occurrences of the
/// literal string.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum CommitSearchKind {
    Message,
    Author,
    /// Pickaxe (`-S`): commits changing the NUMBER of occurrences of the
    /// literal string.
    Content,
    /// `-G`: commits whose diff has an added/removed line matching the regex.
    ContentRegex,
}

/// The three index stages of a conflicted path (1 = base, 2 = ours,
/// 3 = theirs), for the 3-way resolve view. A side is `None` when that stage
/// is absent: add/add conflicts have no base, delete conflicts lack one side.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct ConflictFileSides {
    pub base: Option<String>,
    pub ours: Option<String>,
    pub theirs: Option<String>,
}

/// One step of an interactive-rebase plan. The slice order is the new commit
/// order, oldest first — exactly git's todo-file order. `Squash` melds the
/// commit into the previous kept step combining both messages (accepted
/// unchanged via `GIT_EDITOR=true`); `Fixup` melds keeping only the previous
/// message. Rewording is deliberately not a step — see the separate "reword
/// beyond HEAD" plan.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum RebaseStep {
    Pick { sha: CommitId },
    Squash { sha: CommitId },
    Fixup { sha: CommitId },
    Drop { sha: CommitId },
}

impl RebaseStep {
    pub fn sha(&self) -> &CommitId {
        match self {
            RebaseStep::Pick { sha }
            | RebaseStep::Squash { sha }
            | RebaseStep::Fixup { sha }
            | RebaseStep::Drop { sha } => sha,
        }
    }
}

/// One `git reflog` entry (HEAD's reflog). Backs the Reflog view: the safety
/// net for undo — every HEAD movement is here, including resets and rebases.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct ReflogEntry {
    /// Positional selector, e.g. `HEAD@{0}`. Display-only: it shifts with
    /// every HEAD movement; actions address the entry by `sha`.
    pub selector: String,
    /// The commit HEAD pointed at after this movement.
    pub sha: CommitId,
    /// The action prefix of the reflog subject, e.g. `commit`, `reset`,
    /// `checkout`, `rebase (finish)`.
    pub action: String,
    /// The rest of the reflog subject after `action: `.
    pub subject: String,
    /// Committer timestamp of the reflog entry (Unix seconds).
    pub timestamp: i64,
}

/// Options for `git fetch`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct FetchOptions {
    /// Fetch from all remotes (`--all`) rather than a single named remote.
    pub all: bool,
    /// Prune remote-tracking refs that no longer exist on the remote (`--prune`).
    pub prune: bool,
    /// The remote to fetch when `all` is false; ignored when `all` is true.
    pub remote: Option<String>,
}

/// How `git pull` should integrate fetched changes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
pub enum PullStrategy {
    /// Honor the repo's `pull.rebase` config (pass no integration flag).
    Default,
    /// `--rebase`.
    Rebase,
    /// `--no-rebase` (merge).
    Merge,
    /// `--ff-only`.
    FfOnly,
}

/// Options for `git pull`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct PullOptions {
    pub strategy: PullStrategy,
}

/// Options for `git push`. The remote and branch are always passed explicitly to
/// avoid `push.default` surprises.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct PushOptions {
    pub remote: String,
    pub branch: String,
    /// Set the pushed branch as upstream (`--set-upstream`) — used to publish a
    /// branch that has no tracking configuration yet.
    pub set_upstream: bool,
    /// Force-push but refuse to clobber unseen remote commits (`--force-with-lease`).
    pub force_with_lease: bool,
    /// Submodule guard (`--recurse-submodules=check|on-demand`); `None` = no
    /// flag (git default / user config).
    #[serde(default)]
    pub recurse_submodules: Option<PushRecurseMode>,
}

/// `git push --recurse-submodules` mode - the pre-push guard against
/// publishing a superproject that references unpushed submodule commits.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum PushRecurseMode {
    /// Abort the push when referenced submodule commits are on no remote.
    Check,
    /// Push the needed submodule branches first, then the superproject.
    OnDemand,
}

/// Ahead/behind tracking status for the current branch relative to its upstream.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct TrackingStatus {
    /// The current local branch (short name).
    pub branch: String,
    /// The upstream ref it tracks (e.g. `origin/main`).
    pub upstream: String,
    /// Commits on the local branch not yet on the upstream.
    pub ahead: u32,
    /// Commits on the upstream not yet on the local branch.
    pub behind: u32,
}

/// A configured git remote. `git remote -v` always lists a fetch and a push URL
/// per remote; they're equal unless a separate push URL was set.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct Remote {
    pub name: String,
    pub fetch_url: String,
    pub push_url: String,
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

/// Orthogonal state flags of one submodule. A struct, not an enum: states
/// combine freely (detached AND dirty AND pointer-moved). The UI derives a
/// single display badge by precedence (spec 2026-07-08, "Data model").
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, Default)]
pub struct SubmoduleState {
    /// Registered in `.git/config` (`submodule.<name>.url` present).
    pub initialized: bool,
    /// The worktree is checked out (a git repo exists at the path).
    pub populated: bool,
    /// Checked-out HEAD differs from the SHA recorded in the superproject.
    pub pointer_moved: bool,
    /// Modified tracked files inside the submodule worktree.
    pub dirty_tracked: bool,
    /// Untracked files inside the submodule worktree.
    pub dirty_untracked: bool,
    /// The gitlink is unmerged in the superproject.
    pub conflicted: bool,
    /// A gitlink with no `.gitmodules` entry.
    pub orphan_gitlink: bool,
    /// `.gitmodules` URL and effective (`.git/config`) URL disagree.
    pub config_drift: bool,
}

/// Submodule entry as recorded in the superproject. Keyed by `name` (durable
/// across `git mv`: config sections and `.git/modules/<name>` use it);
/// displayed by `path`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct SubmoduleInfo {
    pub name: String,
    pub path: PathBuf,
    /// Effective URL (`.git/config`); `None` when uninitialized.
    pub url: Option<String>,
    /// URL declared in `.gitmodules` (for drift detection).
    pub gitmodules_url: Option<String>,
    /// `.gitmodules` `branch` field (used by `update --remote`, tier 3).
    pub branch: Option<String>,
    /// The gitlink SHA in the superproject index; `None` for a declared-but-
    /// never-added entry.
    pub recorded_sha: Option<CommitId>,
    /// HEAD of the checked-out submodule; `None` when unpopulated.
    pub checked_out_sha: Option<CommitId>,
    /// The submodule's checked-out branch; `None` = detached HEAD (or
    /// unpopulated).
    pub head_branch: Option<String>,
    pub state: SubmoduleState,
}

/// One commit in a submodule pointer range (`repo_submodule_log`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct SubmoduleLogEntry {
    pub id: CommitId,
    pub subject: String,
}

/// Commits between two submodule pointers, or the reason they can't be shown.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SubmoduleLog {
    Commits { commits: Vec<SubmoduleLogEntry> },
    /// The target SHA is not present in the submodule's object store - the
    /// pointer references an unfetched commit.
    TargetMissing,
}

/// Options for `submodule update`. Empty `paths` = all submodules.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type, Default)]
pub struct SubmoduleUpdateOptions {
    /// Also register new submodules (`--init`).
    pub init: bool,
    /// Recurse into nested submodules (`--recursive`).
    pub recursive: bool,
    pub paths: Vec<PathBuf>,
    /// After the update, attach detached submodule HEADs to a branch pointing
    /// at the same commit (top-level submodules only). Filled backend-side
    /// from the global setting; the frontend never sets it.
    #[serde(default)]
    pub attach_branch: bool,
}

/// Integration mode for `submodule update --remote`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "snake_case")]
pub enum SubmoduleUpdateStrategy {
    /// Detach at the fetched commit (git's default).
    #[default]
    Checkout,
    /// Rebase the current branch onto the fetched commit.
    Rebase,
    /// Merge the fetched commit into the current branch.
    Merge,
}

/// State of a removed submodule's retained gitdir (`.git/modules/<name>`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct SubmoduleGitdirInfo {
    pub path: PathBuf,
    /// Commits on local branches that are on no remote - deleting the gitdir
    /// would destroy them permanently.
    pub unpushed: bool,
}

/// Per-submodule outcome of the post-switch/pull auto-update. Data, not an
/// error: partial success crosses IPC as outcomes (house rule).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SubmoduleAutoUpdateStatus {
    /// Clean submodule checked out at the recorded SHA.
    Updated,
    /// Dirty submodule updated with the local changes carried over
    /// (TryDirectly carry, or a clean auto-stash pop).
    ChangesCarried,
    /// Updated; the changes were deliberately left parked in the
    /// submodule's stash (StashAndKeep).
    ChangesStashed,
    /// The auto-stash pop conflicted: the submodule was rolled back to its
    /// previous commit and the changes reapplied cleanly there. Nothing was
    /// lost; the pointer remains un-updated.
    RolledBack { message: String },
    /// Worst case: rollback's own pop failed too. The changes are SAFE in
    /// the submodule's stash; the submodule sits at its previous commit.
    ChangesInStash { message: String },
    /// The update could not run (conflicted submodule, checkout refused,
    /// fetch failure, ...). The submodule was left untouched.
    Skipped { message: String },
}

/// One submodule's auto-update outcome.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct SubmoduleAutoUpdateResult {
    pub path: PathBuf,
    pub status: SubmoduleAutoUpdateStatus,
}
