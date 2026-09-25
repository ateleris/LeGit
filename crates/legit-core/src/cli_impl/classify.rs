//! Turning git's exit codes and output into outcomes and `GitError`s. Every
//! message a `GitError` carries passes through `clean`: trimmed, and with URL
//! credentials redacted (remote failures quote the URL back, and the text is
//! shown in toasts and the command log).

use super::worktrees;
use crate::error::GitError;
use crate::types::{FastForwardResult, LfsStubs, MergeOutcome, RebaseOutcome, SequenceOutcome};

pub(super) fn clean(s: &str) -> String {
    crate::runner::redact_url_credentials(s.trim()).into_owned()
}

/// The `CommandFailed` for a failure no classifier recognised.
pub(super) fn command_failed(exit_code: i32, stderr: &str) -> GitError {
    GitError::CommandFailed { exit_code, stderr: clean(stderr) }
}

/// A checkout/merge refusing to touch uncommitted changes; `lc` is lowercased.
fn would_overwrite(lc: &str) -> bool {
    lc.contains("would be overwritten by") || lc.contains("commit your changes or stash them")
}

/// A branch refused because another worktree has it checked out; `lc` is
/// lowercased. Covers the old ("checked out at") and new ("used by worktree
/// at") wording of both `switch` and `branch -d`.
fn checked_out_elsewhere(lc: &str) -> bool {
    lc.contains("checked out at") || lc.contains("used by worktree at")
}

/// The merge machinery's `CONFLICT (<kind>)` line. Case-sensitive on purpose:
/// the runner forces `LANG=C`, so git always prints it uppercase, while a
/// case-insensitive match would fire on paths like `conflict (1).txt`.
fn has_conflict_marker(stdout: &str, stderr: &str) -> bool {
    stdout.contains("CONFLICT (") || stderr.contains("CONFLICT (")
}

/// Map a failed `git switch`/`checkout` to a specific `GitError`: the
/// dirty-tree refusal ("your local changes … would be overwritten") →
/// `WouldOverwriteLocalChanges`, an unknown ref → `RefNotFound`, everything
/// else → `CommandFailed`.
pub(super) fn classify_switch_error(exit_code: i32, stderr: &str) -> GitError {
    if let Some(f) = parse_lfs_download_failure(stderr) {
        return GitError::LfsDownloadFailed {
            files: f.files,
            missing_on_remote: f.missing_on_remote,
            stderr: clean(stderr),
        };
    }
    let lc = stderr.to_lowercase();
    if would_overwrite(&lc) {
        return GitError::WouldOverwriteLocalChanges(clean(stderr));
    }
    if checked_out_elsewhere(&lc) {
        let (branch, path) = worktrees::parse_checked_out_elsewhere(stderr);
        return GitError::CheckedOutInWorktree { branch, path, stderr: clean(stderr) };
    }
    if lc.contains("invalid reference") {
        return GitError::RefNotFound(clean(stderr));
    }
    command_failed(exit_code, stderr)
}

/// Map a failed non-force `git branch -d` to a specific `GitError`: the
/// "not fully merged" refusal → `BranchNotFullyMerged` (so the UI can offer
/// a guided force delete), a checked-out-in-worktree refusal →
/// `CheckedOutInWorktree`, everything else → `CommandFailed`.
pub(super) fn classify_branch_delete_error(exit_code: i32, stderr: &str, branch: &str) -> GitError {
    let lc = stderr.to_lowercase();
    if checked_out_elsewhere(&lc) {
        let (b, path) = worktrees::parse_checked_out_elsewhere(stderr);
        return GitError::CheckedOutInWorktree {
            branch: b.or_else(|| Some(branch.to_string())),
            path,
            stderr: clean(stderr),
        };
    }
    if lc.contains("not fully merged") {
        return GitError::BranchNotFullyMerged { branch: branch.to_string(), stderr: clean(stderr) };
    }
    command_failed(exit_code, stderr)
}

/// Compose a user-facing message from a command's streams (stdout carries
/// git's conflict summary, stderr the hints).
pub(super) fn compose_output(stdout: &str, stderr: &str) -> String {
    let mut msg = clean(stdout);
    let err = clean(stderr);
    if !err.is_empty() {
        if !msg.is_empty() {
            msg.push('\n');
        }
        msg.push_str(&err);
    }
    msg
}

/// True when a failed `stash apply`/`pop` indicates the stash WAS applied but
/// left conflicts (git keeps the entry; guidance is "resolve, then drop"), as
/// opposed to a failure where nothing was applied at all: the `CONFLICT (`
/// marker, the index `needs merge` state, or the untracked-collision message.
/// Validated against the real binary in `git_flows.rs`.
pub(super) fn stash_apply_left_conflicts(stdout: &str, stderr: &str) -> bool {
    let combined = format!("{stdout}\n{stderr}");
    has_conflict_marker(stdout, stderr)
        || combined.contains("needs merge")
        || combined.contains("could not restore untracked files from stash")
}

