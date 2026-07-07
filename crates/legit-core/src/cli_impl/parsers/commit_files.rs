//! Parser for the files changed by a commit, backing `commit_files()`.
//!
//! Combines two `git diff-tree -M -z` streams — `--name-status` (change kind +
//! path(s), with rename/copy detection) and `--numstat` (added/deleted line
//! counts, or `-` for binary) — keyed by the destination path. The format flags
//! live next to the parser so the contract is visible in one place
//! (DESIGN-v0.3.md §4.5).
//!
//! `-z` framing (verified against git):
//!   name-status: `M\0<path>\0`, rename/copy `R100\0<old>\0<new>\0`
//!   numstat:     `<add>\t<del>\t<path>\0`, binary `-\t-\t<path>\0`,
//!                rename `<add>\t<del>\t\0<old>\0<new>\0`

use crate::types::{CommitFileChange, FileState};
use std::collections::HashMap;
use std::path::PathBuf;

/// Common `diff-tree` flags for both streams. `-M` enables rename detection.
pub const DIFF_TREE_FLAGS: [&str; 4] = ["--no-commit-id", "-r", "-M", "-z"];

/// Counts parsed from one numstat record. Also reused by the status parser to
/// merge working-tree / index line counts into `FileStatus` entries.
pub(crate) struct NumStat {
    pub(crate) additions: u32,
    pub(crate) deletions: u32,
    pub(crate) binary: bool,
}

/// Parse and merge the `--name-status` and `--numstat` streams into one ordered
/// list (name-status order, which git sorts by path). Files present in
/// name-status but absent from numstat default to `0/0` non-binary.
pub fn parse_commit_files(name_status: &str, numstat: &str) -> Vec<CommitFileChange> {
    let counts = parse_numstat(numstat);

    let mut result = Vec::new();
    let mut tokens = name_status.split('\0');

    while let Some(status) = tokens.next() {
        if status.is_empty() {
            continue;
        }
        // First byte is the change kind; renames/copies carry a similarity
        // score (e.g. `R100`) that we don't surface.
        let kind = status.as_bytes()[0] as char;

        let (path, old_path) = if kind == 'R' || kind == 'C' {
            // `R100\0<old>\0<new>\0` — old then new.
            let old = match tokens.next() {
                Some(o) => o,
                None => break,
            };
            let new = match tokens.next() {
                Some(n) => n,
                None => break,
            };
            (new.to_string(), Some(PathBuf::from(old)))
        } else {
            let p = match tokens.next() {
                Some(p) => p,
                None => break,
            };
            (p.to_string(), None)
        };

        let stat = counts.get(&path);
        result.push(CommitFileChange {
            change: map_kind(kind),
            old_path,
            additions: stat.map(|s| s.additions).unwrap_or(0),
            deletions: stat.map(|s| s.deletions).unwrap_or(0),
            binary: stat.map(|s| s.binary).unwrap_or(false),
            path: PathBuf::from(path),
        });
    }

    result
}

/// Parse the numstat `-z` stream into `destination path -> counts`. The format
/// is identical for `diff-tree --numstat -z` and `diff --numstat -z`, so the
/// status flow reuses this for working-tree / index counts.
pub(crate) fn parse_numstat(numstat: &str) -> HashMap<String, NumStat> {
    let mut map = HashMap::new();
    let mut tokens = numstat.split('\0');

    while let Some(token) = tokens.next() {
        if token.is_empty() {
            continue;
        }
        // token = "<add>\t<del>\t<pathOrEmpty>"
        let mut fields = token.splitn(3, '\t');
        let add = fields.next().unwrap_or("");
        let del = fields.next().unwrap_or("");
        let path_field = fields.next().unwrap_or("");

        // Rename/copy: the path is empty here; old then new follow as their own
        // NUL fields. Key the counts by the new (destination) path.
        let path = if path_field.is_empty() {
            let _old = tokens.next();
            match tokens.next() {
                Some(new) => new.to_string(),
                None => break,
            }
        } else {
            path_field.to_string()
        };

        let binary = add == "-" || del == "-";
        map.insert(
            path,
            NumStat {
                additions: if binary { 0 } else { add.parse().unwrap_or(0) },
                deletions: if binary { 0 } else { del.parse().unwrap_or(0) },
                binary,
            },
        );
    }

    map
}

