//! Per-repo filesystem watcher for live UI refresh.
//!
//! Native git GUIs (Gitnuro, GitKraken, Sublime Merge) refresh primarily off a
//! filesystem watcher, not window focus — so changes made outside the app
//! (commits/checkouts in a terminal, edits in an editor) show up immediately.
//! This module owns that watcher; window-focus refetch in the frontend stays as
//! a cheap backstop.
//!
//! One [`RepoWatcher`] per open repo (see `AppState.watchers`). It watches the
//! working tree and the git dir, debounces the event burst (a single checkout
//! emits thousands of events), classifies the batch into the affected query
//! *domains*, and emits one [`REPO_CHANGED_EVENT`] the frontend maps to scoped
//! `queryClient.invalidateQueries`.
//!
//! Limitations (documented, accepted for now):
//! - Gitignored dirs are still *watched* by `notify`; we only filter their
//!   events post-hoc via a root-`.gitignore` matcher. Pruning them from the
//!   watch set is a future optimization — the global disable toggle is the
//!   escape hatch for pathological repos (e.g. huge `node_modules` on a slow FS).
//! - Only the repo-root `.gitignore` feeds the matcher (not nested/global ones);
//!   it only suppresses redundant refreshes, so `git status` stays authoritative.
//! - Self-induced events (LeGit's own git ops) also trip the watcher; the
//!   redundant invalidate is deduped by react-query against the optimistic one.

use std::collections::BTreeSet;
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use ignore::gitignore::{Gitignore, GitignoreBuilder};
use notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{new_debouncer, DebounceEventResult, Debouncer, RecommendedCache};
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Emitter};

/// Tauri event channel carrying which query domains changed for a repo.
pub const REPO_CHANGED_EVENT: &str = "legit://repo-changed";

/// Debounce window for coalescing a burst of FS events. 300ms balances refresh
/// latency against batching a checkout/rebase's thousands of events into one.
const DEBOUNCE: Duration = Duration::from_millis(300);

/// A react-query data domain affected by a filesystem change. Mirrors the
/// query-key suffixes used by the frontend
/// (`[repoId, "status"|"log"|"branches"|"stashes"|"tags"]`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum ChangeDomain {
    Status,
    Log,
    Branches,
    Stashes,
    Tags,
}

/// Payload for [`REPO_CHANGED_EVENT`]: which repo changed and in which domains.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct RepoChangedPayload {
    pub repo_id: String,
    pub domains: Vec<ChangeDomain>,
}

/// Owns the live debouncer for one repo. Dropping it stops the watch thread and
/// all callbacks — that is the entire teardown (used on repo close / app exit).
pub struct RepoWatcher {
    _debouncer: Debouncer<RecommendedWatcher, RecommendedCache>,
}

impl RepoWatcher {
    /// Start watching `worktree` (+ `git_dir` if it lives outside the worktree,
    /// e.g. linked worktrees/submodules). Emits [`REPO_CHANGED_EVENT`] for
    /// `repo_id` on each debounced batch that touches a relevant path.
    pub fn start(
        app: AppHandle,
        repo_id: String,
        worktree: PathBuf,
        git_dir: PathBuf,
    ) -> notify::Result<RepoWatcher> {
        let ignore = build_ignore(&worktree);
        let worktree_cb = worktree.clone();
        let git_dir_cb = git_dir.clone();

        let mut debouncer = new_debouncer(
            DEBOUNCE,
            None,
            move |result: DebounceEventResult| {
                let events = match result {
                    Ok(events) => events,
                    Err(errors) => {
                        for e in errors {
                            tracing::warn!(repo_id = %repo_id, err = %e, "watcher error");
                        }
                        return;
                    }
                };

                let mut domains: BTreeSet<ChangeDomain> = BTreeSet::new();
                for ev in &events {
                    for path in &ev.event.paths {
                        classify(path, &worktree_cb, &git_dir_cb, &ignore, &mut domains);
                    }
                }
                if domains.is_empty() {
                    return;
                }

                let payload = RepoChangedPayload {
                    repo_id: repo_id.clone(),
                    domains: domains.into_iter().collect(),
                };
                if let Err(e) = app.emit(REPO_CHANGED_EVENT, payload) {
                    tracing::warn!(err = %e, "failed to emit repo-changed event");
                }
            },
        )?;

        // Working tree (recursive). `Debouncer::watch` also registers the path
        // as a cache root so renames are tracked across the tree.
        debouncer.watch(&worktree, RecursiveMode::Recursive)?;

        // Watch the git dir separately only when it isn't already under the
        // working tree (the common `<toplevel>/.git` case is covered above).
        if !git_dir.starts_with(&worktree) {
            debouncer.watch(&git_dir, RecursiveMode::Recursive)?;
        }

        tracing::debug!(worktree = %worktree.display(), git_dir = %git_dir.display(), "repo watcher started");
        Ok(RepoWatcher {
            _debouncer: debouncer,
        })
    }
}

