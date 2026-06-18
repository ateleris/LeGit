//! Parser for a single file's unified diff, backing `file_diff()`.
//!
//! Input is the stdout of `git diff [...] -U<n> -- <path>` for ONE file: a
//! `diff --git` header, optional `index`/`new file`/`deleted file` lines, the
//! `--- ` / `+++ ` path pair (or `Binary files … differ`), then one or more
//! `@@ … @@` hunks. We turn that into a `DiffEntry` (`Text` or `Binary`).
//!
//! Hunk line counts may be omitted when they are `1` (e.g. `@@ -1 +1 @@`), and
//! a `\ No newline at end of file` marker may follow any side's last line — it
//! is not itself a diff line and is skipped.

use crate::types::{BinaryDiff, DiffEntry, DiffHunk, DiffLine, DiffLineKind, TextDiff};
use std::path::PathBuf;

/// Parse one file's unified-diff text into a `DiffEntry`.
pub fn parse_file_diff(stdout: &str) -> DiffEntry {
    let mut old_path: Option<PathBuf> = None;
    let mut new_path: Option<PathBuf> = None;
    let mut hunks: Vec<DiffHunk> = Vec::new();

    for line in stdout.lines() {
        if let Some(rest) = line.strip_prefix("--- ") {
            old_path = side_path(rest);
        } else if let Some(rest) = line.strip_prefix("+++ ") {
            new_path = side_path(rest);
        } else if line.starts_with("Binary files ") || line.starts_with("GIT binary patch") {
            // `Binary files a/x and b/x differ` — fall back to the `diff --git`
            // header paths, which are always present and unambiguous.
            let (o, n) = git_header_paths(stdout);
            return DiffEntry::Binary(BinaryDiff {
                old_path: o,
                new_path: n,
                old_size: None,
                new_size: None,
            });
        } else if line.starts_with("@@") {
            if let Some(h) = parse_hunk_header(line) {
                hunks.push(h);
            }
        } else if let Some(h) = hunks.last_mut() {
            // Inside a hunk: classify the line by its first byte. The leading
            // marker char is stripped from `content`.
            match line.as_bytes().first() {
                Some(b'+') => h.lines.push(DiffLine {
                    kind: DiffLineKind::Added,
                    content: line[1..].to_string(),
                }),
                Some(b'-') => h.lines.push(DiffLine {
                    kind: DiffLineKind::Removed,
                    content: line[1..].to_string(),
                }),
                Some(b' ') => h.lines.push(DiffLine {
                    kind: DiffLineKind::Context,
                    content: line[1..].to_string(),
                }),
                // `\ No newline at end of file` and blank separators: not lines.
                _ => {}
            }
        }
    }

    DiffEntry::Text(TextDiff {
        old_path,
        new_path,
        hunks,
    })
}

/// Resolve a `--- ` / `+++ ` operand to a path. `/dev/null` (add/delete) and an
/// empty operand map to `None`; otherwise strip the `a/`/`b/` prefix and any
/// trailing tab-delimited metadata git may append.
fn side_path(operand: &str) -> Option<PathBuf> {
    let raw = operand.split('\t').next().unwrap_or(operand).trim_end();
    if raw.is_empty() || raw == "/dev/null" {
        return None;
    }
    let stripped = raw
        .strip_prefix("a/")
        .or_else(|| raw.strip_prefix("b/"))
        .unwrap_or(raw);
    Some(PathBuf::from(stripped))
}

/// Pull the two paths out of the `diff --git a/<old> b/<new>` header line.
/// Used for binary diffs, which have no `--- `/`+++ ` operands to read.
fn git_header_paths(stdout: &str) -> (Option<PathBuf>, Option<PathBuf>) {
    for line in stdout.lines() {
        if let Some(rest) = line.strip_prefix("diff --git ") {
            // `a/<old> b/<new>` — find the ` b/` boundary.
            if let Some(idx) = rest.find(" b/") {
                let old = side_path(&rest[..idx]);
                let new = side_path(&rest[idx + 1..]);
                return (old, new);
            }
        }
    }
    (None, None)
}

