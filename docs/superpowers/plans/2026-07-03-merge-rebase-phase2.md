# Merge/Rebase Operations & Op-State (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans
> to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.
> Do NOT use subagent-driven-development (user rule).
> **Do NOT commit or push at any point** — leave all changes uncommitted for
> the user to review and commit (user rule).

**Goal:** Merge and rebase as first-class operations with conflict-aware
outcomes, repo-op-state detection (merge/rebase/cherry-pick/revert in
progress), a Working Changes banner with Continue/Skip/Abort, branch-menu
triggers, and whole-file Take ours/theirs on conflicted rows.

**Architecture:** Conflicts are outcomes, not errors (`MergeOutcome` /
`RebaseOutcome`, following `SwitchOutcome`). Op state is probed via
`git rev-parse --path-format=absolute --git-path …` plus file reads, parsed by
pure functions. Output classification (`classify_merge_output` /
`classify_rebase_output`) and argument construction are pure and unit-tested —
including the `GIT_EDITOR=false` neutralization (`-c core.editor=true`) and
the exit-code-1 conflict-vs-failure ambiguity. The watcher gains an
`op_state` domain; the banner and menus are watcher-driven.

**Tech Stack:** Rust (tokio, serde, specta), Tauri 2 IPC, React 18 +
TanStack Query, vitest / cargo test.

**Spec:** `docs/superpowers/specs/2026-07-03-merge-rebase-conflicts-design.md`
(Phase 2 section).

## Global Constraints

- **Never commit or push.** No em-dashes in any output.
- New theme tokens (`op.banner.bg`, `op.banner.fg`) go in all 4 places
  (`src/theme/tokens.ts`, `src/theme/defaults.ts`, `src/styles/theme.css`,
  both `themes/*.legit-theme.json`) — `contract.test.ts` enforces.
- No literal colours; all dimensions scale from `--ui-font-size`.
- Busy indicators delayed ~150ms (`run()` pattern from WorkingChangesPanel);
  re-entry guarded by a `useRef`.
- Destructive confirmations (Abort) gated by `useConfirmDestructive()`; when
  the setting is off, run immediately.
- The bulk `git log` format must never gain `%G?` (unrelated here, but any
  log-side change must respect it).
- Backend commands: `#[tauri::command] #[specta::specta]`, registered in
  `src-tauri/src/lib.rs`, wrappers in `src/lib/commands.ts`, types mirrored in
  `src/lib/types.ts`.
- Tests: `cargo test -p legit-core`, `cargo test -p legit-app --lib`,
  `npx vitest run`, `npx tsc --noEmit`. Never `npm install` from WSL.
- Menu/action parity: merge/rebase entries live in the shared
  `BranchMenuSection` / `RemoteBranchMenuSection` so all call sites stay in
  sync.

---

### Task 1: Core types (`legit-core/src/types.rs`)

**Files:**
- Modify: `crates/legit-core/src/types.rs` (append after `SwitchDirtyBehavior`, ~line 308)

**Interfaces:**
- Produces (Rust, used by Tasks 2-5): `FfMode { Auto | NoFf | FfOnly }`,
  `MergeOptions { ff: FfMode, squash: bool }`,
  `MergeOutcome { FastForwarded, Merged, Squashed, AlreadyUpToDate, Conflicts { message: String } }`,
  `RebaseOutcome { Completed, AlreadyUpToDate, Conflicts { message }, CompletedWithStashConflicts { message } }`,
  `RepoOpState { None, Merge { branch, message }, Rebase { onto, head_name, current_step, total_steps }, CherryPick { sha }, Revert { sha } }`,
  `ConflictKind { BothModified, BothAdded, DeletedByUs, DeletedByThem }`,
  `ConflictEntry { path, kind }`, `ConflictSide { Ours, Theirs }`.

- [ ] **Step 1: Add the types**

Append to `crates/legit-core/src/types.rs` directly after the
`SwitchDirtyBehavior` enum:

```rust
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
```

- [ ] **Step 2: Verify it compiles**

Run: `cargo check -p legit-core`
Expected: clean (types are additive).

---

### Task 2: Op-state and conflict parsers (pure)

**Files:**
- Create: `crates/legit-core/src/cli_impl/parsers/op_state.rs`
- Create: `crates/legit-core/src/cli_impl/parsers/conflicts.rs`
- Modify: `crates/legit-core/src/cli_impl/parsers/mod.rs` (add `pub mod op_state; pub mod conflicts;`)

**Interfaces:**
- Consumes: `RepoOpState`, `ConflictEntry`, `ConflictKind` (Task 1).
- Produces (used by Task 4):
  - `op_state.rs`: `pub struct OpStateProbe { pub merge_head: bool, pub merge_msg: Option<String>, pub rebase_merge: Option<RebaseMergeFiles>, pub rebase_apply: Option<RebaseApplyFiles>, pub cherry_pick_head: Option<String>, pub revert_head: Option<String> }`,
    `pub struct RebaseMergeFiles { pub head_name: Option<String>, pub onto: Option<String>, pub msgnum: Option<String>, pub end: Option<String> }`,
    `pub struct RebaseApplyFiles { pub next: Option<String>, pub last: Option<String>, pub head_name: Option<String> }`,
    `pub fn op_state_from_probe(probe: OpStateProbe) -> RepoOpState`,
    `pub fn merge_msg_branch(msg: &str) -> Option<String>`
  - `conflicts.rs`: `pub const LS_FILES_UNMERGED_ARGS: [&str; 3] = ["ls-files", "-u", "-z"];`,
    `pub fn parse_unmerged(stdout: &str) -> Result<Vec<ConflictEntry>, GitError>`

- [ ] **Step 1: Write `op_state.rs` with its tests**

