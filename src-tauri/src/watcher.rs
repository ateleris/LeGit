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
//! - Read-only activity used to cause endless refetch loops. On Linux/WSL,
//!   notify subscribes to IN_OPEN, so LeGit's own read commands fired
//!   Access(Open) events on HEAD / refs/* / packed-refs; classifying those
//!   made every refetch trigger the next one. Two guards now break this class
//!   of loop: read/metadata-only event kinds are dropped (`is_noise_kind`),
//!   and git-dir events are dropped unless the file's (size, mtime)
//!   fingerprint actually changed - which also covers no-op touches by
//!   external tools (AV write-backs, sync clients) on Windows, where every
//!   modification arrives as an undifferentiated Modify(Any). Tradeoff: a
//!   same-size rewrite within the filesystem's mtime granularity is swallowed
//!   - ref files are fixed-size, so this needs sub-granularity double writes
//!   (only plausible on FAT's 2s stamps; the focus-refetch backstop catches it).

use std::collections::{BTreeSet, HashMap};
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, SystemTime};

use ignore::gitignore::{Gitignore, GitignoreBuilder};
use notify::event::{AccessKind, AccessMode, ModifyKind};
use notify::{EventKind, RecommendedWatcher, RecursiveMode};
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
    /// A merge/rebase/cherry-pick/revert started, advanced, or ended
    /// (MERGE_HEAD, MERGE_MSG, rebase-merge/, rebase-apply/, *_HEAD).
    OpState,
}

/// Payload for [`REPO_CHANGED_EVENT`]: which repo changed and in which domains.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct RepoChangedPayload {
    pub repo_id: String,
    pub domains: Vec<ChangeDomain>,
    /// First few paths that classified into a domain (relative to the repo;
    /// git-dir paths are prefixed ".git/"). Capped at [`MAX_TRIGGER_PATHS`];
    /// `trigger_count` carries the full total. Feeds the Git Log panel so a
    /// refetch's cause is visible next to the git calls it triggered.
    pub trigger_paths: Vec<String>,
    /// Total number of classified paths in the batch.
    pub trigger_count: u32,
}

/// Display cap for [`RepoChangedPayload::trigger_paths`].
const MAX_TRIGGER_PATHS: usize = 8;

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
        // (size, mtime) per git-dir path, kept across batches: an event whose
        // file is byte-identical since last time (AV/sync-client attribute or
        // stream write-backs) is dropped instead of refetching. Bounded by the
        // number of distinct git-dir paths ever seen (roughly the ref count).
        let mut seen: HashMap<PathBuf, Option<Fingerprint>> = HashMap::new();

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
                let mut triggers: Vec<String> = Vec::new();
                let mut trigger_count: u32 = 0;
                for ev in &events {
                    // Attribute-only / access noise can never change git data.
                    // (On Windows these arrive as Modify(Any) and are handled
                    // by the fingerprint check below instead.)
                    if is_noise_kind(&ev.event.kind) {
                        continue;
                    }
                    for path in &ev.event.paths {
                        // Git-dir files: skip unless the content fingerprint
                        // moved. Also dedupes repeat events for one path, so
                        // trigger_count counts distinct git-dir paths.
                        if path.starts_with(&git_dir_cb)
                            && !fingerprint_changed(&mut seen, path, stat_fingerprint(path))
                        {
                            continue;
                        }
                        let mut path_domains: BTreeSet<ChangeDomain> = BTreeSet::new();
                        classify(path, &worktree_cb, &git_dir_cb, &ignore, &mut path_domains);
                        if path_domains.is_empty() {
                            continue;
                        }
                        trigger_count += 1;
                        if triggers.len() < MAX_TRIGGER_PATHS {
                            let rel = display_path(path, &worktree_cb, &git_dir_cb);
                            if !triggers.contains(&rel) {
                                triggers.push(rel);
                            }
                        }
                        domains.extend(path_domains);
                    }
                }
                if domains.is_empty() {
                    return;
                }

                let payload = RepoChangedPayload {
                    repo_id: repo_id.clone(),
                    domains: domains.into_iter().collect(),
                    trigger_paths: triggers,
                    trigger_count,
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
        // FETCH_HEAD is written by *every* fetch, even one that updated
        // nothing, and holds no data the UI displays — actual remote-ref
        // updates arrive as `refs/remotes/*` writes below. Reacting to it
        // turned each no-op fetch (in-app or external) into a full log
        // refetch, feeding the post-fetch invalidation churn.
        "FETCH_HEAD" => {}
        // Ref/HEAD moves → commit graph + branch list. `refs/stash` and
        // `refs/tags` (and `packed-refs`, which may hold either after a
        // pack-refs) additionally drive their own lists — external `git
        // stash`/`git tag` ops refresh live.
        "HEAD" | "refs" | "packed-refs" | "MERGE_HEAD" | "ORIG_HEAD"
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
        _ => {}
    }
}

/// Event kinds that can never reflect a git data change: pure reads and
/// attribute-only metadata updates (chmod, timestamps). Real ref/index writes
/// arrive as Create / Modify(Data) / Modify(Name) / Remove (or CLOSE_WRITE,
/// see below). Windows reports every modification as Modify(Any), which
/// deliberately does NOT match here; the fingerprint check covers that
/// platform.
///
/// This filter is what breaks the Linux refetch loop: notify's inotify
/// backend subscribes to IN_OPEN, so LeGit's own read commands (log,
/// for-each-ref, rev-list, stash list) fire Access(Open) on HEAD / refs/* /
/// packed-refs, which used to classify as ref changes and refetch forever.
fn is_noise_kind(kind: &EventKind) -> bool {
    match kind {
        // inotify's CLOSE_WRITE arrives as Access(Close(Write)) and is a real
        // write signal: never noise.
        EventKind::Access(AccessKind::Close(AccessMode::Write)) => false,
        EventKind::Access(_) => true,
        EventKind::Modify(ModifyKind::Metadata(_)) => true,
        _ => false,
    }
}

