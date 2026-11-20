//! Staged-blob size measurement for the large-file commit warning
//! (design/2026-11-19-large-staged-file-warning.md): `diff --cached --raw`
//! lists what is staged RELATIVE TO HEAD (a bare `ls-files --stage` would
//! list the whole index, making every committed big file warn forever);
//! `cat-file --batch-check=%(objectsize)` sizes the blobs. Measuring INDEX
//! blobs (not worktree files) is what exempts LFS-tracked files: their
//! staged blob is a small pointer.

use crate::types::StagedBlobSize;
use std::path::PathBuf;

/// `--no-renames` keeps every record single-path; `--no-abbrev` keeps SHAs
/// feedable to cat-file.
pub const DIFF_CACHED_RAW_ARGS: [&str; 6] =
    ["diff", "--cached", "--raw", "-z", "--no-abbrev", "--no-renames"];
pub const BATCH_CHECK_SIZE_ARGS: [&str; 2] = ["cat-file", "--batch-check=%(objectsize)"];

/// `(dst_sha, path)` for every staged BLOB change in `diff --cached --raw -z`
/// output (record: `:<srcmode> <dstmode> <srcsha> <dstsha> <status>\0<path>\0`;
/// works on an unborn branch, where everything lists as `A`). Gitlinks
/// (dst mode 160000) and all-zero dst SHAs (deletions, unmerged `U` entries)
/// are skipped.
pub fn parse_staged_blobs(stdout: &str) -> Vec<(String, PathBuf)> {
    let mut out = Vec::new();
    let mut parts = stdout.split('\0');
    while let (Some(meta), Some(path)) = (parts.next(), parts.next()) {
        let Some(meta) = meta.strip_prefix(':') else { continue };
        let mut fields = meta.split(' ');
        let (Some(_src_mode), Some(dst_mode), Some(_src_sha), Some(dst_sha)) =
            (fields.next(), fields.next(), fields.next(), fields.next())
        else {
            continue;
        };
        if dst_mode == "160000" || dst_sha.bytes().all(|b| b == b'0') {
            continue;
        }
        out.push((dst_sha.to_string(), PathBuf::from(path)));
    }
    out
}

/// Pair each blob with its `--batch-check` answer line (one line per query,
/// in order). A line that is not a plain number (e.g. `<sha> missing`) drops
/// that entry without shifting the rest.
pub fn zip_blob_sizes(blobs: &[(String, PathBuf)], batch_stdout: &str) -> Vec<StagedBlobSize> {
    blobs
        .iter()
        .zip(batch_stdout.lines())
        .filter_map(|((_, path), line)| {
            line.trim().parse::<u64>().ok().map(|size| StagedBlobSize {
                path: path.clone(),
                size,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn parses_changed_staged_blobs_only() {
        let zero = "0".repeat(40);
        let stdout = format!(
            ":100644 100644 {z} {a} M\0src/lib.rs\0\
             :000000 100755 {z} {b} A\0my file.bin\0\
             :000000 160000 {z} {c} A\0sub/module\0\
             :000000 000000 {z} {z} U\0conflicted.txt\0\
             :100644 000000 {d} {z} D\0deleted.txt\0",
            z = zero,
            a = "a".repeat(40),
            b = "b".repeat(40),
            c = "c".repeat(40),
            d = "d".repeat(40),
        );
        let blobs = parse_staged_blobs(&stdout);
        assert_eq!(
            blobs,
            vec![
                ("a".repeat(40), PathBuf::from("src/lib.rs")),
                ("b".repeat(40), PathBuf::from("my file.bin")),
            ]
        );
    }

    #[test]
    fn zips_sizes_by_index() {
        let blobs = vec![
            ("a".repeat(40), PathBuf::from("small.txt")),
            ("b".repeat(40), PathBuf::from("gone.txt")),
            ("c".repeat(40), PathBuf::from("big.bin")),
        ];
        let batch = format!("12\n{} missing\n10485760\n", "b".repeat(40));
        let sizes = zip_blob_sizes(&blobs, &batch);
        assert_eq!(
            sizes,
            vec![
                StagedBlobSize { path: PathBuf::from("small.txt"), size: 12 },
                StagedBlobSize { path: PathBuf::from("big.bin"), size: 10485760 },
            ]
        );
    }
}
