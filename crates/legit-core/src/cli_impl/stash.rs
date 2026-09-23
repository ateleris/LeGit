//! Stashes, always addressed by commit SHA (see CLAUDE.md, stash addressing).

use super::*;

impl<E: GitExecutor + ?Sized> GitCliBackend<E> {
    pub(super) async fn apply_stash_file(&self, stash_sha: &str, path: &Path) -> Result<(), GitError> {
        // Per-file counterpart of `git stash apply`, which lands changes
        // UNSTAGED - so this writes the worktree only (`restore --source`),
        // never the index. Untracked-stashed files come back untracked.
        let source = self.resolve_file_content_source(stash_sha, path).await?;
        let src_arg = format!("--source={source}");
        self.run_pathspec(
            &["restore", &src_arg, "--worktree", "--"],
            std::slice::from_ref(&path.to_path_buf()),
        )
        .await
    }

    pub(super) async fn stashes(&self) -> Result<Vec<StashEntry>, GitError> {
        let runner = self.runner().await;
        let fmt_arg = format!("--format={}", parsers::stash::STASH_FORMAT);

        let output = runner
            .run(&["stash", "list", &fmt_arg])
            .await?;

        Self::ensure_success(&output)?;

        Ok(parsers::stash::parse_stashes(&output.stdout))
    }

    pub(super) async fn create_stash(
        &self,
        message: Option<&str>,
        include_untracked: bool,
        keep_index: bool,
    ) -> Result<StashOutcome, GitError> {
        let mut args = vec!["stash", "push"];
        if include_untracked {
            args.push("--include-untracked");
        }
        if keep_index {
            args.push("--keep-index");
        }
        if let Some(msg) = message.filter(|m| !m.is_empty()) {
            args.push("-m");
            args.push(msg);
        }
        // `git stash push` on a clean tree exits 0 ("No local changes to save"
        // on stdout), so the outcome is decided by whether the stash tip moved,
        // not by the exit code (which only signals real failures).
        let tip_before = self.stash_tip().await?;
        self.run_simple(&args).await?;
        let tip_after = self.stash_tip().await?;
        if stash_created(tip_before.as_deref(), tip_after.as_deref()).is_some() {
            Ok(StashOutcome::Created)
        } else {
            Ok(StashOutcome::NothingToStash)
        }
    }

    pub(super) async fn create_stash_paths(
        &self,
        message: Option<&str>,
        paths: &[PathBuf],
    ) -> Result<StashOutcome, GitError> {
        let mut prefix = vec!["stash", "push", "--include-untracked"];
        if let Some(msg) = message.filter(|m| !m.is_empty()) {
            prefix.push("-m");
            prefix.push(msg);
        }
        prefix.push("--");

        // Same tip-compare outcome as create_stash: a pathspec matching only
        // clean files exits 0 ("No local changes to save") without stashing.
        let tip_before = self.stash_tip().await?;

        // `git stash push -- <pathspec>` embeds the ENTIRE index in the stash
        // entry: other files' staged changes ride along invisibly (they stay
        // staged locally, but the stash lists them and a later pop can
        // resurrect a staged change discarded in the meantime - verified
        // against the real binary). Isolate the index around the push: save
        // it, reset it to HEAD (worktree untouched) so the push can only
        // capture the named paths, then restore it.
        let saved_index = self.write_tree().await?;
        self.run_simple(&["read-tree", "HEAD"]).await?;
        let push = self.run_pathspec(&prefix, paths).await;
        // The index is ALWAYS restored, also when the push failed. Losing the
        // restore never loses content (the worktree holds it) - staged
        // changes would merely show as unstaged - but the user must be told.
        let restore = self.run_simple(&["read-tree", &saved_index]).await;
        match (push, restore) {
            (Err(pe), Err(_)) => {
                return Err(append_error_note(
                    pe,
                    "Note: restoring the index afterwards also failed - staged changes may \
                     now show as unstaged (file contents are intact).",
                ));
            }
            (Err(pe), Ok(())) => return Err(pe),
            (Ok(()), Err(re)) => {
                return Err(append_error_note(
                    re,
                    "Note: the stash itself was created, but restoring the index failed - \
                     staged changes may now show as unstaged (file contents are intact).",
                ));
            }
            (Ok(()), Ok(())) => {}
        }

        let tip_after = self.stash_tip().await?;
        if stash_created(tip_before.as_deref(), tip_after.as_deref()).is_some() {
            // The restored index still carries the stashed paths' old staged
            // content; reset those entries to HEAD - their content lives in
            // the stash now. `reset -q` tolerates paths HEAD never had
            // (stashed-from-untracked).
            self.run_pathspec(&["reset", "-q", "--"], paths)
                .await
                .map_err(|e| {
                    append_error_note(
                        e,
                        "Note: the stash was created, but the stashed paths' index entries \
                         could not be reset - they may still show staged content.",
                    )
                })?;
            Ok(StashOutcome::Created)
        } else {
            Ok(StashOutcome::NothingToStash)
        }
    }

