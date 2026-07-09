//! Parser for the files changed by a commit, backing `commit_files()`.
//!
//! Combines two `git diff-tree -M -z` streams — `--raw` (modes + change kind +
//! path(s), with rename/copy detection) and `--numstat` (added/deleted line
//! counts, or `-` for binary) — keyed by the destination path. `--raw` rather
//! than `--name-status` because only the raw records carry the mode fields
//! that identify gitlinks (`160000`), which classify submodule pointer bumps
//! as `SubmoduleChanged` (spec 2026-07-08, sub-project 2). The format flags
//! live next to the parser so the contract is visible in one place
//! (DESIGN-v0.3.md §4.5).
//!
//! `-z` framing (verified against git):
//!   raw:     `:<oldmode> <newmode> <oldsha> <newsha> <status>\0<path>\0`,
//!            rename/copy `... R100\0<old>\0<new>\0`
//!   numstat: `<add>\t<del>\t<path>\0`, binary `-\t-\t<path>\0`,
//!            rename `<add>\t<del>\t\0<old>\0<new>\0`

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

/// Parse and merge the `--raw` and `--numstat` streams into one ordered list
/// (raw order, which git sorts by path). Files present in the raw stream but
/// absent from numstat default to `0/0` non-binary.
pub fn parse_commit_files(raw: &str, numstat: &str) -> Vec<CommitFileChange> {
    let counts = parse_numstat(numstat);

    let mut result = Vec::new();
    let mut tokens = raw.split('\0');

    while let Some(meta) = tokens.next() {
        // `:<oldmode> <newmode> <oldsha> <newsha> <status>` - path(s) follow
        // as separate NUL fields. Skip anything not shaped like a raw record.
        let Some(meta) = meta.strip_prefix(':') else { continue };
        let mut fields = meta.split(' ');
        let old_mode = fields.next().unwrap_or("");
        let new_mode = fields.next().unwrap_or("");
        let status = fields.nth(2).unwrap_or(""); // skip the two shas
        let Some(&kind_byte) = status.as_bytes().first() else { continue };
        // Renames/copies carry a similarity score (e.g. `R100`) we don't
        // surface.
        let kind = kind_byte as char;

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

        // A modified gitlink is a submodule pointer bump; adds/deletes of a
        // gitlink read better as plain Added/Deleted (matches status).
        let gitlink = old_mode == "160000" || new_mode == "160000";
        let change = if gitlink && matches!(kind, 'M' | 'T') {
            FileState::SubmoduleChanged
        } else {
            map_kind(kind)
        };

        let stat = counts.get(&path);
        result.push(CommitFileChange {
            change,
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

    /// Build a raw diff-tree metadata token (`-z`: path(s) follow as separate
    /// NUL fields, passed by the caller through `z(...)`).
    fn raw(old_mode: &str, new_mode: &str, status: &str) -> String {
        format!(":{old_mode} {new_mode} aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb {status}")
    }

    #[test]
    fn parses_modify_add_delete() {
        let ns = z(&[
            &raw("000000", "100644", "A"), "added.txt",
            &raw("100644", "000000", "D"), "del.txt",
            &raw("100644", "100644", "M"), "keep.txt",
        ]);
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
        // raw R100\0old\0new\0  +  numstat rename: "0\t0\t"\0old\0new\0
        let ns = z(&[&raw("100644", "100644", "R100"), "orig.txt", "moved.txt"]);
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
        let ns = z(&[&raw("100644", "100644", "R86"), "a/old.rs", "b/new.rs"]);
        let nm = z(&["4\t2\t", "a/old.rs", "b/new.rs"]);
        let files = parse_commit_files(&ns, &nm);
        assert_eq!(files[0].change, FileState::Renamed);
        assert_eq!(files[0].old_path, Some(PathBuf::from("a/old.rs")));
        assert_eq!((files[0].additions, files[0].deletions), (4, 2));
    }

    #[test]
    fn marks_binary_files() {
        let ns = z(&[&raw("100644", "100644", "M"), "pic.bin"]);
        let nm = z(&["-\t-\tpic.bin"]);
        let files = parse_commit_files(&ns, &nm);
        assert_eq!(files.len(), 1);
        assert!(files[0].binary);
        assert_eq!((files[0].additions, files[0].deletions), (0, 0));
    }

    #[test]
    fn handles_path_with_spaces() {
        let ns = z(&[&raw("100644", "100644", "M"), "dir with spaces/a b.txt"]);
        let nm = z(&["2\t1\tdir with spaces/a b.txt"]);
        let files = parse_commit_files(&ns, &nm);
        assert_eq!(files[0].path, PathBuf::from("dir with spaces/a b.txt"));
        assert_eq!((files[0].additions, files[0].deletions), (2, 1));
    }

    #[test]
    fn defaults_counts_when_numstat_missing() {
        // raw stream present but numstat empty (shouldn't normally happen).
        let files = parse_commit_files(&z(&[&raw("100644", "100644", "M"), "keep.txt"]), "");
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
        let ns = z(&[
            &raw("000000", "100644", "A"), "keep.txt",
            &raw("000000", "100644", "A"), "src/main.rs",
        ]);
        let nm = z(&["3\t0\tkeep.txt", "10\t0\tsrc/main.rs"]);
        let files = parse_commit_files(&ns, &nm);
        assert_eq!(files.len(), 2);
        assert!(files.iter().all(|f| f.change == FileState::Added));
    }

    #[test]
    fn gitlink_modification_becomes_submodule_changed() {
        let ns = z(&[&raw("160000", "160000", "M"), "vendor/lib"]);
        let nm = z(&["0\t0\tvendor/lib"]);
        let files = parse_commit_files(&ns, &nm);
        assert_eq!(files[0].change, FileState::SubmoduleChanged);
    }

    #[test]
    fn gitlink_add_and_delete_stay_added_deleted() {
        let ns = z(&[
            &raw("000000", "160000", "A"), "vendor/new",
            &raw("160000", "000000", "D"), "vendor/gone",
        ]);
        let files = parse_commit_files(&ns, "");
        assert_eq!(files[0].change, FileState::Added);
        assert_eq!(files[1].change, FileState::Deleted);
    }
}