```rust
//! Pure assembly of `RepoOpState` from probed `.git` state files.
//!
//! The backend probes which state files exist (MERGE_HEAD, rebase-merge/,
//! rebase-apply/, CHERRY_PICK_HEAD, REVERT_HEAD) and reads their contents;
//! everything decision-shaped lives here, testable without a repository.
//! File meanings: rebase-merge/{head-name,onto,msgnum,end} are documented
//! rebase plumbing (msgnum = current step, end = total); rebase-apply is the
//! `git am`-based variant with {next,last}.

use crate::types::RepoOpState;

/// Contents of `.git/rebase-merge/*` (the interactive/merge rebase backend).
#[derive(Debug, Default, Clone)]
pub struct RebaseMergeFiles {
    pub head_name: Option<String>,
    pub onto: Option<String>,
    pub msgnum: Option<String>,
    pub end: Option<String>,
}

/// Contents of `.git/rebase-apply/*` (the am-based rebase backend).
#[derive(Debug, Default, Clone)]
pub struct RebaseApplyFiles {
    pub next: Option<String>,
    pub last: Option<String>,
    pub head_name: Option<String>,
}

/// Everything the op-state probe found in `.git`.
#[derive(Debug, Default, Clone)]
pub struct OpStateProbe {
    pub merge_head: bool,
    pub merge_msg: Option<String>,
    pub rebase_merge: Option<RebaseMergeFiles>,
    pub rebase_apply: Option<RebaseApplyFiles>,
    pub cherry_pick_head: Option<String>,
    pub revert_head: Option<String>,
}

/// The branch named by a MERGE_MSG first line, e.g.
/// `Merge branch 'feature/x' into main` or
/// `Merge remote-tracking branch 'origin/x'`.
pub fn merge_msg_branch(msg: &str) -> Option<String> {
    let first = msg.lines().next()?;
    let rest = first
        .strip_prefix("Merge branch '")
        .or_else(|| first.strip_prefix("Merge remote-tracking branch '"))?;
    let end = rest.find('\'')?;
    (end > 0).then(|| rest[..end].to_string())
}

fn short_branch(full: &str) -> String {
    full.trim()
        .strip_prefix("refs/heads/")
        .unwrap_or(full.trim())
        .to_string()
}

fn short_sha(sha: &str) -> String {
    let t = sha.trim();
    t.chars().take(8).collect()
}

fn num(s: &Option<String>) -> Option<u32> {
    s.as_deref().and_then(|v| v.trim().parse().ok())
}

/// Priority: a rebase (either backend) can coexist with CHERRY_PICK_HEAD
/// (rebase applies commits by cherry-pick), so rebase wins; then merge, then
/// cherry-pick, then revert.
pub fn op_state_from_probe(probe: OpStateProbe) -> RepoOpState {
    if let Some(rm) = probe.rebase_merge {
        return RepoOpState::Rebase {
            onto: rm.onto.as_deref().map(short_sha),
            head_name: rm.head_name.as_deref().map(short_branch),
            current_step: num(&rm.msgnum),
            total_steps: num(&rm.end),
        };
    }
    if let Some(ra) = probe.rebase_apply {
        return RepoOpState::Rebase {
            onto: None,
            head_name: ra.head_name.as_deref().map(short_branch),
            current_step: num(&ra.next),
            total_steps: num(&ra.last),
        };
    }
    if probe.merge_head {
        return RepoOpState::Merge {
            branch: probe.merge_msg.as_deref().and_then(merge_msg_branch),
            message: probe
                .merge_msg
                .map(|m| m.trim_end().to_string())
                .filter(|m| !m.is_empty()),
        };
    }
    if let Some(sha) = probe.cherry_pick_head {
        return RepoOpState::CherryPick { sha: short_sha(&sha) };
    }
    if let Some(sha) = probe.revert_head {
        return RepoOpState::Revert { sha: short_sha(&sha) };
    }
    RepoOpState::None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_probe_is_none() {
        assert_eq!(op_state_from_probe(OpStateProbe::default()), RepoOpState::None);
    }

    #[test]
    fn merge_with_message_parses_branch() {
        let st = op_state_from_probe(OpStateProbe {
            merge_head: true,
            merge_msg: Some("Merge branch 'feature/x' into main\n".into()),
            ..Default::default()
        });
        assert_eq!(
            st,
            RepoOpState::Merge {
                branch: Some("feature/x".into()),
                message: Some("Merge branch 'feature/x' into main".into()),
            }
        );
    }

    #[test]
    fn merge_msg_branch_variants() {
        assert_eq!(merge_msg_branch("Merge branch 'dev'"), Some("dev".into()));
        assert_eq!(
            merge_msg_branch("Merge remote-tracking branch 'origin/dev' into main"),
            Some("origin/dev".into())
        );
        assert_eq!(merge_msg_branch("Revert \"x\""), None);
        assert_eq!(merge_msg_branch(""), None);
    }

    #[test]
    fn rebase_merge_state_with_progress() {
        let st = op_state_from_probe(OpStateProbe {
            rebase_merge: Some(RebaseMergeFiles {
                head_name: Some("refs/heads/feature\n".into()),
                onto: Some("0123456789abcdef0123456789abcdef01234567\n".into()),
                msgnum: Some("2\n".into()),
                end: Some("5\n".into()),
            }),
            ..Default::default()
        });
        assert_eq!(
            st,
            RepoOpState::Rebase {
                onto: Some("01234567".into()),
                head_name: Some("feature".into()),
                current_step: Some(2),
                total_steps: Some(5),
            }
        );
    }

    #[test]
    fn rebase_wins_over_cherry_pick_head() {
        // A rebase applies commits via cherry-pick; CHERRY_PICK_HEAD may exist.
        let st = op_state_from_probe(OpStateProbe {
            rebase_merge: Some(RebaseMergeFiles::default()),
            cherry_pick_head: Some("abc123".into()),
            ..Default::default()
        });
        assert!(matches!(st, RepoOpState::Rebase { .. }));
    }

    #[test]
    fn cherry_pick_and_revert_detected() {
        let cp = op_state_from_probe(OpStateProbe {
            cherry_pick_head: Some("0123456789abcdef\n".into()),
            ..Default::default()
        });
        assert_eq!(cp, RepoOpState::CherryPick { sha: "01234567".into() });
        let rv = op_state_from_probe(OpStateProbe {
            revert_head: Some("fedcba9876543210\n".into()),
            ..Default::default()
        });
        assert_eq!(rv, RepoOpState::Revert { sha: "fedcba98".into() });
    }
}
```

- [ ] **Step 2: Write `conflicts.rs` with its tests**

```rust
//! Parser for `git ls-files -u -z` (unmerged index entries) backing
//! `conflict_entries()`. Format (one record per stage, NUL-terminated):
//! `<mode> <sha> <stage>\t<path>` with stage 1 = base, 2 = ours, 3 = theirs.
//! The args live next to the parser so the contract is in one place.

use crate::error::GitError;
use crate::types::{ConflictEntry, ConflictKind};
use std::collections::BTreeMap;

pub const LS_FILES_UNMERGED_ARGS: [&str; 3] = ["ls-files", "-u", "-z"];

/// Parse the stdout of `git ls-files -u -z` into one entry per conflicted
/// path, classifying by which stages are present.
pub fn parse_unmerged(stdout: &str) -> Result<Vec<ConflictEntry>, GitError> {
    // path -> (has_base, has_ours, has_theirs), insertion-ordered by BTreeMap
    // on path so output is deterministic.
    let mut stages: BTreeMap<String, (bool, bool, bool)> = BTreeMap::new();
    for record in stdout.split('\0').filter(|r| !r.is_empty()) {
        let (meta, path) = record
            .split_once('\t')
            .ok_or_else(|| GitError::Parse(format!("ls-files -u record without tab: {record:?}")))?;
        let stage = meta
            .rsplit(' ')
            .next()
            .and_then(|s| s.parse::<u8>().ok())
            .ok_or_else(|| GitError::Parse(format!("ls-files -u record without stage: {record:?}")))?;
        let entry = stages.entry(path.to_string()).or_default();
        match stage {
            1 => entry.0 = true,
            2 => entry.1 = true,
            3 => entry.2 = true,
            other => {
                return Err(GitError::Parse(format!("unexpected ls-files stage {other}")));
            }
        }
    }
    Ok(stages
        .into_iter()
        .map(|(path, (base, ours, theirs))| {
            let kind = match (base, ours, theirs) {
                (_, true, false) => ConflictKind::DeletedByThem,
                (_, false, true) => ConflictKind::DeletedByUs,
                (false, true, true) => ConflictKind::BothAdded,
                _ => ConflictKind::BothModified,
            };
            ConflictEntry { path, kind }
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(mode: &str, sha: &str, stage: u8, path: &str) -> String {
        format!("{mode} {sha} {stage}\t{path}\0")
    }
    const SHA: &str = "0123456789abcdef0123456789abcdef01234567";

    #[test]
    fn empty_output_is_no_conflicts() {
        assert_eq!(parse_unmerged("").unwrap(), vec![]);
    }

    #[test]
    fn all_three_stages_is_both_modified() {
        let s = [rec("100644", SHA, 1, "a.txt"), rec("100644", SHA, 2, "a.txt"), rec("100644", SHA, 3, "a.txt")].concat();
        assert_eq!(
            parse_unmerged(&s).unwrap(),
            vec![ConflictEntry { path: "a.txt".into(), kind: ConflictKind::BothModified }]
        );
    }

    #[test]
    fn no_base_is_both_added() {
        let s = [rec("100644", SHA, 2, "a.txt"), rec("100644", SHA, 3, "a.txt")].concat();
        assert_eq!(parse_unmerged(&s).unwrap()[0].kind, ConflictKind::BothAdded);
    }

    #[test]
    fn missing_theirs_is_deleted_by_them() {
        let s = [rec("100644", SHA, 1, "a.txt"), rec("100644", SHA, 2, "a.txt")].concat();
        assert_eq!(parse_unmerged(&s).unwrap()[0].kind, ConflictKind::DeletedByThem);
    }

    #[test]
    fn missing_ours_is_deleted_by_us() {
        let s = [rec("100644", SHA, 1, "a.txt"), rec("100644", SHA, 3, "a.txt")].concat();
        assert_eq!(parse_unmerged(&s).unwrap()[0].kind, ConflictKind::DeletedByUs);
    }

    #[test]
    fn multiple_paths_and_tabs_in_meta_handled() {
        let s = [
            rec("100644", SHA, 2, "dir/with space.txt"),
            rec("100644", SHA, 3, "dir/with space.txt"),
            rec("100644", SHA, 1, "b.txt"),
            rec("100644", SHA, 2, "b.txt"),
            rec("100644", SHA, 3, "b.txt"),
        ]
        .concat();
        let got = parse_unmerged(&s).unwrap();
        assert_eq!(got.len(), 2);
        assert!(got.iter().any(|e| e.path == "dir/with space.txt"));
    }
}
```

- [ ] **Step 3: Register modules and run the tests**

Add to `crates/legit-core/src/cli_impl/parsers/mod.rs`:

```rust
pub mod conflicts;
pub mod op_state;
```

Run: `cargo test -p legit-core op_state` and `cargo test -p legit-core conflicts`
Expected: all PASS.

---

### Task 3: Output classifiers and argument builders (pure, in `cli_impl/mod.rs`)

**Files:**
- Modify: `crates/legit-core/src/cli_impl/mod.rs` (next to `classify_switch_error`, ~line 1381; tests in the existing `#[cfg(test)] mod tests`)

**Interfaces:**
- Consumes: `MergeOptions`, `FfMode`, `MergeOutcome`, `RebaseOutcome` (Task 1).
- Produces (used by Task 4):
  - `fn merge_args(target: &str, opts: MergeOptions) -> Vec<String>`
  - `const MERGE_CONTINUE_ARGS: [&str; 4]`, `const MERGE_ABORT_ARGS: [&str; 2]`
  - `fn rebase_args(onto: &str) -> Vec<String>`
  - `const REBASE_CONTINUE_ARGS: [&str; 4]`, `const REBASE_SKIP_ARGS: [&str; 4]`, `const REBASE_ABORT_ARGS: [&str; 2]`
  - `fn classify_merge_output(exit_code: i32, stdout: &str, stderr: &str, squash: bool) -> Result<MergeOutcome, GitError>`
  - `fn classify_rebase_output(exit_code: i32, stdout: &str, stderr: &str) -> Result<RebaseOutcome, GitError>`
  - `fn take_side_means_delete(stderr: &str) -> bool`

- [ ] **Step 1: Add the builders and classifiers**

Insert after `classify_switch_error` in `cli_impl/mod.rs`:

```rust
/// `git merge` argument list. Non-squash merges pass `--no-edit` explicitly:
/// the runner hardens with `GIT_EDITOR=false`, and without `--no-edit` a
/// merge-commit path that decides to open an editor would fail outright.
fn merge_args(target: &str, opts: MergeOptions) -> Vec<String> {
    let mut args: Vec<String> = vec!["merge".into()];
    if opts.squash {
        args.push("--squash".into());
    } else {
        match opts.ff {
            FfMode::Auto => {}
            FfMode::NoFf => args.push("--no-ff".into()),
            FfMode::FfOnly => args.push("--ff-only".into()),
        }
        args.push("--no-edit".into());
    }
    args.push(target.into());
    args
}

/// Continue/abort argument lists. The `-c core.editor=true` neutralizes the
/// editor for the commit-message step (GIT_EDITOR=false would make it fail);
/// `true` accepts the prepared message unchanged.
const MERGE_CONTINUE_ARGS: [&str; 4] = ["-c", "core.editor=true", "merge", "--continue"];
const MERGE_ABORT_ARGS: [&str; 2] = ["merge", "--abort"];

/// `git rebase` always runs with `--autostash` so a dirty tree does not block
/// it; a conflicted stash reapply after completion is its own outcome.
fn rebase_args(onto: &str) -> Vec<String> {
    vec!["rebase".into(), "--autostash".into(), onto.into()]
}

const REBASE_CONTINUE_ARGS: [&str; 4] = ["-c", "core.editor=true", "rebase", "--continue"];
const REBASE_SKIP_ARGS: [&str; 4] = ["-c", "core.editor=true", "rebase", "--skip"];
const REBASE_ABORT_ARGS: [&str; 2] = ["rebase", "--abort"];

/// Compose a user-facing message from a command's streams (stdout carries
/// git's conflict summary, stderr the hints).
fn compose_output(stdout: &str, stderr: &str) -> String {
    let mut msg = stdout.trim().to_string();
    let err = stderr.trim();
    if !err.is_empty() {
        if !msg.is_empty() {
            msg.push_str("\n");
        }
        msg.push_str(err);
    }
    msg
}

/// Split `git merge`'s exit-1 ambiguity: conflicts are an OUTCOME (merge in
/// progress), everything else an error. Encoded in tests, not comments.
fn classify_merge_output(
    exit_code: i32,
    stdout: &str,
    stderr: &str,
    squash: bool,
) -> Result<MergeOutcome, GitError> {
    let out_lc = stdout.to_lowercase();
    let err_lc = stderr.to_lowercase();
    if exit_code == 0 {
        if out_lc.contains("already up to date") {
            return Ok(MergeOutcome::AlreadyUpToDate);
        }
        if squash {
            return Ok(MergeOutcome::Squashed);
        }
        // "Fast-forward" appears on its own line under "Updating a..b".
        if out_lc.lines().any(|l| l.trim() == "fast-forward") {
            return Ok(MergeOutcome::FastForwarded);
        }
        return Ok(MergeOutcome::Merged);
    }
    if out_lc.contains("automatic merge failed")
        || out_lc.contains("conflict")
        || err_lc.contains("you have unmerged files")
        || err_lc.contains("not possible because you have unmerged files")
    {
        return Ok(MergeOutcome::Conflicts { message: compose_output(stdout, stderr) });
    }
    if err_lc.contains("would be overwritten by") {
        return Err(GitError::WouldOverwriteLocalChanges(stderr.trim().to_string()));
    }
    if err_lc.contains("not something we can merge") || err_lc.contains("unknown revision") {
        return Err(GitError::RefNotFound(stderr.trim().to_string()));
    }
    Err(GitError::CommandFailed { exit_code, stderr: compose_output(stdout, stderr) })
}

/// Split `git rebase`'s exit codes the same way. On exit 0 the autostash may
/// still have conflicted ("Applying autostash resulted in conflicts") — the
/// rebase itself succeeded, so that is a distinct success-flavored outcome.
fn classify_rebase_output(
    exit_code: i32,
    stdout: &str,
    stderr: &str,
) -> Result<RebaseOutcome, GitError> {
    let out_lc = stdout.to_lowercase();
    let err_lc = stderr.to_lowercase();
    let stash_conflict = out_lc.contains("applying autostash resulted in conflicts")
        || err_lc.contains("applying autostash resulted in conflicts");
    if exit_code == 0 {
        if stash_conflict {
            return Ok(RebaseOutcome::CompletedWithStashConflicts {
                message: compose_output(stdout, stderr),
            });
        }
        if out_lc.contains("is up to date") || err_lc.contains("is up to date") {
            return Ok(RebaseOutcome::AlreadyUpToDate);
        }
        return Ok(RebaseOutcome::Completed);
    }
    if err_lc.contains("could not apply")
        || out_lc.contains("conflict")
        || err_lc.contains("conflict")
        || err_lc.contains("you have unmerged files")
    {
        return Ok(RebaseOutcome::Conflicts { message: compose_output(stdout, stderr) });
    }
    if err_lc.contains("would be overwritten by") {
        return Err(GitError::WouldOverwriteLocalChanges(stderr.trim().to_string()));
    }
    if err_lc.contains("invalid upstream") || err_lc.contains("unknown revision") {
        return Err(GitError::RefNotFound(stderr.trim().to_string()));
    }
    Err(GitError::CommandFailed { exit_code, stderr: compose_output(stdout, stderr) })
}

/// `git checkout --ours/--theirs` fails when the chosen side has no stage
/// entry (a delete-conflict where that side deleted the file); taking that
/// side then means deleting the path (`git rm -f`).
fn take_side_means_delete(stderr: &str) -> bool {
    let lc = stderr.to_lowercase();
    lc.contains("does not have our version") || lc.contains("does not have their version")
}
```

Add `FfMode, MergeOptions, MergeOutcome, RebaseOutcome, ConflictEntry, ConflictSide, RepoOpState` to the `crate::types::{…}` import list at the top of `cli_impl/mod.rs`.

- [ ] **Step 2: Add the tests**

Append inside the existing `#[cfg(test)] mod tests` in `cli_impl/mod.rs`:

```rust
    // --- merge/rebase argument construction ---

    #[test]
    fn merge_args_pass_no_edit_for_commit_merges() {
        // GIT_EDITOR=false hardening: a merge that decides to open an editor
        // would fail, so every non-squash merge must carry --no-edit.
        for ff in [FfMode::Auto, FfMode::NoFf, FfMode::FfOnly] {
            let args = merge_args("dev", MergeOptions { ff, squash: false });
            assert!(args.contains(&"--no-edit".to_string()), "{args:?}");
            assert_eq!(args.last().unwrap(), "dev");
        }
        assert!(merge_args("dev", MergeOptions { ff: FfMode::NoFf, squash: false })
            .contains(&"--no-ff".to_string()));
        assert!(merge_args("dev", MergeOptions { ff: FfMode::FfOnly, squash: false })
            .contains(&"--ff-only".to_string()));
    }

    #[test]
    fn squash_merge_ignores_ff_and_skips_no_edit() {
        let args = merge_args("dev", MergeOptions { ff: FfMode::NoFf, squash: true });
        assert_eq!(args, vec!["merge", "--squash", "dev"]);
    }

    #[test]
    fn continue_commands_neutralize_the_editor() {
        assert_eq!(MERGE_CONTINUE_ARGS, ["-c", "core.editor=true", "merge", "--continue"]);
        assert_eq!(REBASE_CONTINUE_ARGS, ["-c", "core.editor=true", "rebase", "--continue"]);
        assert_eq!(REBASE_SKIP_ARGS, ["-c", "core.editor=true", "rebase", "--skip"]);
    }

    #[test]
    fn rebase_always_autostashes() {
        assert_eq!(rebase_args("main"), vec!["rebase", "--autostash", "main"]);
    }

    // --- merge output classification (exit-1 ambiguity) ---

    #[test]
    fn merge_conflict_is_outcome_not_error() {
        let out = classify_merge_output(
            1,
            "Auto-merging a.txt\nCONFLICT (content): Merge conflict in a.txt\nAutomatic merge failed; fix conflicts and then commit the result.\n",
            "",
            false,
        );
        assert!(matches!(out, Ok(MergeOutcome::Conflicts { .. })));
    }

    #[test]
    fn merge_success_variants() {
        assert_eq!(
            classify_merge_output(0, "Already up to date.\n", "", false).unwrap(),
            MergeOutcome::AlreadyUpToDate
        );
        assert_eq!(
            classify_merge_output(0, "Updating 1a2b..3c4d\nFast-forward\n a.txt | 1 +\n", "", false).unwrap(),
            MergeOutcome::FastForwarded
        );
        assert_eq!(
            classify_merge_output(0, "Merge made by the 'ort' strategy.\n", "", false).unwrap(),
            MergeOutcome::Merged
        );
        assert_eq!(
            classify_merge_output(0, "Squash commit -- not updating HEAD\n", "", true).unwrap(),
            MergeOutcome::Squashed
        );
    }

    #[test]
    fn merge_real_failures_stay_errors() {
        assert!(matches!(
            classify_merge_output(1, "", "error: Your local changes to the following files would be overwritten by merge:\n\ta.txt\n", false),
            Err(GitError::WouldOverwriteLocalChanges(_))
        ));
        assert!(matches!(
            classify_merge_output(1, "", "merge: nosuch - not something we can merge\n", false),
            Err(GitError::RefNotFound(_))
        ));
        assert!(matches!(
            classify_merge_output(128, "", "fatal: refusing to merge unrelated histories\n", false),
            Err(GitError::CommandFailed { .. })
        ));
        // ff-only refusal is a plain failure with git's own message.
        assert!(matches!(
            classify_merge_output(128, "", "fatal: Not possible to fast-forward, aborting.\n", false),
            Err(GitError::CommandFailed { .. })
        ));
    }

    // --- rebase output classification ---

    #[test]
    fn rebase_conflict_is_outcome_not_error() {
        let out = classify_rebase_output(
            1,
            "Auto-merging a.txt\nCONFLICT (content): Merge conflict in a.txt\n",
            "error: could not apply 1a2b3c4... subject\n",
        );
        assert!(matches!(out, Ok(RebaseOutcome::Conflicts { .. })));
    }

    #[test]
    fn rebase_success_variants() {
        assert_eq!(
            classify_rebase_output(0, "", "Successfully rebased and updated refs/heads/feature.\n").unwrap(),
            RebaseOutcome::Completed
        );
        assert_eq!(
            classify_rebase_output(0, "Current branch feature is up to date.\n", "").unwrap(),
            RebaseOutcome::AlreadyUpToDate
        );
        assert!(matches!(
            classify_rebase_output(
                0,
                "Applying autostash resulted in conflicts.\nYour changes are safe in the stash.\n",
                "Successfully rebased and updated refs/heads/feature.\n"
            )
            .unwrap(),
            RebaseOutcome::CompletedWithStashConflicts { .. }
        ));
    }

    #[test]
    fn rebase_real_failures_stay_errors() {
        assert!(matches!(
            classify_rebase_output(128, "", "fatal: invalid upstream 'nosuch'\n"),
            Err(GitError::RefNotFound(_))
        ));
    }

    // --- take-side delete detection ---

    #[test]
    fn take_side_delete_conflict_detection() {
        assert!(take_side_means_delete("error: path 'a.txt' does not have their version\n"));
        assert!(take_side_means_delete("error: path 'a.txt' does not have our version\n"));
        assert!(!take_side_means_delete("error: pathspec 'a.txt' did not match any files\n"));
    }
```

- [ ] **Step 3: Run the tests**

Run: `cargo test -p legit-core classify_merge && cargo test -p legit-core classify_rebase && cargo test -p legit-core merge_args && cargo test -p legit-core rebase_a && cargo test -p legit-core take_side && cargo test -p legit-core continue_commands && cargo test -p legit-core squash_merge`
Expected: all PASS. (Dead-code warnings for the not-yet-used constants are
expected until Task 4; suppress nothing.)

---

### Task 4: Backend trait methods and implementations

**Files:**
- Modify: `crates/legit-core/src/backend.rs` (trait + import list)
- Modify: `crates/legit-core/src/cli_impl/mod.rs` (impl block; import parsers)

**Interfaces:**
- Consumes: Tasks 1-3 items.
- Produces (used by Task 5), trait methods on `GitBackend`:
  - `async fn merge(&self, target: &str, opts: MergeOptions) -> Result<MergeOutcome, GitError>`
  - `async fn merge_continue(&self) -> Result<MergeOutcome, GitError>`
  - `async fn merge_abort(&self) -> Result<(), GitError>`
  - `async fn rebase(&self, onto: &str) -> Result<RebaseOutcome, GitError>`
  - `async fn rebase_continue(&self) -> Result<RebaseOutcome, GitError>`
  - `async fn rebase_skip(&self) -> Result<RebaseOutcome, GitError>`
  - `async fn rebase_abort(&self) -> Result<(), GitError>`
  - `async fn op_state(&self) -> Result<RepoOpState, GitError>`
  - `async fn conflict_entries(&self) -> Result<Vec<ConflictEntry>, GitError>`
  - `async fn resolve_take_side(&self, path: &Path, side: ConflictSide) -> Result<(), GitError>`

- [ ] **Step 1: Add trait methods to `backend.rs`**

Extend the `use crate::types::{…}` list with `ConflictEntry, ConflictSide,
MergeOptions, MergeOutcome, RebaseOutcome, RepoOpState`, then append to the
trait (before the closing brace):

```rust
    /// Merge `target` into the current branch. Conflicts are an OUTCOME
    /// (`MergeOutcome::Conflicts` — merge in progress, resolve then
    /// continue/abort), not an error. Non-squash merges run with `--no-edit`
    /// (the runner's GIT_EDITOR=false would otherwise fail the message step).
    async fn merge(&self, target: &str, opts: MergeOptions) -> Result<MergeOutcome, GitError>;

    /// Conclude an in-progress merge after conflicts are resolved
    /// (`git merge --continue` with the editor neutralized — the prepared
    /// MERGE_MSG is used unchanged).
    async fn merge_continue(&self) -> Result<MergeOutcome, GitError>;

    /// Abort an in-progress merge, restoring the pre-merge state.
    async fn merge_abort(&self) -> Result<(), GitError>;

    /// Rebase the current branch onto `onto`, always with `--autostash`.
    /// A conflicted stash reapply after a successful rebase is
    /// `CompletedWithStashConflicts` (the stash entry is kept).
    async fn rebase(&self, onto: &str) -> Result<RebaseOutcome, GitError>;

    /// Continue an in-progress rebase after resolving conflicts.
    async fn rebase_continue(&self) -> Result<RebaseOutcome, GitError>;

    /// Skip the current commit of an in-progress rebase.
    async fn rebase_skip(&self) -> Result<RebaseOutcome, GitError>;

    /// Abort an in-progress rebase, restoring the original branch state.
    async fn rebase_abort(&self) -> Result<(), GitError>;

    /// Which multi-step operation (merge/rebase/cherry-pick/revert) the repo
    /// is currently in. Probed from git-reported state paths
    /// (`rev-parse --git-path`), never a hardcoded `.git` layout.
    async fn op_state(&self) -> Result<RepoOpState, GitError>;

    /// The currently conflicted paths with their conflict kinds
    /// (`git ls-files -u`).
    async fn conflict_entries(&self) -> Result<Vec<ConflictEntry>, GitError>;

    /// Resolve a conflicted path by taking one side wholesale:
    /// `git checkout --ours|--theirs -- <path>` + `git add`; for a
    /// delete-conflict where the chosen side deleted the file, `git rm -f`.
    async fn resolve_take_side(&self, path: &Path, side: ConflictSide) -> Result<(), GitError>;
```

- [ ] **Step 2: Implement in `cli_impl/mod.rs`**

Add a small runner helper in the `impl GitCliBackend` block (next to
`run_pathspec`):

```rust
    /// Run args and return (exit_code, stdout, stderr) with 0 for success —
    /// the classifier-friendly shape for merge/rebase commands.
    async fn run_classified(&self, args: &[&str]) -> Result<(i32, String, String), GitError> {
        let runner = self.runner().await;
        let out = runner
            .run(args)
            .await
            .map_err(|e| GitError::Internal(e.to_string()))?;
        let code = if out.success { 0 } else { out.exit_code.unwrap_or(-1) };
        Ok((code, out.stdout, out.stderr))
    }
```

Then add to the `impl GitBackend for GitCliBackend` block (after
`checkout_commit`):

```rust
    async fn merge(&self, target: &str, opts: MergeOptions) -> Result<MergeOutcome, GitError> {
        let args = merge_args(target, opts);
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        let (code, stdout, stderr) = self.run_classified(&refs).await?;
        classify_merge_output(code, &stdout, &stderr, opts.squash)
    }

    async fn merge_continue(&self) -> Result<MergeOutcome, GitError> {
        let (code, stdout, stderr) = self.run_classified(&MERGE_CONTINUE_ARGS).await?;
        classify_merge_output(code, &stdout, &stderr, false)
    }

    async fn merge_abort(&self) -> Result<(), GitError> {
        let (code, _stdout, stderr) = self.run_classified(&MERGE_ABORT_ARGS).await?;
        if code != 0 {
            return Err(GitError::CommandFailed { exit_code: code, stderr: stderr.trim().into() });
        }
        Ok(())
    }

    async fn rebase(&self, onto: &str) -> Result<RebaseOutcome, GitError> {
        let args = rebase_args(onto);
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        let (code, stdout, stderr) = self.run_classified(&refs).await?;
        classify_rebase_output(code, &stdout, &stderr)
    }

    async fn rebase_continue(&self) -> Result<RebaseOutcome, GitError> {
        let (code, stdout, stderr) = self.run_classified(&REBASE_CONTINUE_ARGS).await?;
        classify_rebase_output(code, &stdout, &stderr)
    }

    async fn rebase_skip(&self) -> Result<RebaseOutcome, GitError> {
        let (code, stdout, stderr) = self.run_classified(&REBASE_SKIP_ARGS).await?;
        classify_rebase_output(code, &stdout, &stderr)
    }

    async fn rebase_abort(&self) -> Result<(), GitError> {
        let (code, _stdout, stderr) = self.run_classified(&REBASE_ABORT_ARGS).await?;
        if code != 0 {
            return Err(GitError::CommandFailed { exit_code: code, stderr: stderr.trim().into() });
        }
        Ok(())
    }

    async fn op_state(&self) -> Result<RepoOpState, GitError> {
        // git reports the state paths; only existence/content is read from
        // disk. --path-format=absolute avoids joining against the workdir.
        let (code, stdout, stderr) = self
            .run_classified(&[
                "rev-parse", "--path-format=absolute",
                "--git-path", "MERGE_HEAD",
                "--git-path", "MERGE_MSG",
                "--git-path", "rebase-merge",
                "--git-path", "rebase-apply",
                "--git-path", "CHERRY_PICK_HEAD",
                "--git-path", "REVERT_HEAD",
            ])
            .await?;
        if code != 0 {
            return Err(GitError::CommandFailed { exit_code: code, stderr: stderr.trim().into() });
        }
        let lines: Vec<&str> = stdout.lines().collect();
        if lines.len() < 6 {
            return Err(GitError::Parse(format!("rev-parse --git-path returned {} lines", lines.len())));
        }
        use std::path::Path as P;
        async fn read_opt(p: &P) -> Option<String> {
            tokio::fs::read_to_string(p).await.ok()
        }
        async fn exists(p: &P) -> bool {
            tokio::fs::metadata(p).await.is_ok()
        }
        let (merge_head_p, merge_msg_p, rebase_merge_p, rebase_apply_p, cherry_p, revert_p) = (
            P::new(lines[0]), P::new(lines[1]), P::new(lines[2]),
            P::new(lines[3]), P::new(lines[4]), P::new(lines[5]),
        );
        let probe = parsers::op_state::OpStateProbe {
            merge_head: exists(merge_head_p).await,
            merge_msg: read_opt(merge_msg_p).await,
            rebase_merge: if exists(rebase_merge_p).await {
                Some(parsers::op_state::RebaseMergeFiles {
                    head_name: read_opt(&rebase_merge_p.join("head-name")).await,
                    onto: read_opt(&rebase_merge_p.join("onto")).await,
                    msgnum: read_opt(&rebase_merge_p.join("msgnum")).await,
                    end: read_opt(&rebase_merge_p.join("end")).await,
                })
            } else {
                None
            },
            rebase_apply: if exists(rebase_apply_p).await {
                Some(parsers::op_state::RebaseApplyFiles {
                    next: read_opt(&rebase_apply_p.join("next")).await,
                    last: read_opt(&rebase_apply_p.join("last")).await,
                    head_name: read_opt(&rebase_apply_p.join("head-name")).await,
                })
            } else {
                None
            },
            cherry_pick_head: read_opt(cherry_p).await,
            revert_head: read_opt(revert_p).await,
        };
        Ok(parsers::op_state::op_state_from_probe(probe))
    }

    async fn conflict_entries(&self) -> Result<Vec<ConflictEntry>, GitError> {
        let (code, stdout, stderr) = self
            .run_classified(&parsers::conflicts::LS_FILES_UNMERGED_ARGS)
            .await?;
        if code != 0 {
            return Err(GitError::CommandFailed { exit_code: code, stderr: stderr.trim().into() });
        }
        parsers::conflicts::parse_unmerged(&stdout)
    }

    async fn resolve_take_side(&self, path: &Path, side: ConflictSide) -> Result<(), GitError> {
        let flag = match side {
            ConflictSide::Ours => "--ours",
            ConflictSide::Theirs => "--theirs",
        };
        let p = path.to_string_lossy().into_owned();
        let (code, _stdout, stderr) = self.run_classified(&["checkout", flag, "--", &p]).await?;
        if code != 0 {
            if take_side_means_delete(&stderr) {
                // The chosen side deleted the file: taking it = delete + stage
                // (git rm stages the removal itself).
                let (rm_code, _o, rm_err) = self.run_classified(&["rm", "-f", "--", &p]).await?;
                if rm_code != 0 {
                    return Err(GitError::CommandFailed { exit_code: rm_code, stderr: rm_err.trim().into() });
                }
                return Ok(());
            }
            return Err(GitError::CommandFailed { exit_code: code, stderr: stderr.trim().into() });
        }
        // Stage the taken side to mark the path resolved.
        self.run_pathspec(&["add", "--"], &[path.to_path_buf()]).await
    }
```

If `parsers` is not already in scope as a module path in `mod.rs`, check the
existing references (`grep -n "parsers::" crates/legit-core/src/cli_impl/mod.rs`)
and match that style.

- [ ] **Step 3: Compile and run the core suite**

Run: `cargo test -p legit-core`
Expected: all PASS (131 existing + Task 2/3 additions), no dead-code warnings
remaining for the new constants.

---

### Task 5: IPC commands, watcher domain, TS mirrors

**Files:**
- Create: `src-tauri/src/commands/ops.rs`
- Modify: `src-tauri/src/commands/mod.rs` (`pub mod ops; pub use ops::*;`)
- Modify: `src-tauri/src/lib.rs` (register 10 commands)
- Modify: `src-tauri/src/watcher.rs` (`ChangeDomain::OpState` + classification + tests)
- Modify: `src/lib/types.ts` (mirrors), `src/lib/commands.ts` (wrappers)

**Interfaces:**
- Produces (TS, used by Tasks 6-8):
  - Types: `FfMode = "auto" | "no_ff" | "ff_only"`, `MergeOptions { ff: FfMode; squash: boolean }`,
    `MergeOutcome`, `RebaseOutcome`, `RepoOpState`, `ConflictKind`, `ConflictEntry`, `ConflictSide` (snake_case tagged like `SwitchOutcome`)
  - Wrappers: `repoMerge(repoId, target, options) → Promise<MergeOutcome>`,
    `repoMergeContinue(repoId)`, `repoMergeAbort(repoId)`,
    `repoRebase(repoId, onto) → Promise<RebaseOutcome>`, `repoRebaseContinue(repoId)`,
    `repoRebaseSkip(repoId)`, `repoRebaseAbort(repoId)`,
    `repoOpState(repoId) → Promise<RepoOpState>`,
    `repoConflictEntries(repoId) → Promise<ConflictEntry[]>`,
    `repoResolveTakeSide(repoId, path, side) → Promise<null>`
  - Watcher: `ChangeDomain::OpState` serializes to `"op_state"`; the frontend
    query key is `[repoId, "op_state"]`.

- [ ] **Step 1: Write `src-tauri/src/commands/ops.rs`**

```rust
//! Merge/rebase operations, repo-op-state probing, and whole-file conflict
//! resolution. Conflicts cross the IPC boundary as OUTCOMES (data), not
//! errors — the panels render them as in-progress state, not failure toasts.

use crate::error::AppError;
use crate::state::AppState;
use legit_core::types::{
    ConflictEntry, ConflictSide, MergeOptions, MergeOutcome, RebaseOutcome, RepoOpState,
};
use std::path::PathBuf;

#[tauri::command]
#[specta::specta]
pub async fn repo_merge(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    target: String,
    options: MergeOptions,
) -> Result<MergeOutcome, AppError> {
    let session = state.get_session(&repo_id).await?;
    session.backend.merge(&target, options).await.map_err(AppError::Git)
}

#[tauri::command]
#[specta::specta]
pub async fn repo_merge_continue(
    state: tauri::State<'_, AppState>,
    repo_id: String,
) -> Result<MergeOutcome, AppError> {
    let session = state.get_session(&repo_id).await?;
    session.backend.merge_continue().await.map_err(AppError::Git)
}

#[tauri::command]
#[specta::specta]
pub async fn repo_merge_abort(
    state: tauri::State<'_, AppState>,
    repo_id: String,
) -> Result<(), AppError> {
    let session = state.get_session(&repo_id).await?;
    session.backend.merge_abort().await.map_err(AppError::Git)
}

#[tauri::command]
#[specta::specta]
pub async fn repo_rebase(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    onto: String,
) -> Result<RebaseOutcome, AppError> {
    let session = state.get_session(&repo_id).await?;
    session.backend.rebase(&onto).await.map_err(AppError::Git)
}

#[tauri::command]
#[specta::specta]
pub async fn repo_rebase_continue(
    state: tauri::State<'_, AppState>,
    repo_id: String,
) -> Result<RebaseOutcome, AppError> {
    let session = state.get_session(&repo_id).await?;
    session.backend.rebase_continue().await.map_err(AppError::Git)
}

#[tauri::command]
#[specta::specta]
pub async fn repo_rebase_skip(
    state: tauri::State<'_, AppState>,
    repo_id: String,
) -> Result<RebaseOutcome, AppError> {
    let session = state.get_session(&repo_id).await?;
    session.backend.rebase_skip().await.map_err(AppError::Git)
}

#[tauri::command]
#[specta::specta]
pub async fn repo_rebase_abort(
    state: tauri::State<'_, AppState>,
    repo_id: String,
) -> Result<(), AppError> {
    let session = state.get_session(&repo_id).await?;
    session.backend.rebase_abort().await.map_err(AppError::Git)
}

#[tauri::command]
#[specta::specta]
pub async fn repo_op_state(
    state: tauri::State<'_, AppState>,
    repo_id: String,
) -> Result<RepoOpState, AppError> {
    let session = state.get_session(&repo_id).await?;
    session.backend.op_state().await.map_err(AppError::Git)
}

#[tauri::command]
#[specta::specta]
pub async fn repo_conflict_entries(
    state: tauri::State<'_, AppState>,
    repo_id: String,
) -> Result<Vec<ConflictEntry>, AppError> {
    let session = state.get_session(&repo_id).await?;
    session.backend.conflict_entries().await.map_err(AppError::Git)
}

#[tauri::command]
#[specta::specta]
pub async fn repo_resolve_take_side(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    path: String,
    side: ConflictSide,
) -> Result<(), AppError> {
    let session = state.get_session(&repo_id).await?;
    session
        .backend
        .resolve_take_side(&PathBuf::from(path), side)
        .await
        .map_err(AppError::Git)
}
```

Add `pub mod ops;` + `pub use ops::*;` to `src-tauri/src/commands/mod.rs`, and
register all 10 commands in `src-tauri/src/lib.rs` `collect_commands![]` after
`commands::repo_write_worktree_file,`:

```rust
        commands::repo_merge,
        commands::repo_merge_continue,
        commands::repo_merge_abort,
        commands::repo_rebase,
        commands::repo_rebase_continue,
        commands::repo_rebase_skip,
        commands::repo_rebase_abort,
        commands::repo_op_state,
        commands::repo_conflict_entries,
        commands::repo_resolve_take_side,
```

- [ ] **Step 2: Watcher `OpState` domain (test-first within the same file)**

In `src-tauri/src/watcher.rs`:

1. Add `OpState,` to `enum ChangeDomain` (serializes as `"op_state"` via the
   existing `rename_all = "snake_case"`).
2. In `classify_git`, extend the ref-move arm and the rebase arm, and add a
   `MERGE_MSG` arm:

```rust
        "HEAD" | "refs" | "packed-refs" | "MERGE_HEAD" | "ORIG_HEAD" | "FETCH_HEAD"
        | "CHERRY_PICK_HEAD" | "REVERT_HEAD" => {
            out.insert(ChangeDomain::Log);
            out.insert(ChangeDomain::Branches);
            if matches!(first.as_str(), "MERGE_HEAD" | "CHERRY_PICK_HEAD" | "REVERT_HEAD") {
                out.insert(ChangeDomain::OpState);
            }
            if first == "packed-refs" || rel.starts_with("refs/stash") {
                out.insert(ChangeDomain::Stashes);
            }
            if first == "packed-refs" || rel.starts_with("refs/tags") {
                out.insert(ChangeDomain::Tags);
            }
        }
        // The prepared merge message feeds the op-state banner.
        "MERGE_MSG" => {
            out.insert(ChangeDomain::OpState);
        }
        // In-progress merge/rebase state affects all three (conflicts + refs)
        // plus the op-state banner.
        "rebase-merge" | "rebase-apply" => {
            out.insert(ChangeDomain::Status);
            out.insert(ChangeDomain::Log);
            out.insert(ChangeDomain::Branches);
            out.insert(ChangeDomain::OpState);
        }
```

3. Add tests to the watcher's `#[cfg(test)]` module:

```rust
    #[test]
    fn merge_head_drives_op_state() {
        let wt = Path::new("/repo");
        let gd = Path::new("/repo/.git");
        let mut out = BTreeSet::new();
        classify(Path::new("/repo/.git/MERGE_HEAD"), wt, gd, &Gitignore::empty(), &mut out);
        assert!(out.contains(&ChangeDomain::OpState));
    }

    #[test]
    fn rebase_dir_drives_op_state() {
        let wt = Path::new("/repo");
        let gd = Path::new("/repo/.git");
        let mut out = BTreeSet::new();
        classify(Path::new("/repo/.git/rebase-merge/msgnum"), wt, gd, &Gitignore::empty(), &mut out);
        assert!(out.contains(&ChangeDomain::OpState) && out.contains(&ChangeDomain::Status));
    }

    #[test]
    fn merge_msg_drives_op_state_only() {
        let wt = Path::new("/repo");
        let gd = Path::new("/repo/.git");
        let mut out = BTreeSet::new();
        classify(Path::new("/repo/.git/MERGE_MSG"), wt, gd, &Gitignore::empty(), &mut out);
        assert_eq!(out.into_iter().collect::<Vec<_>>(), vec![ChangeDomain::OpState]);
    }
```

Run: `cargo test -p legit-app --lib`
Expected: PASS, including the three new watcher tests.

- [ ] **Step 3: TS mirrors and wrappers**

Append to `src/lib/types.ts` (after `SwitchDirtyBehavior`):

```ts
/** Fast-forward behavior for a merge (matches legit-core `FfMode`). */
export type FfMode = "auto" | "no_ff" | "ff_only";