/// Map one changed path to the query domains it affects, accumulating into `out`.
fn classify(
    path: &Path,
    worktree: &Path,
    git_dir: &Path,
    ignore: &Gitignore,
    out: &mut BTreeSet<ChangeDomain>,
) {
    // Inside the git dir: HEAD/refs/index drive log/branches/status.
    if let Ok(rel) = path.strip_prefix(git_dir) {
        classify_git(rel, out);
        return;
    }
    // Otherwise a working-tree path.
    if let Ok(rel) = path.strip_prefix(worktree) {
        // `.git` under the worktree is handled by the branch above; guard the
        // case where git_dir resolution differs from the literal `.git` path.
        if rel.starts_with(".git") {
            return;
        }
        // `_or_any_parents` so a file *inside* an ignored dir (e.g. a write to
        // `node_modules/x/y.js`) is skipped via the `node_modules/` rule, not
        // just direct matches. is_dir is unknown for deletions; `false` is the
        // safe default (file patterns still match; only dir-only patterns differ).
        if ignore.matched_path_or_any_parents(rel, false).is_ignore() {
            return;
        }
        out.insert(ChangeDomain::Status);
    }
}

/// Classify a path *relative to the git dir*. Objects/logs/lockfiles are noise.
fn classify_git(rel: &Path, out: &mut BTreeSet<ChangeDomain>) {
    let first = match rel.components().next() {
        Some(Component::Normal(c)) => c.to_string_lossy().into_owned(),
        _ => return,
    };

    // The object database churns constantly and never needs a UI refresh on its
    // own; reflog (`logs/`) mirrors ref moves we already catch via `refs/HEAD`.
    if first == "objects" || first == "logs" {
        return;
    }
    // Lock files (index.lock, ref .lock, packed-refs.lock) are transient noise.
    if rel
        .file_name()
        .map(|n| n.to_string_lossy().ends_with(".lock"))
        .unwrap_or(false)
    {
        return;
    }

    match first.as_str() {
        // Index change → staged/unstaged set changed.
        "index" => {
            out.insert(ChangeDomain::Status);
        }
        // Ref/HEAD moves → commit graph + branch list. `refs/stash` and
        // `refs/tags` (and `packed-refs`, which may hold either after a
        // pack-refs) additionally drive their own lists — external `git
        // stash`/`git tag` ops refresh live.
        "HEAD" | "refs" | "packed-refs" | "MERGE_HEAD" | "ORIG_HEAD" | "FETCH_HEAD"
        | "CHERRY_PICK_HEAD" | "REVERT_HEAD" => {
            out.insert(ChangeDomain::Log);
            out.insert(ChangeDomain::Branches);
            if first == "packed-refs" || rel.starts_with("refs/stash") {
                out.insert(ChangeDomain::Stashes);
            }
            if first == "packed-refs" || rel.starts_with("refs/tags") {
                out.insert(ChangeDomain::Tags);
            }
        }
        // In-progress merge/rebase state affects all three (conflicts + refs).
        "rebase-merge" | "rebase-apply" => {
            out.insert(ChangeDomain::Status);
            out.insert(ChangeDomain::Log);
            out.insert(ChangeDomain::Branches);
        }
        _ => {}
    }
}

