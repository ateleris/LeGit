//! Parser for `git status --porcelain=v1 -z` output backing `status()`.
//!
//! The format flags live here next to the parser so the contract is visible in
//! one place (DESIGN-v0.3.md §4.5). `--porcelain=v1` gives a stable, two-column
//! `XY <path>` record per change; `-z` makes records NUL-separated and disables
//! path quoting, so paths with spaces/unicode pass through verbatim.

use crate::types::{FileState, FileStatus};
use std::path::PathBuf;

/// Arguments for the status command, in order. `-z` is required for the NUL
/// framing this parser assumes.
pub const STATUS_ARGS: [&str; 3] = ["status", "--porcelain=v1", "-z"];

/// Parse the stdout of `git status --porcelain=v1 -z`.
///
/// Each record is `XY <path>` where `X` is the index (staged) column and `Y`
/// the working-tree column. A non-blank, non-untracked `X` yields a staged
/// `FileStatus`; a non-blank `Y` yields a working-tree one — so a path that is
/// both staged and then re-modified produces two entries. Untracked (`??`) maps
/// to a single `Untracked` entry, unmerged records (containing `U`, or the
/// `AA`/`DD` both-sides forms) to a single `Conflicted` entry.
///
/// Rename/copy records (`R`/`C`) are followed by a second NUL-terminated field
/// carrying the original path; it is consumed and ignored (we report the new
/// path only).
pub fn parse_status(output: &str) -> Vec<FileStatus> {
    let mut result = Vec::new();
    let mut tokens = output.split('\0');

    while let Some(entry) = tokens.next() {
        // The trailing `-z` separator produces a final empty token; blank
        // tokens are never valid records.
        if entry.len() < 3 {
            continue;
        }
        let bytes = entry.as_bytes();
        let x = bytes[0] as char;
        let y = bytes[1] as char;
        // Byte offset 3 is safe: X, Y and the separating space are all ASCII.
        let path = &entry[3..];

        // Rename/copy carries the original path as the next NUL field — consume it.
        if x == 'R' || x == 'C' || y == 'R' || y == 'C' {
            tokens.next();
        }

        // Unmerged (conflict) records: either column is `U`, or the both-sides
        // `AA`/`DD` forms. Reported once, not split into staged/unstaged.
        if x == 'U' || y == 'U' || (x == 'A' && y == 'A') || (x == 'D' && y == 'D') {
            result.push(FileStatus {
                path: PathBuf::from(path),
                state: FileState::Conflicted,
                staged: false,
            });
            continue;
        }

        // Untracked / ignored: single entry, never staged.
        if x == '?' {
            result.push(FileStatus {
                path: PathBuf::from(path),
                state: FileState::Untracked,
                staged: false,
            });
            continue;
        }
        if x == '!' {
            result.push(FileStatus {
                path: PathBuf::from(path),
                state: FileState::Ignored,
                staged: false,
            });
            continue;
        }

        // Staged change (index column).
        if x != ' ' {
            result.push(FileStatus {
                path: PathBuf::from(path),
                state: map_code(x),
                staged: true,
            });
        }
        // Working-tree change (worktree column).
        if y != ' ' {
            result.push(FileStatus {
                path: PathBuf::from(path),
                state: map_code(y),
                staged: false,
            });
        }
    }

    result
}

/// Map a single porcelain status code to a `FileState`. `T` (typechange) folds
/// into `Modified`; anything unexpected also falls back to `Modified`.
fn map_code(code: char) -> FileState {
    match code {
        'A' => FileState::Added,
        'D' => FileState::Deleted,
        'R' => FileState::Renamed,
        'C' => FileState::Copied,
        'M' | 'T' => FileState::Modified,
        _ => FileState::Modified,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Join porcelain records into a single `-z` stream (trailing NUL included).
    fn stream(records: &[&str]) -> String {
        let mut s = records.join("\0");
        s.push('\0');
        s
    }

    #[test]
    fn parses_working_tree_modification() {
        let out = stream(&[" M src/main.rs"]);
        assert_eq!(
            parse_status(&out),
            vec![FileStatus {
                path: PathBuf::from("src/main.rs"),
                state: FileState::Modified,
                staged: false,
            }]
        );
    }

    #[test]
    fn parses_staged_addition() {
        let out = stream(&["A  new.txt"]);
        assert_eq!(
            parse_status(&out),
            vec![FileStatus {
                path: PathBuf::from("new.txt"),
                state: FileState::Added,
                staged: true,
            }]
        );
    }

    #[test]
    fn splits_staged_and_restaged_modification() {
        // Staged modification then further modified in the working tree.
        let out = stream(&["MM file.rs"]);
        assert_eq!(
            parse_status(&out),
            vec![
                FileStatus {
                    path: PathBuf::from("file.rs"),
                    state: FileState::Modified,
                    staged: true,
                },
                FileStatus {
                    path: PathBuf::from("file.rs"),
                    state: FileState::Modified,
                    staged: false,
                },
            ]
        );
    }

    #[test]
    fn parses_untracked() {
        let out = stream(&["?? scratch.tmp"]);
        assert_eq!(
            parse_status(&out),
            vec![FileStatus {
                path: PathBuf::from("scratch.tmp"),
                state: FileState::Untracked,
                staged: false,
            }]
        );
    }

    #[test]
    fn parses_rename_and_consumes_original_path() {
        // `R  new\0old\0` — the original path is a separate field.
        let out = stream(&["R  new.rs", "old.rs"]);
        assert_eq!(
            parse_status(&out),
            vec![FileStatus {
                path: PathBuf::from("new.rs"),
                state: FileState::Renamed,
                staged: true,
            }]
        );
    }

    #[test]
    fn parses_conflict() {
        let out = stream(&["UU merged.rs"]);
        assert_eq!(
            parse_status(&out),
            vec![FileStatus {
                path: PathBuf::from("merged.rs"),
                state: FileState::Conflicted,
                staged: false,
            }]
        );
    }

    #[test]
    fn parses_path_with_spaces() {
        let out = stream(&[" M dir with spaces/a b.txt"]);
        assert_eq!(
            parse_status(&out),
            vec![FileStatus {
                path: PathBuf::from("dir with spaces/a b.txt"),
                state: FileState::Modified,
                staged: false,
            }]
        );
    }

    #[test]
    fn empty_input_yields_no_changes() {
        assert_eq!(parse_status(""), vec![]);
        assert_eq!(parse_status("\0"), vec![]);
    }

    #[test]
    fn parses_multiple_records() {
        let out = stream(&["A  added.rs", " D removed.rs", "?? untracked.rs"]);
        let parsed = parse_status(&out);
        assert_eq!(parsed.len(), 3);
        assert_eq!(parsed[0].state, FileState::Added);
        assert!(parsed[0].staged);
        assert_eq!(parsed[1].state, FileState::Deleted);
        assert!(!parsed[1].staged);
        assert_eq!(parsed[2].state, FileState::Untracked);
    }
}