export interface MergeOptions {
  ff: FfMode;
  /** `--squash`: stages the result without committing; `ff` is ignored. */
  squash: boolean;
}

/** Outcome of merge/merge-continue — conflicts are data, not an error. */
export type MergeOutcome =
  | { kind: "fast_forwarded" }
  | { kind: "merged" }
  | { kind: "squashed" }
  | { kind: "already_up_to_date" }
  | { kind: "conflicts"; message: string };

export type RebaseOutcome =
  | { kind: "completed" }
  | { kind: "already_up_to_date" }
  | { kind: "conflicts"; message: string }
  /** Rebase finished, but reapplying the autostash conflicted (stash kept). */
  | { kind: "completed_with_stash_conflicts"; message: string };

/** Which multi-step operation the repo is in (matches `RepoOpState`). */
export type RepoOpState =
  | { kind: "none" }
  | { kind: "merge"; branch: string | null; message: string | null }
  | {
      kind: "rebase";
      onto: string | null;
      head_name: string | null;
      current_step: number | null;
      total_steps: number | null;
    }
  | { kind: "cherry_pick"; sha: string }
  | { kind: "revert"; sha: string };

export type ConflictKind = "both_modified" | "both_added" | "deleted_by_us" | "deleted_by_them";

export interface ConflictEntry {
  path: string;
  kind: ConflictKind;
}