/// Map a diff-tree status letter to a `FileState`. `T` (typechange) folds into
/// `Modified`; anything unexpected also falls back to `Modified`.
fn map_kind(kind: char) -> FileState {
    match kind {
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

    fn z(records: &[&str]) -> String {
        let mut s = records.join("\0");
        s.push('\0');
        s
    }

    #[test]
    fn parses_modify_add_delete() {
        let ns = z(&["A", "added.txt", "D", "del.txt", "M", "keep.txt"]);
        let nm = z(&["1\t0\tadded.txt", "0\t1\tdel.txt", "3\t2\tkeep.txt"]);
        let files = parse_commit_files(&ns, &nm);
        assert_eq!(files.len(), 3);
        assert_eq!(files[0].path, PathBuf::from("added.txt"));
        assert_eq!(files[0].change, FileState::Added);
        assert_eq!((files[0].additions, files[0].deletions), (1, 0));
        assert_eq!(files[1].change, FileState::Deleted);
        assert_eq!((files[1].additions, files[1].deletions), (0, 1));
        assert_eq!(files[2].change, FileState::Modified);
        assert_eq!((files[2].additions, files[2].deletions), (3, 2));
        assert!(!files[2].binary);
    }

    #[test]
    fn parses_rename_with_old_and_new_paths() {
        // R100\0old\0new\0  +  numstat rename: "0\t0\t"\0old\0new\0
        let ns = z(&["R100", "orig.txt", "moved.txt"]);
        let nm = z(&["0\t0\t", "orig.txt", "moved.txt"]);
        let files = parse_commit_files(&ns, &nm);
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].change, FileState::Renamed);
        assert_eq!(files[0].path, PathBuf::from("moved.txt"));
        assert_eq!(files[0].old_path, Some(PathBuf::from("orig.txt")));
        assert_eq!((files[0].additions, files[0].deletions), (0, 0));
    }

    #[test]
    fn parses_rename_with_content_change_counts() {
        let ns = z(&["R86", "a/old.rs", "b/new.rs"]);
        let nm = z(&["4\t2\t", "a/old.rs", "b/new.rs"]);
        let files = parse_commit_files(&ns, &nm);
        assert_eq!(files[0].change, FileState::Renamed);
        assert_eq!(files[0].old_path, Some(PathBuf::from("a/old.rs")));
        assert_eq!((files[0].additions, files[0].deletions), (4, 2));
    }

    #[test]
    fn marks_binary_files() {
        let ns = z(&["M", "pic.bin"]);
        let nm = z(&["-\t-\tpic.bin"]);
        let files = parse_commit_files(&ns, &nm);
        assert_eq!(files.len(), 1);
        assert!(files[0].binary);
        assert_eq!((files[0].additions, files[0].deletions), (0, 0));
    }

    #[test]
    fn handles_path_with_spaces() {
        let ns = z(&["M", "dir with spaces/a b.txt"]);
        let nm = z(&["2\t1\tdir with spaces/a b.txt"]);
        let files = parse_commit_files(&ns, &nm);
        assert_eq!(files[0].path, PathBuf::from("dir with spaces/a b.txt"));
        assert_eq!((files[0].additions, files[0].deletions), (2, 1));
    }

    #[test]
    fn defaults_counts_when_numstat_missing() {
        // name-status present but numstat empty (shouldn't normally happen).
        let files = parse_commit_files(&z(&["M", "keep.txt"]), "");
        assert_eq!(files.len(), 1);
        assert_eq!((files[0].additions, files[0].deletions), (0, 0));
        assert!(!files[0].binary);
    }

    #[test]
    fn empty_input_yields_no_files() {
        assert_eq!(parse_commit_files("", ""), vec![]);
        assert_eq!(parse_commit_files("\0", "\0"), vec![]);
    }

    #[test]
    fn root_commit_all_added() {
        // diff against the empty tree: every file is an addition.
        let ns = z(&["A", "keep.txt", "A", "src/main.rs"]);
        let nm = z(&["3\t0\tkeep.txt", "10\t0\tsrc/main.rs"]);
        let files = parse_commit_files(&ns, &nm);
        assert_eq!(files.len(), 2);
        assert!(files.iter().all(|f| f.change == FileState::Added));
    }
}
