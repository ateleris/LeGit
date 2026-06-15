//! Parser for `git for-each-ref` output backing `branches()`.
//!
//! The format string lives here next to the parser so the contract is visible
//! in one place (DESIGN-v0.3.md §4.5). Fields are tab-separated (refnames
//! cannot contain tabs), one ref per line.

use crate::types::{Branch, CommitId};

/// `--format=` argument for `git for-each-ref`. Fields, tab-separated:
///   refname (full) · objectname (commit sha) · upstream (full ref) · HEAD marker
pub const BRANCH_FORMAT: &str =
    "%(refname)\t%(objectname)\t%(upstream)\t%(HEAD)";

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
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build one for-each-ref line from its four fields.
    fn line(refname: &str, oid: &str, upstream: &str, head: &str) -> String {
        format!("{refname}\t{oid}\t{upstream}\t{head}")
    }

    #[test]
    fn parses_current_local_branch_with_upstream() {
        let out = line("refs/heads/dev", "abc123", "refs/remotes/origin/dev", "*");
        let branches = parse_branches(&out);
        assert_eq!(branches, vec![Branch {
            name: "dev".to_string(),
            is_current: true,
            is_remote: false,
            upstream: Some("refs/remotes/origin/dev".to_string()),
            head: Some(CommitId::new("abc123".to_string())),
        }]);
    }

    #[test]
    fn parses_local_branch_without_upstream() {
        let out = line("refs/heads/feature", "def456", "", " ");
        let branches = parse_branches(&out);
        assert_eq!(branches, vec![Branch {
            name: "feature".to_string(),
            is_current: false,
            is_remote: false,
            upstream: None,
            head: Some(CommitId::new("def456".to_string())),
        }]);
    }

    #[test]
    fn parses_remote_branch() {
        let out = line("refs/remotes/origin/dev", "abc123", "", " ");
        let branches = parse_branches(&out);
        assert_eq!(branches, vec![Branch {
            name: "origin/dev".to_string(),
            is_current: false,
            is_remote: true,
            upstream: None,
            head: Some(CommitId::new("abc123".to_string())),
        }]);
    }

    #[test]
    fn skips_remote_head_symref() {
        let out = [
            line("refs/remotes/origin/HEAD", "abc123", "", " "),
            line("refs/remotes/origin/main", "abc123", "", " "),
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
            line("refs/heads/main", "aaa", "refs/remotes/origin/main", " "),
            line("refs/remotes/origin/main", "aaa", "", " "),
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