export type ConflictSide = "ours" | "theirs";
```

Append to `src/lib/commands.ts` (imports: add the new types to the existing
`import type {…} from "./types"`):

```ts
// --- merge / rebase / op-state ---

export const repoMerge = (repoId: string, target: string, options: MergeOptions) =>
  invoke<MergeOutcome>("repo_merge", { repoId, target, options });

export const repoMergeContinue = (repoId: string) =>
  invoke<MergeOutcome>("repo_merge_continue", { repoId });

export const repoMergeAbort = (repoId: string) =>
  invoke<null>("repo_merge_abort", { repoId });

export const repoRebase = (repoId: string, onto: string) =>
  invoke<RebaseOutcome>("repo_rebase", { repoId, onto });

export const repoRebaseContinue = (repoId: string) =>
  invoke<RebaseOutcome>("repo_rebase_continue", { repoId });

export const repoRebaseSkip = (repoId: string) =>
  invoke<RebaseOutcome>("repo_rebase_skip", { repoId });

export const repoRebaseAbort = (repoId: string) =>
  invoke<null>("repo_rebase_abort", { repoId });

export const repoOpState = (repoId: string) =>
  invoke<RepoOpState>("repo_op_state", { repoId });

export const repoConflictEntries = (repoId: string) =>
  invoke<ConflictEntry[]>("repo_conflict_entries", { repoId });

