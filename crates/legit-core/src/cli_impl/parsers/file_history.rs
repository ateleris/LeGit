//! Parser for a single file's history (`git log --follow --name-status`),
//! backing `file_history()`. The format constant lives here so the command
//! and the parser share one contract.
//!
//! Framing (verified against the real binary): each record STARTS with ASCII
//! RS (0x1E via `%x1e`), followed by the newline-separated fields, a blank
//! line, then the commit's `--name-status` line(s):
//!
//! ```text
//! \x1e<sha>\n<author>\n<unix ts>\n<subject>\n\nM\t<path>
//! \x1e<sha>\n...\n\nR100\t<old>\t<new>
//! ```
//!
//! The name-status line carries the file's path AS OF THAT COMMIT (the
//! rename commit shows `R<score>\t<old>\t<new>`; older commits show the old
//! name directly), so no cross-record path walking is needed. A record with
//! no name-status line (e.g. an unsimplified merge) inherits the nearest
//! newer path, falling back to the queried path.

use crate::error::ParseError;
use crate::types::{CommitId, FileHistoryEntry};

/// Format string to pass to `git log --format=`. RS FIRST (records are
/// prefixed, not terminated, so the trailing name-status lines stay inside
/// their record). Fields: sha, author name, author date (unix), subject.
pub const FILE_HISTORY_FORMAT: &str = "%x1e%H%n%an%n%at%n%s";

/// Flags accompanying the format: rename following + detection and the
/// per-commit name-status output the path tracking is built on.
pub const FILE_HISTORY_FLAGS: [&str; 3] = ["--follow", "-M", "--name-status"];

const RECORD_SEP: char = '\x1e';

/// Parse `git log --follow -M --name-status --format=FILE_HISTORY_FORMAT`
/// output. `queried_path` is the path the log was requested for (fallback
/// for records without a name-status line). Newest first, like git.
pub fn parse_file_history(
    output: &str,
    queried_path: &str,
) -> Result<Vec<FileHistoryEntry>, ParseError> {
    let mut entries: Vec<FileHistoryEntry> = Vec::new();
    for chunk in output.split(RECORD_SEP) {
        if chunk.trim().is_empty() {
            continue;
        }
        let mut lines = chunk.lines();
        let sha = lines.next().unwrap_or_default().trim();
        let author = lines.next().unwrap_or_default();
        let ts_raw = lines.next().unwrap_or_default().trim();
        let subject = lines.next().unwrap_or_default();
        if sha.is_empty() || ts_raw.is_empty() {
            let snippet = &chunk[..chunk.len().min(120)];
            return Err(ParseError::new("malformed file-history record", snippet));
        }
        let timestamp: i64 = ts_raw.parse().map_err(|_| {
            ParseError::new("file-history timestamp is not an integer", ts_raw)
        })?;

        // First non-blank line after the fields is the name-status entry.
        let name_status = lines.map(str::trim_end).find(|l| !l.is_empty());
        let (path, old_path) = match name_status {
            Some(line) => parse_name_status(line),
            None => (None, None),
        };
        let fallback = entries
            .last()
            .map(|e| e.path.clone())
            .unwrap_or_else(|| queried_path.to_string());

        entries.push(FileHistoryEntry {
            commit_id: CommitId::new(sha),
            summary: subject.to_string(),
            author: author.to_string(),
            timestamp,
            path: path.unwrap_or(fallback),
            old_path,
        });
    }
    Ok(entries)
}

/// One `--name-status` line -> (path at this commit, renamed-from). Renames
/// and copies are `X<score>\t<old>\t<new>`; everything else is `X\t<path>`.
/// Unrecognizable lines yield (None, None) - the caller falls back.
fn parse_name_status(line: &str) -> (Option<String>, Option<String>) {
    let mut parts = line.split('\t');
    let status = parts.next().unwrap_or_default();
    let kind = status.chars().next().unwrap_or(' ');
    match kind {
        'R' | 'C' => {
            let old = parts.next();
            let new = parts.next();
            match (old, new) {
                (Some(old), Some(new)) => (Some(new.to_string()), Some(old.to_string())),
                _ => (None, None),
            }
        }
        'M' | 'A' | 'D' | 'T' => (parts.next().map(str::to_string), None),
        _ => (None, None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(sha: &str, subject: &str, name_status: &str) -> String {
        format!("\x1e{sha}\nAlice\n1783288808\n{subject}\n\n{name_status}\n")
    }

    #[test]
    fn parses_a_plain_modification_history() {
        let out = record("aaa", "modify", "M\tsrc/a.rs") + &record("bbb", "add", "A\tsrc/a.rs");
        let entries = parse_file_history(&out, "src/a.rs").unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].commit_id.as_str(), "aaa");
        assert_eq!(entries[0].summary, "modify");
        assert_eq!(entries[0].author, "Alice");
        assert_eq!(entries[0].timestamp, 1783288808);
        assert_eq!(entries[0].path, "src/a.rs");
        assert_eq!(entries[0].old_path, None);
        assert_eq!(entries[1].path, "src/a.rs");
    }

    #[test]
    fn rename_commit_carries_new_path_and_old_path_and_older_commits_use_the_old_name() {
        let out = record("ccc", "modify b", "M\tb.txt")
            + &record("bbb", "rename a to b", "R100\ta.txt\tb.txt")
            + &record("aaa", "add a", "A\ta.txt");
        let entries = parse_file_history(&out, "b.txt").unwrap();
        assert_eq!(entries[0].path, "b.txt");
        assert_eq!(entries[1].path, "b.txt");
        assert_eq!(entries[1].old_path.as_deref(), Some("a.txt"));
        assert_eq!(entries[2].path, "a.txt");
        assert_eq!(entries[2].old_path, None);
    }

    #[test]
    fn record_without_name_status_inherits_the_nearest_newer_path() {
        // e.g. a merge commit git lists without per-file output.
        let out = record("ccc", "modify", "M\tnew.rs")
            + "\x1eddd\nAlice\n1783288808\nmerge\n\n"
            + &record("aaa", "add", "A\tnew.rs");
        let entries = parse_file_history(&out, "queried.rs").unwrap();
        assert_eq!(entries[1].path, "new.rs");
        // ...and the very first record falls back to the queried path.
        let only_merge = "\x1eddd\nAlice\n1783288808\nmerge\n\n";
        let entries = parse_file_history(only_merge, "queried.rs").unwrap();
        assert_eq!(entries[0].path, "queried.rs");
    }

    #[test]
    fn empty_output_is_an_empty_history() {
        assert_eq!(parse_file_history("", "a").unwrap(), vec![]);
    }

    #[test]
    fn malformed_timestamp_is_an_error() {
        let out = "\x1eaaa\nAlice\nnot-a-number\nsubject\n\nM\ta\n";
        assert!(parse_file_history(out, "a").is_err());
    }
}