    pub(super) async fn apply_stash(&self, stash_sha: &str) -> Result<StashApplyOutcome, GitError> {
        let selector = self.resolve_stash_selector(stash_sha).await?;
        self.run_stash_apply(&["stash", "apply", &selector]).await
    }

    pub(super) async fn pop_stash(&self, stash_sha: &str) -> Result<StashApplyOutcome, GitError> {
        let selector = self.resolve_stash_selector(stash_sha).await?;
        self.run_stash_apply(&["stash", "pop", &selector]).await
    }

    pub(super) async fn drop_stash(&self, stash_sha: &str) -> Result<(), GitError> {
        let selector = self.resolve_stash_selector(stash_sha).await?;
        self.run_simple(&["stash", "drop", &selector]).await
    }

    pub(super) async fn stash_branch(&self, stash_sha: &str, branch_name: &str) -> Result<(), GitError> {
        let selector = self.resolve_stash_selector(stash_sha).await?;
        // `stash branch` is checkout -b at the stash base + apply + drop; its
        // failure mode is the checkout's, so classify like a switch.
        self.run_switch(&[
            "stash",
            "branch",
            "--end-of-options",
            safe_ref("branch name", branch_name)?,
            &selector,
        ])
        .await
        .map(|_| ())
    }

    pub(super) async fn rename_stash(&self, stash_sha: &str, new_message: &str) -> Result<(), GitError> {
        let selector = self.resolve_stash_selector(stash_sha).await?;
        // Drop the old entry, then re-store the same commit (we already hold its
        // SHA, so the content survives even if the store step fails - it stays
        // reachable via fsck). `git stash store` prepends, so the renamed stash
        // lands at stash@{0}.
        self.run_simple(&["stash", "drop", &selector]).await?;
        self.run_simple(&["stash", "store", "-m", new_message, stash_sha]).await
    }

    /// Run a `git stash apply`/`pop`, mapping a merge conflict (non-zero exit
    /// whose output mentions a conflict) to `Conflicts` rather than `Err` - the
    /// apply partially succeeded and the user must resolve the working tree. Any
    /// other failure (e.g. a bad selector) is a real `CommandFailed`.
    pub(super) async fn run_stash_apply(&self, args: &[&str]) -> Result<StashApplyOutcome, GitError> {
        let runner = self.runner().await;
        let output = runner
            .run(args)
            .await?;
        if output.success {
            return Ok(StashApplyOutcome::Clean);
        }
        if stash_apply_left_conflicts(&output.stdout, &output.stderr) {
            let combined = format!("{}\n{}", output.stdout, output.stderr);
            Ok(StashApplyOutcome::Conflicts {
                message: combined.trim().to_string(),
            })
        } else {
            Err(command_failed(output.exit_code.unwrap_or(-1), &output.stderr))
        }
    }