/** Whole-file resolution; delete-conflicts resolve to deletion when the
 *  chosen side removed the file. (Mark-resolved without taking a side is
 *  just `repoStage([path])`.) */
export const repoResolveTakeSide = (repoId: string, path: string, side: ConflictSide) =>
  invoke<null>("repo_resolve_take_side", { repoId, path, side });
```

Run: `cargo check -p legit-app && npx tsc --noEmit`
Expected: clean.

---

### Task 6: Op-state banner in Working Changes (+ hook, feedback, tokens)

**Files:**
- Create: `src/lib/useOpState.ts`
- Create: `src/lib/mergeFeedback.ts`
- Create: `src/panels/WorkingChanges/OpStateBanner.tsx`
- Modify: `src/panels/WorkingChanges/WorkingChangesPanel.tsx` (mount banner)
- Modify: theme 4-places for `op.banner.bg`, `op.banner.fg`

**Interfaces:**
- Consumes: Task 5 wrappers/types; `invalidateRepoDomains`;
  `useConfirmDestructive` from `../../store/settings`; `ToolbarButton`.
- Produces:
  - `useOpState(repoId: string | undefined): RepoOpState | null`
  - `notifyMergeOutcome(outcome: MergeOutcome, target: string): void`,
    `notifyRebaseOutcome(outcome: RebaseOutcome, onto: string): void`,
    `notifyOpError(e: unknown): void` (used again by Task 7)
  - `<OpStateBanner repoId={string} opState={RepoOpState} conflictCount={number} />`
    (renders null unless merge/rebase)
  - Constant `OP_DOMAINS = ["status", "log", "branches", "diff", "op_state"]`
    exported from `useOpState.ts` (every merge/rebase mutation invalidates it).

- [ ] **Step 1: Theme tokens (4 places)**

`src/theme/tokens.ts` (new group entries, after the Diff group):

```ts
  { name: "op.banner.bg", group: "Working Changes", documentation: "Background of the merge/rebase-in-progress banner." },
  { name: "op.banner.fg", group: "Working Changes", documentation: "Text of the merge/rebase-in-progress banner." },
