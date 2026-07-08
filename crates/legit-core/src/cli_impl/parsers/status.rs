//! Parser for `git status --porcelain=v2 -z` output backing `status()`.
//!
//! The format flags live here next to the parser so the contract is visible in
//! one place (DESIGN-v0.3.md §4.5). `--porcelain=v2` gives one tagged record
//! per change (`1` ordinary, `2` rename/copy, `u` unmerged, `?` untracked,
//! `!` ignored); `-z` makes records NUL-separated and disables path quoting,
//! so paths with spaces/unicode pass through verbatim. v2 (git 2.11+, stable)
//! is required because only its `S<c><m><u>` sub-field distinguishes a moved
//! submodule pointer from a dirty submodule worktree - porcelain v1 reports
//! both as ` M` (spec: 2026-07-08 submodules architecture, sub-project 1).
//! The sub-field and mode fields are skipped positionally for now and get
//! surfaced in sub-project 2.
//!
//! Line counts are not part of porcelain status: they come from two extra
//! `git diff --numstat -z` runs (index and working tree) whose parsed maps are
//! merged into the entries by `apply_numstat`.

use super::commit_files::NumStat;
use crate::types::{FileState, FileStatus};
use std::collections::HashMap;

/// Arguments for the status command, in order. `-z` is required for the NUL
/// framing this parser assumes. `--untracked-files=all` lists each untracked
/// file individually; without it git collapses an entirely-untracked directory
/// into a single `dir/` entry, which the UI can't stage/diff per file.
pub const STATUS_ARGS: [&str; 4] =
    ["status", "--porcelain=v2", "-z", "--untracked-files=all"];

/// Line counts for unstaged entries: working tree vs index. `-M` matches the
/// rename detection porcelain status performs, so a renamed entry's counts are
/// keyed by the same (destination) path the status record reports.
pub const NUMSTAT_UNSTAGED_ARGS: [&str; 4] = ["diff", "--numstat", "-M", "-z"];

/// Line counts for staged entries: index vs HEAD.
pub const NUMSTAT_STAGED_ARGS: [&str; 5] = ["diff", "--numstat", "-M", "-z", "--cached"];

/// Parse the stdout of `git status --porcelain=v2 -z`.
///
/// Record tags: `1` ordinary change, `2` rename/copy (the original path is
/// the next NUL field - consumed and ignored, we report the new path only),
/// `u` unmerged, `?` untracked, `!` ignored. In `<XY>`, `X` is the index
/// (staged) column and `Y` the working-tree column, `.` meaning unmodified -
/// a path both staged and re-modified produces two entries, exactly like the
/// old v1 parser. `#` headers appear only with `--branch`/`--show-stash`
/// (never passed); unknown tags are skipped.
pub fn parse_status(output: &str) -> Vec<FileStatus> {
    let mut result = Vec::new();
    let mut tokens = output.split('\0');

    while let Some(record) = tokens.next() {
        // The trailing `-z` separator produces a final empty token.
        let Some(&tag) = record.as_bytes().first() else {
            continue;
        };
        match tag {
            // `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>`
            b'1' => {
                let mut fields = record.splitn(9, ' ');
                let (Some(xy), Some(sub)) = (fields.nth(1), fields.next()) else {
                    continue;
                };
                let Some(path) = fields.nth(5) else { continue };
                if sub.starts_with('S') {
                    push_submodule_columns(xy, sub, path, &mut result);
                } else {
                    push_columns(xy, path, &mut result);
                }
            }
            // `2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>` +
            // the original path as the next NUL field - consume it.
            b'2' => {
                tokens.next();
                let mut fields = record.splitn(10, ' ');
                if let (Some(xy), Some(path)) = (fields.nth(1), fields.nth(7)) {
                    push_columns(xy, path, &mut result);
                }
            }
            // `u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>` -
            // reported once, not split into staged/unstaged (v1's `AA`/`DD`/
            // `*U` forms all arrive as `u` records here).
            b'u' => {
                if let Some(path) = record.splitn(11, ' ').nth(10) {
                    result.push(FileStatus::new(path, FileState::Conflicted, false));
                }
            }
            // Untracked / ignored: single entry, never staged.
            b'?' => {
                if let Some(path) = record.strip_prefix("? ") {
                    result.push(FileStatus::new(path, FileState::Untracked, false));
                }
            }
            b'!' => {
                if let Some(path) = record.strip_prefix("! ") {
                    result.push(FileStatus::new(path, FileState::Ignored, false));
                }
            }
            _ => {}
        }
    }

    result
}

