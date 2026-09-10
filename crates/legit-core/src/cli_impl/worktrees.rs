//! Worktree management for `GitCliBackend` (list/add/remove/prune) and the
//! checked-out-elsewhere message extractor.
//!
//! The `GitBackend` trait impl in `mod.rs` delegates to the same-named
//! inherent methods here (a trait impl cannot span files).

use crate::error::GitError;
use crate::executor::GitExecutor;
use crate::types::{WorktreeAddMode, WorktreeInfo};

use super::{parsers, safe_ref, GitCliBackend};

impl<E: GitExecutor + ?Sized> GitCliBackend<E> {
    pub(super) async fn worktree_list(&self) -> Result<Vec<WorktreeInfo>, GitError> {
        let runner = self.runner().await;
        let out = runner.run(&parsers::worktrees::WORKTREE_LIST_ARGS).await?;
        Self::ensure_success(&out)?;
        let mut list = parsers::worktrees::parse_worktree_list(&out.stdout);
        // git names an absorbed submodule's gitdir as the main worktree's
        // path; resolve the real toplevel and fix the entry (best-effort: a
        // failed probe leaves the list as parsed). A bare main has no
        // toplevel to ask for.
        if list.first().is_some_and(|m| !m.bare) {
            let probe = runner
                .run(&[
                    "rev-parse",
                    "--path-format=absolute",
                    "--git-common-dir",
                    "--show-toplevel",
                ])
                .await;
            if let Ok(o) = probe {
                if o.success {
                    let mut lines = o.stdout.lines();
                    if let (Some(common), Some(top)) = (lines.next(), lines.next()) {
                        fix_absorbed_submodule_main_path(&mut list, common.trim(), top.trim());
                    }
                }
            }
        }
        // Best-effort dirtiness per checkout, for the read-only indicators.
        // `--no-optional-locks` keeps the probe from writing ANOTHER
        // worktree's index (a plain `status` refreshes the stat cache);
        // bare/prunable entries have nothing to probe. A failed probe leaves
        // None - never an error.
        for w in &mut list {
            if w.bare || w.prunable.is_some() {
                continue;
            }
            let probe = runner
                .run(&["--no-optional-locks", "-C", &w.path, "status", "--porcelain", "-z"])
                .await;
            w.dirty = match probe {
                Ok(o) if o.success => Some(!o.stdout.is_empty()),
                _ => None,
            };
        }
        Ok(list)
    }

    pub(super) async fn worktree_add(
        &self,
        path: &str,
        mode: &WorktreeAddMode,
    ) -> Result<(), GitError> {
        if path.trim().is_empty() {
            return Err(GitError::Internal("worktree path is empty".into()));
        }
        match mode {
            WorktreeAddMode::Checkout { branch } => {
                let b = safe_ref("branch", branch)?;
                self.run_simple(&["worktree", "add", "--", path, b]).await
            }
            WorktreeAddMode::NewBranch { name, start_point } => {
                let n = safe_ref("branch", name)?;
                match start_point.as_deref() {
                    Some(s) => {
                        let s = safe_ref("revision", s)?;
                        self.run_simple(&["worktree", "add", "-b", n, "--", path, s]).await
                    }
                    None => self.run_simple(&["worktree", "add", "-b", n, "--", path]).await,
                }
            }
            WorktreeAddMode::Detach { rev } => match rev.as_deref() {
                Some(r) => {
                    let r = safe_ref("revision", r)?;
                    self.run_simple(&["worktree", "add", "--detach", "--", path, r]).await
                }
                None => self.run_simple(&["worktree", "add", "--detach", "--", path]).await,
            },
        }
    }

    pub(super) async fn worktree_remove(&self, path: &str, force: bool) -> Result<(), GitError> {
        if force {
            self.run_simple(&["worktree", "remove", "--force", "--", path]).await
        } else {
            self.run_simple(&["worktree", "remove", "--", path]).await
        }
    }

    pub(super) async fn worktree_prune(&self) -> Result<(), GitError> {
        self.run_simple(&["worktree", "prune"]).await
    }

    pub(super) async fn worktree_lock(
        &self,
        path: &str,
        reason: Option<&str>,
    ) -> Result<(), GitError> {
        match reason {
            Some(r) => {
                self.run_simple(&["worktree", "lock", "--reason", r, "--", path]).await
            }
            None => self.run_simple(&["worktree", "lock", "--", path]).await,
        }
    }

    pub(super) async fn worktree_unlock(&self, path: &str) -> Result<(), GitError> {
        self.run_simple(&["worktree", "unlock", "--", path]).await
    }
}