    /// Resolve a stash commit SHA to its *current* reflog selector
    /// (`stash@{N}`). All stash mutations go through this: the UI addresses
    /// stashes by SHA (stable), while git's stash commands want the positional
    /// selector (which shifts on every create/drop/pop - including ones made
    /// outside the app). Resolving at action time guarantees the operation hits
    /// the entry the user actually clicked, or fails loudly with `RefNotFound`
    /// if that stash no longer exists.
    pub(super) async fn resolve_stash_selector(&self, stash_sha: &str) -> Result<String, GitError> {
        self.resolve_stash_selector_in(None, stash_sha).await
    }

    /// `resolve_stash_selector` inside the repo at `scope` (a submodule path),
    /// or the repo itself for `None`.
    pub(super) async fn resolve_stash_selector_in(
        &self,
        scope: Option<&str>,
        stash_sha: &str,
    ) -> Result<String, GitError> {
        let list = self.run_checked(&scoped(scope, &["stash", "list", "--format=%H %gd"])).await?;
        find_stash_selector(&list, stash_sha).ok_or_else(|| {
            GitError::RefNotFound(format!(
                "{stash_sha} is not (or no longer) a stash entry - the stash list may have changed"
            ))
        })
    }

    /// Tree object of the current index (`git write-tree`) - used to save
    /// and restore the index around a pathspec stash.
    pub(super) async fn write_tree(&self) -> Result<String, GitError> {
        let (code, stdout, stderr) = self.run_classified(&["write-tree"]).await?;
        if code != 0 {
            return Err(command_failed(code, &stderr));
        }
        Ok(stdout.trim().to_string())
    }

    /// The current `refs/stash` tip, or `None` when there are no stash entries.
    /// This is how `create_stash`/`create_stash_paths` decide whether a
    /// `stash push` actually created an entry: `git stash push` exits **0**
    /// with "No local changes to save" (on stdout) for a clean tree, so
    /// neither the exit code nor stderr can tell - only a changed stash tip
    /// can. (Flows that go on to POP the created entry use the stronger
    /// `find_created_stash` list-diff instead.)
    pub(super) async fn stash_tip(&self) -> Result<Option<String>, GitError> {
        let runner = self.runner().await;
        let output = runner
            .run_expecting(&["rev-parse", "-q", "--verify", "refs/stash"], &[1])
            .await?;
        if output.success {
            Ok(Some(output.stdout.trim().to_string()))
        } else {
            // `-q --verify` exits 1 for a missing ref without output.
            Ok(None)
        }
    }

    /// Pop a specific stash entry addressed by its commit SHA (resolved to the
    /// current selector at call time). Conflict-aware via `run_stash_apply`.
    pub(super) async fn pop_stash_sha(&self, sha: &str) -> Result<StashApplyOutcome, GitError> {
        self.pop_stash_sha_in(None, sha).await
    }

    /// `pop_stash_sha` inside the repo at `scope` (a submodule path).
    pub(super) async fn pop_stash_sha_in(
        &self,
        scope: Option<&str>,
        sha: &str,
    ) -> Result<StashApplyOutcome, GitError> {
        let selector = self.resolve_stash_selector_in(scope, sha).await?;
        self.run_stash_apply(&scoped(scope, &["stash", "pop", &selector])).await
    }

    /// Auto-stash the repo at `scope` (untracked files included) under
    /// `marker`, and identify OUR entry by a marker-matched stash-list diff:
    /// never by exit code (`stash push` exits 0 on a clean tree) and never by
    /// the tip alone (an entry created concurrently must not be adopted and
    /// later popped). Every failure says whether anything may have been
    /// stashed, so callers can never lose track of the user's changes.
    pub(super) async fn auto_stash_push(
        &self,
        scope: Option<&str>,
        marker: &str,
    ) -> Result<AutoStash, AutoStashFailure> {
        let list = scoped(scope, STASH_LIST_SUBJECT_ARGS);
        let before = self.run_checked(&list).await.map_err(AutoStashFailure::ListUnreadable)?;
        self.run_simple(&scoped(scope, &["stash", "push", "--include-untracked", "-m", marker]))
            .await
            .map_err(AutoStashFailure::PushFailed)?;
        let after = self.run_checked(&list).await.map_err(AutoStashFailure::Unverified)?;
        Ok(match find_created_stash(&before, &after, marker) {
            Some(sha) => AutoStash::Created(sha),
            None => AutoStash::Nothing,
        })
    }
}