/// Emit the staged (index column) and/or working-tree entry for one record.
/// `.` means "unmodified on this side" in v2, replacing v1's space.
fn push_columns(xy: &str, path: &str, out: &mut Vec<FileStatus>) {
    let mut chars = xy.chars();
    let (Some(x), Some(y)) = (chars.next(), chars.next()) else {
        return;
    };
    if x != '.' {
        out.push(FileStatus::new(path, map_code(x), true));
    }
    if y != '.' {
        out.push(FileStatus::new(path, map_code(y), false));
    }
}

/// Emit entries for a submodule record (`S<c><m><u>` sub field). The staged
/// column stages the gitlink pointer, so staged `M`/`T` becomes
/// `SubmoduleChanged` (add/delete read better as `Added`/`Deleted`). The
/// worktree `M` covers both pointer moves and dirty contents; only a real
/// pointer move (`c` flag) yields an entry - dirty-only submodules surface
/// as a Refs-panel badge, not a pseudo file change.
fn push_submodule_columns(xy: &str, sub: &str, path: &str, out: &mut Vec<FileStatus>) {
    let mut chars = xy.chars();
    let (Some(x), Some(y)) = (chars.next(), chars.next()) else {
        return;
    };
    let pointer_moved = sub.as_bytes().get(1) == Some(&b'C');
    if x != '.' {
        let state = match x {
            'A' => FileState::Added,
            'D' => FileState::Deleted,
            _ => FileState::SubmoduleChanged,
        };
        out.push(FileStatus::new(path, state, true));
    }
    match y {
        '.' => {}
        'D' => out.push(FileStatus::new(path, FileState::Deleted, false)),
        _ if pointer_moved => {
            out.push(FileStatus::new(path, FileState::SubmoduleChanged, false));
        }
        _ => {} // dirty-only
    }
}

/// Whether an entry can carry line counts from the numstat streams. Untracked
/// and ignored paths never appear in `git diff`; conflicted paths show up in
/// unmerged form without usable counts; gitlinks have no meaningful line
/// counts. Their counts stay `None` — "no data", not a misleading `0/0`.
pub fn wants_counts(status: &FileStatus) -> bool {
    !matches!(
        status.state,
        FileState::Untracked
            | FileState::Ignored
            | FileState::Conflicted
            | FileState::SubmoduleChanged
    )
}

/// Merge the parsed numstat maps into the status entries: staged entries read
/// from the index-vs-HEAD map, unstaged ones from the worktree-vs-index map.
/// Entries git reported no counts for keep `None` (see `wants_counts`).
pub(crate) fn apply_numstat(
    statuses: &mut [FileStatus],
    staged: &HashMap<String, NumStat>,
    unstaged: &HashMap<String, NumStat>,
) {
    for st in statuses.iter_mut() {
        if !wants_counts(st) {
            continue;
        }
        let counts = if st.staged { staged } else { unstaged };
        let Some(n) = counts.get(st.path.to_string_lossy().as_ref()) else {
            continue;
        };
        if n.binary {
            st.binary = true;
        } else {
            st.additions = Some(n.additions);
            st.deletions = Some(n.deletions);
        }
    }
}

/// Map a single porcelain status code to a `FileState`. `T` (typechange) folds
/// into `Modified`; anything unexpected also falls back to `Modified`.
fn map_code(code: char) -> FileState {
    match code {
        'A' => FileState::Added,
        'D' => FileState::Deleted,
        'R' => FileState::Renamed,
        'C' => FileState::Copied,
        'M' | 'T' => FileState::Modified,
        _ => FileState::Modified,
    }
}

#[cfg(test)]
mod tests {
    use super::super::commit_files::parse_numstat;
    use super::*;

    /// Join porcelain records into a single `-z` stream (trailing NUL included).
    fn stream(records: &[&str]) -> String {
        let mut s = records.join("\0");
        s.push('\0');
        s
    }

    /// Build a v2 ordinary (`1`) record. Only `<XY>` and `<path>` matter to
    /// the parser; the sub/mode/hash fields are positional filler it skips.
    fn ord(xy: &str, path: &str) -> String {
        format!("1 {xy} N... 100644 100644 100644 aaaaaaa bbbbbbb {path}")
    }

    /// Ordinary record for a submodule entry: `S<c><m><u>` sub field and
    /// gitlink (160000) modes.
    fn ord_sub(xy: &str, sub: &str, path: &str) -> String {
        format!("1 {xy} {sub} 160000 160000 160000 aaaaaaa bbbbbbb {path}")
    }

    /// Build a v2 rename/copy (`2`) record. The original path travels as the
    /// next NUL field, so callers pass it as a separate `stream` element.
    fn ren(xy: &str, score: &str, path: &str) -> String {
        format!("2 {xy} N... 100644 100644 100644 aaaaaaa bbbbbbb {score} {path}")
    }

