//! The repo's installed git hooks, for the repo-settings hooks view.

use super::*;
use crate::fs::FsDirEntry;
use crate::types::{HookEntry, HooksReport};

/// Every hook name git runs, in githooks(5) order. A file in the hooks
/// directory with any other name is never executed by git.
const KNOWN_HOOKS: [&str; 28] = [
    "applypatch-msg",
    "pre-applypatch",
    "post-applypatch",
    "pre-commit",
    "pre-merge-commit",
    "prepare-commit-msg",
    "commit-msg",
    "post-commit",
    "pre-rebase",
    "post-checkout",
    "post-merge",
    "pre-push",
    "pre-receive",
    "update",
    "proc-receive",
    "post-receive",
    "post-update",
    "reference-transaction",
    "push-to-checkout",
    "pre-auto-gc",
    "post-rewrite",
    "sendemail-validate",
    "fsmonitor-watchman",
    "p4-changelist",
    "p4-prepare-changelist",
    "p4-post-changelist",
    "p4-pre-submit",
    "post-index-change",
];

impl<E: GitExecutor + ?Sized> GitCliBackend<E> {
    pub(super) async fn hooks_report(&self) -> Result<HooksReport, GitError> {
        let runner = self.runner().await;
        let dir = self
            .run_checked(&["rev-parse", "--path-format=absolute", "--git-path", "hooks"])
            .await?;
        let dir = dir.trim().to_string();
        // Unset key exits 1 (expected).
        let cfg = runner
            .run_expecting(&["config", "--get", "core.hooksPath"], &[1])
            .await?;
        let hooks_path = (cfg.success && !cfg.stdout.trim().is_empty())
            .then(|| cfg.stdout.trim().to_string());
        // A redirected hooks dir may simply not exist; that is "no hooks",
        // not an error.
        let entries = self
            .fs
            .read_dir(&HostPath(dir.clone()))
            .await
            .unwrap_or_default();
        Ok(build_hooks_report(dir, hooks_path, entries))
    }

    /// Delete an installed hook from the DEFAULT hooks directory. Refused for
    /// a `core.hooksPath`-redirected dir (those files are usually tracked,
    /// team-shared content - manage them in the working tree) and for any
    /// name outside `KNOWN_HOOKS` (which also rules out path traversal).
    pub(super) async fn remove_hook(&self, name: &str) -> Result<(), GitError> {
        if !KNOWN_HOOKS.contains(&name) {
            return Err(GitError::Internal(format!("not a git hook name: {name}")));
        }
        let runner = self.runner().await;
        let cfg = runner
            .run_expecting(&["config", "--get", "core.hooksPath"], &[1])
            .await?;
        if cfg.success && !cfg.stdout.trim().is_empty() {
            return Err(GitError::Internal(
                "hooks are redirected by core.hooksPath; manage that file in the working tree"
                    .into(),
            ));
        }
        let dir = self
            .run_checked(&["rev-parse", "--path-format=absolute", "--git-path", "hooks"])
            .await?;
        let dir = HostPath(dir.trim().to_string());
        self.fs.remove_file(&dir.join(name)).await.map_err(fs_internal)
    }
}

/// Assemble the report from the resolved directory's listing: directories
/// and git's `.sample` templates are not hooks; known hooks come first in
/// githooks(5) order, everything else alphabetically after them.
fn build_hooks_report(
    dir: String,
    hooks_path: Option<String>,
    entries: Vec<FsDirEntry>,
) -> HooksReport {
    let files: Vec<String> = entries
        .into_iter()
        .filter(|e| !e.is_dir && !e.name.ends_with(".sample"))
        .map(|e| e.name)
        .collect();
    let mut hooks: Vec<HookEntry> = KNOWN_HOOKS
        .iter()
        .filter(|k| files.iter().any(|f| f == *k))
        .map(|k| HookEntry { name: k.to_string(), known: true })
        .collect();
    let mut others: Vec<String> = files
        .into_iter()
        .filter(|f| !KNOWN_HOOKS.contains(&f.as_str()))
        .collect();
    others.sort();
    hooks.extend(others.into_iter().map(|name| HookEntry { name, known: false }));
    HooksReport { dir, hooks_path, hooks }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(name: &str) -> FsDirEntry {
        FsDirEntry { name: name.into(), is_dir: false }
    }

    fn subdir(name: &str) -> FsDirEntry {
        FsDirEntry { name: name.into(), is_dir: true }
    }

    fn names(report: &HooksReport) -> Vec<&str> {
        report.hooks.iter().map(|h| h.name.as_str()).collect()
    }

    #[test]
    fn samples_and_directories_are_not_hooks() {
        let r = build_hooks_report(
            "/r/.git/hooks".into(),
            None,
            vec![file("pre-commit.sample"), subdir("_"), file("pre-commit")],
        );
        assert_eq!(names(&r), vec!["pre-commit"]);
        assert!(r.hooks[0].known);
    }

    #[test]
    fn known_hooks_lead_in_canonical_order_then_others_alphabetically() {
        let r = build_hooks_report(
            "/r/.husky".into(),
            Some(".husky".into()),
            vec![
                file("zz-helper.sh"),
                file("commit-msg"),
                file("pre-commit"),
                file("a-helper.sh"),
            ],
        );
        assert_eq!(
            names(&r),
            vec!["pre-commit", "commit-msg", "a-helper.sh", "zz-helper.sh"]
        );
        assert!(r.hooks[0].known && r.hooks[1].known);
        assert!(!r.hooks[2].known && !r.hooks[3].known);
    }
}
