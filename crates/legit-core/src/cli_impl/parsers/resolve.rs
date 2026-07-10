//! Parsers backing the "reopen a resolved conflict" flow.
//!
//! `git ls-files --resolve-undo -z` lists the index's resolve-undo (REUC)
//! records - the paths whose merge conflicts were resolved and staged during
//! the in-progress operation (the record persists until the merge commit).
//! Format matches `ls-files -u`: `<mode> <sha> <stage>\t<path>`, one record
//! per recorded stage, NUL-terminated.
//!
//! `git diff --cached --check` reports staged content problems, one per line:
//! `<path>:<line>: <message>`. It exits 2 when it found any - an outcome, not
//! a failure. Only `leftover conflict marker` messages are kept (it also
//! reports whitespace errors), and only changed lines are checked, so
//! marker-like content in untouched parts of a file never flags.
//! The args live next to the parsers so each contract is in one place.

use crate::error::GitError;
use std::collections::BTreeSet;

pub const LS_FILES_RESOLVE_UNDO_ARGS: [&str; 3] = ["ls-files", "--resolve-undo", "-z"];
pub const DIFF_CACHED_CHECK_ARGS: [&str; 3] = ["diff", "--cached", "--check"];
/// Worktree-side variant: flags markers in modified-but-unstaged content
/// (e.g. a staged resolution that was unstaged again).
pub const DIFF_CHECK_ARGS: [&str; 2] = ["diff", "--check"];

const MARKER_MESSAGE: &str = "leftover conflict marker";

/// Parse `git ls-files --resolve-undo -z` output into the unique set of
/// paths with a resolve-undo record (sorted for determinism).
pub fn parse_resolve_undo(stdout: &str) -> Result<Vec<String>, GitError> {
    let mut paths = BTreeSet::new();
    for record in stdout.split('\0').filter(|r| !r.is_empty()) {
        let (_meta, path) = record.split_once('\t').ok_or_else(|| {
            GitError::Parse(format!("ls-files --resolve-undo record without tab: {record:?}"))
        })?;
        paths.insert(path.to_string());
    }
    Ok(paths.into_iter().collect())
}

/// Parse `git diff --cached --check` output into the unique paths flagged
/// with a leftover conflict marker, in first-seen order. Whitespace-error
/// lines (the command's other finding kind) are ignored.
pub fn parse_leftover_markers(stdout: &str) -> Vec<String> {
    let mut seen = BTreeSet::new();
    let mut paths = Vec::new();
    for line in stdout.lines() {
        // `<path>:<line>: leftover conflict marker` - split off the message,
        // then the line number from the right, so paths containing ':' stay
        // intact.
        let Some(loc) = line.strip_suffix(MARKER_MESSAGE).and_then(|l| l.strip_suffix(": "))
        else {
            continue;
        };
        let Some((path, lineno)) = loc.rsplit_once(':') else { continue };
        if lineno.parse::<u32>().is_err() {
            continue;
        }
        if seen.insert(path.to_string()) {
            paths.push(path.to_string());
        }
    }
    paths
}

#[cfg(test)]
mod tests {
    use super::*;

    const SHA: &str = "0123456789abcdef0123456789abcdef01234567";

    #[test]
    fn resolve_undo_empty_is_no_paths() {
        assert_eq!(parse_resolve_undo("").unwrap(), Vec::<String>::new());
    }

    #[test]
    fn resolve_undo_dedupes_stage_records_per_path() {
        let s = format!(
            "100644 {SHA} 1\ta.txt\0100644 {SHA} 2\ta.txt\0100644 {SHA} 3\ta.txt\0100644 {SHA} 2\tdir/with space.txt\0"
        );
        assert_eq!(
            parse_resolve_undo(&s).unwrap(),
            vec!["a.txt".to_string(), "dir/with space.txt".to_string()]
        );
    }

    #[test]
    fn resolve_undo_record_without_tab_is_parse_error() {
        assert!(parse_resolve_undo("garbage\0").is_err());
    }

    #[test]
    fn markers_empty_output_is_no_paths() {
        assert_eq!(parse_leftover_markers(""), Vec::<String>::new());
    }

    #[test]
    fn markers_dedupes_and_keeps_first_seen_order() {
        let out = "b.txt:1: leftover conflict marker\n\
                   b.txt:3: leftover conflict marker\n\
                   a.txt:7: leftover conflict marker\n";
        assert_eq!(parse_leftover_markers(out), vec!["b.txt", "a.txt"]);
    }

    #[test]
    fn markers_ignores_whitespace_error_lines() {
        let out = "a.txt:2: trailing whitespace.\n\
                   a.txt:4: leftover conflict marker\n\
                   c.txt:9: new blank line at EOF.\n";
        assert_eq!(parse_leftover_markers(out), vec!["a.txt"]);
    }

    #[test]
    fn markers_path_containing_colon_stays_intact() {
        let out = "dir/a:b.txt:12: leftover conflict marker\n";
        assert_eq!(parse_leftover_markers(out), vec!["dir/a:b.txt"]);
    }

    #[test]
    fn markers_message_as_filename_content_not_confused() {
        // A finding line must end with the exact message and carry a numeric
        // line - anything else (e.g. diff noise) is skipped, never a panic.
        let out = "not a finding line\nx.txt:notanumber: leftover conflict marker\n";
        assert_eq!(parse_leftover_markers(out), Vec::<String>::new());
    }
}
