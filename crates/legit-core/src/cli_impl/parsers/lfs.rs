//! Git LFS text formats: pointer files and `.gitattributes` track lines.

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LfsPointer {
    pub oid: String,
    pub size: u64,
}

// Mirror of the strict frontend grammar in src/lib/lfsPointer.ts: version
// line first, `oid sha256:<64 lowercase hex>` and `size <n>` among
// key-value lines, whole pointer under 1024 bytes. Strictness matters: a
// false positive would divert a real file into the LFS lookup.
const VERSION_PREFIX: &str = "version https://git-lfs.github.com/spec/";

const MAX_POINTER_BYTES: usize = 1024;

fn is_key_value(line: &str) -> bool {
    match line.split_once(' ') {
        Some((key, value)) => {
            !key.is_empty()
                && key.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
                && value.chars().next().is_some_and(|c| !c.is_whitespace())
        }
        None => false,
    }
}

pub fn parse_lfs_pointer(bytes: &[u8]) -> Option<LfsPointer> {
    if bytes.is_empty() || bytes.len() >= MAX_POINTER_BYTES {
        return None;
    }
    let text = std::str::from_utf8(bytes).ok()?;
    let mut lines = text.strip_suffix('\n').unwrap_or(text).lines();
    if !lines.next()?.starts_with(VERSION_PREFIX) {
        return None;
    }
    let (mut oid, mut size) = (None, None);
    for line in lines {
        if let Some(hex) = line.strip_prefix("oid sha256:") {
            if hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
                oid = Some(hex.to_string());
                continue;
            }
        }
        if let Some(n) = line.strip_prefix("size ") {
            if let Ok(v) = n.parse::<u64>() {
                size = Some(v);
                continue;
            }
        }
        // Unknown keys (pointer extensions) are fine; a non key-value line
        // means this is not a pointer at all.
        if !is_key_value(line) {
            return None;
        }
    }
    Some(LfsPointer { oid: oid?, size: size? })
}

/// `<git-dir>/lfs/objects/<oid[0..2]>/<oid[2..4]>/<oid>` (the LFS store is
/// plain files; oid is validated 64-hex by the parser). Textual '/' join:
/// the git dir may be a remote posix path on a Windows app build.
pub fn lfs_object_path(git_dir: &crate::fs::HostPath, oid: &str) -> crate::fs::HostPath {
    git_dir.join(&format!("lfs/objects/{}/{}/{oid}", &oid[..2], &oid[2..4]))
}

/// The attribute set `git lfs track` writes; a tracked line consisting of a
/// subset of these can be removed safely, anything extra must not be dropped.
const LFS_ATTRS: [&str; 4] = ["filter=lfs", "diff=lfs", "merge=lfs", "-text"];

/// Split a `.gitattributes` line into (pattern, attrs). The pattern token may
/// be double-quoted (patterns containing whitespace). None for blank/comment
/// lines or a dangling quote.
fn split_attr_line(line: &str) -> Option<(String, Vec<&str>)> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') {
        return None;
    }
    if let Some(rest) = line.strip_prefix('"') {
        let end = rest.find('"')?;
        Some((rest[..end].to_string(), rest[end + 1..].split_whitespace().collect()))
    } else {
        let mut parts = line.split_whitespace();
        let pattern = parts.next()?.to_string();
        Some((pattern, parts.collect()))
    }
}

/// Patterns whose attributes include `filter=lfs`, in file order.
pub fn parse_lfs_patterns(text: &str) -> Vec<String> {
    text.lines()
        .filter_map(split_attr_line)
        .filter(|(_, attrs)| attrs.contains(&"filter=lfs"))
        .map(|(pattern, _)| pattern)
        .collect()
}

/// The exact line `git lfs track <pattern>` would write (quoted when the
/// pattern contains whitespace).
pub fn format_track_line(pattern: &str) -> String {
    let quoted = if pattern.chars().any(char::is_whitespace) {
        format!("\"{pattern}\"")
    } else {
        pattern.to_string()
    };
    format!("{quoted} filter=lfs diff=lfs merge=lfs -text")
}

/// Append a track line for `pattern`. None = already tracked (no-op).
/// Preserves existing content and guarantees a trailing newline.
pub fn add_lfs_pattern(existing: &str, pattern: &str) -> Option<String> {
    if parse_lfs_patterns(existing).iter().any(|p| p == pattern) {
        return None;
    }
    let mut out = existing.to_string();
    if !out.is_empty() && !out.ends_with('\n') {
        out.push('\n');
    }
    out.push_str(&format_track_line(pattern));
    out.push('\n');
    Some(out)
}

