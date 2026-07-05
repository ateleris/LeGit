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
