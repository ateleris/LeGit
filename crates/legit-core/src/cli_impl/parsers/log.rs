//! Parser for `git log` output (DESIGN-v0.3.md §F.2).
//!
//! The format string constant lives here so the command and the parser share a
//! single contract. Fields are newline-separated; records are terminated by
//! ASCII Record Separator (0x1E, `%x1e`). 0x1E never appears in human-authored
//! commit metadata or message text — it is a non-printable control character
//! not produced by any standard tool.

use crate::error::ParseError;
use crate::types::{Commit, CommitId, RefDecoration, Signature};
use chrono::DateTime;

/// Format string to pass to `git log --format=`.
/// Fields per record (newline-separated):
///   0: SHA (%H)
///   1: parent SHAs, space-separated (%P) — empty for root commits
///   2: author name (%an)
///   3: author email (%ae)
///   4: author date, strict ISO 8601 (%aI, e.g. 2023-01-15T10:30:00+02:00)
///   5: committer name (%cn)
///   6: committer email (%ce)
///   7: committer date, strict ISO 8601 (%cI)
///   8: decoration (%d) — e.g. " (HEAD -> refs/heads/main, refs/tags/v1.0)"
///   9: subject line (%s)
///  10: body (%b) — may contain newlines; captured by splitn (must stay last)
/// Record terminator: ASCII RS (0x1E) via %x1e.
///
/// NOTE: we deliberately omit `%G?` (per-commit signature status). That field
/// makes git verify EVERY commit's signature during the walk — spawning the
/// gpg/ssh verifier once per signed commit — which is very slow on large or
/// heavily-signed histories (seconds to tens of seconds). The commit list shows
/// no per-row signature; full verification is done on demand in `commit_details`
/// (`git verify-commit`).
pub const LOG_FORMAT: &str =
    "%H%n%P%n%an%n%ae%n%aI%n%cn%n%ce%n%cI%n%d%n%s%n%b%x1e";

const RECORD_SEP: char = '\x1e';
const FIELD_COUNT: usize = 11;

/// Parse the stdout of `git log --format=LOG_FORMAT` into `Vec<Commit>`.
///
/// Returns an error if any record is malformed. An empty string returns an
/// empty vec (no commits, or no output from git).
pub fn parse_log(output: &str) -> Result<Vec<Commit>, ParseError> {
    output
        .split(RECORD_SEP)
        .filter(|chunk| !chunk.trim().is_empty())
        .map(|chunk| parse_record(chunk.trim_start_matches('\n')))
        .collect()
}

fn parse_record(record: &str) -> Result<Commit, ParseError> {
    let parts: Vec<&str> = record.splitn(FIELD_COUNT, '\n').collect();
    if parts.len() < FIELD_COUNT {
        let snippet = &record[..record.len().min(120)];
        return Err(ParseError::new(
            format!(
                "log record has {} fields, expected {}",
                parts.len(),
                FIELD_COUNT
            ),
            snippet,
        ));
    }

    let sha = parts[0].trim();
    let parents_raw = parts[1].trim();
    let author_name = parts[2];
    let author_email = parts[3].trim();
    let author_iso = parts[4].trim();
    let committer_name = parts[5];
    let committer_email = parts[6].trim();
    let committer_iso = parts[7].trim();
    let decoration_raw = parts[8];
    let subject = parts[9].trim_end_matches('\n').to_string();
    // Body: everything after the 10th newline; strip trailing newline git appends.
    let body = parts[10].trim_end_matches('\n').to_string();

    let (author_ts, author_tz) = parse_iso_timestamp(author_iso)?;
    let (committer_ts, committer_tz) = parse_iso_timestamp(committer_iso)?;

    let parents: Vec<CommitId> = if parents_raw.is_empty() {
        vec![]
    } else {
        parents_raw
            .split_ascii_whitespace()
            .map(CommitId::new)
            .collect()
    };

    let message = if body.is_empty() {
        subject.clone()
    } else {
        format!("{}\n\n{}", subject, body)
    };

    let decorations = parse_decoration(decoration_raw);

    Ok(Commit {
        id: CommitId::new(sha),
        parents,
        author: Signature {
            name: author_name.to_string(),
            email: author_email.to_string(),
            timestamp: author_ts,
            tz_offset_minutes: author_tz,
        },
        committer: Signature {
            name: committer_name.to_string(),
            email: committer_email.to_string(),
            timestamp: committer_ts,
            tz_offset_minutes: committer_tz,
        },
        message,
        timestamp: author_ts,
        // The commit list does not verify signatures (too slow per-row); the
        // signature is populated on demand by `commit_details`. Signature
        // PRESENCE is filled in afterwards by `log`'s batched header scan.
        signature: None,
        has_signature: false,
        decorations,
    })
}