```

`src/theme/defaults.ts`: `"op.banner.bg": "diff-hunk-header",` and
`"op.banner.fg": "main-fg",`
`src/styles/theme.css`: `--op-banner-bg: var(--palette-diff-hunk-header);`
and `--op-banner-fg: var(--palette-main-fg);`
Both `themes/*.legit-theme.json`: `"op.banner.bg": "diff-hunk-header",` and
`"op.banner.fg": "main-fg",`

Run: `npx vitest run src/theme/`
Expected: PASS.

- [ ] **Step 2: `src/lib/useOpState.ts`**

```ts
import { useQuery } from "@tanstack/react-query";
import { repoOpState } from "./commands";
import type { RepoOpState } from "./types";

/** Query domains every merge/rebase mutation must refresh. */
export const OP_DOMAINS = ["status", "log", "branches", "diff", "op_state"] as const;

/**
 * The repo's current multi-step operation state (merge/rebase/… in progress).
 * Watcher-driven via the "op_state" domain; `null` while loading or without
 * a repo.
 */
export function useOpState(repoId: string | undefined): RepoOpState | null {
  const { data } = useQuery<RepoOpState>({
    queryKey: [repoId, "op_state"],
    queryFn: () => repoOpState(repoId!),
    enabled: !!repoId,
    staleTime: 5_000,
  });
  return data ?? null;
}
```

- [ ] **Step 3: `src/lib/mergeFeedback.ts`**

```ts
// Shared user feedback for merge/rebase — used by the Commits, Branches and
// Working Changes panels so the messaging stays in one place (mirrors
// switchFeedback.ts).

import type { MergeOutcome, RebaseOutcome } from "./types";
import { formatAppError, gitErrorKind } from "./types";
import { notify } from "../store/notifications";

export function notifyMergeOutcome(outcome: MergeOutcome, target: string) {
  switch (outcome.kind) {
    case "fast_forwarded":
      notify.info(`Fast-forwarded to '${target}'.`);
      break;
    case "merged":
      notify.info(`Merged '${target}'.`);
      break;
    case "squashed":
      notify.info(
        `Squash of '${target}' staged — review the changes and commit when ready.`,
      );
      break;
    case "already_up_to_date":
      notify.info(`Already up to date with '${target}'.`);
      break;
    case "conflicts":
      notify.info(
        `Merging '${target}' hit conflicts. Resolve them in Working Changes, ` +
          `then Continue — or Abort to restore the previous state.`,
      );
      break;
  }
}

export function notifyRebaseOutcome(outcome: RebaseOutcome, onto: string) {
  switch (outcome.kind) {
    case "completed":
      notify.info(`Rebased onto '${onto}'.`);
      break;
    case "already_up_to_date":
      notify.info(`Already up to date with '${onto}'.`);
      break;
    case "conflicts":
      notify.info(
        `Rebasing onto '${onto}' hit conflicts. Resolve them in Working ` +
          `Changes, then Continue — or Skip the commit, or Abort the rebase.`,
      );
      break;
    case "completed_with_stash_conflicts":
      notify.info(
        `Rebased onto '${onto}', but restoring your auto-stashed changes ` +
          `produced conflicts — resolve them in the working tree. The stash ` +
          `entry was kept; drop it once resolved.`,
      );
      break;
  }
}

/** Error message for a failed merge/rebase action (not a conflict — those
 *  are outcomes). */