/// (size, mtime) of a git-dir file. `None` means the path is gone (or
/// unreadable), which is itself a distinct, comparable state.
type Fingerprint = (u64, Option<SystemTime>);

fn stat_fingerprint(path: &Path) -> Option<Fingerprint> {
    std::fs::metadata(path)
        .ok()
        .map(|m| (m.len(), m.modified().ok()))
}

/// Record `current` for `path` and report whether it differs from the last
/// batch. First sighting counts as changed (there is nothing to dedupe
/// against), so a fresh watcher never swallows a real event.
fn fingerprint_changed(
    seen: &mut HashMap<PathBuf, Option<Fingerprint>>,
    path: &Path,
    current: Option<Fingerprint>,
) -> bool {
    match seen.get(path) {
        Some(prev) if *prev == current => false,
        _ => {
            seen.insert(path.to_path_buf(), current);
            true
        }
    }
}

/// Repo-relative display form of a trigger path: git-dir paths as
/// ".git/<rel>", worktree paths as-is, anything else verbatim.
fn display_path(path: &Path, worktree: &Path, git_dir: &Path) -> String {
    if let Ok(rel) = path.strip_prefix(git_dir) {
        return Path::new(".git").join(rel).to_string_lossy().into_owned();
    }
    if let Ok(rel) = path.strip_prefix(worktree) {
        return rel.to_string_lossy().into_owned();
    }
    path.to_string_lossy().into_owned()
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
    fn fetch_head_is_ignored() {
        // Every fetch writes FETCH_HEAD, updates or not; real remote-ref
        // changes arrive as refs/remotes/* writes. Reacting here re-fetched
        // the log after every no-op fetch.
        let wt = Path::new("/repo");
        let gd = Path::new("/repo/.git");
        let mut out = BTreeSet::new();
        classify(Path::new("/repo/.git/FETCH_HEAD"), wt, gd, &Gitignore::empty(), &mut out);
        assert!(out.is_empty(), "got {out:?}");
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

    #[test]
    fn metadata_and_access_kinds_are_noise() {
        // notify's inotify backend subscribes to IN_OPEN, so on Linux/WSL
        // LeGit's own read commands fire Access(Open) on HEAD / refs/* /
        // packed-refs. Classifying those made every refetch trigger the next
        // one: an infinite log/branches/tags loop. Reads must be noise.
        use notify::event::{DataChange, MetadataKind};
        assert!(is_noise_kind(&EventKind::Access(AccessKind::Open(
            AccessMode::Any
        ))));
        assert!(is_noise_kind(&EventKind::Access(AccessKind::Read)));
        assert!(is_noise_kind(&EventKind::Modify(ModifyKind::Metadata(
            MetadataKind::WriteTime
        ))));
        // inotify reports CLOSE_WRITE as Access(Close(Write)): a real write.
        assert!(!is_noise_kind(&EventKind::Access(AccessKind::Close(
            AccessMode::Write
        ))));
        // Real writes and Windows' undifferentiated Modify(Any) must pass.
        assert!(!is_noise_kind(&EventKind::Modify(ModifyKind::Data(
            DataChange::Any
        ))));
        assert!(!is_noise_kind(&EventKind::Modify(ModifyKind::Any)));
        assert!(!is_noise_kind(&EventKind::Create(
            notify::event::CreateKind::Any
        )));
        assert!(!is_noise_kind(&EventKind::Remove(
            notify::event::RemoveKind::Any
        )));
    }

    #[test]
    fn fingerprint_dedupes_unchanged_paths() {
        let mut seen = HashMap::new();
        let p = Path::new("/repo/.git/packed-refs");
        let fp = Some((100, Some(SystemTime::UNIX_EPOCH)));

        // First sighting always fires; identical repeats are dropped.
        assert!(fingerprint_changed(&mut seen, p, fp));
        assert!(!fingerprint_changed(&mut seen, p, fp));
        assert!(!fingerprint_changed(&mut seen, p, fp));

        // A real rewrite (new mtime and/or size) fires again.
        let newer = SystemTime::UNIX_EPOCH + Duration::from_secs(1);
        assert!(fingerprint_changed(&mut seen, p, Some((100, Some(newer)))));
        assert!(fingerprint_changed(&mut seen, p, Some((101, Some(newer)))));

        // Deletion is a distinct state: fires once, then dedupes.
        assert!(fingerprint_changed(&mut seen, p, None));
        assert!(!fingerprint_changed(&mut seen, p, None));

        // Recreation after deletion fires.
        assert!(fingerprint_changed(&mut seen, p, fp));
    }

    #[test]
    fn fingerprint_tracks_paths_independently() {
        let mut seen = HashMap::new();
        let a = Path::new("/repo/.git/refs/heads/main");
        let b = Path::new("/repo/.git/refs/heads/dev");
        let fp = Some((41, Some(SystemTime::UNIX_EPOCH)));
        assert!(fingerprint_changed(&mut seen, a, fp));
        assert!(fingerprint_changed(&mut seen, b, fp));
        assert!(!fingerprint_changed(&mut seen, a, fp));
    }

    #[test]
    fn display_path_is_repo_relative() {
        let wt = Path::new("/repo");
        let gd = Path::new("/repo/.git");
        assert_eq!(
            display_path(&gd.join("packed-refs"), wt, gd),
            Path::new(".git").join("packed-refs").to_string_lossy()
        );
        assert_eq!(
            display_path(&wt.join("src/main.rs"), wt, gd),
            Path::new("src").join("main.rs").to_string_lossy()
        );
    }
}