/// Parse a strict ISO 8601 timestamp (e.g. `2023-01-15T10:30:00+02:00`) into
/// (unix_seconds, tz_offset_minutes).
fn parse_iso_timestamp(s: &str) -> Result<(i64, i32), ParseError> {
    DateTime::parse_from_rfc3339(s)
        .map(|dt| {
            let unix = dt.timestamp();
            let tz_minutes = dt.offset().local_minus_utc() / 60;
            (unix, tz_minutes)
        })
        .map_err(|e| {
            ParseError::new(format!("bad ISO timestamp ({e})"), s)
        })
}

/// Parse the `%d` decoration field emitted by `git log --decorate=full`.
///
/// Git emits one of:
/// - `""` — no refs point here
/// - `" (HEAD -> refs/heads/main, refs/heads/dev, refs/tags/v1.0)"` — one or more refs
fn parse_decoration(s: &str) -> Vec<RefDecoration> {
    let s = s.trim();
    if s.is_empty() {
        return vec![];
    }
    // Strip surrounding parentheses that git wraps around the list.
    let inner = s.trim_start_matches('(').trim_end_matches(')').trim();
    if inner.is_empty() {
        return vec![];
    }
    inner.split(", ").map(|part| classify_ref(part.trim())).collect()
}

fn classify_ref(part: &str) -> RefDecoration {
    if let Some(target) = part.strip_prefix("HEAD -> ") {
        RefDecoration::HeadOf(target.to_string())
    } else if part == "HEAD" {
        RefDecoration::Head
    } else if part.starts_with("refs/heads/") {
        RefDecoration::Branch(part.to_string())
    } else if let Some(tag) = part.strip_prefix("tag: ") {
        // git --decorate=full prefixes tag refs with "tag: ".
        RefDecoration::Tag(tag.to_string())
    } else if part.starts_with("refs/tags/") {
        RefDecoration::Tag(part.to_string())
    } else if part.starts_with("refs/remotes/") {
        RefDecoration::Remote(part.to_string())
    } else {
        RefDecoration::Other(part.to_string())
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a record from the 11 fields (H,P,an,ae,aI,cn,ce,cI,d,s,b).
    fn single(fields: [&str; 11]) -> String {
        fields.join("\n") + "\x1e"
    }

    const SHA1: &str = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";
    const SHA2: &str = "b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3";
    const SHA3: &str = "c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4";
    const TS_UTC: &str = "2024-03-15T12:00:00+00:00";
    const TS_POS: &str = "2024-03-15T14:00:00+02:00";
    const TS_NEG: &str = "2024-03-15T08:00:00-04:00";

    #[test]
    fn empty_output() {
        assert!(parse_log("").unwrap().is_empty());
    }

    #[test]
    fn single_commit_no_body() {
        let raw = single([SHA1, "", "Alice", "alice@example.com", TS_UTC, "Alice", "alice@example.com", TS_UTC, "", "Initial commit", ""]);
        let commits = parse_log(&raw).unwrap();
        assert_eq!(commits.len(), 1);
        let c = &commits[0];
        assert_eq!(c.id.as_str(), SHA1);
        assert!(c.parents.is_empty());
        assert_eq!(c.author.name, "Alice");
        assert_eq!(c.author.email, "alice@example.com");
        assert_eq!(c.author.tz_offset_minutes, 0);
        assert_eq!(c.message, "Initial commit");
        // The commit list never carries a signature (verified on demand instead).
        assert!(c.signature.is_none());
    }

    #[test]
    fn two_commits() {
        let raw = single([SHA1, SHA2, "Alice", "alice@example.com", TS_UTC, "Alice", "alice@example.com", TS_UTC, "", "Second commit", ""])
            + &single([SHA2, "", "Alice", "alice@example.com", TS_UTC, "Alice", "alice@example.com", TS_UTC, "", "First commit", ""]);
        let commits = parse_log(&raw).unwrap();
        assert_eq!(commits.len(), 2);
        assert_eq!(commits[0].id.as_str(), SHA1);
        assert_eq!(commits[0].parents[0].as_str(), SHA2);
        assert_eq!(commits[1].id.as_str(), SHA2);
    }

    #[test]
    fn merge_commit_two_parents() {
        let parents = format!("{SHA2} {SHA3}");
        let raw = single([SHA1, &parents, "Bob", "bob@example.com", TS_UTC, "Bob", "bob@example.com", TS_UTC, "", "Merge branch 'feat'", ""]);
        let commits = parse_log(&raw).unwrap();
        assert_eq!(commits[0].parents.len(), 2);
        assert_eq!(commits[0].parents[0].as_str(), SHA2);
        assert_eq!(commits[0].parents[1].as_str(), SHA3);
    }

    #[test]
    fn positive_timezone_offset() {
        let raw = single([SHA1, "", "Alice", "a@b.com", TS_POS, "Alice", "a@b.com", TS_POS, "", "TZ commit", ""]);
        let commits = parse_log(&raw).unwrap();
        // +02:00 = 120 minutes
        assert_eq!(commits[0].author.tz_offset_minutes, 120);
        // Timestamp is UTC epoch regardless of timezone
        assert_eq!(commits[0].author.timestamp, 1710504000); // 2024-03-15T12:00:00Z
    }

    #[test]
    fn negative_timezone_offset() {
        let raw = single([SHA1, "", "Alice", "a@b.com", TS_NEG, "Alice", "a@b.com", TS_NEG, "", "TZ commit", ""]);
        let commits = parse_log(&raw).unwrap();
        // -04:00 = -240 minutes
        assert_eq!(commits[0].author.tz_offset_minutes, -240);
        assert_eq!(commits[0].author.timestamp, 1710504000); // same UTC instant
    }

    #[test]
    fn body_with_newlines() {
        let body = "First line\n\nSecond paragraph\nContinued";
        let raw = single([SHA1, "", "Alice", "a@b.com", TS_UTC, "Alice", "a@b.com", TS_UTC, "", "Subject", body]);
        let commits = parse_log(&raw).unwrap();
        assert!(commits[0].message.contains("First line"));
        assert!(commits[0].message.contains("Second paragraph"));
    }

    #[test]
    fn long_message_preserved() {
        let body: String = std::iter::repeat("x").take(4096).collect();
        let raw = single([SHA1, "", "Alice", "a@b.com", TS_UTC, "Alice", "a@b.com", TS_UTC, "", "Big commit", &body]);
        let commits = parse_log(&raw).unwrap();
        assert!(commits[0].message.len() > 4096);
    }

    #[test]
    fn unicode_in_author_name_and_message() {
        let raw = single([SHA1, "", "山田 太郎", "yamada@example.jp", TS_UTC, "田中 花子", "tanaka@example.jp", TS_UTC, "", "日本語コミット", "Ünïcödé bödÿ with 🦀"]);
        let commits = parse_log(&raw).unwrap();
        assert_eq!(commits[0].author.name, "山田 太郎");
        assert_eq!(commits[0].committer.name, "田中 花子");
        assert_eq!(commits[0].message, "日本語コミット\n\nÜnïcödé bödÿ with 🦀");
    }

    #[test]
    fn body_containing_nul_byte() {
        // NUL in body is rare but legal. The RS-based record separator means
        // NUL doesn't interfere with record or field boundaries.
        let body = "before\0after";
        let raw = single([SHA1, "", "Alice", "a@b.com", TS_UTC, "Alice", "a@b.com", TS_UTC, "", "NUL test", body]);
        let commits = parse_log(&raw).unwrap();
        assert!(commits[0].message.contains("before\0after"));
    }

    #[test]
    fn body_containing_percent_x1e_escaped() {
        // Verify the parser doesn't break if body happens to contain
        // text that resembles the delimiter when printed as ASCII.
        // The actual 0x1e byte would split the record; this test confirms
        // that printable text "\x1e" (the 4-char escape) passes through fine.
        let body = r"contains \x1e literal backslash text";
        let raw = single([SHA1, "", "Alice", "a@b.com", TS_UTC, "Alice", "a@b.com", TS_UTC, "", "Escape test", body]);
        let commits = parse_log(&raw).unwrap();
        assert!(commits[0].message.contains(r"\x1e"));
    }

    #[test]
    fn unsigned_commit_has_no_signature() {
        let raw = single([SHA1, "", "Alice", "a@b.com", TS_UTC, "Alice", "a@b.com", TS_UTC, "", "Unsigned", ""]);
        assert!(parse_log(&raw).unwrap()[0].signature.is_none());
    }

    #[test]
    fn bad_record_returns_error() {
        // Missing fields — only has 5 fields instead of 11.
        let raw = "sha\nparents\nname\nemail\nts\x1e";
        assert!(parse_log(raw).is_err());
    }

    #[test]
    fn bad_timestamp_returns_error() {
        let raw = single([SHA1, "", "Alice", "a@b.com", "NOT_A_DATE", "Alice", "a@b.com", TS_UTC, "", "Bad ts", ""]);
        assert!(parse_log(&raw).is_err());
    }

    // --- decoration tests ---

    #[test]
    fn decoration_none() {
        let raw = single([SHA1, "", "Alice", "a@b.com", TS_UTC, "Alice", "a@b.com", TS_UTC, "", "No deco", ""]);
        let commits = parse_log(&raw).unwrap();
        assert!(commits[0].decorations.is_empty());
    }

    #[test]
    fn decoration_single_branch() {
        let raw = single([SHA1, "", "Alice", "a@b.com", TS_UTC, "Alice", "a@b.com", TS_UTC, " (refs/heads/main)", "Branch", ""]);
        let commits = parse_log(&raw).unwrap();
        assert_eq!(commits[0].decorations, vec![RefDecoration::Branch("refs/heads/main".to_string())]);
    }

    #[test]
    fn decoration_head_on_branch() {
        let raw = single([SHA1, "", "Alice", "a@b.com", TS_UTC, "Alice", "a@b.com", TS_UTC, " (HEAD -> refs/heads/main)", "HEAD on branch", ""]);
        let commits = parse_log(&raw).unwrap();
        assert_eq!(commits[0].decorations, vec![RefDecoration::HeadOf("refs/heads/main".to_string())]);
    }

    #[test]
    fn decoration_multiple() {
        let raw = single([SHA1, "", "Alice", "a@b.com", TS_UTC, "Alice", "a@b.com", TS_UTC, " (HEAD -> refs/heads/main, refs/heads/dev)", "Multi", ""]);
        let commits = parse_log(&raw).unwrap();
        assert_eq!(commits[0].decorations, vec![
            RefDecoration::HeadOf("refs/heads/main".to_string()),
            RefDecoration::Branch("refs/heads/dev".to_string()),
        ]);
    }

    #[test]
    fn decoration_branches_and_tags() {
        // git --decorate=full prefixes tag refs with "tag: ".
        let raw = single([SHA1, "", "Alice", "a@b.com", TS_UTC, "Alice", "a@b.com", TS_UTC, " (refs/heads/main, tag: refs/tags/v1.0)", "Tag", ""]);
        let commits = parse_log(&raw).unwrap();
        assert_eq!(commits[0].decorations, vec![
            RefDecoration::Branch("refs/heads/main".to_string()),
            RefDecoration::Tag("refs/tags/v1.0".to_string()),
        ]);
    }

    #[test]
    fn decoration_tag_only() {
        let raw = single([SHA1, "", "Alice", "a@b.com", TS_UTC, "Alice", "a@b.com", TS_UTC, " (tag: refs/tags/v2.0)", "Tag", ""]);
        let commits = parse_log(&raw).unwrap();
        assert_eq!(commits[0].decorations, vec![
            RefDecoration::Tag("refs/tags/v2.0".to_string()),
        ]);
    }

    #[test]
    fn decoration_detached_head() {
        let raw = single([SHA1, "", "Alice", "a@b.com", TS_UTC, "Alice", "a@b.com", TS_UTC, " (HEAD)", "Detached", ""]);
        let commits = parse_log(&raw).unwrap();
        assert_eq!(commits[0].decorations, vec![RefDecoration::Head]);
    }

    #[test]
    fn decoration_unicode_branch_name() {
        let raw = single([SHA1, "", "Alice", "a@b.com", TS_UTC, "Alice", "a@b.com", TS_UTC, " (refs/heads/ветка)", "Unicode branch", ""]);
        let commits = parse_log(&raw).unwrap();
        assert_eq!(commits[0].decorations, vec![RefDecoration::Branch("refs/heads/ветка".to_string())]);
    }

    #[test]
    fn decoration_other_ref() {
        let raw = single([SHA1, "", "Alice", "a@b.com", TS_UTC, "Alice", "a@b.com", TS_UTC, " (refs/notes/commits)", "Notes", ""]);
        let commits = parse_log(&raw).unwrap();
        assert_eq!(commits[0].decorations, vec![RefDecoration::Other("refs/notes/commits".to_string())]);
    }

    #[test]
    fn decoration_remote_ref() {
        let raw = single([SHA1, "", "Alice", "a@b.com", TS_UTC, "Alice", "a@b.com", TS_UTC, " (refs/remotes/origin/main)", "Remote", ""]);
        let commits = parse_log(&raw).unwrap();
        assert_eq!(commits[0].decorations, vec![RefDecoration::Remote("refs/remotes/origin/main".to_string())]);
    }

    #[test]
    fn decoration_branch_name_with_spaces() {
        // Branch names can contain spaces when created explicitly.
        let raw = single([SHA1, "", "Alice", "a@b.com", TS_UTC, "Alice", "a@b.com", TS_UTC,
            " (refs/heads/my feature branch)", "Spaced branch", ""]);
        let commits = parse_log(&raw).unwrap();
        assert_eq!(commits[0].decorations, vec![
            RefDecoration::Branch("refs/heads/my feature branch".to_string()),
        ]);
    }

    #[test]
    fn decoration_branch_name_unusual_chars() {
        // Branch names can contain dots, slashes (namespaced), and hyphens.
        let raw = single([SHA1, "", "Alice", "a@b.com", TS_UTC, "Alice", "a@b.com", TS_UTC,
            " (refs/heads/fix/issue-42.patch)", "Unusual chars", ""]);
        let commits = parse_log(&raw).unwrap();
        assert_eq!(commits[0].decorations, vec![
            RefDecoration::Branch("refs/heads/fix/issue-42.patch".to_string()),
        ]);
    }

    #[test]
    fn decoration_multiple_branches_one_with_spaces() {
        // Two branches: one with a space, one normal.
        // The split is on ", " (comma-space), so the space within "my feature"
        // is not treated as a separator — "my feature" stays intact.
        let raw = single([SHA1, "", "Alice", "a@b.com", TS_UTC, "Alice", "a@b.com", TS_UTC,
            " (refs/heads/my feature, refs/heads/main)", "Multi spaced", ""]);
        let commits = parse_log(&raw).unwrap();
        assert_eq!(commits[0].decorations, vec![
            RefDecoration::Branch("refs/heads/my feature".to_string()),
            RefDecoration::Branch("refs/heads/main".to_string()),
        ]);
    }
}