export function notifyOpError(e: unknown) {
  if (gitErrorKind(e) === "WouldOverwriteLocalChanges") {
    notify.error(
      "This would overwrite uncommitted changes. Commit or stash them first.",
    );
    return;
  }
  notify.error(formatAppError(e));
}
```

(Check `gitErrorKind` is exported from `src/lib/types.ts` — it is used by
`switchFeedback.ts` the same way.)

- [ ] **Step 4: `src/panels/WorkingChanges/OpStateBanner.tsx`**

```tsx
import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useConfirmDestructive } from "../../store/settings";
import { invalidateRepoDomains } from "../../lib/repoInvalidation";
import { OP_DOMAINS } from "../../lib/useOpState";
import {
  repoMergeAbort,
  repoMergeContinue,
  repoRebaseAbort,
  repoRebaseContinue,
  repoRebaseSkip,
} from "../../lib/commands";
import type { RepoOpState } from "../../lib/types";
import { notifyMergeOutcome, notifyOpError, notifyRebaseOutcome } from "../../lib/mergeFeedback";
import { ToolbarButton } from "../shared/ToolbarButton";

/**
 * "Merge/rebase in progress" banner at the top of Working Changes: what is
 * running, how many conflicts remain, Continue / Skip / Abort. Renders only
 * for merge/rebase (cherry-pick/revert are detected but get no UI yet).
 * Abort is destructive (discards resolutions) — inline confirm, gated by the
 * global setting.
 */