/// Split `git merge`'s exit-1 ambiguity: conflicts are an OUTCOME (merge in
/// progress), everything else an error. Encoded in tests, not comments.
pub(super) fn classify_merge_output(
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
        || has_conflict_marker(stdout, stderr)
        || err_lc.contains("you have unmerged files")
        || err_lc.contains("not possible because you have unmerged files")
    {
        return Ok(MergeOutcome::Conflicts {
            message: compose_output(stdout, stderr),
        });
    }
    if would_overwrite(&err_lc) {
        return Err(GitError::WouldOverwriteLocalChanges(clean(stderr)));
    }
    if err_lc.contains("not something we can merge") || err_lc.contains("unknown revision") {
        return Err(GitError::RefNotFound(clean(stderr)));
    }
    Err(GitError::CommandFailed { exit_code, stderr: compose_output(stdout, stderr) })
}

/// Classify the local `merge --ff-only <remote-ref>` step of
/// `checkout_remote_branch`. Exit 0 leaves only two possibilities (a merge
/// commit cannot happen under `--ff-only`): already up to date, or a
/// fast-forward. The divergence refusal is an OUTCOME (`Diverged`) - the
/// checkout it follows already succeeded - and any other failure carries
/// git's own message (`Failed`), never an `Err`. Validated against the real
/// binary in `tests/git_flows.rs`.
pub(super) fn classify_fast_forward(exit_code: i32, stdout: &str, stderr: &str) -> FastForwardResult {
    if exit_code == 0 {
        if stdout.to_lowercase().contains("already up to date") {
            return FastForwardResult::UpToDate;
        }
        return FastForwardResult::FastForwarded;
    }
    if stderr.to_lowercase().contains("not possible to fast-forward") {
        return FastForwardResult::Diverged;
    }
    FastForwardResult::Failed {
        message: compose_output(stdout, stderr),
    }
}

/// Split `git rebase`'s exit codes the same way. On exit 0 the autostash may
/// still have conflicted; the rebase itself succeeded, so that is a distinct
/// success-flavored outcome. Git reworded that message in 2.55 (sequencer.c):
/// up to 2.54 it prints "Applying autostash resulted in conflicts.", from
/// 2.55 "Your local changes are stashed, however applying them\nresulted in
/// conflicts. ..." - both wordings must classify as the stash-conflict
/// outcome (missing one silently reports Completed while the working tree
/// holds conflict markers; caught by CI's newer git 2026-08-21).
pub(super) fn classify_rebase_output(
    exit_code: i32,
    stdout: &str,
    stderr: &str,
) -> Result<RebaseOutcome, GitError> {
    let out_lc = stdout.to_lowercase();
    let err_lc = stderr.to_lowercase();
    let has = |needle: &str| out_lc.contains(needle) || err_lc.contains(needle);
    let stash_conflict = has("applying autostash resulted in conflicts")
        || has("your local changes are stashed, however applying them");
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
        || has_conflict_marker(stdout, stderr)
        || err_lc.contains("you have unmerged files")
    {
        return Ok(RebaseOutcome::Conflicts {
            message: compose_output(stdout, stderr),
        });
    }
    if would_overwrite(&err_lc) {
        return Err(GitError::WouldOverwriteLocalChanges(clean(stderr)));
    }
    if err_lc.contains("invalid upstream") || err_lc.contains("unknown revision") {
        return Err(GitError::RefNotFound(clean(stderr)));
    }
    Err(GitError::CommandFailed { exit_code, stderr: compose_output(stdout, stderr) })
}

/// Split the sequencer's (revert/cherry-pick) exit-1 ambiguity the same way
/// as merge/rebase: a paused sequencer (conflicts, or a pick whose
/// resolution turned out empty ("is now empty" / "nothing to commit")) is
/// an OUTCOME the user concludes via continue/skip/abort; real failures stay
/// errors. Encoded in tests, not comments.
pub(super) fn classify_sequence_output(
    exit_code: i32,
    stdout: &str,
    stderr: &str,
) -> Result<SequenceOutcome, GitError> {
    let err_lc = stderr.to_lowercase();
    if exit_code == 0 {
        return Ok(SequenceOutcome::Completed);
    }
    if err_lc.contains("could not apply")
        || err_lc.contains("could not revert")
        || has_conflict_marker(stdout, stderr)
        || err_lc.contains("you have unmerged files")
        || err_lc.contains("is now empty")
        || err_lc.contains("nothing to commit")
    {
        return Ok(SequenceOutcome::Conflicts {
            message: compose_output(stdout, stderr),
        });
    }
    if would_overwrite(&err_lc) {
        return Err(GitError::WouldOverwriteLocalChanges(clean(stderr)));
    }
    if err_lc.contains("bad revision") || err_lc.contains("unknown revision") {
        return Err(GitError::RefNotFound(clean(stderr)));
    }
    Err(GitError::CommandFailed { exit_code, stderr: compose_output(stdout, stderr) })
}

