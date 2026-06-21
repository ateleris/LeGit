//! Parser for `git stash list` output backing `stashes()`.
//!
//! The format string lives here next to the parser so the contract is visible
//! in one place. Fields are tab-separated, one stash per line. The trailing
//! message field is captured with `splitn` so a tab inside a user-supplied
//! stash message cannot break the parse.

use crate::types::{CommitId, Signature, StashEntry};
use chrono::DateTime;

/// `--format=` argument for `git stash list`. Fields, tab-separated:
///   stash sha (%H) · selector (%gd, e.g. `stash@{0}`) · parents (%P, base first)
///   · author name (%an) · author email (%ae) · author date ISO 8601 (%aI)
///   · reflog subject / message (%gs) — kept last; may contain tabs.
pub const STASH_FORMAT: &str = "%H%x09%gd%x09%P%x09%an%x09%ae%x09%aI%x09%gs";

const FIELD_COUNT: usize = 7;

/// Parse the stdout of `git stash list --format=STASH_FORMAT`.
///
/// Lines that don't have the expected field count (or a malformed timestamp /
/// selector) are skipped, so a single bad entry never breaks the whole list.
pub fn parse_stashes(output: &str) -> Vec<StashEntry> {
    output.lines().filter_map(parse_line).collect()
}

fn parse_line(line: &str) -> Option<StashEntry> {
    let line = line.trim_end_matches('\r');
    if line.trim().is_empty() {
        return None;
    }
    let parts: Vec<&str> = line.splitn(FIELD_COUNT, '\t').collect();
    if parts.len() < FIELD_COUNT {
        return None;
    }
    let stash_sha = parts[0].trim();
    let selector = parts[1].trim();
    let parents_raw = parts[2].trim();
    let author_name = parts[3];
    let author_email = parts[4].trim();
    let author_iso = parts[5].trim();
    let message = parts[6].to_string();

    if stash_sha.is_empty() || selector.is_empty() {
        return None;
    }

    let index = parse_selector_index(selector)?;
    let base_sha = parents_raw.split_ascii_whitespace().next()?;
    let (timestamp, tz_offset_minutes) = parse_iso_timestamp(author_iso)?;

    Some(StashEntry {
        index,
        selector: selector.to_string(),
        message,
        stash_sha: CommitId::new(stash_sha),
        base_sha: CommitId::new(base_sha),
        author: Signature {
            name: author_name.to_string(),
            email: author_email.to_string(),
            timestamp,
            tz_offset_minutes,
        },
        timestamp,
    })
}

/// Extract `N` from a `stash@{N}` selector.
fn parse_selector_index(selector: &str) -> Option<u32> {
    selector
        .strip_prefix("stash@{")?
        .strip_suffix('}')?
        .parse()
        .ok()
}

/// Parse a strict ISO 8601 timestamp into (unix_seconds, tz_offset_minutes).
fn parse_iso_timestamp(s: &str) -> Option<(i64, i32)> {
    DateTime::parse_from_rfc3339(s)
        .map(|dt| (dt.timestamp(), dt.offset().local_minus_utc() / 60))
        .ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(sha: &str, sel: &str, parents: &str, msg: &str) -> String {
        format!(
            "{sha}\t{sel}\t{parents}\tAlice\talice@example.com\t2023-01-15T10:30:00+02:00\t{msg}"
        )
    }

    #[test]
    fn empty_input_yields_no_stashes() {
        assert_eq!(parse_stashes(""), vec![]);
    }

    #[test]
    fn parses_single_stash() {
        let out = line("aaa111", "stash@{0}", "base000 index00", "On main: hello");
        let stashes = parse_stashes(&out);
        assert_eq!(stashes.len(), 1);
        let s = &stashes[0];
        assert_eq!(s.index, 0);
        assert_eq!(s.selector, "stash@{0}");
        assert_eq!(s.message, "On main: hello");
        assert_eq!(s.stash_sha, CommitId::new("aaa111"));
        // Base is the FIRST parent, even with index/untracked parents present.
        assert_eq!(s.base_sha, CommitId::new("base000"));
        assert_eq!(s.author.name, "Alice");
        assert_eq!(s.timestamp, 1673771400);
    }

    #[test]
    fn base_is_first_of_three_parents() {
        let out = line("s", "stash@{0}", "base index untracked", "WIP");
        let stashes = parse_stashes(&out);
        assert_eq!(stashes[0].base_sha, CommitId::new("base"));
    }

    #[test]
    fn parses_multiple_and_reads_selector_index() {
        let out = [
            line("s0", "stash@{0}", "b0 i0", "On main: a"),
            line("s1", "stash@{1}", "b1 i1", "On dev: b"),
            line("s2", "stash@{2}", "b2 i2", "WIP on main: c"),
        ]
        .join("\n");
        let stashes = parse_stashes(&out);
        assert_eq!(stashes.len(), 3);
        assert_eq!(stashes[0].index, 0);
        assert_eq!(stashes[1].index, 1);
        assert_eq!(stashes[2].index, 2);
    }

    #[test]
    fn message_with_tab_is_preserved() {
        let out = line("s", "stash@{0}", "b i", "msg\twith\ttabs");
        let stashes = parse_stashes(&out);
        assert_eq!(stashes[0].message, "msg\twith\ttabs");
    }

    #[test]
    fn skips_malformed_lines() {
        let out = "garbage line with too few fields\n";
        assert_eq!(parse_stashes(out), vec![]);
    }
}
