//! Command contract + parser for the renormalize flow.
//!
//! `git add --renormalize -n` (dry run) turned out to be useless as a
//! preview: it lists EVERY tracked file, not the ones whose index entry
//! would change (validated against real git in `tests/git_flows.rs`'s
//! fixtures during development). Instead, the preview simulates the run on
//! a THROWAWAY INDEX: `write-tree` snapshots the real index, `read-tree`
//! rebuilds it under `GIT_INDEX_FILE`, `add --renormalize` runs against
//! that copy, and `diff-index --cached <tree>` reports exactly which
//! entries changed - the real index is never touched. The real run uses
//! the same `write-tree` + `diff-index` bracket to report what it actually
//! restaged.
//!
//! All path output goes through `--name-only -z` (NUL-separated, no
//! quoting), so the parser needs no unquoting rules at all.

/// Re-run the clean filter over all tracked files and restage them
/// (`--renormalize` implies `-u`: pending unstaged modifications and
/// deletions of tracked files are staged too).
pub const RENORMALIZE_ARGS: [&str; 4] = ["add", "--renormalize", "--", "."];

/// Prefix for listing index entries that differ from a tree; the tree sha
/// from `write-tree` is appended at call time.
pub const DIFF_INDEX_NAME_ONLY_Z: [&str; 4] = ["diff-index", "--cached", "--name-only", "-z"];

/// Suffix appended to the real index path (`rev-parse --git-path index`)
/// to name the preview's throwaway index. The command layer removes the
/// file after a preview, best-effort.
pub const RENORMALIZE_PREVIEW_INDEX_SUFFIX: &str = ".legit-renormalize-preview";

/// Parse `--name-only -z` output (NUL-separated paths, no quoting).
pub fn parse_name_only_z(text: &str) -> Vec<String> {
    text.split('\0')
        .filter(|p| !p.is_empty())
        .map(str::to_string)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_output_is_empty() {
        assert!(parse_name_only_z("").is_empty());
    }

    #[test]
    fn parses_nul_separated_paths() {
        assert_eq!(
            parse_name_only_z("a.txt\0dir/b c.txt\0"),
            vec!["a.txt", "dir/b c.txt"]
        );
    }

    #[test]
    fn no_unquoting_needed_for_special_characters() {
        // -z output is raw: quotes and non-ASCII arrive verbatim.
        assert_eq!(
            parse_name_only_z("it's.txt\0ümlaut ö.txt\0"),
            vec!["it's.txt", "ümlaut ö.txt"]
        );
    }

    #[test]
    fn tolerates_missing_trailing_nul() {
        assert_eq!(parse_name_only_z("a.txt"), vec!["a.txt"]);
    }
}
