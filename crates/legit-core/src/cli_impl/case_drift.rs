//! Case-only rename drift: detection and the staged-rename fix.
//!
//! On a case-insensitive filesystem a rename that changes only letter case
//! (`test.c` -> `Test.c`) is invisible to `git status`: the index path still
//! resolves to the file, so the tree reads as clean. Detection therefore
//! compares the index (`git ls-files`) against actual directory-listing case
//! via the session's `RepoFs` (host-correct for remote repos), and the fix
//! stages the rename with `git mv` - which also normalizes the on-disk case.
//!
//! The `GitBackend` trait impl in `mod.rs` delegates to the same-named
//! inherent methods here (a trait impl cannot span files).

use std::collections::HashMap;

use crate::error::GitError;
use crate::executor::GitExecutor;
use crate::types::CaseDriftEntry;

use super::GitCliBackend;

impl<E: GitExecutor + ?Sized> GitCliBackend<E> {
    /// Tracked paths whose on-disk case differs from the index. Empty on a
    /// case-sensitive filesystem (`core.ignorecase` unset/false): the drift
    /// state cannot exist there, and the scan would pay a directory listing
    /// per tracked directory for nothing.
    pub(super) async fn case_drift(&self) -> Result<Vec<CaseDriftEntry>, GitError> {
        let runner = self.runner().await;
        let ignorecase = runner
            .run_expecting(&["config", "--type=bool", "--get", "core.ignorecase"], &[1])
            .await?;
        if !(ignorecase.success && ignorecase.stdout.trim() == "true") {
            return Ok(Vec::new());
        }

        let top = runner.run(&["rev-parse", "--show-toplevel"]).await?;
        Self::ensure_success(&top)?;
        let ls = runner.run(&["ls-files", "-z"]).await?;
        Self::ensure_success(&ls)?;
        drop(runner);
        let tracked: Vec<String> = ls
            .stdout
            .split('\0')
            .filter(|p| !p.is_empty())
            .map(str::to_string)
            .collect();

        // Textual '/' joins throughout: the toplevel is a host path (posix on
        // a remote host), never native-join material for the app OS.
        let root = crate::fs::HostPath(top.stdout.trim().to_string());
        let mut listings: HashMap<String, Vec<String>> = HashMap::new();
        for dir in tracked_dirs(&tracked) {
            let host_dir = if dir.is_empty() { root.clone() } else { root.join(&dir) };
            // Best-effort: a directory that vanished mid-scan (or is
            // unreadable) simply contributes no listing; detection skips
            // paths it cannot judge rather than failing the whole scan.
            if let Ok(entries) = self.fs.read_dir(&host_dir).await {
                listings.insert(dir, entries.into_iter().map(|e| e.name).collect());
            }
        }

        Ok(detect_case_drift(&tracked, &listings))
    }

    /// Stage a case-only rename (`git mv`), normalizing the on-disk case at
    /// the same time. Only accepts a pair that differs by case alone.
    pub(super) async fn stage_case_rename(&self, from: &str, to: &str) -> Result<(), GitError> {
        validate_case_pair(from, to)?;
        match self.run_simple(&["mv", "--", from, to]).await {
            Ok(()) => Ok(()),
            // Some git/filesystem combinations refuse the direct case-only
            // move ("destination exists"); go through a temp name.
            Err(direct) => {
                let tmp = format!("{to}.legit-casefix-tmp");
                if self.run_simple(&["mv", "--", from, &tmp]).await.is_err() {
                    return Err(direct);
                }
                match self.run_simple(&["mv", "--", &tmp, to]).await {
                    Ok(()) => Ok(()),
                    Err(second) => {
                        // The file must not stay parked under the temp name;
                        // a failed restore must not be silent (house rule).
                        match self.run_simple(&["mv", "--", &tmp, from]).await {
                            Ok(()) => Err(second),
                            Err(_) => Err(super::append_error_note(
                                second,
                                &format!("note: the file is left renamed to '{tmp}'"),
                            )),
                        }
                    }
                }
            }
        }
    }

    /// Discard detected case drift: rename the disk file back to the tracked
    /// spelling, leaving the index untouched. A direct `git mv <disk>
    /// <index>` refuses ("not under version control": the source must be the
    /// INDEX spelling), so this round-trips index-spelling -> temp ->
    /// index-spelling; step one finds the drifted disk file
    /// case-insensitively, and step two restores the index entry it staged.
    pub(super) async fn discard_case_rename(
        &self,
        index_path: &str,
        disk_path: &str,
    ) -> Result<(), GitError> {
        validate_case_pair(index_path, disk_path)?;
        let tmp = format!("{index_path}.legit-casefix-tmp");
        self.run_simple(&["mv", "--", index_path, &tmp]).await?;
        match self.run_simple(&["mv", "--", &tmp, index_path]).await {
            Ok(()) => Ok(()),
            // Half-done: the file sits at the temp name with a staged rename.
            // A failed recovery step must not be silent (house rule).
            Err(second) => Err(super::append_error_note(
                second,
                &format!("note: the file is left renamed to '{tmp}' with the rename staged"),
            )),
        }
    }
}