/// In a submodule with an absorbed gitdir, `git worktree list` reports the
/// gitdir (`<super>/.git/modules/<name>`) as the main worktree's path - it
/// derives the entry from the common dir and ignores `core.worktree` - so
/// the session's own checkout would render as a foreign worktree. When the
/// main entry's path is the git common dir, rewrite it to the real toplevel.
pub(super) fn fix_absorbed_submodule_main_path(
    list: &mut [WorktreeInfo],
    common_dir: &str,
    toplevel: &str,
) {
    let norm = |p: &str| p.replace('\\', "/");
    let Some(main) = list.first_mut() else { return };
    if main.is_main && norm(&main.path) == norm(common_dir) {
        main.path = toplevel.to_string();
    }
}

/// Best-effort (branch, worktree path) from git's two refusal messages:
/// switch/checkout: `fatal: '<branch>' is already checked out at '<path>'`;
/// branch delete (wording varies by git version):
/// `error: Cannot delete branch '<b>' checked out at '<path>'` or
/// `error: cannot delete branch '<b>' used by worktree at '<path>'`.
pub(super) fn parse_checked_out_elsewhere(stderr: &str) -> (Option<String>, Option<String>) {
    // Both messages quote the branch first and the path last.
    let quoted: Vec<&str> = stderr.split('\'').skip(1).step_by(2).collect();
    match quoted.as_slice() {
        [branch, .., path] => (Some(branch.to_string()), Some(path.to_string())),
        _ => (None, None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(path: &str, is_main: bool) -> WorktreeInfo {
        WorktreeInfo {
            path: path.to_string(),
            head: Some("1111111111111111111111111111111111111111".into()),
            branch: Some("main".into()),
            is_main,
            detached: false,
            bare: false,
            locked: None,
            prunable: None,
            dirty: None,
        }
    }

    #[test]
    fn rewrites_the_gitdir_main_entry_of_an_absorbed_submodule() {
        let mut list = vec![entry("/super/.git/modules/lib", true)];
        fix_absorbed_submodule_main_path(
            &mut list,
            "/super/.git/modules/lib",
            "/super/lib",
        );
        assert_eq!(list[0].path, "/super/lib");
    }

    #[test]
    fn leaves_a_normal_repo_untouched() {
        let mut list = vec![entry("/repo", true), entry("/wt", false)];
        fix_absorbed_submodule_main_path(&mut list, "/repo/.git", "/repo");
        assert_eq!(list[0].path, "/repo");
        assert_eq!(list[1].path, "/wt");
    }

    #[test]
    fn leaves_a_linked_worktree_sessions_main_entry_untouched() {
        // Seen from a linked worktree: the main entry is the MAIN repo's
        // toplevel (not this session's), which is correct as-is.
        let mut list = vec![entry("/repo", true), entry("/wt", false)];
        fix_absorbed_submodule_main_path(&mut list, "/repo/.git", "/wt");
        assert_eq!(list[0].path, "/repo");
    }

    #[test]
    fn compares_paths_across_separator_styles() {
        let mut list = vec![entry("C:/super/.git/modules/lib", true)];
        fix_absorbed_submodule_main_path(
            &mut list,
            "C:\\super\\.git\\modules\\lib",
            "C:/super/lib",
        );
        assert_eq!(list[0].path, "C:/super/lib");
    }

    #[test]
    fn extracts_branch_and_path_from_the_switch_refusal() {
        let (b, p) = parse_checked_out_elsewhere(
            "fatal: 'feature' is already checked out at '/home/u/wt-feature'",
        );
        assert_eq!(b.as_deref(), Some("feature"));
        assert_eq!(p.as_deref(), Some("/home/u/wt-feature"));
    }

    #[test]
    fn extracts_from_the_branch_delete_refusals() {
        let (b, p) = parse_checked_out_elsewhere(
            "error: Cannot delete branch 'feature' checked out at '/home/u/wt-feature'",
        );
        assert_eq!(b.as_deref(), Some("feature"));
        assert_eq!(p.as_deref(), Some("/home/u/wt-feature"));
        let (b2, p2) = parse_checked_out_elsewhere(
            "error: cannot delete branch 'f' used by worktree at '/w'",
        );
        assert_eq!(b2.as_deref(), Some("f"));
        assert_eq!(p2.as_deref(), Some("/w"));
    }

    #[test]
    fn unrecognized_message_yields_nones() {
        assert_eq!(parse_checked_out_elsewhere("fatal: something else"), (None, None));
    }
}