    /// Build a v2 unmerged (`u`) record.
    fn unm(xy: &str, path: &str) -> String {
        format!("u {xy} N... 100644 100644 100644 100644 a1 a2 a3 {path}")
    }

    /// Shorthand for the expected parser output (counts always empty there).
    fn fs(path: &str, state: FileState, staged: bool) -> FileStatus {
        FileStatus::new(path, state, staged)
    }

    #[test]
    fn parses_working_tree_modification() {
        let out = stream(&[&ord(".M", "src/main.rs")]);
        assert_eq!(
            parse_status(&out),
            vec![fs("src/main.rs", FileState::Modified, false)]
        );
    }

    #[test]
    fn parses_staged_addition() {
        let out = stream(&[&ord("A.", "new.txt")]);
        assert_eq!(parse_status(&out), vec![fs("new.txt", FileState::Added, true)]);
    }

    #[test]
    fn splits_staged_and_restaged_modification() {
        // Staged modification then further modified in the working tree.
        let out = stream(&[&ord("MM", "file.rs")]);
        assert_eq!(
            parse_status(&out),
            vec![
                fs("file.rs", FileState::Modified, true),
                fs("file.rs", FileState::Modified, false),
            ]
        );
    }

    #[test]
    fn parses_untracked() {
        let out = stream(&["? scratch.tmp"]);
        assert_eq!(
            parse_status(&out),
            vec![fs("scratch.tmp", FileState::Untracked, false)]
        );
    }

    #[test]
    fn parses_ignored() {
        let out = stream(&["! target/debug"]);
        assert_eq!(
            parse_status(&out),
            vec![fs("target/debug", FileState::Ignored, false)]
        );
    }

    #[test]
    fn parses_rename_and_consumes_original_path() {
        // `2 ... new.rs\0old.rs\0` - the original path is a separate field.
        let out = stream(&[&ren("R.", "R100", "new.rs"), "old.rs"]);
        assert_eq!(parse_status(&out), vec![fs("new.rs", FileState::Renamed, true)]);
    }

    #[test]
    fn parses_worktree_rename() {
        let out = stream(&[&ren(".R", "R100", "new.rs"), "old.rs"]);
        assert_eq!(parse_status(&out), vec![fs("new.rs", FileState::Renamed, false)]);
    }

    #[test]
    fn parses_conflict() {
        let out = stream(&[&unm("UU", "merged.rs")]);
        assert_eq!(
            parse_status(&out),
            vec![fs("merged.rs", FileState::Conflicted, false)]
        );
    }

    #[test]
    fn parses_both_sides_conflict_forms() {
        // v1 special-cased `AA`/`DD`; v2 delivers them as `u` records too.
        let out = stream(&[&unm("AA", "both-added.rs"), &unm("DD", "both-deleted.rs")]);
        assert_eq!(
            parse_status(&out),
            vec![
                fs("both-added.rs", FileState::Conflicted, false),
                fs("both-deleted.rs", FileState::Conflicted, false),
            ]
        );
    }

    #[test]
    fn parses_path_with_spaces() {
        let out = stream(&[&ord(".M", "dir with spaces/a b.txt")]);
        assert_eq!(
            parse_status(&out),
            vec![fs("dir with spaces/a b.txt", FileState::Modified, false)]
        );
    }

    #[test]
    fn typechange_folds_to_modified() {
        let out = stream(&[&ord(".T", "link.rs")]);
        assert_eq!(parse_status(&out), vec![fs("link.rs", FileState::Modified, false)]);
    }

    #[test]
    fn submodule_pointer_moves_become_submodule_changed() {
        let out = stream(&[
            // Staged pointer move: the sub field describes the worktree side,
            // so a staged-only move reads `M.` with `S...`.
            &ord_sub("M.", "S...", "vendor/staged-bump"),
            // Worktree pointer move: the `c` flag.
            &ord_sub(".M", "SC..", "vendor/moved"),
            // Staged move + worktree moved again on top.
            &ord_sub("MM", "SC..", "vendor/both"),
        ]);
        assert_eq!(
            parse_status(&out),
            vec![
                fs("vendor/staged-bump", FileState::SubmoduleChanged, true),
                fs("vendor/moved", FileState::SubmoduleChanged, false),
                fs("vendor/both", FileState::SubmoduleChanged, true),
                fs("vendor/both", FileState::SubmoduleChanged, false),
            ]
        );
    }

    #[test]
    fn dirty_only_submodules_produce_no_entry() {
        // Dirty contents are not a committable superproject change: they show
        // as a badge on the Refs-panel submodule row, never as a pseudo file
        // modification (spec 2026-07-08, sub-project 2).
        let out = stream(&[
            &ord_sub(".M", "S.M.", "vendor/dirty"),
            &ord_sub(".M", "S..U", "vendor/untracked"),
            &ord_sub(".M", "S.MU", "vendor/both-dirty"),
        ]);
        assert_eq!(parse_status(&out), vec![]);
    }

