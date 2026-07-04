//! Parser for `git blame --porcelain` output backing `blame()`.
//!
//! Porcelain format: every blamed line gets a header `<sha> <origLine>
//! <finalLine>[ <numLines>]` (the 4-field form starts a new group), followed
//! by commit metadata (`author`, `author-time`, `summary`, …) the FIRST time
//! a commit appears, and the line content prefixed with a TAB. Metadata for
//! repeat commits is not re-emitted, so the parser caches it per sha.

use crate::types::{BlameHunk, CommitId};
use std::collections::HashMap;

/// The all-zeros sha git uses for not-yet-committed lines.
pub const UNCOMMITTED_SHA: &str = "0000000000000000000000000000000000000000";

#[derive(Default, Clone)]
struct Meta {
    author: String,
    timestamp: i64,
    summary: String,
}

/// Parse `git blame --porcelain` output into hunks (consecutive lines of the
/// same commit). Unknown metadata keys are skipped; a malformed stream yields
/// the hunks parsed so far rather than failing outright.
pub fn parse_blame(output: &str) -> Vec<BlameHunk> {
    let mut metas: HashMap<String, Meta> = HashMap::new();
    let mut hunks: Vec<BlameHunk> = Vec::new();
    let mut current_sha: Option<String> = None;
    let mut current_start: u32 = 0;
    let mut pending_lines: Vec<String> = Vec::new();

    let flush = |hunks: &mut Vec<BlameHunk>,
                 metas: &HashMap<String, Meta>,
                 sha: &Option<String>,
                 start: u32,
                 lines: &mut Vec<String>| {
        let Some(sha) = sha else { return };
        if lines.is_empty() {
            return;
        }
        let meta = metas.get(sha).cloned().unwrap_or_default();
        hunks.push(BlameHunk {
            sha: CommitId::new(sha.clone()),
            author: meta.author,
            timestamp: meta.timestamp,
            summary: meta.summary,
            start_line: start,
            lines: std::mem::take(lines),
        });
    };

    for line in output.split('\n') {
        if let Some(content) = line.strip_prefix('\t') {
            pending_lines.push(content.to_string());
            continue;
        }
        if let Some((sha, orig_final)) = parse_header(line) {
            let final_line: u32 = orig_final;
            // A new hunk starts when the commit changes OR the line numbers
            // stop being consecutive (git's 4-field groups already imply
            // this, but deriving it from the data is sturdier).
            let consecutive = current_sha.as_deref() == Some(sha)
                && final_line == current_start + pending_lines.len() as u32;
            if !consecutive {
                flush(&mut hunks, &metas, &current_sha, current_start, &mut pending_lines);
                current_sha = Some(sha.to_string());
                current_start = final_line;
            }
            continue;
        }
        // Commit metadata for the sha of the most recent header.
        let Some(sha) = &current_sha else { continue };
        let meta = metas.entry(sha.clone()).or_default();
        if let Some(v) = line.strip_prefix("author ") {
            meta.author = v.to_string();
        } else if let Some(v) = line.strip_prefix("author-time ") {
            meta.timestamp = v.trim().parse().unwrap_or(0);
        } else if let Some(v) = line.strip_prefix("summary ") {
            meta.summary = v.to_string();
        }
    }
    flush(&mut hunks, &metas, &current_sha, current_start, &mut pending_lines);
    hunks
}

/// A porcelain header is `<40-hex sha> <origLine> <finalLine>[ <numLines>]`.
/// Returns (sha, finalLine).
fn parse_header(line: &str) -> Option<(&str, u32)> {
    let mut parts = line.split(' ');
    let sha = parts.next()?;
    if sha.len() != 40 || !sha.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let _orig: u32 = parts.next()?.parse().ok()?;
    let final_line: u32 = parts.next()?.parse().ok()?;
    Some((sha, final_line))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SHA_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const SHA_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    fn sample() -> String {
        // Two lines by A (metadata emitted once), one by B, one more by A
        // (no metadata re-emission — must come from the cache).
        format!(
            "{SHA_A} 1 1 2\nauthor Alice\nauthor-mail <a@x>\nauthor-time 1751600000\nauthor-tz +0000\nsummary first\nfilename f.txt\n\tline one\n{SHA_A} 2 2\n\tline two\n{SHA_B} 3 3 1\nauthor Bob\nauthor-time 1751700000\nsummary second\nfilename f.txt\n\tline three\n{SHA_A} 9 4 1\n\tline four\n"
        )
    }

    #[test]
    fn groups_consecutive_lines_and_caches_metadata() {
        let hunks = parse_blame(&sample());
        assert_eq!(hunks.len(), 3);

        assert_eq!(hunks[0].sha.as_str(), SHA_A);
        assert_eq!(hunks[0].author, "Alice");
        assert_eq!(hunks[0].summary, "first");
        assert_eq!(hunks[0].timestamp, 1751600000);
        assert_eq!(hunks[0].start_line, 1);
        assert_eq!(hunks[0].lines, vec!["line one", "line two"]);

        assert_eq!(hunks[1].sha.as_str(), SHA_B);
        assert_eq!(hunks[1].author, "Bob");
        assert_eq!(hunks[1].start_line, 3);

        // The repeat A hunk gets metadata from the cache.
        assert_eq!(hunks[2].sha.as_str(), SHA_A);
        assert_eq!(hunks[2].author, "Alice");
        assert_eq!(hunks[2].summary, "first");
        assert_eq!(hunks[2].start_line, 4);
        assert_eq!(hunks[2].lines, vec!["line four"]);
    }

    #[test]
    fn uncommitted_lines_carry_the_zero_sha() {
        let raw = format!(
            "{UNCOMMITTED_SHA} 1 1 1\nauthor Not Committed Yet\nauthor-time 1751800000\nsummary Version of f.txt from f.txt\nfilename f.txt\n\tdirty line\n"
        );
        let hunks = parse_blame(&raw);
        assert_eq!(hunks.len(), 1);
        assert_eq!(hunks[0].sha.as_str(), UNCOMMITTED_SHA);
        assert_eq!(hunks[0].lines, vec!["dirty line"]);
    }

    #[test]
    fn tab_in_content_is_preserved_and_empty_input_is_empty() {
        assert!(parse_blame("").is_empty());
        let raw = format!("{SHA_A} 1 1 1\nauthor A\nauthor-time 1\nsummary s\n\thas\ttab\n");
        assert_eq!(parse_blame(&raw)[0].lines, vec!["has\ttab"]);
    }
}