/// Build a gitignore matcher from the repo-root `.gitignore` (cheap; suppresses
/// refresh storms from build output / `node_modules`). Empty if none/unreadable.
fn build_ignore(worktree: &Path) -> Gitignore {
    let mut builder = GitignoreBuilder::new(worktree);
    let root_ignore = worktree.join(".gitignore");
    if root_ignore.exists() {
        let _ = builder.add(root_ignore);
    }
    builder.build().unwrap_or_else(|_| Gitignore::empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn domains(path: &str, worktree: &Path, git_dir: &Path, ignore: &Gitignore) -> Vec<ChangeDomain> {
        let mut out = BTreeSet::new();
        classify(&worktree.join(path), worktree, git_dir, ignore, &mut out);
        out.into_iter().collect()
    }

    #[test]
    fn worktree_edit_is_status() {
        let wt = Path::new("/repo");
        let gd = Path::new("/repo/.git");
        let ig = Gitignore::empty();
        assert_eq!(domains("src/main.rs", wt, gd, &ig), vec![ChangeDomain::Status]);
    }

    #[test]
    fn index_change_is_status() {
        let wt = Path::new("/repo");
        let gd = Path::new("/repo/.git");
        let mut out = BTreeSet::new();
        classify(Path::new("/repo/.git/index"), wt, gd, &Gitignore::empty(), &mut out);
        assert_eq!(out.into_iter().collect::<Vec<_>>(), vec![ChangeDomain::Status]);
    }

    #[test]
    fn ref_change_is_log_and_branches() {
        let wt = Path::new("/repo");
        let gd = Path::new("/repo/.git");
        let mut out = BTreeSet::new();
        classify(Path::new("/repo/.git/refs/heads/main"), wt, gd, &Gitignore::empty(), &mut out);
        let got: Vec<_> = out.into_iter().collect();
        assert!(got.contains(&ChangeDomain::Log) && got.contains(&ChangeDomain::Branches));
    }

    #[test]
    fn stash_ref_change_includes_stashes_domain() {
        // External `git stash` ops move `refs/stash`; the stash list must
        // refresh live, not only via focus.
        let wt = Path::new("/repo");
        let gd = Path::new("/repo/.git");
        let mut out = BTreeSet::new();
        classify(Path::new("/repo/.git/refs/stash"), wt, gd, &Gitignore::empty(), &mut out);
        assert!(out.contains(&ChangeDomain::Stashes), "got {out:?}");
        assert!(out.contains(&ChangeDomain::Log));
    }

    #[test]
    fn branch_ref_change_does_not_include_stashes() {
        let wt = Path::new("/repo");
        let gd = Path::new("/repo/.git");
        let mut out = BTreeSet::new();
        classify(Path::new("/repo/.git/refs/heads/main"), wt, gd, &Gitignore::empty(), &mut out);
        assert!(!out.contains(&ChangeDomain::Stashes), "got {out:?}");
    }

    #[test]
    fn packed_refs_change_includes_stashes_and_tags_domains() {
        // `git pack-refs` can move refs/stash and refs/tags into packed-refs.
        let wt = Path::new("/repo");
        let gd = Path::new("/repo/.git");
        let mut out = BTreeSet::new();
        classify(Path::new("/repo/.git/packed-refs"), wt, gd, &Gitignore::empty(), &mut out);
        assert!(out.contains(&ChangeDomain::Stashes), "got {out:?}");
        assert!(out.contains(&ChangeDomain::Tags), "got {out:?}");
    }

    #[test]
    fn tag_ref_change_includes_tags_domain() {
        let wt = Path::new("/repo");
        let gd = Path::new("/repo/.git");
        let mut out = BTreeSet::new();
        classify(Path::new("/repo/.git/refs/tags/v1.0"), wt, gd, &Gitignore::empty(), &mut out);
        assert!(out.contains(&ChangeDomain::Tags), "got {out:?}");
        let mut branch = BTreeSet::new();
        classify(Path::new("/repo/.git/refs/heads/main"), wt, gd, &Gitignore::empty(), &mut branch);
        assert!(!branch.contains(&ChangeDomain::Tags), "got {branch:?}");
    }

    #[test]
    fn objects_and_locks_are_ignored() {
        let wt = Path::new("/repo");
        let gd = Path::new("/repo/.git");
        for noise in ["objects/ab/cdef", "index.lock", "refs/heads/main.lock", "logs/HEAD"] {
            let mut out = BTreeSet::new();
            classify(&gd.join(noise), wt, gd, &Gitignore::empty(), &mut out);
            assert!(out.is_empty(), "{noise} should be ignored, got {out:?}");
        }
    }

    #[test]
    fn gitignored_worktree_path_is_skipped() {
        let wt = Path::new("/repo");
        let gd = Path::new("/repo/.git");
        let mut b = GitignoreBuilder::new(wt);
        b.add_line(None, "node_modules/").unwrap();
        let ig = b.build().unwrap();
        assert!(domains("node_modules/x/index.js", wt, gd, &ig).is_empty());
    }
}
