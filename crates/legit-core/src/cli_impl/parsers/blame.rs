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
    /// The porcelain `previous <sha> <path>` header: the parent commit to
    /// re-blame at and the file's path IN THAT COMMIT (the old name when this
    /// commit renamed the file). `None` for the commit that introduced the
    /// file.
    previous: Option<(String, String)>,
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
        let (previous_sha, previous_path) = match meta.previous {
            Some((psha, ppath)) => (Some(CommitId::new(psha)), Some(ppath)),
            None => (None, None),
        };
        hunks.push(BlameHunk {
            sha: CommitId::new(sha.clone()),
            author: meta.author,
            timestamp: meta.timestamp,
            summary: meta.summary,
            start_line: start,
            lines: std::mem::take(lines),
            has_previous: previous_sha.is_some(),
            previous_sha,
            previous_path,
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
        } else if let Some(v) = line.strip_prefix("previous ") {
            if let Some((psha, ppath)) = v.split_once(' ') {
                meta.previous = Some((psha.to_string(), unquote_path(ppath)));
            }
        }
    }
    flush(&mut hunks, &metas, &current_sha, current_start, &mut pending_lines);
    hunks
}

/// Undo git's C-style path quoting (`"sp\303\244ter.txt"` -> `später.txt`).
/// core.quotePath (default true) quotes porcelain path fields containing
/// non-ASCII or special bytes; octal escapes are raw bytes, decoded as UTF-8.
/// Unquoted input is returned verbatim.
fn unquote_path(s: &str) -> String {
    let Some(inner) = s.strip_prefix('"').and_then(|t| t.strip_suffix('"')) else {
        return s.to_string();
    };
    let bytes = inner.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\\' && i + 1 < bytes.len() {
            let c = bytes[i + 1];
            if (b'0'..=b'7').contains(&c) {
                // Up to 3 octal digits form one raw byte.
                let mut val: u32 = 0;
                let mut n = 0;
                while n < 3 && i + 1 + n < bytes.len() && (b'0'..=b'7').contains(&bytes[i + 1 + n]) {
                    val = val * 8 + u32::from(bytes[i + 1 + n] - b'0');
                    n += 1;
                }
                out.push(val as u8);
                i += 1 + n;
                continue;
            }
            out.push(match c {
                b'n' => b'\n',
                b't' => b'\t',
                b'r' => b'\r',
                other => other, // covers \\ and \" (and passes unknowns through)
            });
            i += 2;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
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
    fn previous_header_marks_has_previous() {
        // A has a `previous` header (a parent version exists → can blame parent);
        // B introduced the file (no `previous` → button should hide).
        let raw = format!(
            "{SHA_A} 1 1 1\nauthor A\nauthor-time 1\nsummary changed\nprevious {SHA_B} f.txt\nfilename f.txt\n\tline one\n{SHA_B} 2 2 1\nauthor B\nauthor-time 2\nsummary added\nfilename f.txt\n\tline two\n"
        );
        let hunks = parse_blame(&raw);
        assert_eq!(hunks.len(), 2);
        assert!(hunks[0].has_previous, "A has a parent version of the file");
        assert_eq!(hunks[0].previous_sha.as_ref().map(|s| s.as_str()), Some(SHA_B));
        assert_eq!(hunks[0].previous_path.as_deref(), Some("f.txt"));
        assert!(!hunks[1].has_previous, "B introduced the file — no previous");
        assert!(hunks[1].previous_sha.is_none());
        assert!(hunks[1].previous_path.is_none());
    }

    #[test]
    fn previous_header_carries_the_old_path_across_a_rename() {
        // The blamed commit renamed old.txt -> new.txt: `previous` points at
        // the OLD path, which is what a "blame parent" must re-blame (the new
        // name does not exist in the parent).
        let raw = format!(
            "{SHA_A} 1 1 1\nauthor A\nauthor-time 1\nsummary rename\nprevious {SHA_B} old.txt\nfilename new.txt\n\tline\n"
        );
        let hunks = parse_blame(&raw);
        assert_eq!(hunks[0].previous_path.as_deref(), Some("old.txt"));
    }

    #[test]
    fn previous_path_with_spaces_is_kept_whole() {
        // Only the first token is the sha; everything after is the path.
        let raw = format!(
            "{SHA_A} 1 1 1\nauthor A\nauthor-time 1\nsummary s\nprevious {SHA_B} my old file.txt\nfilename f.txt\n\tline\n"
        );
        assert_eq!(parse_blame(&raw)[0].previous_path.as_deref(), Some("my old file.txt"));
    }

    #[test]
    fn previous_path_c_quoting_is_undone() {
        // core.quotePath (default true) C-quotes non-ASCII paths with octal
        // byte escapes: "sp\303\244ter.txt" is `später.txt` in UTF-8.
        let raw = format!(
            "{SHA_A} 1 1 1\nauthor A\nauthor-time 1\nsummary s\nprevious {SHA_B} \"sp\\303\\244ter.txt\"\nfilename f.txt\n\tline\n"
        );
        assert_eq!(parse_blame(&raw)[0].previous_path.as_deref(), Some("später.txt"));

        // Escaped quote/backslash/tab forms decode too.
        let raw = format!(
            "{SHA_A} 1 1 1\nauthor A\nauthor-time 1\nsummary s\nprevious {SHA_B} \"a\\\"b\\\\c\\td.txt\"\nfilename f.txt\n\tline\n"
        );
        assert_eq!(parse_blame(&raw)[0].previous_path.as_deref(), Some("a\"b\\c\td.txt"));
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