/// `git checkout --ours/--theirs` fails when the chosen side has no stage
/// entry (a delete-conflict where that side deleted the file); taking that
/// side then means deleting the path (`git rm -f`).
pub(super) fn take_side_means_delete(stderr: &str) -> bool {
    let lc = stderr.to_lowercase();
    lc.contains("does not have our version") || lc.contains("does not have their version")
}

/// Append a follow-up note to an error without losing its kind (used when a
/// best-effort recovery step after the primary failure also failed and the
/// user must be told both facts).
pub(super) fn append_error_note(e: GitError, note: &str) -> GitError {
    let add = |msg: String| format!("{msg}\n\n{note}");
    match e {
        GitError::RefNotFound(m) => GitError::RefNotFound(add(m)),
        GitError::AuthFailed(m) => GitError::AuthFailed(add(m)),
        GitError::PushRejected { stderr } => GitError::PushRejected { stderr: add(stderr) },
        GitError::PushRejectedByRemote { stderr } => {
            GitError::PushRejectedByRemote { stderr: add(stderr) }
        }
        GitError::UnpushedSubmodules { stderr } => {
            GitError::UnpushedSubmodules { stderr: add(stderr) }
        }
        GitError::WouldOverwriteLocalChanges(m) => GitError::WouldOverwriteLocalChanges(add(m)),
        GitError::BranchNotFullyMerged { branch, stderr } => {
            GitError::BranchNotFullyMerged { branch, stderr: add(stderr) }
        }
        GitError::CheckedOutInWorktree { branch, path, stderr } => {
            GitError::CheckedOutInWorktree { branch, path, stderr: add(stderr) }
        }
        GitError::LfsDownloadFailed { files, missing_on_remote, stderr } => {
            GitError::LfsDownloadFailed { files, missing_on_remote, stderr: add(stderr) }
        }
        GitError::CommandFailed { exit_code, stderr } => {
            GitError::CommandFailed { exit_code, stderr: add(stderr) }
        }
        GitError::CloneCancelled { cleanup_failed } => GitError::CloneCancelled {
            cleanup_failed: Some(match cleanup_failed {
                Some(m) => add(m),
                None => note.to_string(),
            }),
        },
        GitError::UnsafeArgument(m) => GitError::UnsafeArgument(add(m)),
        GitError::Parse(m) => GitError::Parse(add(m)),
        GitError::GitUnavailable(m) => GitError::GitUnavailable(add(m)),
        GitError::Internal(m) => GitError::Internal(add(m)),
        GitError::RewordNotHead | GitError::RewordPushed => GitError::Internal(add(e.to_string())),
    }
}

/// What a git-lfs download failure in some operation's stderr amounts to.
/// Produced by `parse_lfs_download_failure`; pure data.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LfsDownloadFailure {
    /// Worktree paths whose LFS content could not be downloaded.
    pub files: Vec<String>,
    /// The cause is "object absent on the server" (missing upload), not a
    /// network/auth problem.
    pub missing_on_remote: bool,
}

/// Detect a git-lfs smudge/download failure in an operation's stderr and
/// extract the affected paths. Matches the two stable line shapes git-lfs
/// emits (validated against the real binary):
/// `Error downloading object: <path> (<short-oid>): ...` (also present when
/// the operation still exits 0, e.g. under `lfs.skipdownloaderrors`) and
/// `fatal: <path>: smudge filter lfs failed` (the loud, non-zero case).
/// Returns `None` when the stderr shows no LFS involvement.
pub(crate) fn parse_lfs_download_failure(stderr: &str) -> Option<LfsDownloadFailure> {
    let mut files: Vec<String> = Vec::new();
    let mut push = |f: &str| {
        let f = f.trim();
        if !f.is_empty() && !files.iter().any(|k| k == f) {
            files.push(f.to_string());
        }
    };
    let mut involved = false;
    for line in stderr.lines().map(str::trim) {
        if let Some(rest) = line.strip_prefix("Error downloading object: ") {
            involved = true;
            push(rest.split(" (").next().unwrap_or(""));
        } else if let Some(prefix) = line.strip_suffix(": smudge filter lfs failed") {
            involved = true;
            push(prefix.strip_prefix("fatal: ").unwrap_or(prefix));
        }
    }
    if !involved {
        return None;
    }
    let lc = stderr.to_lowercase();
    let missing_on_remote = lc.contains("remote missing object")
        || lc.contains("does not exist on the server")
        || lc.contains("[404]");
    Some(LfsDownloadFailure { files, missing_on_remote })
}

/// The `LfsStubs` an exit-0 operation left behind, from its stderr; `None`
/// when the stderr shows no LFS involvement. Public for the command layer's
/// own git invocations (clone runs outside `GitBackend`).
pub fn lfs_stubs_from_stderr(stderr: &str) -> Option<LfsStubs> {
    parse_lfs_download_failure(stderr).map(|f| LfsStubs {
        files: f.files,
        missing_on_remote: f.missing_on_remote,
    })
}