/// Validate a case-rename pair: relative paths of normal components only
/// (the `submodule_move` worktree-escape rule) that differ by case alone.
fn validate_case_pair(a: &str, b: &str) -> Result<(), GitError> {
    for p in [a, b] {
        let path = std::path::Path::new(p);
        if p.is_empty()
            || path.is_absolute()
            || path
                .components()
                .any(|c| !matches!(c, std::path::Component::Normal(_)))
        {
            return Err(GitError::Internal(format!("invalid path '{p}'")));
        }
    }
    if a == b || fold(a) != fold(b) {
        return Err(GitError::Internal(format!(
            "'{a}' -> '{b}' is not a case-only rename"
        )));
    }
    Ok(())
}

/// Every directory the tracked paths touch, as index-cased repo-relative
/// paths ("" = the repo root), deduplicated.
fn tracked_dirs(tracked: &[String]) -> Vec<String> {
    let mut dirs: Vec<String> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for path in tracked {
        let mut end = 0usize;
        if seen.insert(String::new()) {
            dirs.push(String::new());
        }
        while let Some(pos) = path[end..].find('/') {
            end += pos;
            let dir = &path[..end];
            if seen.insert(dir.to_string()) {
                dirs.push(dir.to_string());
            }
            end += 1;
        }
    }
    dirs
}

/// Compare tracked index paths against on-disk directory listings and report
/// case-only drift. `listings` maps an index-cased directory ("" = repo
/// root) to the names actually on disk in it. Nested drift is collapsed to
/// the shallowest drifting component: a drifted directory is reported once
/// (`is_dir`) and everything under it is skipped - fixing the directory
/// re-exposes any deeper drift on the next scan. Paths that cannot be judged
/// (no listing, or no case-insensitive match: a deleted file) report
/// nothing. Results are sorted by `index_path`.
fn detect_case_drift(
    tracked: &[String],
    listings: &HashMap<String, Vec<String>>,
) -> Vec<CaseDriftEntry> {
    let mut out: Vec<CaseDriftEntry> = Vec::new();
    // Index-cased prefixes of directories already reported as drifted -
    // everything under them is collapsed into that report.
    let mut reported_dirs: Vec<String> = Vec::new();

    'paths: for path in tracked {
        if reported_dirs.iter().any(|d| is_under(path, d)) {
            continue;
        }
        let mut index_dir = String::new();
        let mut disk_parent = String::new();
        let component_count = path.split('/').count();
        for (i, comp) in path.split('/').enumerate() {
            let Some(listing) = listings.get(&index_dir) else {
                continue 'paths;
            };
            if listing.iter().any(|n| n == comp) {
                // Exact case on disk: descend.
                push_component(&mut disk_parent, comp);
                push_component(&mut index_dir, comp);
                continue;
            }
            let Some(actual) = listing.iter().find(|n| fold(n) == fold(comp)) else {
                // No case-insensitive match either: the path is gone from
                // disk - status territory (Deleted), not case drift.
                continue 'paths;
            };
            let is_dir = i + 1 < component_count;
            let index_prefix = {
                let mut p = index_dir.clone();
                push_component(&mut p, comp);
                p
            };
            let disk_path = {
                let mut p = disk_parent.clone();
                push_component(&mut p, actual);
                p
            };
            out.push(CaseDriftEntry {
                index_path: index_prefix.clone(),
                disk_path,
                is_dir,
            });
            if is_dir {
                reported_dirs.push(index_prefix);
            }
            continue 'paths;
        }
    }
    out.sort_by(|a, b| a.index_path.cmp(&b.index_path));
    out
}

/// Whether `path` lies strictly under directory `dir` (index-cased paths).
fn is_under(path: &str, dir: &str) -> bool {
    path.len() > dir.len() && path.starts_with(dir) && path.as_bytes()[dir.len()] == b'/'
}

fn push_component(base: &mut String, comp: &str) {
    if !base.is_empty() {
        base.push('/');
    }
    base.push_str(comp);
}