/// Remove `pattern`'s LFS line. Ok(None) = not tracked (no-op). Err when the
/// matching line carries attributes beyond the standard LFS set - refusing
/// beats silently dropping the user's other attributes.
pub fn remove_lfs_pattern(existing: &str, pattern: &str) -> Result<Option<String>, String> {
    let mut removed = false;
    let mut kept: Vec<&str> = Vec::new();
    for line in existing.lines() {
        match split_attr_line(line) {
            Some((p, attrs)) if p == pattern && attrs.contains(&"filter=lfs") => {
                if attrs.iter().any(|a| !LFS_ATTRS.contains(a)) {
                    return Err(format!(
                        "the .gitattributes line for \"{pattern}\" carries attributes \
                         besides the standard LFS set; edit .gitattributes directly \
                         so they are not lost"
                    ));
                }
                removed = true;
            }
            _ => kept.push(line),
        }
    }
    if !removed {
        return Ok(None);
    }
    let mut out = kept.join("\n");
    if !out.is_empty() {
        out.push('\n');
    }
    Ok(Some(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    const POINTER: &str = "version https://git-lfs.github.com/spec/v1\noid sha256:4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393\nsize 12345\n";

    #[test]
    fn parses_lfs_pointers_strictly() {
        let p = parse_lfs_pointer(POINTER.as_bytes()).expect("pointer");
        assert_eq!(p.oid, "4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393");
        assert_eq!(p.size, 12345);
        // Extension key-value lines are tolerated.
        let ext = format!("{POINTER}x-custom value\n");
        assert!(parse_lfs_pointer(ext.as_bytes()).is_some());
        // Rejected: no version line, non key-value line, missing oid/size,
        // binary bytes, oversized pointer.
        assert!(parse_lfs_pointer(b"oid sha256:abcd\nsize 1\n").is_none());
        // A line that is not `key value` shaped (no space / bad key chars)
        // disqualifies the whole blob. NOTE: "not a pointer!" WOULD pass as
        // key "not" + value - the grammar (like the TS original) tolerates
        // unknown keys, so the rejection needs a structurally invalid line.
        let junk = format!("{POINTER}definitely_not_a_key_value_line\n");
        assert!(parse_lfs_pointer(junk.as_bytes()).is_none());
        let bad_key = format!("{POINTER}b@d key\n");
        assert!(parse_lfs_pointer(bad_key.as_bytes()).is_none());
        assert!(parse_lfs_pointer(b"version https://git-lfs.github.com/spec/v1\nsize 1\n").is_none());
        assert!(parse_lfs_pointer(&[0x89, 0x50, 0x00, 0x47]).is_none());
        let huge = format!("version https://git-lfs.github.com/spec/v1\n{}", "k v\n".repeat(300));
        assert!(parse_lfs_pointer(huge.as_bytes()).is_none());
    }

    #[test]
    fn lfs_object_path_layout() {
        // Textual '/' joins: a remote posix git dir must never grow '\\' on a
        // Windows app build.
        let oid = "4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393";
        assert_eq!(
            lfs_object_path(&crate::fs::HostPath("/repo/.git".into()), oid).as_str(),
            format!("/repo/.git/lfs/objects/4d/7a/{oid}")
        );
    }

    #[test]
    fn parse_lfs_patterns_shapes() {
        let text = "\
# comment\n\
*.png filter=lfs diff=lfs merge=lfs -text\n\
\"my file.psd\" filter=lfs diff=lfs merge=lfs -text\n\
*.txt text eol=lf\n\
*.bin filter=lfs\n";
        let patterns = parse_lfs_patterns(text);
        assert_eq!(patterns, vec!["*.png", "my file.psd", "*.bin"]);
        assert!(parse_lfs_patterns("").is_empty());
    }

    #[test]
    fn add_lfs_pattern_appends_and_dedupes() {
        // Create-from-empty, with trailing newline.
        let out = add_lfs_pattern("", "*.png").expect("added");
        assert_eq!(out, "*.png filter=lfs diff=lfs merge=lfs -text\n");
        // Append preserves existing content and fixes a missing final newline.
        let out = add_lfs_pattern("*.txt text eol=lf", "*.png").expect("added");
        assert_eq!(out, "*.txt text eol=lf\n*.png filter=lfs diff=lfs merge=lfs -text\n");
        // Whitespace patterns are quoted on write.
        let out = add_lfs_pattern("", "my file.psd").expect("added");
        assert_eq!(out, "\"my file.psd\" filter=lfs diff=lfs merge=lfs -text\n");
        // Duplicate (plain and quoted existing forms) is a no-op.
        assert!(add_lfs_pattern("*.png filter=lfs diff=lfs merge=lfs -text\n", "*.png").is_none());
        assert!(add_lfs_pattern("\"my file.psd\" filter=lfs\n", "my file.psd").is_none());
    }

    #[test]
    fn remove_lfs_pattern_rules() {
        let text = "*.txt text eol=lf\n*.png filter=lfs diff=lfs merge=lfs -text\n";
        // Standard line removed, others kept.
        let out = remove_lfs_pattern(text, "*.png").expect("ok").expect("removed");
        assert_eq!(out, "*.txt text eol=lf\n");
        // Absent pattern is a no-op (Ok(None)).
        assert!(remove_lfs_pattern(text, "*.zip").expect("ok").is_none());
        // A same-pattern line WITHOUT filter=lfs is not touched and not a match.
        assert!(remove_lfs_pattern("*.png text\n", "*.png").expect("ok").is_none());
        // Extra attributes on the LFS line: refuse rather than drop them.
        let err = remove_lfs_pattern("*.png filter=lfs text=auto\n", "*.png").unwrap_err();
        assert!(err.contains(".gitattributes"), "message should point at manual editing: {err}");
        // Quoted lines match their unquoted pattern.
        let out = remove_lfs_pattern("\"my file.psd\" filter=lfs diff=lfs merge=lfs -text\n", "my file.psd")
            .expect("ok")
            .expect("removed");
        assert_eq!(out, "");
    }
}