    #[test]
    fn submodule_add_and_delete_keep_their_states() {
        let out = stream(&[
            &ord_sub("A.", "S...", "vendor/new"),
            &ord_sub("D.", "S...", "vendor/gone-index"),
            &ord_sub(".D", "S...", "vendor/gone-tree"),
        ]);
        assert_eq!(
            parse_status(&out),
            vec![
                fs("vendor/new", FileState::Added, true),
                fs("vendor/gone-index", FileState::Deleted, true),
                fs("vendor/gone-tree", FileState::Deleted, false),
            ]
        );
    }

    #[test]
    fn submodule_changed_wants_no_counts() {
        assert!(!wants_counts(&fs("vendor/lib", FileState::SubmoduleChanged, true)));
    }

    #[test]
    fn skips_unknown_record_tags() {
        // `#` headers only appear with --branch/--show-stash (never passed);
        // anything unrecognized must be skipped, not crash or mis-parse.
        let out = stream(&["# branch.oid deadbeef", &ord(".M", "a.txt")]);
        assert_eq!(parse_status(&out), vec![fs("a.txt", FileState::Modified, false)]);
    }

    #[test]
    fn empty_input_yields_no_changes() {
        assert_eq!(parse_status(""), vec![]);
        assert_eq!(parse_status("\0"), vec![]);
    }

    #[test]
    fn parses_multiple_records() {
        let out = stream(&[&ord("A.", "added.rs"), &ord(".D", "removed.rs"), "? untracked.rs"]);
        let parsed = parse_status(&out);
        assert_eq!(parsed.len(), 3);
        assert_eq!(parsed[0].state, FileState::Added);
        assert!(parsed[0].staged);
        assert_eq!(parsed[1].state, FileState::Deleted);
        assert!(!parsed[1].staged);
        assert_eq!(parsed[2].state, FileState::Untracked);
    }

    // -- apply_numstat -------------------------------------------------------

    #[test]
    fn merges_staged_and_unstaged_counts_separately() {
        // Same path staged and re-modified: each side gets its own diff's counts.
        let mut statuses = parse_status(&stream(&[&ord("MM", "file.rs")]));
        let staged = parse_numstat(&stream(&["3\t1\tfile.rs"]));
        let unstaged = parse_numstat(&stream(&["2\t0\tfile.rs"]));
        apply_numstat(&mut statuses, &staged, &unstaged);

        assert!(statuses[0].staged);
        assert_eq!((statuses[0].additions, statuses[0].deletions), (Some(3), Some(1)));
        assert!(!statuses[1].staged);
        assert_eq!((statuses[1].additions, statuses[1].deletions), (Some(2), Some(0)));
    }

    #[test]
    fn untracked_and_conflicted_keep_no_counts() {
        let mut statuses = parse_status(&stream(&["? new.txt", &unm("UU", "merged.rs")]));
        // Even if a numstat stream mentioned the paths, they must stay None.
        let counts = parse_numstat(&stream(&["9\t9\tnew.txt", "9\t9\tmerged.rs"]));
        apply_numstat(&mut statuses, &counts, &counts);

        for st in &statuses {
            assert_eq!(st.additions, None);
            assert_eq!(st.deletions, None);
            assert!(!st.binary);
        }
    }

    #[test]
    fn marks_binary_without_counts() {
        let mut statuses = parse_status(&stream(&[&ord(".M", "pic.bin")]));
        let unstaged = parse_numstat(&stream(&["-\t-\tpic.bin"]));
        apply_numstat(&mut statuses, &HashMap::new(), &unstaged);

        assert!(statuses[0].binary);
        assert_eq!(statuses[0].additions, None);
        assert_eq!(statuses[0].deletions, None);
    }

    #[test]
    fn staged_rename_counts_key_by_destination_path() {
        // Porcelain reports the new path; `diff --numstat -M -z` keys the
        // rename record by the destination too, so they line up.
        let mut statuses = parse_status(&stream(&[&ren("R.", "R100", "new.rs"), "old.rs"]));
        let staged = parse_numstat(&stream(&["4\t2\t", "old.rs", "new.rs"]));
        apply_numstat(&mut statuses, &staged, &HashMap::new());

        assert_eq!((statuses[0].additions, statuses[0].deletions), (Some(4), Some(2)));
    }

    #[test]
    fn missing_numstat_entry_keeps_none() {
        let mut statuses = parse_status(&stream(&[&ord(".M", "file.rs")]));
        apply_numstat(&mut statuses, &HashMap::new(), &HashMap::new());
        assert_eq!(statuses[0].additions, None);
        assert_eq!(statuses[0].deletions, None);
    }
}
