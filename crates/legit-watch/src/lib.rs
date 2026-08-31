//! Per-repo filesystem watcher: notify wiring, debounce, and change-domain
//! classification.
//!
//! Native git GUIs (Gitnuro, GitKraken, Sublime Merge) refresh primarily off a
//! filesystem watcher, not window focus — so changes made outside the app
//! (commits/checkouts in a terminal, edits in an editor) show up immediately.
//! This crate owns the watcher CORE: it must run next to the repo's
//! filesystem, so the Tauri app hosts one per local repo and the remote agent
//! hosts one per remote repo. The host supplies a `sink` callback; the core
//! watches the working tree and the git dir, debounces the event burst (a
//! single checkout emits thousands of events), classifies the batch into the
//! affected query *domains*, and hands the sink one [`WatchBatch`] per burst.
//! The Tauri side wraps the batch in a [`RepoChangedPayload`] and emits it to
//! the frontend, which maps it to scoped `queryClient.invalidateQueries`.
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

/// Re-exported so hosts can name `notify::Result`/`notify::Error` without
/// depending on notify themselves.
pub use notify;

/// Debounce window for coalescing a burst of FS events. 300ms balances refresh
/// latency against batching a checkout/rebase's thousands of events into one.
const DEBOUNCE: Duration = Duration::from_millis(300);

/// A react-query data domain affected by a filesystem change. Mirrors the
/// query-key suffixes used by the frontend
/// (`[repoId, "status"|"log"|"branches"|"stashes"|"tags"|"diff"|…]`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum ChangeDomain {
    Status,
    Log,
    Branches,
    Stashes,
    Tags,
    /// Worktree content, the index, or the HEAD-anchored comparison base
    /// changed: open worktree/index diffs may be stale. Revision-pair diffs
    /// are immutable, so ref-only churn (remote/tag/stash refs) stays out.
    Diff,
    /// A merge/rebase/cherry-pick/revert started, advanced, or ended
    /// (MERGE_HEAD, MERGE_MSG, rebase-merge/, rebase-apply/, *_HEAD).
    OpState,
    /// Submodule state changed: a write inside a submodule gitdir
    /// (`.git/modules/**` HEAD/refs/index). Superproject-side triggers
    /// (index, `.gitmodules`) already arrive via `Status`, which the frontend
    /// derives into the submodules query (`withDerivedDomains`).
    Submodules,
}

/// One debounced batch's classified result, handed to the host's sink.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WatchBatch {
    pub domains: Vec<ChangeDomain>,
    /// First few paths that classified into a domain (relative to the repo;
    /// git-dir paths are prefixed ".git/"). Capped at [`MAX_TRIGGER_PATHS`];
    /// `trigger_count` carries the full total.
    pub trigger_paths: Vec<String>,
    /// Total number of classified paths in the batch.
    pub trigger_count: u32,
}

/// Frontend event payload: which repo changed and in which domains. The wire
/// shape of the Tauri `legit://repo-changed` event (and the agent protocol's
/// watch notification); the frontend hand-mirrors it in `src/lib/types.ts`.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct RepoChangedPayload {
    pub repo_id: String,
    pub domains: Vec<ChangeDomain>,
    /// See [`WatchBatch::trigger_paths`]. Feeds the Git Log panel so a
    /// refetch's cause is visible next to the git calls it triggered.
    pub trigger_paths: Vec<String>,
    pub trigger_count: u32,
}

/// Display cap for [`WatchBatch::trigger_paths`].
const MAX_TRIGGER_PATHS: usize = 8;

/// Callback receiving each classified batch. Runs on the debouncer's thread —
/// keep it cheap (an event emit / channel send).
pub type WatchSink = Box<dyn Fn(WatchBatch) + Send + Sync + 'static>;

/// Owns the live debouncer for one repo. Dropping it stops the watch thread and
/// all callbacks — that is the entire teardown (used on repo close / app exit).
pub struct WatcherCore {
    _debouncer: Debouncer<RecommendedWatcher, RecommendedCache>,
}