/// Case-folding for the drift comparison. `char::to_lowercase` covers the
/// simple one-to-one mappings, which is what filesystem case-insensitivity
/// means in practice for the names git stores.
fn fold(s: &str) -> String {
    s.chars().flat_map(char::to_lowercase).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn listings(entries: &[(&str, &[&str])]) -> HashMap<String, Vec<String>> {
        entries
            .iter()
            .map(|(dir, names)| {
                (dir.to_string(), names.iter().map(|n| n.to_string()).collect())
            })
            .collect()
    }

    fn tracked(paths: &[&str]) -> Vec<String> {
        paths.iter().map(|p| p.to_string()).collect()
    }

    fn entry(index_path: &str, disk_path: &str, is_dir: bool) -> CaseDriftEntry {
        CaseDriftEntry {
            index_path: index_path.to_string(),
            disk_path: disk_path.to_string(),
            is_dir,
        }
    }

    #[test]
    fn clean_tree_reports_nothing() {
        let t = tracked(&["test.c", "src/main.rs"]);
        let l = listings(&[("", &["test.c", "src"]), ("src", &["main.rs"])]);
        assert_eq!(detect_case_drift(&t, &l), Vec::new());
    }

    #[test]
    fn file_case_drift_is_reported() {
        // The user's original bug: tracked test.c, renamed on disk to Test.c.
        let t = tracked(&["test.c"]);
        let l = listings(&[("", &["Test.c"])]);
        assert_eq!(detect_case_drift(&t, &l), vec![entry("test.c", "Test.c", false)]);
    }

    #[test]
    fn file_drift_inside_a_healthy_directory_keeps_the_directory_case() {
        let t = tracked(&["src/test.c"]);
        let l = listings(&[("", &["src"]), ("src", &["Test.c"])]);
        assert_eq!(
            detect_case_drift(&t, &l),
            vec![entry("src/test.c", "src/Test.c", false)]
        );
    }

    #[test]
    fn directory_drift_is_reported_once_as_a_directory() {
        // Renaming src -> Src drifts every tracked path under it; the report
        // collapses to the directory so one `git mv` fixes all of them.
        let t = tracked(&["src/a.c", "src/b.c"]);
        let l = listings(&[("", &["Src"]), ("src", &["a.c", "b.c"])]);
        assert_eq!(detect_case_drift(&t, &l), vec![entry("src", "Src", true)]);
    }

    #[test]
    fn drift_below_a_drifted_directory_is_not_reported_separately() {
        // Both the directory and a file inside drifted: only the shallowest
        // component is actionable now (fixing it re-exposes the rest).
        let t = tracked(&["src/a.c"]);
        let l = listings(&[("", &["Src"]), ("src", &["A.c"])]);
        assert_eq!(detect_case_drift(&t, &l), vec![entry("src", "Src", true)]);
    }

    #[test]
    fn deleted_file_reports_nothing() {
        // No case-insensitive match at all = the file is gone; that is
        // `git status` territory (Deleted), not case drift.
        let t = tracked(&["test.c"]);
        let l = listings(&[("", &["other.c"])]);
        assert_eq!(detect_case_drift(&t, &l), Vec::new());
    }

    #[test]
    fn missing_listing_reports_nothing() {
        // A directory that could not be listed cannot be judged.
        let t = tracked(&["src/test.c"]);
        let l = listings(&[("", &["src"])]);
        assert_eq!(detect_case_drift(&t, &l), Vec::new());
    }

    #[test]
    fn exact_match_wins_over_a_case_variant() {
        // Pathological listing with both spellings (case-sensitive disk):
        // the exact match means no drift.
        let t = tracked(&["test.c"]);
        let l = listings(&[("", &["test.c", "Test.c"])]);
        assert_eq!(detect_case_drift(&t, &l), Vec::new());
    }

    #[test]
    fn results_are_sorted_by_index_path() {
        let t = tracked(&["b.c", "a.c"]);
        let l = listings(&[("", &["B.c", "A.c"])]);
        assert_eq!(
            detect_case_drift(&t, &l),
            vec![entry("a.c", "A.c", false), entry("b.c", "B.c", false)]
        );
    }

    #[test]
    fn non_ascii_case_drift_is_detected() {
        let t = tracked(&["übung.txt"]);
        let l = listings(&[("", &["Übung.txt"])]);
        assert_eq!(
            detect_case_drift(&t, &l),
            vec![entry("übung.txt", "Übung.txt", false)]
        );
    }

    #[test]
    fn tracked_dirs_collects_unique_prefixes() {
        let t = tracked(&["a.c", "src/b.c", "src/deep/c.c"]);
        let mut dirs = tracked_dirs(&t);
        dirs.sort();
        assert_eq!(dirs, vec!["".to_string(), "src".to_string(), "src/deep".to_string()]);
    }
}
