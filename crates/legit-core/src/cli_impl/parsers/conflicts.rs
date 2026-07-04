//! Parser for `git ls-files -u -z` (unmerged index entries) backing
//! `conflict_entries()`. Format (one record per stage, NUL-terminated):
//! `<mode> <sha> <stage>\t<path>` with stage 1 = base, 2 = ours, 3 = theirs.
//! The args live next to the parser so the contract is in one place.

use crate::error::GitError;
use crate::types::{ConflictEntry, ConflictKind};
use std::collections::BTreeMap;

pub const LS_FILES_UNMERGED_ARGS: [&str; 3] = ["ls-files", "-u", "-z"];

/// Parse the stdout of `git ls-files -u -z` into one entry per conflicted
/// path, classifying by which stages are present.
pub fn parse_unmerged(stdout: &str) -> Result<Vec<ConflictEntry>, GitError> {
    // path -> (has_base, has_ours, has_theirs); BTreeMap keeps the output
    // deterministic (sorted by path).
    let mut stages: BTreeMap<String, (bool, bool, bool)> = BTreeMap::new();
    for record in stdout.split('\0').filter(|r| !r.is_empty()) {
        let (meta, path) = record.split_once('\t').ok_or_else(|| {
            GitError::Parse(format!("ls-files -u record without tab: {record:?}"))
        })?;
        let stage = meta
            .rsplit(' ')
            .next()
            .and_then(|s| s.parse::<u8>().ok())
            .ok_or_else(|| {
                GitError::Parse(format!("ls-files -u record without stage: {record:?}"))
            })?;
        let entry = stages.entry(path.to_string()).or_default();
        match stage {
            1 => entry.0 = true,
            2 => entry.1 = true,
            3 => entry.2 = true,
            other => {
                return Err(GitError::Parse(format!("unexpected ls-files stage {other}")));
            }
        }
    }
    Ok(stages
        .into_iter()
        .map(|(path, (base, ours, theirs))| {
            let kind = match (base, ours, theirs) {
                (_, true, false) => ConflictKind::DeletedByThem,
                (_, false, true) => ConflictKind::DeletedByUs,
                (false, true, true) => ConflictKind::BothAdded,
                _ => ConflictKind::BothModified,
            };
            ConflictEntry { path, kind }
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(mode: &str, sha: &str, stage: u8, path: &str) -> String {
        format!("{mode} {sha} {stage}\t{path}\0")
    }
    const SHA: &str = "0123456789abcdef0123456789abcdef01234567";

    #[test]
    fn empty_output_is_no_conflicts() {
        assert_eq!(parse_unmerged("").unwrap(), vec![]);
    }

    #[test]
    fn all_three_stages_is_both_modified() {
        let s = [
            rec("100644", SHA, 1, "a.txt"),
            rec("100644", SHA, 2, "a.txt"),
            rec("100644", SHA, 3, "a.txt"),
        ]
        .concat();
        assert_eq!(
            parse_unmerged(&s).unwrap(),
            vec![ConflictEntry {
                path: "a.txt".into(),
                kind: ConflictKind::BothModified
            }]
        );
    }

    #[test]
    fn no_base_is_both_added() {
        let s = [rec("100644", SHA, 2, "a.txt"), rec("100644", SHA, 3, "a.txt")].concat();
        assert_eq!(parse_unmerged(&s).unwrap()[0].kind, ConflictKind::BothAdded);
    }

    #[test]
    fn missing_theirs_is_deleted_by_them() {
        let s = [rec("100644", SHA, 1, "a.txt"), rec("100644", SHA, 2, "a.txt")].concat();
        assert_eq!(parse_unmerged(&s).unwrap()[0].kind, ConflictKind::DeletedByThem);
    }

    #[test]
    fn missing_ours_is_deleted_by_us() {
        let s = [rec("100644", SHA, 1, "a.txt"), rec("100644", SHA, 3, "a.txt")].concat();
        assert_eq!(parse_unmerged(&s).unwrap()[0].kind, ConflictKind::DeletedByUs);
    }

    #[test]
    fn multiple_paths_and_spaces_in_paths_handled() {
        let s = [
            rec("100644", SHA, 2, "dir/with space.txt"),
            rec("100644", SHA, 3, "dir/with space.txt"),
            rec("100644", SHA, 1, "b.txt"),
            rec("100644", SHA, 2, "b.txt"),
            rec("100644", SHA, 3, "b.txt"),
        ]
        .concat();
        let got = parse_unmerged(&s).unwrap();
        assert_eq!(got.len(), 2);
        assert!(got.iter().any(|e| e.path == "dir/with space.txt"));
    }
}