export function OpStateBanner({
  repoId,
  opState,
  conflictCount,
}: {
  repoId: string;
  opState: RepoOpState;
  conflictCount: number;
}) {
  const queryClient = useQueryClient();
  const confirmDestructive = useConfirmDestructive();
  const [confirmingAbort, setConfirmingAbort] = useState(false);
  const [busy, setBusy] = useState(false);
  const runningRef = useRef(false);

  if (opState.kind !== "merge" && opState.kind !== "rebase") return null;
  const isMerge = opState.kind === "merge";

  const run = async (fn: () => Promise<void>) => {
    if (runningRef.current) return;
    runningRef.current = true;
    const busyTimer = window.setTimeout(() => setBusy(true), 150);
    try {
      await fn();
    } catch (e) {
      notifyOpError(e);
    } finally {
      window.clearTimeout(busyTimer);
      runningRef.current = false;
      setBusy(false);
      setConfirmingAbort(false);
      invalidateRepoDomains(queryClient, repoId, OP_DOMAINS);
    }
  };

  const target = isMerge
    ? (opState.branch ?? "branch")
    : (opState.onto ?? "target");

  const onContinue = () =>
    run(async () => {
      if (isMerge) notifyMergeOutcome(await repoMergeContinue(repoId), target);
      else notifyRebaseOutcome(await repoRebaseContinue(repoId), target);
    });
  const onSkip = () =>
    run(async () => {
      notifyRebaseOutcome(await repoRebaseSkip(repoId), target);
    });
  const doAbort = () =>
    run(async () => {
      if (isMerge) await repoMergeAbort(repoId);
      else await repoRebaseAbort(repoId);
    });
  const onAbort = () => {
    if (!confirmDestructive) return void doAbort();
    setConfirmingAbort(true);
  };

  const title = isMerge
    ? `Merging '${opState.branch ?? "…"}'`
    : `Rebasing${opState.head_name ? ` '${opState.head_name}'` : ""} onto ${opState.onto ?? "…"}` +
      (opState.current_step != null && opState.total_steps != null
        ? ` — step ${opState.current_step}/${opState.total_steps}`
        : "");
  const conflictsText =
    conflictCount > 0
      ? `${conflictCount} conflict${conflictCount === 1 ? "" : "s"} remaining`
      : "all conflicts resolved";

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "4px 8px",
        background: "var(--op-banner-bg)",
        color: "var(--op-banner-fg)",
        fontSize: "var(--fz-sm)",
      }}
    >
      {confirmingAbort ? (
        <>
          <span style={{ minWidth: 0 }}>
            Abort {isMerge ? "merge" : "rebase"}? Conflict resolutions will be discarded.
          </span>
          <span style={{ display: "flex", gap: 4, marginLeft: "auto" }}>
            <ToolbarButton label={isMerge ? "Abort merge" : "Abort rebase"} disabled={busy} onClick={doAbort} />
            <ToolbarButton label="Cancel" disabled={busy} onClick={() => setConfirmingAbort(false)} />
          </span>
        </>
      ) : (
        <>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
            {title} — {conflictsText}
          </span>
          <span style={{ display: "flex", gap: 4, marginLeft: "auto" }}>
            <ToolbarButton
              label="Continue"
              title={
                conflictCount > 0
                  ? "Resolve all conflicts first"
                  : isMerge
                    ? "Commit the merge"
                    : "Continue the rebase"
              }
              disabled={busy || conflictCount > 0}
              onClick={onContinue}
            />
            {!isMerge && <ToolbarButton label="Skip" title="Skip the current commit" disabled={busy} onClick={onSkip} />}
            <ToolbarButton
              label={confirmDestructive ? "Abort…" : "Abort"}
              title={isMerge ? "Abort the merge" : "Abort the rebase"}
              disabled={busy}
              onClick={onAbort}
            />
          </span>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Mount in `WorkingChangesPanel.tsx`**

Imports: `import { OpStateBanner } from "./OpStateBanner";` and
`import { useOpState } from "../../lib/useOpState";`

In the component (after the `status` query):

```ts
  const opState = useOpState(repo?.id);
  const conflictCount = useMemo(
    () => status.filter((s) => s.state === "Conflicted").length,
    [status],
  );
```

Render the banner as the first child inside the panel root (directly above
the existing toolbar row):

```tsx
      {repo && opState && (opState.kind === "merge" || opState.kind === "rebase") && (
        <OpStateBanner repoId={repo.id} opState={opState} conflictCount={conflictCount} />
      )}
```

- [ ] **Step 6: Verify**

Run: `npx tsc --noEmit && npx vitest run`
Expected: clean, all PASS.

---

### Task 7: Branch-menu triggers (merge / rebase)

**Files:**
- Modify: `src/panels/Commits/menu/BranchMenuSection.tsx` (both sections)
- Modify: `src/panels/Commits/CommitsPanel.tsx` (handlers + prop threading, menu at ~line 1056, `RefsCell` usage at ~line 1118)
- Modify: `src/panels/Commits/cells/RefsCell.tsx` (props + forwarding)
- Modify: `src/panels/Branches/BranchesPanel.tsx` (handlers + menu usage)

**Interfaces:**
- Consumes: `repoMerge`, `repoRebase`, `MergeOptions`, `FfMode` (Task 5);
  `notifyMergeOutcome`, `notifyRebaseOutcome`, `notifyOpError`, `OP_DOMAINS`
  (Task 6); `useOpState` (Task 6).
- Produces: new props on the shared sections (all call sites must pass them):
  - `BranchMenuSection`: `currentBranch: string | null`,
    `opInProgress: boolean`, `onMerge: (options: MergeOptions) => void`,
    `onRebaseOnto: () => void`
  - `RemoteBranchMenuSection`: same four props.

- [ ] **Step 1: Extend the shared menu sections**

In `BranchMenuSection.tsx`, add a shared merge/rebase group component and use
it in BOTH sections (parity by construction):

```tsx
import type { MergeOptions } from "../../../lib/types";

/**
 * Merge/rebase entries for a target branch (local or remote-tracking),
 * shared by both sections. Hidden when the target IS the current branch,
 * when HEAD is detached (no current branch), or while a merge/rebase is
 * already in progress.
 */
function MergeRebaseItems({
  targetLabel,
  currentBranch,
  opInProgress,
  isCurrent,
  onMerge,
  onRebaseOnto,
}: {
  targetLabel: string;
  currentBranch: string | null;
  opInProgress: boolean;
  isCurrent: boolean;
  onMerge: (options: MergeOptions) => void;
  onRebaseOnto: () => void;
}) {
  if (isCurrent || !currentBranch || opInProgress) return null;
  return (
    <>
      <Separator />
      <MenuItem onClick={() => onMerge({ ff: "auto", squash: false })}>
        Merge into '{currentBranch}'
      </MenuItem>
      <MenuItem onClick={() => onMerge({ ff: "no_ff", squash: false })}>
        Merge into '{currentBranch}' (no fast-forward)
      </MenuItem>
      <MenuItem onClick={() => onMerge({ ff: "ff_only", squash: false })}>
        Merge into '{currentBranch}' (fast-forward only)
      </MenuItem>
      <MenuItem onClick={() => onMerge({ ff: "auto", squash: true })}>
        Squash merge into '{currentBranch}'
      </MenuItem>
      <MenuItem onClick={onRebaseOnto}>
        Rebase '{currentBranch}' onto '{targetLabel}'
      </MenuItem>
    </>
  );
}
```

`BranchMenuSection` gains the four props and renders
`<MergeRebaseItems targetLabel={name} isCurrent={isCurrent} … />` between the
Rename item and the delete Separator. `RemoteBranchMenuSection` gains the same
four props and renders `<MergeRebaseItems targetLabel={remoteName}
isCurrent={false} … />` after its Checkout item. Every `onMerge`/`onRebaseOnto`
click must also `closeMenu()` — wire that at the call sites (consistent with
the existing `onCheckout` pattern).

Note (spec deviation, deliberate): the spec listed remote-tracking branches as
"merge only", but `git rebase origin/main` is the most common rebase there is —
remote branches get the rebase item too.

- [ ] **Step 2: CommitsPanel handlers + threading**

Add imports (`repoMerge`, `repoRebase`, `MergeOptions` type,
`notifyMergeOutcome`, `notifyRebaseOutcome`, `notifyOpError`, `OP_DOMAINS`,
`useOpState`). Locate the panel's branches data (`grep -n '"branches"'
src/panels/Commits/CommitsPanel.tsx` — a `useQuery` with key
`[repo?.id, "branches"]`; match its local variable name) and derive:

```ts
  const currentBranch = useMemo(
    () => branches.find((b) => !b.is_remote && b.is_current)?.name ?? null,
    [branches],
  );
  const opState = useOpState(repo?.id);
  const opInProgress = !!opState && opState.kind !== "none";
```

Handlers next to `handleBranchCheckout` (~line 286):

```ts
  const handleMerge = useCallback(async (target: string, options: MergeOptions) => {
    if (!repo) return;
    try {
      const outcome = await repoMerge(repo.id, target, options);
      invalidateRepoDomains(queryClient, repo.id, OP_DOMAINS);
      notifyMergeOutcome(outcome, target);
    } catch (e) {
      invalidateRepoDomains(queryClient, repo.id, OP_DOMAINS);
      notifyOpError(e);
    }
  }, [repo, queryClient]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleRebaseOnto = useCallback(async (onto: string) => {
    if (!repo) return;
    try {
      const outcome = await repoRebase(repo.id, onto);
      invalidateRepoDomains(queryClient, repo.id, OP_DOMAINS);
      notifyRebaseOutcome(outcome, onto);
    } catch (e) {
      invalidateRepoDomains(queryClient, repo.id, OP_DOMAINS);
      notifyOpError(e);
    }
  }, [repo, queryClient]); // eslint-disable-line react-hooks/exhaustive-deps
```

Wire into the commit-row menu's `BranchMenuSection` (~line 1059) and
`RemoteBranchMenuSection` (~line 1071):

```tsx
                              currentBranch={currentBranch}
                              opInProgress={opInProgress}
                              onMerge={(options) => { closeMenu(); handleMerge(b.name, options); }}
                              onRebaseOnto={() => { closeMenu(); handleRebaseOnto(b.name); }}
```

(for the remote section use `name` — the remote ref — as the target).

Thread the same through `RefsCell` (~line 1118): pass `currentBranch`,
`opInProgress`, `onBranchMerge={handleMerge}`, `onBranchRebaseOnto={handleRebaseOnto}`
as new `RefsCell` props; inside `RefsCell`, forward to both sections
(`onMerge={(options) => { closeMenu(); onBranchMerge?.(localName, options); }}`
etc., using `remoteName` for the remote chip). Add the four props to
`RefsCellProps` with types `currentBranch?: string | null`,
`opInProgress?: boolean`,
`onBranchMerge?: (target: string, options: MergeOptions) => void`,
`onBranchRebaseOnto?: (target: string) => void`, defaulting to hidden items
when absent (`currentBranch ?? null`, `opInProgress ?? false`).

- [ ] **Step 3: BranchesPanel — add a row context menu with the shared sections**

`BranchesPanel` currently has NO context menu (rows use inline hover buttons:
Checkout / rename / delete edit modes). Give its rows a right-click menu that
renders the SAME shared sections, so merge/rebase (and future items) can't
drift out of parity:

1. Imports: `PanelContextMenuProvider`, `usePanelContextMenu` from
   `../Commits/menu/PanelContextMenu`; `BranchMenuSection`,
   `RemoteBranchMenuSection` from `../Commits/menu/BranchMenuSection`;
   `repoMerge`, `repoRebase`, `useOpState`, `OP_DOMAINS`, feedback fns as in
   Step 2.
2. Derive `currentBranch` from the panel's existing branch list and
   `opInProgress` from `useOpState(repo?.id)` exactly as in Step 2, and add
   the same `handleMerge` / `handleRebaseOnto` handlers (same code as Step 2).
3. Wrap the section's root in `<PanelContextMenuProvider baseline={[]}>` (or
   thread `openMenu` via the render-prop form used by WorkingChangesPanel,
   `{({ openMenu, closeMenu }) => (…)}`), and on each local-branch row div add:

```tsx
              onContextMenu={(e) =>
                openMenu(
                  e,
                  <BranchMenuSection
                    name={b.name}
                    isCurrent={b.is_current}
                    currentBranch={currentBranch}
                    opInProgress={opInProgress}
                    onCheckout={() => { closeMenu(); doCheckout(b.name); }}
                    onRename={() => { closeMenu(); startRename(b.name); }}
                    onDelete={(force) => { closeMenu(); startDelete(b.name, force); }}
                    onMerge={(options) => { closeMenu(); handleMerge(b.name, options); }}
                    onRebaseOnto={() => { closeMenu(); handleRebaseOnto(b.name); }}
                  />,
                )
              }
```

   and the remote-branch rows the analogous `RemoteBranchMenuSection` with
   `onMerge`/`onRebaseOnto` targeting the remote ref name. Match
   `startRename`/`startDelete` to the panel's existing edit-mode setters
   (`setEdit({ name, mode: "rename" | "delete" })` — check the local names at
   the top of the file and reuse them; the delete flow must keep its existing
   inline-confirm behavior).

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit && npx vitest run`
Expected: clean. All call sites of both menu sections now pass the four new
props (tsc enforces since they are required on the section components).

---

### Task 8: Conflicted-row actions + full verification

**Files:**
- Modify: `src/panels/WorkingChanges/WorkingChangesPanel.tsx` (unstaged-row context menu, ~line 402)

**Interfaces:**
- Consumes: `repoConflictEntries`, `repoResolveTakeSide`, `repoStage`
  (existing), `ConflictEntry`/`ConflictKind` types, `run()` helper (existing).

- [ ] **Step 1: Conflict entries query + labels**

In `WorkingChangesPanel`:

```ts
  // Conflict kinds for correct Take-ours/theirs labels; only fetched while
  // conflicts exist (cheap ls-files -u otherwise never runs).
  const { data: conflictEntries = [] } = useQuery<ConflictEntry[]>({
    queryKey: [repo?.id, "op_state", "conflicts"],
    queryFn: () => repoConflictEntries(repo!.id),
    enabled: !!repo && conflictCount > 0,
    staleTime: 5_000,
  });
  const conflictKinds = useMemo(
    () => new Map(conflictEntries.map((e) => [e.path, e.kind])),
    [conflictEntries],
  );
```

Label helper (module level, exported for a vitest test file
`src/panels/WorkingChanges/conflictLabels.ts` + `conflictLabels.test.ts`):

```ts
import type { ConflictKind } from "../../lib/types";

/** Menu labels for whole-file conflict resolution, delete-aware: taking a
 *  side that deleted the file must say so. */
export function takeSideLabels(kind: ConflictKind | undefined): {
  ours: string;
  theirs: string;
} {
  switch (kind) {
    case "deleted_by_us":
      return { ours: "Take ours (delete file)", theirs: "Take theirs (keep file)" };
    case "deleted_by_them":
      return { ours: "Take ours (keep file)", theirs: "Take theirs (delete file)" };
    default:
      return { ours: "Take ours", theirs: "Take theirs" };
  }
}
```

Test (`conflictLabels.test.ts`):

```ts
import { describe, expect, it } from "vitest";
import { takeSideLabels } from "./conflictLabels";

describe("takeSideLabels", () => {
  it("marks the deleting side for delete conflicts", () => {
    expect(takeSideLabels("deleted_by_them").theirs).toBe("Take theirs (delete file)");
    expect(takeSideLabels("deleted_by_us").ours).toBe("Take ours (delete file)");
  });
  it("plain labels for content conflicts and unknown kinds", () => {
    expect(takeSideLabels("both_modified")).toEqual({ ours: "Take ours", theirs: "Take theirs" });
    expect(takeSideLabels(undefined)).toEqual({ ours: "Take ours", theirs: "Take theirs" });
  });
});
```

- [ ] **Step 2: Menu items on conflicted rows**

In the unstaged list's `onContextMenu` (~line 402), before the existing Stage
item, render conflict actions when the clicked file is conflicted (single
file only — `targets.length === 1 && f.change === "Conflicted"`):

```tsx
                    {targets.length === 1 && f.change === "Conflicted" && (
                      <>
                        <MenuItem onClick={() => { run(() => repoResolveTakeSide(repo!.id, f.path, "ours")); closeMenu(); }}>
                          {takeSideLabels(conflictKinds.get(f.path)).ours}
                        </MenuItem>
                        <MenuItem onClick={() => { run(() => repoResolveTakeSide(repo!.id, f.path, "theirs")); closeMenu(); }}>
                          {takeSideLabels(conflictKinds.get(f.path)).theirs}
                        </MenuItem>
                        <MenuItem onClick={() => { run(() => repoStage([f.path]).then(() => null)); closeMenu(); }}>
                          Mark resolved
                        </MenuItem>
                      </>
                    )}
```

(Adapt the `repoStage` call to the panel's existing `stage(targets)` helper if
it already stages via `run()` — prefer `stage([f.path])` with a "Mark
resolved" label; check the helper's name at the top of the file.)
Also extend the panel's `refresh()` domain list with `"op_state"` so
resolution actions refresh the banner immediately.

- [ ] **Step 3: Full verification**

Run: `npx tsc --noEmit && npx vitest run && cargo test -p legit-core && cargo test -p legit-app --lib`
Expected: all PASS.

- [ ] **Step 4: Manual checklist (user runs the app from PowerShell)**

In a scratch repo with two branches that conflict:

1. Branch menu on a non-current branch shows the merge group + rebase; on the
   current branch and while an op is in progress they are hidden.
2. Merge a conflicting branch: toast points at Working Changes; banner shows
   "Merging 'x' — N conflicts remaining"; Continue is disabled.
3. Take ours / Take theirs on a conflicted row resolves it (label says
   "delete file" on a modify/delete conflict and deletes accordingly); count
   drops; at 0 Continue enables.
4. Continue commits the merge with the prepared message; banner disappears;
   log shows the merge commit.
5. Abort (with destructive confirmation on) asks inline, then restores the
   pre-merge state.
6. Rebase a conflicting branch: banner shows step i/n; Skip advances; Abort
   restores; a clean rebase toasts success.
7. Rebase with uncommitted changes: autostash carries them; force the
   stash-conflict case (edit the same lines) and check the
   "stash entry was kept" toast.
8. Squash merge: changes staged, no commit; commit normally afterward.
9. Fast-forward-only merge of a diverged branch: readable error toast.
10. External `git merge` from a terminal while the app is open: banner appears
    via the watcher without focusing the app.
