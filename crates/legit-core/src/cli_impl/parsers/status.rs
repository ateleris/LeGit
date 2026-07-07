//! Parser for `git status --porcelain=v1 -z` output backing `status()`.
//!
//! The format flags live here next to the parser so the contract is visible in
//! one place (DESIGN-v0.3.md §4.5). `--porcelain=v1` gives a stable, two-column
//! `XY <path>` record per change; `-z` makes records NUL-separated and disables
//! path quoting, so paths with spaces/unicode pass through verbatim.
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
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"];

/// Line counts for unstaged entries: working tree vs index. `-M` matches the
/// rename detection porcelain status performs, so a renamed entry's counts are
/// keyed by the same (destination) path the status record reports.
pub const NUMSTAT_UNSTAGED_ARGS: [&str; 4] = ["diff", "--numstat", "-M", "-z"];

/// Line counts for staged entries: index vs HEAD.
pub const NUMSTAT_STAGED_ARGS: [&str; 5] = ["diff", "--numstat", "-M", "-z", "--cached"];

/// Parse the stdout of `git status --porcelain=v1 -z`.
///
/// Each record is `XY <path>` where `X` is the index (staged) column and `Y`
/// the working-tree column. A non-blank, non-untracked `X` yields a staged
/// `FileStatus`; a non-blank `Y` yields a working-tree one — so a path that is
/// both staged and then re-modified produces two entries. Untracked (`??`) maps
/// to a single `Untracked` entry, unmerged records (containing `U`, or the
/// `AA`/`DD` both-sides forms) to a single `Conflicted` entry.
///
/// Rename/copy records (`R`/`C`) are followed by a second NUL-terminated field
/// carrying the original path; it is consumed and ignored (we report the new
/// path only).
pub fn parse_status(output: &str) -> Vec<FileStatus> {
    let mut result = Vec::new();
    let mut tokens = output.split('\0');

    while let Some(entry) = tokens.next() {
        // The trailing `-z` separator produces a final empty token; blank
        // tokens are never valid records.
        if entry.len() < 3 {
            continue;
        }
        let bytes = entry.as_bytes();
        let x = bytes[0] as char;
        let y = bytes[1] as char;
        // Byte offset 3 is safe: X, Y and the separating space are all ASCII.
        let path = &entry[3..];

        // Rename/copy carries the original path as the next NUL field — consume it.
        if x == 'R' || x == 'C' || y == 'R' || y == 'C' {
            tokens.next();
        }

        // Unmerged (conflict) records: either column is `U`, or the both-sides
        // `AA`/`DD` forms. Reported once, not split into staged/unstaged.
        if x == 'U' || y == 'U' || (x == 'A' && y == 'A') || (x == 'D' && y == 'D') {
            result.push(FileStatus::new(path, FileState::Conflicted, false));
            continue;
        }

        // Untracked / ignored: single entry, never staged.
        if x == '?' {
            result.push(FileStatus::new(path, FileState::Untracked, false));
            continue;
        }
        if x == '!' {
            result.push(FileStatus::new(path, FileState::Ignored, false));
            continue;
        }

        // Staged change (index column).
        if x != ' ' {
            result.push(FileStatus::new(path, map_code(x), true));
        }
        // Working-tree change (worktree column).
        if y != ' ' {
            result.push(FileStatus::new(path, map_code(y), false));
        }
    }

    result
}

/// Whether an entry can carry line counts from the numstat streams. Untracked
/// and ignored paths never appear in `git diff`; conflicted paths show up in
/// unmerged form without usable counts. Their counts stay `None` — "no data",
/// not a misleading `0/0`.
pub fn wants_counts(status: &FileStatus) -> bool {
    !matches!(
        status.state,
        FileState::Untracked | FileState::Ignored | FileState::Conflicted
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

    /// Shorthand for the expected parser output (counts always empty there).
    fn fs(path: &str, state: FileState, staged: bool) -> FileStatus {
        FileStatus::new(path, state, staged)
    }

    #[test]
    fn parses_working_tree_modification() {
        let out = stream(&[" M src/main.rs"]);
        assert_eq!(
            parse_status(&out),
            vec![fs("src/main.rs", FileState::Modified, false)]
        );
    }

    #[test]
    fn parses_staged_addition() {
        let out = stream(&["A  new.txt"]);
        assert_eq!(parse_status(&out), vec![fs("new.txt", FileState::Added, true)]);
    }

    #[test]
    fn splits_staged_and_restaged_modification() {
        // Staged modification then further modified in the working tree.
        let out = stream(&["MM file.rs"]);
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
        let out = stream(&["?? scratch.tmp"]);
        assert_eq!(
            parse_status(&out),
            vec![fs("scratch.tmp", FileState::Untracked, false)]
        );
    }

    #[test]
    fn parses_rename_and_consumes_original_path() {
        // `R  new\0old\0` — the original path is a separate field.
        let out = stream(&["R  new.rs", "old.rs"]);
        assert_eq!(parse_status(&out), vec![fs("new.rs", FileState::Renamed, true)]);
    }

    #[test]
    fn parses_conflict() {
        let out = stream(&["UU merged.rs"]);
        assert_eq!(
            parse_status(&out),
            vec![fs("merged.rs", FileState::Conflicted, false)]
        );
    }

    #[test]
    fn parses_path_with_spaces() {
        let out = stream(&[" M dir with spaces/a b.txt"]);
        assert_eq!(
            parse_status(&out),
            vec![fs("dir with spaces/a b.txt", FileState::Modified, false)]
        );
    }

    #[test]
    fn empty_input_yields_no_changes() {
        assert_eq!(parse_status(""), vec![]);
        assert_eq!(parse_status("\0"), vec![]);
    }

    #[test]
    fn parses_multiple_records() {
        let out = stream(&["A  added.rs", " D removed.rs", "?? untracked.rs"]);
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
        let mut statuses = parse_status(&stream(&["MM file.rs"]));
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
        let mut statuses = parse_status(&stream(&["?? new.txt", "UU merged.rs"]));
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
        let mut statuses = parse_status(&stream(&[" M pic.bin"]));
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
        let mut statuses = parse_status(&stream(&["R  new.rs", "old.rs"]));
        let staged = parse_numstat(&stream(&["4\t2\t", "old.rs", "new.rs"]));
        apply_numstat(&mut statuses, &staged, &HashMap::new());

        assert_eq!((statuses[0].additions, statuses[0].deletions), (Some(4), Some(2)));
    }

    #[test]
    fn missing_numstat_entry_keeps_none() {
        let mut statuses = parse_status(&stream(&[" M file.rs"]));
        apply_numstat(&mut statuses, &HashMap::new(), &HashMap::new());
        assert_eq!(statuses[0].additions, None);
        assert_eq!(statuses[0].deletions, None);
    }
}