/// What an auto-stash push left behind.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum AutoStash {
    /// The tree was clean: nothing was stashed.
    Nothing,
    /// Our entry, by commit SHA.
    Created(String),
}

/// Why an auto-stash push could not complete.
#[derive(Debug)]
pub(super) enum AutoStashFailure {
    /// Nothing was stashed: the stash list could not be read beforehand.
    ListUnreadable(GitError),
    /// Nothing was stashed: the push itself failed.
    PushFailed(GitError),
    /// The push ran but its entry could not be identified: the user's
    /// changes may already sit in the stash while the tree looks clean.
    Unverified(GitError),
}

/// `args` run in the repo at `scope` (`git -C <scope> ...`), or as-is.
pub(super) fn scoped<'a>(scope: Option<&'a str>, args: &[&'a str]) -> Vec<&'a str> {
    match scope {
        Some(dir) => ["-C", dir].into_iter().chain(args.iter().copied()).collect(),
        None => args.to_vec(),
    }
}

/// Decide whether a `git stash push` actually created an entry, given the
/// `refs/stash` tip before and after the push. `git stash push` exits **0**
/// with "No local changes to save" (on stdout) for a clean tree, so neither
/// the exit code nor stderr can tell - only a moved tip can. Returns the
/// created entry's SHA. In particular, an unchanged tip with a pre-existing
/// stash must return `None`, or a later restore would touch the user's own
/// stash.
/// The SHA of the entry OUR just-run `stash push -m <marker>` created, or
/// `None` when the tree was clean. Diffs the full stash list (`--format=%H %s`
/// stdout, newest first) instead of the tip, and requires the new entry's
/// subject to carry our marker message: an entry created concurrently by
/// another process must never be adopted as ours - the auto-stash flows POP
/// or DROP the detected entry, so adopting a foreign one moves someone
/// else's data. Tip-compare (`stash_created`) remains correct where only
/// "did anything get stashed" is needed and nothing is popped.
/// The list format `find_created_stash` consumes: one entry per line,
/// `<sha> <subject>`, newest first (kept next to its parser per convention).
pub(super) const STASH_LIST_SUBJECT_ARGS: &[&str] = &["stash", "list", "--format=%H %s"];

pub(super) fn find_created_stash(before_list: &str, after_list: &str, marker: &str) -> Option<String> {
    let before: std::collections::HashSet<&str> = before_list
        .lines()
        .filter_map(|l| l.trim().split(' ').next())
        .filter(|s| !s.is_empty())
        .collect();
    for line in after_list.lines() {
        let line = line.trim();
        let Some((sha, subject)) = line.split_once(' ') else {
            continue;
        };
        if !before.contains(sha) && subject.contains(marker) {
            return Some(sha.to_string());
        }
    }
    None
}

pub(super) fn stash_created(tip_before: Option<&str>, tip_after: Option<&str>) -> Option<String> {
    match tip_after {
        Some(after) if tip_before != Some(after) => Some(after.to_string()),
        _ => None,
    }
}

/// Find a stash entry's current reflog selector in the output of
/// `git stash list --format=%H %gd`, by the entry's commit SHA.
pub(super) fn find_stash_selector(list_stdout: &str, stash_sha: &str) -> Option<String> {
    for line in list_stdout.lines() {
        if let Some((sha, selector)) = line.trim().split_once(' ') {
            if sha == stash_sha {
                return Some(selector.trim().to_string());
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- auto-stash: did the push create an entry? -------------------------
    // Regression tests for the clean-tree bug: `git stash push` exits 0 with
    // "No local changes to save", so detection must come from the stash tip.

    #[test]
    fn stash_created_clean_tree_no_prior_stash() {
        assert_eq!(stash_created(None, None), None);
    }

    #[test]
    fn stash_created_clean_tree_with_prior_stash_is_none() {
        // THE data-loss case: unchanged tip + pre-existing stash must be None,
        // or the restore step would pop the user's own stash.
        assert_eq!(stash_created(Some("abc"), Some("abc")), None);
    }

    #[test]
    fn stash_created_dirty_tree_no_prior_stash() {
        assert_eq!(stash_created(None, Some("new")), Some("new".into()));
    }

    #[test]
    fn stash_created_dirty_tree_with_prior_stash() {
        assert_eq!(stash_created(Some("old"), Some("new")), Some("new".into()));
    }

    // --- auto-stash: which entry did OUR push create? ------------------------
    // Set-diff over the full stash list plus a marker-message match, so an
    // entry created concurrently by another process is never adopted (and
    // later popped/dropped) as ours - the tip alone cannot tell them apart.

    const MARKER: &str = "legit: auto-stash before switching to feature";

    #[test]
    fn find_created_stash_clean_tree_is_none() {
        let list = "aaa On main: WIP\n";
        assert_eq!(find_created_stash(list, list, MARKER), None);
    }

    #[test]
    fn find_created_stash_picks_the_new_marker_entry() {
        let before = "aaa On main: WIP\n";
        let after = format!("bbb On main: {MARKER}\naaa On main: WIP\n");
        assert_eq!(find_created_stash(before, &after, MARKER), Some("bbb".into()));
    }

    #[test]
    fn find_created_stash_ignores_a_concurrent_foreign_entry() {
        // Another process stashed between our push and the list read: its
        // entry is the tip, ours sits below. Tip-compare would adopt "ccc"
        // and pop someone else's stash; the marker match must pick "bbb".
        let before = "aaa On main: WIP\n";
        let after = format!("ccc On main: WIP other\nbbb On main: {MARKER}\naaa On main: WIP\n");
        assert_eq!(find_created_stash(before, &after, MARKER), Some("bbb".into()));
    }

    #[test]
    fn find_created_stash_foreign_entry_only_is_none() {
        // Clean tree for US (push saved nothing), but a foreign stash
        // appeared concurrently: nothing of ours to pop.
        let before = "aaa On main: WIP\n";
        let after = "ccc On main: WIP other\naaa On main: WIP\n";
        assert_eq!(find_created_stash(before, after, MARKER), None);
    }

    #[test]
    fn find_created_stash_pre_existing_marker_entry_is_not_adopted() {
        // A leftover auto-stash from an earlier crash carries the marker but
        // predates our push: it is in `before`, so it must not be adopted.
        let list = format!("bbb On main: {MARKER}\naaa On main: WIP\n");
        assert_eq!(find_created_stash(&list, &list, MARKER), None);
    }

    #[test]
    fn find_created_stash_empty_before_list() {
        let after = format!("bbb On main: {MARKER}\n");
        assert_eq!(find_created_stash("", &after, MARKER), Some("bbb".into()));
    }

    // --- stash SHA → selector resolution ------------------------------------

    #[test]
    fn stash_selector_found_by_sha() {
        let out = "aaa111 stash@{0}\nbbb222 stash@{1}\nccc333 stash@{2}\n";
        assert_eq!(find_stash_selector(out, "bbb222"), Some("stash@{1}".into()));
    }

    #[test]
    fn stash_selector_missing_sha_is_none() {
        let out = "aaa111 stash@{0}\n";
        assert_eq!(find_stash_selector(out, "zzz999"), None);
        assert_eq!(find_stash_selector("", "zzz999"), None);
    }
}
