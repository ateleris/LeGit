//! Parser for the Work Log sweep (`git log --source` across local branches).
//!
//! One record per line, tab-separated, subject last so tabs inside a subject
//! survive the `splitn`. `%S` needs `--source` on the invocation.

use super::log::parse_iso_timestamp;
use crate::error::ParseError;
use crate::types::{CommitId, Signature, WorkLogCommit};

/// Format string to pass to `git log --format=`. Tab-separated, one line per
/// commit: SHA, author name, author email, author date (%aI), source ref
/// (%S, requires `--source`), subject. Subject stays LAST (tabs survive the
/// splitn). `%G?` is deliberately absent (per-commit signature verification
/// is far too slow for a bulk walk).
pub const WORK_LOG_FORMAT: &str = "%H%x09%an%x09%ae%x09%aI%x09%S%x09%s";

const FIELD_COUNT: usize = 6;

/// Parse the stdout of `git log --format=WORK_LOG_FORMAT --source`.
pub fn parse_work_log(output: &str) -> Result<Vec<WorkLogCommit>, ParseError> {
    output
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(parse_record)
        .collect()
}

fn parse_record(line: &str) -> Result<WorkLogCommit, ParseError> {
    let parts: Vec<&str> = line.splitn(FIELD_COUNT, '\t').collect();
    if parts.len() < FIELD_COUNT {
        let snippet = &line[..line.len().min(120)];
        return Err(ParseError::new(
            format!(
                "work log record has {} fields, expected {}",
                parts.len(),
                FIELD_COUNT
            ),
            snippet,
        ));
    }
    let (timestamp, tz_offset_minutes) = parse_iso_timestamp(parts[3].trim())?;
    let source_ref = match parts[4].trim() {
        "" => None,
        s => Some(s.to_string()),
    };
    Ok(WorkLogCommit {
        id: CommitId::new(parts[0].trim()),
        author: Signature {
            name: parts[1].to_string(),
            email: parts[2].trim().to_string(),
            timestamp,
            tz_offset_minutes,
        },
        subject: parts[5].to_string(),
        source_ref,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const SHA: &str = "a94a8fe5ccb19ba61c4c0873d391e987982fbbd3";

    #[test]
    fn parses_record() {
        let line = format!(
            "{SHA}\tAlice\ta@b.com\t2026-11-12T09:12:00+01:00\trefs/heads/dev\tfix stash"
        );
        let commits = parse_work_log(&line).unwrap();
        assert_eq!(commits.len(), 1);
        let c = &commits[0];
        assert_eq!(c.id.as_str(), SHA);
        assert_eq!(c.author.name, "Alice");
        assert_eq!(c.author.email, "a@b.com");
        assert_eq!(c.author.timestamp, 1794471120);
        assert_eq!(c.author.tz_offset_minutes, 60);
        assert_eq!(c.subject, "fix stash");
        assert_eq!(c.source_ref.as_deref(), Some("refs/heads/dev"));
    }

    #[test]
    fn subject_may_contain_tabs() {
        let line = format!(
            "{SHA}\tAlice\ta@b.com\t2026-11-12T09:12:00+01:00\trefs/heads/dev\ta\tb\tc"
        );
        let commits = parse_work_log(&line).unwrap();
        assert_eq!(commits[0].subject, "a\tb\tc");
    }

    #[test]
    fn empty_source_ref_is_none() {
        let line = format!("{SHA}\tAlice\ta@b.com\t2026-11-12T09:12:00+01:00\t\tsubject");
        let commits = parse_work_log(&line).unwrap();
        assert_eq!(commits[0].source_ref, None);
    }

    #[test]
    fn skips_blank_lines() {
        let out = format!(
            "\n{SHA}\tAlice\ta@b.com\t2026-11-12T09:12:00+01:00\tHEAD\ts\n\n"
        );
        let commits = parse_work_log(&out).unwrap();
        assert_eq!(commits.len(), 1);
    }
}
