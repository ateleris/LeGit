//! Parser for `git reflog` output backing `reflog()`.
//!
//! The format string lives here next to the parser so the contract is visible
//! in one place. Fields are tab-separated, one entry per line, subject last
//! (it may contain tabs).

use crate::types::{CommitId, ReflogEntry};

/// `--format=` argument for `git reflog`. Fields, tab-separated:
///   sha (%H) · selector (%gd, e.g. `HEAD@{0}`) · committer date Unix (%ct)
///   · reflog subject (%gs, e.g. `commit: message`) — kept last.
pub const REFLOG_FORMAT: &str = "%H%x09%gd%x09%ct%x09%gs";

const FIELD_COUNT: usize = 4;

/// Parse the stdout of `git reflog --format=REFLOG_FORMAT`.
///
/// The subject's `action: rest` prefix is split off (e.g. `checkout: moving
/// from a to b` → action `checkout`); a subject without the prefix keeps the
/// whole text as `subject` with an empty action. Malformed lines are skipped
/// so a single bad entry never breaks the list.
pub fn parse_reflog(output: &str) -> Vec<ReflogEntry> {
    output.lines().filter_map(parse_line).collect()
}

fn parse_line(line: &str) -> Option<ReflogEntry> {
    let line = line.trim_end_matches('\r');
    if line.trim().is_empty() {
        return None;
    }
    let parts: Vec<&str> = line.splitn(FIELD_COUNT, '\t').collect();
    if parts.len() < FIELD_COUNT {
        return None;
    }
    let sha = parts[0].trim();
    let selector = parts[1].trim();
    let timestamp: i64 = parts[2].trim().parse().ok()?;
    let full_subject = parts[3];

    if sha.is_empty() || selector.is_empty() {
        return None;
    }

    let (action, subject) = match full_subject.split_once(": ") {
        Some((a, rest)) => (a.trim().to_string(), rest.to_string()),
        None => (String::new(), full_subject.to_string()),
    };

    Some(ReflogEntry {
        selector: selector.to_string(),
        sha: CommitId::new(sha),
        action,
        subject,
        timestamp,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_commit_and_checkout_entries() {
        let raw = "aaa111\tHEAD@{0}\t1751600000\tcommit: add feature\n\
                   bbb222\tHEAD@{1}\t1751590000\tcheckout: moving from main to feature\n";
        let entries = parse_reflog(raw);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].selector, "HEAD@{0}");
        assert_eq!(entries[0].sha.as_str(), "aaa111");
        assert_eq!(entries[0].action, "commit");
        assert_eq!(entries[0].subject, "add feature");
        assert_eq!(entries[0].timestamp, 1751600000);
        assert_eq!(entries[1].action, "checkout");
    }

    #[test]
    fn action_with_parenthetical_mode_is_kept_whole() {
        let raw = "ccc333\tHEAD@{2}\t1751580000\trebase (finish): returning to refs/heads/main\n";
        let entries = parse_reflog(raw);
        assert_eq!(entries[0].action, "rebase (finish)");
        assert_eq!(entries[0].subject, "returning to refs/heads/main");
    }

    #[test]
    fn subject_without_action_prefix_keeps_full_text() {
        let raw = "ddd444\tHEAD@{3}\t1751570000\tsome bare subject\n";
        let entries = parse_reflog(raw);
        assert_eq!(entries[0].action, "");
        assert_eq!(entries[0].subject, "some bare subject");
    }

    #[test]
    fn message_with_tab_is_preserved_and_bad_lines_skipped() {
        let raw = "eee555\tHEAD@{4}\t1751560000\tcommit: has\ttab\n\
                   not-enough-fields\n\
                   fff666\tHEAD@{5}\tnot-a-number\tcommit: x\n";
        let entries = parse_reflog(raw);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].subject, "has\ttab");
    }
}