/// Map a failed remote op's stderr to a specific `GitError`: authentication
/// problems → `AuthFailed`, non-fast-forward pushes → `PushRejected`, pushes
/// the server itself declined (hook / branch policy) → `PushRejectedByRemote`,
/// everything else → `CommandFailed`. Public so session-less callers (e.g. the
/// `git clone` command) can classify failures the same way.
pub fn classify_remote_error(exit_code: i32, stderr: &str) -> GitError {
    let lc = stderr.to_lowercase();
    const AUTH: [&str; 6] = [
        "authentication failed",
        "permission denied (publickey)",
        "could not read username",
        "could not read password",
        "terminal prompts disabled",
        "access denied",
    ];
    if AUTH.iter().any(|p| lc.contains(p)) {
        return GitError::AuthFailed(clean(stderr));
    }
    // An LFS smudge/download failure inside the operation (pull's merge
    // phase, clone's checkout, submodule update). After AUTH: a broken
    // credential setup stays an auth problem even when LFS reports it.
    if let Some(f) = parse_lfs_download_failure(stderr) {
        return GitError::LfsDownloadFailed {
            files: f.files,
            missing_on_remote: f.missing_on_remote,
            stderr: clean(stderr),
        };
    }
    // A checkout/merge inside the operation refusing to overwrite local
    // changes (e.g. `submodule update --remote` on a dirty submodule, or a
    // pull into a dirty tree). Classified so the UI can say "commit, stash,
    // or discard first" instead of dumping raw stderr.
    if would_overwrite(&lc) {
        return GitError::WouldOverwriteLocalChanges(clean(stderr));
    }
    // `push --recurse-submodules=check|on-demand` refusing to publish a
    // superproject whose gitlinks reference commits on no submodule remote.
    // MUST precede the generic rejection check: the same stderr can also
    // contain "failed to push some refs".
    if lc.contains("submodule paths contain changes") || lc.contains("process for submodule") {
        return GitError::UnpushedSubmodules {
            stderr: clean(stderr),
        };
    }
    // The remote itself declined (pre-receive hook / branch policy, e.g.
    // Azure DevOps TF402455). MUST precede the non-fast-forward check: the
    // same stderr also contains "failed to push some refs", and "pull first /
    // force-push" advice would be wrong (the policy rejects those too).
    const REJECTED_BY_REMOTE: [&str; 2] = ["[remote rejected]", "pre-receive hook declined"];
    if REJECTED_BY_REMOTE.iter().any(|p| lc.contains(p)) {
        return GitError::PushRejectedByRemote {
            stderr: clean(stderr),
        };
    }
    const REJECTED: [&str; 4] = [
        "[rejected]",
        "non-fast-forward",
        "fetch first",
        "stale info",
    ];
    if REJECTED.iter().any(|p| lc.contains(p)) {
        return GitError::PushRejected {
            stderr: clean(stderr),
        };
    }
    // Refs were refused for a reason no pattern above recognized: never claim
    // non-fast-forward - surface it as a remote decline so the UI points at
    // the server's own message instead of advising pull/force-push.
    if lc.contains("failed to push some refs") {
        return GitError::PushRejectedByRemote {
            stderr: clean(stderr),
        };
    }
    command_failed(exit_code, stderr)
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::*;

    // --- sequencer (cherry-pick / revert) output classification --------------
    // The exit-1 ambiguity: a paused sequencer (conflicts) is an OUTCOME, a
    // bad revision or dirty tree is an error. Same treatment as the tested
    // merge/rebase siblings.

    #[test]
    fn sequence_exit_zero_is_completed() {
        let r = classify_sequence_output(0, "[main abc] applied\n", "");
        assert_eq!(r.unwrap(), SequenceOutcome::Completed);
    }

    #[test]
    fn sequence_conflict_phrases_are_the_conflicts_outcome() {
        for stderr in [
            "error: could not apply abc123... subject",
            "error: could not revert abc123... subject",
            "CONFLICT (content): Merge conflict in a.txt",
            "error: you have unmerged files",
            "The previous cherry-pick is now empty, possibly due to conflict resolution.",
        ] {
            let r = classify_sequence_output(1, "", stderr);
            assert!(
                matches!(r, Ok(SequenceOutcome::Conflicts { .. })),
                "{stderr:?} -> {r:?}"
            );
        }
    }

    #[test]
    fn sequence_overwrite_with_conflictish_pathname_is_not_conflicts() {
        // The dirty-tree refusal lists the blocking paths; a path containing
        // the word "conflict" must not steal the classification from
        // WouldOverwriteLocalChanges (pre-fix: bare token match misfired).
        let r = classify_sequence_output(
            1,
            "",
            "error: Your local changes to the following files would be overwritten by merge:\n\
             \tdocs/conflicts.md\n\
             Please commit your changes or stash them before you merge.\n\
             Aborting\n",
        );
        assert!(matches!(r, Err(GitError::WouldOverwriteLocalChanges(_))), "{r:?}");
    }

    #[test]
    fn sequence_overwrite_and_bad_rev_classify_as_errors() {
        let r = classify_sequence_output(
            1,
            "",
            "error: Your local changes to the following files would be overwritten by merge:",
        );
        assert!(matches!(r, Err(GitError::WouldOverwriteLocalChanges(_))), "{r:?}");
        let r = classify_sequence_output(128, "", "fatal: bad revision 'nope'");
        assert!(matches!(r, Err(GitError::RefNotFound(_))), "{r:?}");
        let r = classify_sequence_output(128, "", "fatal: something else entirely");
        assert!(matches!(r, Err(GitError::CommandFailed { exit_code: 128, .. })), "{r:?}");
    }

    // --- stash apply/pop: conflict vs plain failure --------------------------

    #[test]
    fn stash_apply_conflict_marker_lines_classify_as_conflicts() {
        assert!(stash_apply_left_conflicts(
            "Auto-merging a.txt\nCONFLICT (content): Merge conflict in a.txt\n",
            ""
        ));
        assert!(stash_apply_left_conflicts("", "a.txt: needs merge\n"));
        assert!(stash_apply_left_conflicts(
            "",
            "error: could not restore untracked files from stash\n"
        ));
    }

    #[test]
    fn stash_apply_conflicty_pathname_is_not_a_conflict() {
        // "conflict" appearing only inside a pathname (or the would-be-
        // overwritten failure, where NOTHING was applied) must stay an error:
        // the guidance for real conflicts is "resolve, then drop", which
        // would be wrong here.
        assert!(!stash_apply_left_conflicts(
            "",
            "error: Your local changes to the following files would be overwritten by merge:\n\tconflicts.md\nPlease commit your changes or stash them before you merge.\n"
        ));
        assert!(!stash_apply_left_conflicts("", "fatal: ambiguous argument 'stash@{9}'\n"));
    }

    #[test]
    fn switch_error_dirty_tree_is_classified() {
        let stderr = "error: Your local changes to the following files would be overwritten by checkout:\n\tsrc/main.rs\nPlease commit your changes or stash them before you switch branches.\nAborting";
        match classify_switch_error(1, stderr) {
            GitError::WouldOverwriteLocalChanges(msg) => {
                assert!(msg.contains("would be overwritten"));
            }
            other => panic!("expected WouldOverwriteLocalChanges, got {other:?}"),
        }
    }

    #[test]
    fn switch_error_unknown_ref_is_ref_not_found() {
        let stderr = "fatal: invalid reference: no-such-branch";
        assert!(matches!(
            classify_switch_error(128, stderr),
            GitError::RefNotFound(_)
        ));
    }

    #[test]
    fn switch_error_other_is_command_failed() {
        let stderr = "fatal: a branch named 'x' already exists";
        assert!(matches!(
            classify_switch_error(128, stderr),
            GitError::CommandFailed { exit_code: 128, .. }
        ));
    }

    #[test]
    fn branch_delete_not_fully_merged_is_classified() {
        let stderr = "error: The branch 'feature' is not fully merged.\nhint: If you are sure you want to delete it, run 'git branch -D feature'.\n";
        match classify_branch_delete_error(1, stderr, "feature") {
            GitError::BranchNotFullyMerged { branch, stderr: s } => {
                assert_eq!(branch, "feature");
                assert!(s.contains("not fully merged"));
            }
            other => panic!("expected BranchNotFullyMerged, got {other:?}"),
        }
    }

    #[test]
    fn branch_delete_other_failure_is_command_failed() {
        let stderr = "error: branch 'nope' not found.";
        assert!(matches!(
            classify_branch_delete_error(1, stderr, "nope"),
            GitError::CommandFailed { exit_code: 1, .. }
        ));
    }

    // --- LFS download-failure detection ---------------------------------
    // Stderr shapes captured from real git-lfs 3.7.1 (file:// standalone
    // transfer); the [404] variant mirrors the HTTPS wording.

    const LFS_LOUD_PULL_STDERR: &str = "\
 * branch            main       -> FETCH_HEAD
Downloading big.bin (2.0 KB)
Error downloading object: big.bin (8f786a0): Smudge error: Error downloading big.bin (8f786a0717ae6c4d70b78d003300b3d340fe84fb131c5be1ef028d0fdcbe7f6d): error transferring \"8f786a0717ae6c4d70b78d003300b3d340fe84fb131c5be1ef028d0fdcbe7f6d\": [0] remote missing object 8f786a0717ae6c4d70b78d003300b3d340fe84fb131c5be1ef028d0fdcbe7f6d

Errors logged to 'C:\\repo\\.git\\lfs\\logs\\20260901T161311.log'.
Use `git lfs logs last` to view the log.
error: external filter 'git-lfs filter-process' failed
fatal: big.bin: smudge filter lfs failed
";

    #[test]
    fn lfs_failure_parses_files_and_missing_cause() {
        let f = parse_lfs_download_failure(LFS_LOUD_PULL_STDERR).unwrap();
        assert_eq!(f.files, vec!["big.bin".to_string()]);
        assert!(f.missing_on_remote);
    }

    #[test]
    fn lfs_failure_exit_zero_shape_has_no_fatal_line() {
        // Under lfs.skipdownloaderrors the operation exits 0 and only the
        // "Error downloading object" lines appear.
        let stderr = "Downloading big.bin (2.0 KB)\n\
Error downloading object: big.bin (8f786a0): Smudge error: [404] Object does not exist on the server: https://host/info/lfs\n\
Errors logged to '/r/.git/lfs/logs/x.log'.\n";
        let f = parse_lfs_download_failure(stderr).unwrap();
        assert_eq!(f.files, vec!["big.bin".to_string()]);
        assert!(f.missing_on_remote);
    }

    #[test]
    fn lfs_failure_dedupes_files_and_flags_non_missing_causes() {
        let stderr = "\
Error downloading object: a.bin (1111111): Smudge error: [401] Authentication required\n\
Error downloading object: b.bin (2222222): Smudge error: connection refused\n\
fatal: a.bin: smudge filter lfs failed\n";
        let f = parse_lfs_download_failure(stderr).unwrap();
        assert_eq!(f.files, vec!["a.bin".to_string(), "b.bin".to_string()]);
        assert!(!f.missing_on_remote);
    }

    #[test]
    fn lfs_failure_none_for_unrelated_stderr() {
        assert_eq!(parse_lfs_download_failure("fatal: repository not found\n"), None);
        assert_eq!(parse_lfs_download_failure(""), None);
    }

    #[test]
    fn remote_error_lfs_failure_is_classified() {
        match classify_remote_error(128, LFS_LOUD_PULL_STDERR) {
            GitError::LfsDownloadFailed { files, missing_on_remote, .. } => {
                assert_eq!(files, vec!["big.bin".to_string()]);
                assert!(missing_on_remote);
            }
            other => panic!("expected LfsDownloadFailed, got {other:?}"),
        }
    }

    #[test]
    fn switch_error_lfs_failure_is_classified() {
        let stderr = "\
Error downloading object: feat.bin (d686331): Smudge error: [404] Object does not exist on the server\n\
error: external filter 'git-lfs filter-process' failed\n\
fatal: feat.bin: smudge filter lfs failed\n";
        match classify_switch_error(128, stderr) {
            GitError::LfsDownloadFailed { files, missing_on_remote, .. } => {
                assert_eq!(files, vec!["feat.bin".to_string()]);
                assert!(missing_on_remote);
            }
            other => panic!("expected LfsDownloadFailed, got {other:?}"),
        }
    }

    #[test]
    fn append_note_preserves_kind_and_both_messages() {
        let e = GitError::CommandFailed {
            exit_code: 1,
            stderr: "switch failed".into(),
        };
        match append_error_note(e, "note about the stash") {
            GitError::CommandFailed { exit_code, stderr } => {
                assert_eq!(exit_code, 1);
                assert!(stderr.contains("switch failed"));
                assert!(stderr.contains("note about the stash"));
            }
            other => panic!("kind changed: {other:?}"),
        }
    }

    const CRED_STDERR: &str =
        "fatal: repository 'https://alice:s3cr3t@example.com/r.git/' not found\n";

    #[test]
    fn unclassified_failure_is_trimmed_and_redacted() {
        let out = crate::runner::RunOutput {
            stdout: String::new(),
            stderr: CRED_STDERR.into(),
            exit_code: Some(128),
            success: false,
            duration_ms: 0,
        };
        match GitCliBackend::<GitRunner>::ensure_success(&out) {
            Err(GitError::CommandFailed { exit_code, stderr }) => {
                assert_eq!(exit_code, 128);
                assert!(!stderr.contains("s3cr3t"), "{stderr}");
                assert!(stderr.contains("example.com"), "{stderr}");
                assert!(!stderr.ends_with('\n'));
            }
            other => panic!("expected CommandFailed, got {other:?}"),
        }
    }

    #[test]
    fn every_classifier_redacts_credentials() {
        let errors = vec![
            classify_switch_error(128, CRED_STDERR),
            classify_branch_delete_error(1, CRED_STDERR, "b"),
            classify_merge_output(128, "", CRED_STDERR, false).unwrap_err(),
            classify_rebase_output(128, "", CRED_STDERR).unwrap_err(),
            classify_sequence_output(128, "", CRED_STDERR).unwrap_err(),
            classify_remote_error(128, CRED_STDERR),
        ];
        for e in errors {
            assert!(!format!("{e:?}").contains("s3cr3t"), "leaked: {e:?}");
        }
    }

    #[test]
    fn conflict_marker_is_case_sensitive_so_paths_never_match() {
        let stdout = "Auto-merging conflict (1).txt\n";
        let stderr = "hook says no\n";
        assert!(classify_merge_output(1, stdout, stderr, false).is_err());
        assert!(classify_rebase_output(1, stdout, stderr).is_err());
        assert!(classify_sequence_output(1, stdout, stderr).is_err());
        assert!(!stash_apply_left_conflicts(stdout, stderr));
    }

    #[test]
    fn switch_and_branch_delete_share_the_worktree_phrases() {
        for stderr in [
            "fatal: 'feature' is already checked out at '/wt'\n",
            "fatal: 'feature' is already used by worktree at '/wt'\n",
            "error: Cannot delete branch 'feature' checked out at '/wt'\n",
            "error: cannot delete branch 'feature' used by worktree at '/wt'\n",
        ] {
            assert!(
                matches!(classify_switch_error(128, stderr), GitError::CheckedOutInWorktree { .. }),
                "switch: {stderr}"
            );
            assert!(
                matches!(
                    classify_branch_delete_error(1, stderr, "feature"),
                    GitError::CheckedOutInWorktree { .. }
                ),
                "branch -d: {stderr}"
            );
        }
    }

    #[test]
    fn append_note_preserves_every_actionable_kind() {
        let s = || "git said no".to_string();
        let cases = vec![
            GitError::RefNotFound(s()),
            GitError::AuthFailed(s()),
            GitError::PushRejected { stderr: s() },
            GitError::UnpushedSubmodules { stderr: s() },
            GitError::WouldOverwriteLocalChanges(s()),
            GitError::BranchNotFullyMerged { branch: "b".into(), stderr: s() },
            GitError::CheckedOutInWorktree {
                branch: Some("b".into()),
                path: Some("/wt".into()),
                stderr: s(),
            },
            GitError::LfsDownloadFailed {
                files: vec!["f.bin".into()],
                missing_on_remote: true,
                stderr: s(),
            },
            GitError::CommandFailed { exit_code: 1, stderr: s() },
            GitError::CloneCancelled { cleanup_failed: None },
            GitError::UnsafeArgument(s()),
            GitError::Parse(s()),
            GitError::GitUnavailable(s()),
            GitError::Internal(s()),
        ];
        for e in cases {
            let before = std::mem::discriminant(&e);
            let noted = append_error_note(e.clone(), "the stash is kept");
            assert_eq!(std::mem::discriminant(&noted), before, "kind changed: {noted:?}");
            assert!(format!("{noted:?}").contains("the stash is kept"), "note lost: {noted:?}");
        }
    }

    #[test]
    fn append_note_keeps_structured_details() {
        let e = GitError::CheckedOutInWorktree {
            branch: Some("feature".into()),
            path: Some("/wt".into()),
            stderr: "fatal: 'feature' is already used by worktree".into(),
        };
        match append_error_note(e, "auto-stash pop failed") {
            GitError::CheckedOutInWorktree { branch, path, stderr } => {
                assert_eq!(branch.as_deref(), Some("feature"));
                assert_eq!(path.as_deref(), Some("/wt"));
                assert!(stderr.contains("already used by worktree"));
                assert!(stderr.contains("auto-stash pop failed"));
            }
            other => panic!("kind changed: {other:?}"),
        }
    }

    #[test]
    fn classify_detects_unpushed_submodules() {
        // git's advice text for --recurse-submodules=check (exit 128).
        let stderr = "The following submodule paths contain changes that can\nnot be found on any remote:\n  lib\n";
        assert!(matches!(
            classify_remote_error(128, stderr),
            GitError::UnpushedSubmodules { .. }
        ));
    }

    #[test]
    fn classify_auth_failure() {
        let e = classify_remote_error(128, "fatal: Authentication failed for 'https://x/y'");
        assert!(matches!(e, GitError::AuthFailed(_)));
    }

    /// git quotes the failing URL back at us, credentials included, and that
    /// text becomes the error the UI shows. The token must not survive the
    /// classification.
    #[test]
    fn classify_auth_failure_redacts_the_url_credentials() {
        let e = classify_remote_error(
            128,
            "fatal: Authentication failed for 'https://simon:ghp_SECRET@github.com/o/r.git/'",
        );
        let GitError::AuthFailed(msg) = e else {
            panic!("expected AuthFailed, got {e:?}")
        };
        assert!(!msg.contains("ghp_SECRET"), "secret survived: {msg}");
        assert!(msg.contains("simon:***@github.com"), "{msg}");
    }

    #[test]
    fn classify_publickey_denied() {
        let e = classify_remote_error(128, "git@github.com: Permission denied (publickey).");
        assert!(matches!(e, GitError::AuthFailed(_)));
    }

    #[test]
    fn classify_non_fast_forward() {
        let e = classify_remote_error(
            1,
            " ! [rejected]        main -> main (non-fast-forward)\nerror: failed to push some refs",
        );
        assert!(matches!(e, GitError::PushRejected { .. }));
    }

    #[test]
    fn classify_remote_declined_branch_policy() {
        // Azure DevOps branch policy: contains "failed to push some refs" too,
        // so the remote-decline check must win over the non-fast-forward one.
        let e = classify_remote_error(
            1,
            "To ssh.dev.azure.com:v3/org/proj/repo\n ! [remote rejected]   develop -> develop (TF402455: Pushes to this branch are not permitted; you must use a pull request to update this branch.)\nerror: failed to push some refs to 'ssh.dev.azure.com:v3/org/proj/repo'",
        );
        assert!(matches!(e, GitError::PushRejectedByRemote { .. }), "{e:?}");
    }

    #[test]
    fn classify_remote_declined_pre_receive_hook() {
        let e = classify_remote_error(
            1,
            " ! [remote rejected] main -> main (pre-receive hook declined)\nerror: failed to push some refs to 'origin'",
        );
        assert!(matches!(e, GitError::PushRejectedByRemote { .. }), "{e:?}");
    }

    #[test]
    fn classify_push_refs_failure_without_known_cause_is_remote_decline() {
        // No non-fast-forward marker: never claim "pull first" for an
        // unrecognized refusal - route it to the show-the-server's-message kind.
        let e = classify_remote_error(1, "error: failed to push some refs to 'origin'");
        assert!(matches!(e, GitError::PushRejectedByRemote { .. }), "{e:?}");
    }

    #[test]
    fn classify_other_failure() {
        let e = classify_remote_error(1, "fatal: could not create work tree dir");
        assert!(matches!(e, GitError::CommandFailed { exit_code: 1, .. }));
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
            classify_merge_output(0, "Updating 1a2b..3c4d\nFast-forward\n a.txt | 1 +\n", "", false)
                .unwrap(),
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
            classify_merge_output(
                1,
                "",
                "error: Your local changes to the following files would be overwritten by merge:\n\ta.txt\n",
                false
            ),
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

    #[test]
    fn merge_failure_mentioning_a_conflict_named_path_is_not_conflicts() {
        let r = classify_merge_output(
            1,
            "Auto-merging conflict.txt\n",
            "hook says no\nNot committing merge; use 'git commit' to complete the merge.\n",
            false,
        );
        match r {
            Err(GitError::CommandFailed { exit_code, stderr }) => {
                assert_eq!(exit_code, 1);
                assert!(stderr.contains("hook says no"));
            }
            other => panic!("expected CommandFailed, got {other:?}"),
        }
    }

    // --- fast-forward step classification (checkout_remote_branch) ---

    #[test]
    fn fast_forward_success_without_up_to_date_marker_is_fast_forwarded() {
        // `--ff-only` exit 0 leaves only two possibilities: already up to
        // date, or an actual fast-forward - no merge commit can happen.
        let r = classify_fast_forward(
            0,
            "Updating abc123..def456\nFast-forward\n a.txt | 1 +\n",
            "",
        );
        assert_eq!(r, FastForwardResult::FastForwarded);
    }

    #[test]
    fn fast_forward_already_up_to_date_is_up_to_date() {
        let r = classify_fast_forward(0, "Already up to date.\n", "");
        assert_eq!(r, FastForwardResult::UpToDate);
    }

    #[test]
    fn fast_forward_refusal_is_diverged() {
        let r = classify_fast_forward(128, "", "fatal: Not possible to fast-forward, aborting.\n");
        assert_eq!(r, FastForwardResult::Diverged);
    }

    #[test]
    fn fast_forward_other_failure_carries_gits_message() {
        let r = classify_fast_forward(
            1,
            "",
            "error: Your local changes to the following files would be overwritten by merge:\n\ta.txt\n",
        );
        match r {
            FastForwardResult::Failed { message } => {
                assert!(message.contains("would be overwritten"), "{message}");
            }
            other => panic!("expected Failed, got {other:?}"),
        }
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
    fn rebase_overwrite_with_conflictish_pathname_is_not_conflicts() {
        // Same misfire class as the sequencer sibling: a blocking path named
        // "conflicts.md" in the refusal's file list must not classify as the
        // Conflicts outcome ("resolve, then continue" - nothing is running).
        let r = classify_rebase_output(
            1,
            "",
            "error: The following untracked working tree files would be overwritten by checkout:\n\
             \tdocs/conflicts.md\n\
             Please move or remove them before you switch branches.\n\
             Aborting\n",
        );
        assert!(matches!(r, Err(GitError::WouldOverwriteLocalChanges(_))), "{r:?}");
    }

    #[test]
    fn rebase_success_variants() {
        assert_eq!(
            classify_rebase_output(0, "", "Successfully rebased and updated refs/heads/feature.\n")
                .unwrap(),
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
        // git >= 2.55 reworded the autostash-conflict message and prints it
        // on stderr (sequencer.c). Regression: the old wording alone was
        // matched, so new gits reported Completed with conflict markers in
        // the tree (CI failure 2026-08-21).
        assert!(matches!(
            classify_rebase_output(
                0,
                "",
                "Successfully rebased and updated refs/heads/feature.\n\
                 Your local changes are stashed, however applying them\n\
                 resulted in conflicts.  You can either resolve the conflicts\n\
                 and then discard the stash with \"git stash drop\", or, if you\n\
                 do not want to resolve them now, run \"git reset --hard\" and\n\
                 apply the local changes later by running \"git stash pop\".\n"
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
}