impl WatcherCore {
    /// Start watching `worktree` (+ `git_dir` if it lives outside the worktree,
    /// e.g. linked worktrees/submodules). Calls `sink` for each debounced
    /// batch that touches a relevant path.
    pub fn start(
        worktree: PathBuf,
        git_dir: PathBuf,
        sink: WatchSink,
    ) -> notify::Result<WatcherCore> {
        let ignore = build_ignore(&worktree);
        let worktree_cb = worktree.clone();
        let git_dir_cb = git_dir.clone();
        // (size, mtime) per DOMAIN-RELEVANT git-dir path, kept across batches:
        // an event whose file is byte-identical since last time (AV/sync-client
        // attribute or stream write-backs) is dropped instead of refetching.
        // Only paths that classify to a domain enter the map (see
        // `path_contribution`), so it is bounded by roughly the ref count.
        let mut seen: HashMap<PathBuf, Option<Fingerprint>> = HashMap::new();

        let mut debouncer = new_debouncer(
            DEBOUNCE,
            None,
            move |result: DebounceEventResult| {
                let events = match result {
                    Ok(events) => events,
                    Err(errors) => {
                        for e in errors {
                            tracing::warn!(worktree = %worktree_cb.display(), err = %e, "watcher error");
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
                        let path_domains = path_contribution(
                            path,
                            &worktree_cb,
                            &git_dir_cb,
                            &ignore,
                            &mut seen,
                            stat_fingerprint,
                        );
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

                sink(WatchBatch {
                    domains: domains.into_iter().collect(),
                    trigger_paths: triggers,
                    trigger_count,
                });
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
        Ok(WatcherCore {
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
        // File content changed: an open worktree diff of it is stale.
        out.insert(ChangeDomain::Diff);
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
        // Index change → staged/unstaged set changed, and with it both sides
        // of every worktree/index diff.
        "index" => {
            out.insert(ChangeDomain::Status);
            out.insert(ChangeDomain::Diff);
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
            // Remote-tracking refs drive the tags query too: each tag's
            // `target_on_remote` flag is computed against them, so a
            // push/fetch must refresh the tag list (else "Push tag" stays
            // disabled after pushing the tagged commit).
            if first == "packed-refs"
                || rel.starts_with("refs/tags")
                || rel.starts_with("refs/remotes")
            {
                out.insert(ChangeDomain::Tags);
            }
            // Staged diffs compare the index against HEAD, so they go stale
            // when HEAD's resolved target moves: the HEAD file itself, a
            // local branch head (possibly packed), or an op head (external
            // `git reset --soft` moves the branch ref without touching the
            // index). Remote/tag/stash refs never anchor a diff - a plain
            // fetch must not refetch open diffs.
            if first != "refs" || rel.starts_with("refs/heads") {
                out.insert(ChangeDomain::Diff);
            }
        }
        // The prepared merge message feeds the op-state banner.
        "MERGE_MSG" => {
            out.insert(ChangeDomain::OpState);
        }
        // A submodule's gitdir lives at `.git/modules/<name>/...`; the name
        // defaults to the submodule path, so it may contain slashes - classify
        // by tail components instead of locating the module boundary.
        "modules" => {
            let comps: Vec<String> = rel
                .components()
                .skip(1)
                .filter_map(|c| match c {
                    Component::Normal(s) => Some(s.to_string_lossy().into_owned()),
                    _ => None,
                })
                .collect();
            // Same noise filter as the superproject gitdir: object database,
            // reflogs, and FETCH_HEAD churn without UI-visible state changes
            // (lock files are already filtered above).
            if comps.iter().any(|c| c == "objects" || c == "logs" || c == "FETCH_HEAD") {
                return;
            }
            if comps
                .iter()
                .any(|c| c == "HEAD" || c == "index" || c == "refs" || c == "packed-refs")
            {
                out.insert(ChangeDomain::Submodules);
                // A submodule HEAD move is a pointer move: visible in the
                // superproject's status as SubmoduleChanged, and as a gitlink
                // change in an open diff of the submodule path.
                out.insert(ChangeDomain::Status);
                out.insert(ChangeDomain::Diff);
            }
        }
        // In-progress merge/rebase state affects all three (conflicts + refs)
        // plus the op-state banner; each step rewrites worktree/index content
        // (conflict markers), so open diffs go stale too.
        "rebase-merge" | "rebase-apply" => {
            out.insert(ChangeDomain::Status);
            out.insert(ChangeDomain::Log);
            out.insert(ChangeDomain::Branches);
            out.insert(ChangeDomain::OpState);
            out.insert(ChangeDomain::Diff);
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

/// One batch path's contribution to the emitted domains: classify FIRST, and
/// only for paths that resolve to a domain apply the git-dir fingerprint
/// gate. The ordering is load-bearing: the `seen` map lives for the whole
/// session, and loose objects / `logs/` / lockfiles classify to no domain -
/// fingerprinting them before classifying grew the map without bound (one
/// entry per object ever written) and paid a stat per irrelevant path. The
/// "bounded by roughly the ref count" property only holds post-classify.
/// `fingerprint` is injected so the decision is testable without a
/// filesystem.
fn path_contribution(
    path: &Path,
    worktree: &Path,
    git_dir: &Path,
    ignore: &Gitignore,
    seen: &mut HashMap<PathBuf, Option<Fingerprint>>,
    fingerprint: impl Fn(&Path) -> Option<Fingerprint>,
) -> BTreeSet<ChangeDomain> {
    let mut path_domains = BTreeSet::new();
    classify(path, worktree, git_dir, ignore, &mut path_domains);
    if path_domains.is_empty() {
        return path_domains;
    }
    // Git-dir files: suppress unless the content fingerprint moved (dedupes
    // AV/sync-client attribute write-backs and repeat events for one path).
    if path.starts_with(git_dir) && !fingerprint_changed(seen, path, fingerprint(path)) {
        path_domains.clear();
    }
    path_domains
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

    // --- path_contribution: classify-before-fingerprint ordering -----------
    // The fingerprint map lives for the whole session; only domain-relevant
    // git-dir paths may enter it. Fingerprinting before classifying grew it
    // without bound (one entry per loose object / lockfile ever written).

    #[test]
    fn path_contribution_ignores_loose_objects_and_keeps_map_empty() {
        let wt = Path::new("/repo");
        let gd = Path::new("/repo/.git");
        let mut seen = HashMap::new();
        let out = path_contribution(
            Path::new("/repo/.git/objects/ab/cdef0123"),
            wt,
            gd,
            &Gitignore::empty(),
            &mut seen,
            |_| Some((1, None)),
        );
        assert!(out.is_empty());
        assert!(seen.is_empty(), "irrelevant paths must not enter the fingerprint map");
    }

    #[test]
    fn path_contribution_fingerprint_gates_relevant_git_dir_paths() {
        let wt = Path::new("/repo");
        let gd = Path::new("/repo/.git");
        let refs = Path::new("/repo/.git/refs/heads/main");
        let mut seen = HashMap::new();
        // First sighting: domains reported, path recorded.
        let first =
            path_contribution(refs, wt, gd, &Gitignore::empty(), &mut seen, |_| Some((1, None)));
        assert!(!first.is_empty());
        assert_eq!(seen.len(), 1);
        // Same fingerprint again: deduped.
        let second =
            path_contribution(refs, wt, gd, &Gitignore::empty(), &mut seen, |_| Some((1, None)));
        assert!(second.is_empty(), "unchanged fingerprint must suppress the path");
        // Changed fingerprint: reported again.
        let third =
            path_contribution(refs, wt, gd, &Gitignore::empty(), &mut seen, |_| Some((2, None)));
        assert!(!third.is_empty());
    }

    #[test]
    fn path_contribution_worktree_paths_bypass_the_fingerprint_map() {
        let wt = Path::new("/repo");
        let gd = Path::new("/repo/.git");
        let mut seen = HashMap::new();
        let out = path_contribution(
            Path::new("/repo/src/main.rs"),
            wt,
            gd,
            &Gitignore::empty(),
            &mut seen,
            |_| None,
        );
        assert_eq!(
            out.into_iter().collect::<Vec<_>>(),
            vec![ChangeDomain::Status, ChangeDomain::Diff]
        );
        assert!(seen.is_empty());
    }

    #[test]
    fn worktree_edit_is_status_and_diff() {
        // An external edit of a tracked file must refresh both the status
        // list and an open worktree diff of it.
        let wt = Path::new("/repo");
        let gd = Path::new("/repo/.git");
        let ig = Gitignore::empty();
        assert_eq!(
            domains("src/main.rs", wt, gd, &ig),
            vec![ChangeDomain::Status, ChangeDomain::Diff]
        );
    }

    #[test]
    fn index_change_is_status_and_diff() {
        // External stage/unstage rewrites .git/index; open diffs (worktree
        // AND staged) change sides, so both domains must fire - this was the
        // "external `git add` leaves the open diff stale" bug.
        let wt = Path::new("/repo");
        let gd = Path::new("/repo/.git");
        let mut out = BTreeSet::new();
        classify(Path::new("/repo/.git/index"), wt, gd, &Gitignore::empty(), &mut out);
        assert_eq!(
            out.into_iter().collect::<Vec<_>>(),
            vec![ChangeDomain::Status, ChangeDomain::Diff]
        );
    }

    #[test]
    fn head_anchored_moves_drive_diff() {
        // Staged diffs are index-vs-HEAD: a HEAD move (checkout), a local
        // branch head move (commit / reset --soft, possibly packed), or an op
        // head must refresh them.
        let wt = Path::new("/repo");
        let gd = Path::new("/repo/.git");
        for anchor in ["HEAD", "refs/heads/main", "packed-refs", "MERGE_HEAD", "ORIG_HEAD"] {
            let mut out = BTreeSet::new();
            classify(&gd.join(anchor), wt, gd, &Gitignore::empty(), &mut out);
            assert!(out.contains(&ChangeDomain::Diff), "{anchor} should drive Diff, got {out:?}");
        }
    }

    #[test]
    fn remote_tag_and_stash_refs_do_not_drive_diff() {
        // Diffs are never anchored to remote/tag/stash refs: a plain fetch or
        // an external `git tag`/`git stash` must not refetch open diffs.
        let wt = Path::new("/repo");
        let gd = Path::new("/repo/.git");
        for quiet in ["refs/remotes/origin/main", "refs/tags/v1.0", "refs/stash"] {
            let mut out = BTreeSet::new();
            classify(&gd.join(quiet), wt, gd, &Gitignore::empty(), &mut out);
            assert!(!out.contains(&ChangeDomain::Diff), "{quiet} should not drive Diff, got {out:?}");
        }
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
    fn remote_ref_change_includes_tags_domain() {
        // A push/fetch moves refs/remotes/<remote>/<branch>; the tags query's
        // per-tag `target_on_remote` flag depends on remote-tracking refs, so
        // it must refetch (the disabled "Push tag (commit not on remote)"
        // entry stayed stale after pushing the tagged commit).
        let wt = Path::new("/repo");
        let gd = Path::new("/repo/.git");
        let mut out = BTreeSet::new();
        classify(Path::new("/repo/.git/refs/remotes/origin/main"), wt, gd, &Gitignore::empty(), &mut out);
        assert!(out.contains(&ChangeDomain::Tags), "got {out:?}");
        assert!(out.contains(&ChangeDomain::Log));
        assert!(out.contains(&ChangeDomain::Branches));
    }

    #[test]
    fn local_branch_ref_change_does_not_include_tags() {
        // Local head moves don't affect `target_on_remote` - no tags refetch.
        let wt = Path::new("/repo");
        let gd = Path::new("/repo/.git");
        let mut out = BTreeSet::new();
        classify(Path::new("/repo/.git/refs/heads/main"), wt, gd, &Gitignore::empty(), &mut out);
        assert!(!out.contains(&ChangeDomain::Tags), "got {out:?}");
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
    fn submodule_gitdir_head_move_hits_submodules_domain() {
        // A commit inside a submodule moves `.git/modules/<name>/HEAD`;
        // before the Submodules domain that classified as nothing and the UI
        // went stale.
        let wt = Path::new("/repo");
        let gd = Path::new("/repo/.git");
        let mut out = BTreeSet::new();
        classify(Path::new("/repo/.git/modules/lib/HEAD"), wt, gd, &Gitignore::empty(), &mut out);
        assert!(out.contains(&ChangeDomain::Submodules), "got {out:?}");
        assert!(out.contains(&ChangeDomain::Status), "pointer move shows in status too");
        assert!(out.contains(&ChangeDomain::Diff), "gitlink change shows in an open diff");
    }

    #[test]
    fn submodule_gitdir_refs_hit_submodules_even_for_slashed_names() {
        // Submodule names default to their path and may contain slashes:
        // `.git/modules/vendor/lib/refs/heads/main`.
        let wt = Path::new("/repo");
        let gd = Path::new("/repo/.git");
        let mut out = BTreeSet::new();
        classify(
            Path::new("/repo/.git/modules/vendor/lib/refs/heads/main"),
            wt, gd, &Gitignore::empty(), &mut out,
        );
        assert!(out.contains(&ChangeDomain::Submodules), "got {out:?}");
    }

    #[test]
    fn submodule_gitdir_objects_and_locks_stay_quiet() {
        let wt = Path::new("/repo");
        let gd = Path::new("/repo/.git");
        for noisy in [
            "/repo/.git/modules/lib/objects/aa/bbcc",
            "/repo/.git/modules/lib/index.lock",
            "/repo/.git/modules/lib/logs/HEAD",
            "/repo/.git/modules/lib/FETCH_HEAD",
        ] {
            let mut out = BTreeSet::new();
            classify(Path::new(noisy), wt, gd, &Gitignore::empty(), &mut out);
            assert!(out.is_empty(), "{noisy} classified as {out:?}");
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
        assert!(out.contains(&ChangeDomain::Diff), "rebase steps rewrite worktree/index content");
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
