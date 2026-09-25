//! Conflict resolution: conflicted entries, sides, take-side, undo, leftover markers, reopen.

use super::*;

impl<E: GitExecutor + ?Sized> GitCliBackend<E> {
    pub(super) async fn conflict_file_sides(&self, path: &Path) -> Result<ConflictFileSides, GitError> {
        // `git show :N:<path>` per stage; a missing stage exits non-zero and
        // means "no content on that side" (add/add, delete conflicts).
        let runner = self.runner().await;
        let mut sides = [None, None, None];
        for (i, stage) in ["1", "2", "3"].iter().enumerate() {
            let spec = format!(":{stage}:{}", path.to_string_lossy());
            let output = runner
                .run(&["show", &spec])
                .await?;
            if output.success {
                sides[i] = Some(output.stdout);
            }
        }
        let [base, ours, theirs] = sides;
        Ok(ConflictFileSides { base, ours, theirs })
    }

    pub(super) async fn conflict_entries(&self) -> Result<Vec<ConflictEntry>, GitError> {
        let (code, stdout, stderr) = self
            .run_classified(&parsers::conflicts::LS_FILES_UNMERGED_ARGS)
            .await?;
        if code != 0 {
            return Err(command_failed(code, &stderr));
        }
        parsers::conflicts::parse_unmerged(&stdout)
    }

    pub(super) async fn resolve_take_side(&self, path: &Path, side: ConflictSide) -> Result<(), GitError> {
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
                return self.run_simple(&["rm", "-f", "--", &p]).await;
            }
            return Err(command_failed(code, &stderr));
        }
        // Stage the taken side to mark the path resolved.
        self.run_pathspec(&["add", "--"], &[path.to_path_buf()]).await
    }

    pub(super) async fn resolve_undo_paths(&self) -> Result<Vec<String>, GitError> {
        let (code, stdout, stderr) = self
            .run_classified(&parsers::resolve::LS_FILES_RESOLVE_UNDO_ARGS)
            .await?;
        if code != 0 {
            return Err(command_failed(code, &stderr));
        }
        parsers::resolve::parse_resolve_undo(&stdout)
    }

    pub(super) async fn staged_marker_paths(&self) -> Result<Vec<String>, GitError> {
        self.run_marker_check(&parsers::resolve::DIFF_CACHED_CHECK_ARGS)
            .await
    }

    pub(super) async fn unstaged_marker_paths(&self) -> Result<Vec<String>, GitError> {
        self.run_marker_check(&parsers::resolve::DIFF_CHECK_ARGS).await
    }

    pub(super) async fn conflict_reopen(&self, path: &Path) -> Result<(), GitError> {
        let p = path.to_string_lossy().into_owned();
        self.run_simple(&["update-index", "--unresolve", "--", &p])
            .await?;
        // Regenerate the conflict markers in the worktree. If this fails the
        // reopen half-happened (stages restored, worktree still holds the old
        // resolution) - the user must learn both facts.
        self.run_simple(&["checkout", "-m", "--", &p])
            .await
            .map_err(|e| {
                append_error_note(
                    e,
                    &format!(
                        "Note: the conflict stages for '{p}' were restored (the file shows as \
                         conflicted again), but regenerating the conflict markers in the file \
                         failed - its content is still the previous resolution."
                    ),
                )
            })
    }

    /// Run a `git diff [--cached] --check` invocation and parse the flagged
    /// leftover-conflict-marker paths. `--check` exits 2 when it found
    /// problems - that is the data this returns, not a failure; anything
    /// else non-zero is an error.
    pub(super) async fn run_marker_check(&self, args: &[&str]) -> Result<Vec<String>, GitError> {
        let (code, stdout, stderr) = self.run_classified(args).await?;
        if code != 0 && code != 2 {
            return Err(command_failed(code, &stderr));
        }
        Ok(parsers::resolve::parse_leftover_markers(&stdout))
    }
}