/// Parse `@@ -<os>[,<ol>] +<ns>[,<nl>] @@[ section]` into a hunk with no lines.
fn parse_hunk_header(line: &str) -> Option<DiffHunk> {
    let rest = line.strip_prefix("@@ ")?;
    let close = rest.find(" @@")?;
    let ranges = &rest[..close];
    let mut parts = ranges.split_whitespace();
    let (old_start, old_lines) = parse_range(parts.next()?.strip_prefix('-')?)?;
    let (new_start, new_lines) = parse_range(parts.next()?.strip_prefix('+')?)?;
    Some(DiffHunk {
        old_start,
        old_lines,
        new_start,
        new_lines,
        header: line.to_string(),
        lines: Vec::new(),
    })
}

/// Parse a `<start>[,<count>]` range; a missing count means `1`.
fn parse_range(range: &str) -> Option<(u32, u32)> {
    let mut nums = range.split(',');
    let start = nums.next()?.parse().ok()?;
    let count = match nums.next() {
        Some(c) => c.parse().ok()?,
        None => 1,
    };
    Some((start, count))
}

/// Build a minimal, self-contained patch for a single hunk of a file diff,
/// suitable for `git apply [--cached] [-R] --recount`. Works by slicing the raw
/// `git diff` output — the file preamble (everything before the first `@@`)
/// followed by just the `hunk_index`-th hunk block — so `\ No newline at end of
/// file` markers and file-mode headers are preserved verbatim. Returns `None`
/// if there is no hunk at `hunk_index`.
pub fn build_hunk_patch(raw_diff: &str, hunk_index: usize) -> Option<String> {
    let mut preamble: Vec<&str> = Vec::new();
    let mut hunks: Vec<Vec<&str>> = Vec::new();

    for line in raw_diff.lines() {
        if line.starts_with("@@") {
            hunks.push(vec![line]);
        } else if let Some(current) = hunks.last_mut() {
            current.push(line);
        } else {
            preamble.push(line);
        }
    }

    let hunk = hunks.get(hunk_index)?;
    let mut patch = String::new();
    for line in preamble.iter().chain(hunk.iter()) {
        patch.push_str(line);
        patch.push('\n');
    }
    Some(patch)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(entry: DiffEntry) -> TextDiff {
        match entry {
            DiffEntry::Text(t) => t,
            other => panic!("expected Text, got {other:?}"),
        }
    }

    #[test]
    fn parses_single_hunk_modification() {
        let diff = "\
diff --git a/foo.txt b/foo.txt
index e69de29..d95f3ad 100644
--- a/foo.txt
+++ b/foo.txt
@@ -1,3 +1,4 @@ fn main()
 context line
-removed line
+added line
+another added
 trailing context
";
        let t = text(parse_file_diff(diff));
        assert_eq!(t.old_path, Some(PathBuf::from("foo.txt")));
        assert_eq!(t.new_path, Some(PathBuf::from("foo.txt")));
        assert_eq!(t.hunks.len(), 1);
        let h = &t.hunks[0];
        assert_eq!((h.old_start, h.old_lines), (1, 3));
        assert_eq!((h.new_start, h.new_lines), (1, 4));
        assert_eq!(h.header, "@@ -1,3 +1,4 @@ fn main()");
        let kinds: Vec<_> = h.lines.iter().map(|l| l.kind.clone()).collect();
        assert_eq!(
            kinds,
            vec![
                DiffLineKind::Context,
                DiffLineKind::Removed,
                DiffLineKind::Added,
                DiffLineKind::Added,
                DiffLineKind::Context,
            ]
        );
        assert_eq!(h.lines[2].content, "added line");
    }

    #[test]
    fn parses_added_file() {
        let diff = "\
diff --git a/new.txt b/new.txt
new file mode 100644
index 0000000..3b18e51
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,2 @@
+hello
+world
";
        let t = text(parse_file_diff(diff));
        assert_eq!(t.old_path, None);
        assert_eq!(t.new_path, Some(PathBuf::from("new.txt")));
        assert_eq!(t.hunks.len(), 1);
        assert!(t.hunks[0]
            .lines
            .iter()
            .all(|l| l.kind == DiffLineKind::Added));
    }

    #[test]
    fn parses_deleted_file() {
        let diff = "\
diff --git a/gone.txt b/gone.txt
deleted file mode 100644
index 3b18e51..0000000
--- a/gone.txt
+++ /dev/null
@@ -1,2 +0,0 @@
-hello
-world
";
        let t = text(parse_file_diff(diff));
        assert_eq!(t.old_path, Some(PathBuf::from("gone.txt")));
        assert_eq!(t.new_path, None);
        assert!(t.hunks[0]
            .lines
            .iter()
            .all(|l| l.kind == DiffLineKind::Removed));
    }

    #[test]
    fn parses_multiple_hunks() {
        let diff = "\
diff --git a/x.rs b/x.rs
--- a/x.rs
+++ b/x.rs
@@ -1,2 +1,2 @@
 a
-b
+B
@@ -10,2 +10,2 @@ fn other()
 c
-d
+D
";
        let t = text(parse_file_diff(diff));
        assert_eq!(t.hunks.len(), 2);
        assert_eq!((t.hunks[1].new_start, t.hunks[1].new_lines), (10, 2));
        assert_eq!(t.hunks[1].header, "@@ -10,2 +10,2 @@ fn other()");
    }

    #[test]
    fn defaults_omitted_counts_to_one() {
        let diff = "\
diff --git a/s.txt b/s.txt
--- a/s.txt
+++ b/s.txt
@@ -1 +1 @@
-old
+new
";
        let t = text(parse_file_diff(diff));
        let h = &t.hunks[0];
        assert_eq!((h.old_start, h.old_lines), (1, 1));
        assert_eq!((h.new_start, h.new_lines), (1, 1));
    }

    #[test]
    fn skips_no_newline_marker() {
        let diff = "\
diff --git a/n.txt b/n.txt
--- a/n.txt
+++ b/n.txt
@@ -1 +1 @@
-old
\\ No newline at end of file
+new
\\ No newline at end of file
";
        let t = text(parse_file_diff(diff));
        let kinds: Vec<_> = t.hunks[0].lines.iter().map(|l| l.kind.clone()).collect();
        assert_eq!(kinds, vec![DiffLineKind::Removed, DiffLineKind::Added]);
    }

    #[test]
    fn detects_binary_diff() {
        let diff = "\
diff --git a/img.png b/img.png
index aaaaaaa..bbbbbbb 100644
Binary files a/img.png and b/img.png differ
";
        match parse_file_diff(diff) {
            DiffEntry::Binary(BinaryDiff {
                old_path, new_path, ..
            }) => {
                assert_eq!(old_path, Some(PathBuf::from("img.png")));
                assert_eq!(new_path, Some(PathBuf::from("img.png")));
            }
            other => panic!("expected Binary, got {other:?}"),
        }
    }

    #[test]
    fn empty_input_yields_empty_text_diff() {
        let t = text(parse_file_diff(""));
        assert_eq!(t.old_path, None);
        assert_eq!(t.new_path, None);
        assert!(t.hunks.is_empty());
    }

    const TWO_HUNK_DIFF: &str = "\
diff --git a/x.rs b/x.rs
index 1111111..2222222 100644
--- a/x.rs
+++ b/x.rs
@@ -1,2 +1,2 @@
 a
-b
+B
@@ -10,2 +10,2 @@ fn other()
 c
-d
+D
";

    #[test]
    fn builds_patch_for_first_hunk_only() {
        let patch = build_hunk_patch(TWO_HUNK_DIFF, 0).unwrap();
        assert_eq!(
            patch,
            "\
diff --git a/x.rs b/x.rs
index 1111111..2222222 100644
--- a/x.rs
+++ b/x.rs
@@ -1,2 +1,2 @@
 a
-b
+B
"
        );
    }

    #[test]
    fn builds_patch_for_second_hunk_only() {
        let patch = build_hunk_patch(TWO_HUNK_DIFF, 1).unwrap();
        assert_eq!(
            patch,
            "\
diff --git a/x.rs b/x.rs
index 1111111..2222222 100644
--- a/x.rs
+++ b/x.rs
@@ -10,2 +10,2 @@ fn other()
 c
-d
+D
"
        );
    }

    #[test]
    fn returns_none_for_out_of_range_hunk() {
        assert!(build_hunk_patch(TWO_HUNK_DIFF, 2).is_none());
        assert!(build_hunk_patch("", 0).is_none());
    }

    #[test]
    fn preserves_no_newline_marker_in_patch() {
        let diff = "\
diff --git a/n.txt b/n.txt
--- a/n.txt
+++ b/n.txt
@@ -1 +1 @@
-old
\\ No newline at end of file
+new
\\ No newline at end of file
";
        let patch = build_hunk_patch(diff, 0).unwrap();
        assert!(patch.contains("\\ No newline at end of file"));
    }
}
