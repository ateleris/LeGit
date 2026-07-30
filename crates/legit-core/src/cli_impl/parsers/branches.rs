//! Parser for `git for-each-ref` output backing `branches()`.
//!
//! The format string lives here next to the parser so the contract is visible
//! in one place (DESIGN-v0.3.md §4.5). Fields are tab-separated (refnames
//! cannot contain tabs), one ref per line.

use crate::types::{Branch, CommitId};

/// `--format=` argument for `git for-each-ref`. Fields, tab-separated:
///   refname (full) · objectname (commit sha) · upstream (full ref) · HEAD marker
///   · upstream divergence (`[ahead N, behind M]` / `[gone]` / empty)
///   · creatordate (Unix seconds; the tip commit's committer date)
pub const BRANCH_FORMAT: &str =
    "%(refname)\t%(objectname)\t%(upstream)\t%(HEAD)\t%(upstream:track)\t%(creatordate:unix)";

/// Parse the stdout of `git for-each-ref --format=BRANCH_FORMAT refs/heads refs/remotes`.
///
/// Lines that don't have the expected field count are skipped, as is the
/// symbolic `refs/remotes/<remote>/HEAD` ref (it mirrors the remote's default
/// branch and is not a branch in its own right).
pub fn parse_branches(output: &str) -> Vec<Branch> {
    output.lines().filter_map(parse_line).collect()
}

fn parse_line(line: &str) -> Option<Branch> {
    let line = line.trim_end_matches('\r');
    if line.trim().is_empty() {
        return None;
    }
    let mut fields = line.split('\t');
    let refname = fields.next()?;
    let oid = fields.next()?;
    let upstream = fields.next().unwrap_or("");
    let head = fields.next().unwrap_or("");
    let track = fields.next().unwrap_or("");
    // Degrade to 0 rather than dropping the branch on a missing/odd date.
    let created_at = fields.next().and_then(|f| f.trim().parse().ok()).unwrap_or(0);

    let is_remote = refname.starts_with("refs/remotes/");
    let name = if is_remote {
        refname.strip_prefix("refs/remotes/")?
    } else {
        refname.strip_prefix("refs/heads/")?
    };

    // Skip the symbolic `refs/remotes/<remote>/HEAD` — it tracks the remote's
    // default branch and is not a branch in its own right.
    if is_remote && name.ends_with("/HEAD") {
        return None;
    }

    let (ahead, behind, upstream_gone) = parse_track(track);
    Some(Branch {
        name: name.to_string(),
        is_current: head == "*",
        is_remote,
        upstream: if upstream.is_empty() {
            None
        } else {
            Some(upstream.to_string())
        },
        head: if oid.is_empty() {
            None
        } else {
            Some(CommitId::new(oid.to_string()))
        },
        ahead,
        behind,
        upstream_gone,
        created_at,
    })
}

/// Parse `%(upstream:track)`: `[ahead N]`, `[behind M]`, `[ahead N, behind M]`,
/// `[gone]` (upstream ref no longer exists), or empty (no upstream / in sync).
/// The runner pins `LC_ALL=C.UTF-8`, so the English keywords are stable.
fn parse_track(track: &str) -> (Option<u32>, Option<u32>, bool) {
    let inner = match track
        .trim()
        .strip_prefix('[')
        .and_then(|t| t.strip_suffix(']'))
    {
        Some(inner) => inner,
        None => return (None, None, false),
    };
    if inner == "gone" {
        return (None, None, true);
    }
    let mut ahead = None;
    let mut behind = None;
    for part in inner.split(',') {
        let part = part.trim();
        if let Some(n) = part.strip_prefix("ahead ") {
            ahead = n.parse().ok();
        } else if let Some(n) = part.strip_prefix("behind ") {
            behind = n.parse().ok();
        }
    }
    (ahead, behind, false)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build one for-each-ref line from its six fields (fixed creatordate).
    fn line(refname: &str, oid: &str, upstream: &str, head: &str, track: &str) -> String {
        format!("{refname}\t{oid}\t{upstream}\t{head}\t{track}\t1700000000")
    }

    #[test]
    fn parses_current_local_branch_with_upstream() {
        let out = line(
            "refs/heads/dev",
            "abc123",
            "refs/remotes/origin/dev",
            "*",
            "[ahead 2, behind 1]",
        );
        let branches = parse_branches(&out);
        assert_eq!(branches, vec![Branch {
            name: "dev".to_string(),
            is_current: true,
            is_remote: false,
            upstream: Some("refs/remotes/origin/dev".to_string()),
            head: Some(CommitId::new("abc123".to_string())),
            ahead: Some(2),
            behind: Some(1),
            upstream_gone: false,
            created_at: 1700000000,
        }]);
    }

    #[test]
    fn parses_local_branch_without_upstream() {
        let out = line("refs/heads/feature", "def456", "", " ", "");
        let branches = parse_branches(&out);
        assert_eq!(branches, vec![Branch {
            name: "feature".to_string(),
            is_current: false,
            is_remote: false,
            upstream: None,
            head: Some(CommitId::new("def456".to_string())),
            ahead: None,
            behind: None,
            upstream_gone: false,
            created_at: 1700000000,
        }]);
    }

    #[test]
    fn parses_remote_branch() {
        let out = line("refs/remotes/origin/dev", "abc123", "", " ", "");
        let branches = parse_branches(&out);
        assert_eq!(branches, vec![Branch {
            name: "origin/dev".to_string(),
            is_current: false,
            is_remote: true,
            upstream: None,
            head: Some(CommitId::new("abc123".to_string())),
            ahead: None,
            behind: None,
            upstream_gone: false,
            created_at: 1700000000,
        }]);
    }

    #[test]
    fn parses_track_variants() {
        assert_eq!(parse_track(""), (None, None, false));
        assert_eq!(parse_track("[ahead 3]"), (Some(3), None, false));
        assert_eq!(parse_track("[behind 7]"), (None, Some(7), false));
        assert_eq!(parse_track("[ahead 1, behind 2]"), (Some(1), Some(2), false));
        assert_eq!(parse_track("[gone]"), (None, None, true));
        // Unrecognized content inside brackets degrades to "no info", not a panic.
        assert_eq!(parse_track("[weird]"), (None, None, false));
    }

    #[test]
    fn skips_remote_head_symref() {
        let out = [
            line("refs/remotes/origin/HEAD", "abc123", "", " ", ""),
            line("refs/remotes/origin/main", "abc123", "", " ", ""),
        ]
        .join("\n");
        let branches = parse_branches(&out);
        assert_eq!(branches.len(), 1);
        assert_eq!(branches[0].name, "origin/main");
    }

    #[test]
    fn parses_multiple_lines_and_ignores_blanks() {
        let out = format!(
            "{}\n\n{}\n",
            line("refs/heads/main", "aaa", "refs/remotes/origin/main", " ", ""),
            line("refs/remotes/origin/main", "aaa", "", " ", ""),
        );
        let branches = parse_branches(&out);
        assert_eq!(branches.len(), 2);
        assert_eq!(branches[0].name, "main");
        assert_eq!(branches[1].name, "origin/main");
    }

    #[test]
    fn empty_input_yields_no_branches() {
        assert_eq!(parse_branches(""), vec![]);
    }
}
