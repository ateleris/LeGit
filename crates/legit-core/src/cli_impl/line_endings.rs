//! Pure line-ending logic: classification, check-in normalization policy,
//! attribute/blob parsers, and EOL conversion. Everything here is pure
//! `text -> type`; the IPC commands in `src-tauri` do the IO around it.

use crate::types::{LineEndingKind, LineEndingStatusEntry, LineEndingTransition};
use std::collections::{HashMap, HashSet};

use super::BINARY_SNIFF_WINDOW;

/// Whether a file's bytes hold MIXED (CRLF + bare-LF) line endings:
/// `Some(true)` mixed, `Some(false)` uniform (incl. no newlines at all),
/// `None` binary (NUL in the leading `BINARY_SNIFF_WINDOW` bytes - git's
/// heuristic, shared with `classify_line_endings` so both classify a blob
/// identically). The LF of a CRLF pair never counts as a bare LF, and
/// old-Mac lone CRs count as neither. Pure sibling of
/// `classify_line_endings`; backs the mixed-endings warning.
pub fn mixed_endings_in_bytes(bytes: &[u8]) -> Option<bool> {
    let probe = &bytes[..bytes.len().min(BINARY_SNIFF_WINDOW)];
    if probe.contains(&0u8) {
        return None;
    }
    let mut has_crlf = false;
    let mut has_lf_only = false;
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] == b'\r' && i + 1 < bytes.len() && bytes[i + 1] == b'\n' {
            has_crlf = true;
            i += 2;
        } else if bytes[i] == b'\n' {
            has_lf_only = true;
            i += 1;
        } else {
            i += 1;
        }
        if has_crlf && has_lf_only {
            return Some(true);
        }
    }
    Some(false)
}

/// Classify the line-ending style of some text (the Diff/File View/Blame
/// indicator). Binary is detected by a NUL byte in the leading window (git's
/// heuristic). Pure so it's unit-tested. Backs `repo_line_ending_kind`.
pub fn classify_line_endings(text: &str) -> LineEndingKind {
    let bytes = text.as_bytes();
    if bytes.iter().take(BINARY_SNIFF_WINDOW).any(|&b| b == 0) {
        return LineEndingKind::Binary;
    }
    let (mut crlf, mut lf, mut cr) = (false, false, false);
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'\r' if i + 1 < bytes.len() && bytes[i + 1] == b'\n' => {
                crlf = true;
                i += 2;
            }
            b'\r' => {
                cr = true;
                i += 1;
            }
            b'\n' => {
                lf = true;
                i += 1;
            }
            _ => i += 1,
        }
    }
    match (crlf, lf, cr) {
        (false, false, false) => LineEndingKind::None,
        (true, false, false) => LineEndingKind::Crlf,
        (false, true, false) => LineEndingKind::Lf,
        (false, false, true) => LineEndingKind::Cr,
        _ => LineEndingKind::Mixed,
    }
}

/// The `text` attribute's effective value for a path (`git check-attr`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EolTextAttr {
    /// `text` - normalization always on.
    Set,
    /// `-text` / `binary` - normalization off.
    Unset,
    /// `text=auto` - normalize when the content looks like text.
    Auto,
    /// No `text` attribute - `core.autocrlf` decides.
    Unspecified,
}

/// Resolved `core.autocrlf`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AutocrlfSetting {
    True,
    Input,
    False,
}

/// Parse `git config --get core.autocrlf` output. Anything unrecognized
/// (including unset - git exits 1 with empty stdout) is False, git's default.
pub fn parse_autocrlf(stdout: &str) -> AutocrlfSetting {
    match stdout.trim().to_ascii_lowercase().as_str() {
        "true" => AutocrlfSetting::True,
        "input" => AutocrlfSetting::Input,
        _ => AutocrlfSetting::False,
    }
}

/// Whether `git add` would normalize CRLF to LF for this path (the clean
/// filter), per gitattributes(5). `content_kind` is the working file's raw
/// classification (binary content is never converted). `index_kind` is the
/// blob currently in the index, if any: in the AUTO modes (`text=auto`, or
/// no attr + autocrlf true/input) git leaves files whose indexed blob
/// already contains CRLF untouched ("files that contain CRLF in the
/// repository will not be touched"); an explicit `text` or `eol` attribute
/// normalizes unconditionally. These rules are assumptions about git's
/// convert.c and are validated against the real binary in git_flows.rs.
pub fn checkin_normalizes(
    text: EolTextAttr,
    eol_attr_set: bool,
    autocrlf: AutocrlfSetting,
    content_kind: LineEndingKind,
    index_kind: Option<LineEndingKind>,
) -> bool {
    if content_kind == LineEndingKind::Binary {
        return false;
    }
    let index_has_crlf = matches!(
        index_kind,
        Some(LineEndingKind::Crlf) | Some(LineEndingKind::Mixed)
    );
    match text {
        EolTextAttr::Unset => false,
        EolTextAttr::Set => true,
        EolTextAttr::Auto => !index_has_crlf,
        EolTextAttr::Unspecified => {
            if eol_attr_set {
                // An `eol=` attribute alone implies `text`.
                true
            } else {
                matches!(autocrlf, AutocrlfSetting::True | AutocrlfSetting::Input)
                    && !index_has_crlf
            }
        }
    }
}

/// `classify_line_endings` as `git add` would see the content after CRLF->LF
/// normalization: CRLF counts as LF; bare LF and lone CR are unchanged. The
/// check-in kind of a working file is this when `checkin_normalizes` says
/// yes, the raw classification otherwise.
pub fn classify_line_endings_normalized(text: &str) -> LineEndingKind {
    let bytes = text.as_bytes();
    if bytes.iter().take(BINARY_SNIFF_WINDOW).any(|&b| b == 0) {
        return LineEndingKind::Binary;
    }
    let (mut lf, mut cr) = (false, false);
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'\r' if i + 1 < bytes.len() && bytes[i + 1] == b'\n' => {
                lf = true;
                i += 2;
            }
            b'\r' => {
                cr = true;
                i += 1;
            }
            b'\n' => {
                lf = true;
                i += 1;
            }
            _ => i += 1,
        }
    }
    match (lf, cr) {
        (false, false) => LineEndingKind::None,
        (true, false) => LineEndingKind::Lf,
        (false, true) => LineEndingKind::Cr,
        (true, true) => LineEndingKind::Mixed,
    }
}

/// Parse `git cat-file --batch` output into one entry per requested object,
/// in request order: `Some(bytes)` for a found object, `None` for one git
/// could not resolve ("<input> missing" and similar). Byte-exact: the
/// framing declares byte counts, which is why this parses RAW stdout
/// (`run_with_stdin_bytes`) - the runner's lossy UTF-8 String would shift
/// them. Returns `None` on a framing violation (fail closed).
pub fn parse_cat_file_batch(out: &[u8]) -> Option<Vec<Option<Vec<u8>>>> {
    let mut entries = Vec::new();
    let mut i = 0usize;
    while i < out.len() {
        let nl = out[i..].iter().position(|&b| b == b'\n')? + i;
        let header = std::str::from_utf8(&out[i..nl]).ok()?;
        i = nl + 1;
        // A found object's header is "<oid> <type> <size>"; anything whose
        // last token isn't a number ("<input> missing", "... ambiguous") is
        // an unresolvable request.
        let Some(size) = header.rsplit(' ').next().and_then(|t| t.parse::<usize>().ok())
        else {
            entries.push(None);
            continue;
        };
        if i + size > out.len() {
            return None;
        }
        entries.push(Some(out[i..i + size].to_vec()));
        i += size;
        // LF terminator after the contents.
        if out.get(i) == Some(&b'\n') {
            i += 1;
        }
    }
    Some(entries)
}

/// Parse `git check-attr -z --stdin text eol` output (path NUL attr NUL
/// value NUL triples) into per-path line-ending attributes: the `text`
/// attribute plus whether an `eol=` attribute applies. Output shape is
/// validated against the real binary in git_flows.rs.
pub fn parse_check_attr_z(stdout: &str) -> HashMap<String, (EolTextAttr, bool)> {
    let mut map: HashMap<String, (EolTextAttr, bool)> = HashMap::new();
    let mut it = stdout.split('\0');
    while let (Some(path), Some(attr), Some(value)) = (it.next(), it.next(), it.next()) {
        if path.is_empty() {
            break;
        }
        let entry = map
            .entry(path.to_string())
            .or_insert((EolTextAttr::Unspecified, false));
        match attr {
            "text" => {
                entry.0 = match value {
                    "set" => EolTextAttr::Set,
                    "unset" => EolTextAttr::Unset,
                    "auto" => EolTextAttr::Auto,
                    _ => EolTextAttr::Unspecified,
                };
            }
            "eol" => entry.1 = value != "unspecified" && value != "unset",
            _ => {}
        }
    }
    map
}

/// Parse `git check-attr -z --stdin filter` output (path NUL attr NUL value
/// NUL triples) into the set of paths whose `filter` attribute resolves to
/// `lfs`. Output shape validated against the real binary in git_flows.rs.
pub fn parse_check_attr_filter_lfs(stdout: &str) -> HashSet<String> {
    let mut set = HashSet::new();
    let mut it = stdout.split('\0');
    while let (Some(path), Some(attr), Some(value)) = (it.next(), it.next(), it.next()) {
        if path.is_empty() {
            break;
        }
        if attr == "filter" && value == "lfs" {
            set.insert(path.to_string());
        }
    }
    set
}

/// Kinds that can appear in a transition chip: an actual line-ending style.
fn transitionable(kind: LineEndingKind) -> bool {
    matches!(
        kind,
        LineEndingKind::Lf | LineEndingKind::Crlf | LineEndingKind::Cr | LineEndingKind::Mixed
    )
}

fn transition_between(
    from: Option<LineEndingKind>,
    to: Option<LineEndingKind>,
) -> Option<LineEndingTransition> {
    let (from, to) = (from?, to?);
    (transitionable(from) && transitionable(to) && from != to)
        .then_some(LineEndingTransition { from, to })
}

/// Assemble one changed file's line-ending summary from its (optional)
/// sides. Pure: the `repo_line_ending_status` command only does IO around
/// this. `working`/`index`/`head` are the raw bytes of each side, `None`
/// when that side is missing, unreadable, oversized, or binary-skipped.
pub fn derive_line_ending_entry(
    path: &str,
    working: Option<&[u8]>,
    index: Option<&[u8]>,
    head: Option<&[u8]>,
    text_attr: EolTextAttr,
    eol_attr_set: bool,
    autocrlf: AutocrlfSetting,
) -> LineEndingStatusEntry {
    let classify = |b: &[u8]| classify_line_endings(&String::from_utf8_lossy(b));
    let index_kind = index.map(classify);
    let head_kind = head.map(classify);
    let working_raw = working.map(classify);

    // What `git add` would store for the working file (the policy-aware side).
    let checkin = working.map(|b| {
        let text = String::from_utf8_lossy(b);
        let raw = classify_line_endings(&text);
        if checkin_normalizes(text_attr, eol_attr_set, autocrlf, raw, index_kind) {
            classify_line_endings_normalized(&text)
        } else {
            raw
        }
    });

    LineEndingStatusEntry {
        path: path.to_string(),
        unstaged: transition_between(index_kind, checkin),
        staged: transition_between(head_kind, index_kind),
        mixed: working.and_then(mixed_endings_in_bytes).unwrap_or(false),
        working_raw,
    }
}

/// Rewrite every line ending (CRLF, bare LF, or lone CR) in `bytes` to
/// `target`, leaving all other bytes untouched. No EOL is added or removed,
/// so a missing trailing newline stays missing. Returns `None` for binary
/// content (NUL in the leading window, git's heuristic) and for targets that
/// aren't a concrete kind (only Lf/Crlf/Cr can be converted to). Pure so the
/// "only EOLs change" contract is unit-tested; backs `repo_revert_line_endings`.
pub fn convert_line_endings(bytes: &[u8], target: LineEndingKind) -> Option<Vec<u8>> {
    let eol: &[u8] = match target {
        LineEndingKind::Lf => b"\n",
        LineEndingKind::Crlf => b"\r\n",
        LineEndingKind::Cr => b"\r",
        _ => return None,
    };
    if bytes.iter().take(BINARY_SNIFF_WINDOW).any(|&b| b == 0) {
        return None;
    }
    let mut out = Vec::with_capacity(bytes.len() + bytes.len() / 8);
    let mut i = 0usize;
    while i < bytes.len() {
        match bytes[i] {
            b'\r' if i + 1 < bytes.len() && bytes[i + 1] == b'\n' => {
                out.extend_from_slice(eol);
                i += 2;
            }
            b'\r' | b'\n' => {
                out.extend_from_slice(eol);
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- mixed line-ending detection ------------------------------------------

    #[test]
    fn mixed_endings_pure_and_mixed() {
        assert_eq!(mixed_endings_in_bytes(b"a\r\nb\r\n"), Some(false));
        assert_eq!(mixed_endings_in_bytes(b"a\nb\n"), Some(false));
        assert_eq!(mixed_endings_in_bytes(b"a\r\nb\n"), Some(true));
        assert_eq!(mixed_endings_in_bytes(b""), Some(false));
        assert_eq!(mixed_endings_in_bytes(b"no newline at all"), Some(false));
    }

    #[test]
    fn mixed_endings_lone_cr_is_not_lf() {
        // Old-Mac CR endings are neither CRLF nor LF: a CR+LF file mix still
        // reports mixed, but CR alone does not create a false LF sighting.
        assert_eq!(mixed_endings_in_bytes(b"a\rb\r"), Some(false));
        assert_eq!(mixed_endings_in_bytes(b"a\r\nb\rc\r\n"), Some(false));
    }

    #[test]
    fn mixed_endings_binary_is_none() {
        assert_eq!(mixed_endings_in_bytes(b"ab\0cd\r\nx\n"), None);
    }

    #[test]
    fn mixed_endings_sniff_window_matches_classify_line_endings() {
        // Regression: the NUL probe once stopped at 512 bytes while
        // classify_line_endings used BINARY_SNIFF_WINDOW (8000, git's
        // buffer_is_binary) - a NUL between the two made the siblings
        // disagree. Both must classify identically across the boundary.

        // NUL inside the window but past the old 512-byte probe: binary.
        let mut inside = vec![b'a'; 600];
        inside[599] = 0;
        inside.extend_from_slice(b"\r\nx\n");
        assert_eq!(mixed_endings_in_bytes(&inside), None);
        let inside_text = String::from_utf8(inside).unwrap();
        assert_eq!(classify_line_endings(&inside_text), LineEndingKind::Binary);

        // NUL at the last in-window byte: still binary.
        let mut edge = vec![b'a'; BINARY_SNIFF_WINDOW];
        edge[BINARY_SNIFF_WINDOW - 1] = 0;
        edge.extend_from_slice(b"\r\nx\n");
        assert_eq!(mixed_endings_in_bytes(&edge), None);
        let edge_text = String::from_utf8(edge).unwrap();
        assert_eq!(classify_line_endings(&edge_text), LineEndingKind::Binary);

        // NUL just past the window: text for both (git's heuristic ignores
        // it), so the mixed endings still register.
        let mut outside = vec![b'a'; BINARY_SNIFF_WINDOW];
        outside.extend_from_slice(b"\0\r\nx\n");
        assert_eq!(mixed_endings_in_bytes(&outside), Some(true));
        let outside_text = String::from_utf8(outside).unwrap();
        assert_eq!(classify_line_endings(&outside_text), LineEndingKind::Mixed);
    }

    #[test]
    fn mixed_endings_crlf_never_counts_as_lf() {
        // The LF in a CRLF pair must not read as a bare LF.
        assert_eq!(mixed_endings_in_bytes(b"\r\n\r\n\r\n"), Some(false));
    }

    // --- line-ending classification -----------------------------------------

    #[test]
    fn classify_line_endings_pure_kinds() {
        assert_eq!(classify_line_endings("a\nb\nc\n"), LineEndingKind::Lf);
        assert_eq!(classify_line_endings("a\r\nb\r\n"), LineEndingKind::Crlf);
        assert_eq!(classify_line_endings("a\rb\r"), LineEndingKind::Cr);
    }

    #[test]
    fn classify_line_endings_mixed_and_edge_cases() {
        assert_eq!(classify_line_endings("a\r\nb\nc\n"), LineEndingKind::Mixed);
        assert_eq!(classify_line_endings("lone line, no break"), LineEndingKind::None);
        assert_eq!(classify_line_endings(""), LineEndingKind::None);
        // A lone CR mixed with CRLF is still mixed.
        assert_eq!(classify_line_endings("a\r\nb\rc"), LineEndingKind::Mixed);
    }

    #[test]
    fn classify_line_endings_binary_wins() {
        assert_eq!(classify_line_endings("a\0b\r\n"), LineEndingKind::Binary);
    }

    // --- check-in normalization ----------------------------------------------

    #[test]
    fn parse_autocrlf_values() {
        assert_eq!(parse_autocrlf("true\n"), AutocrlfSetting::True);
        assert_eq!(parse_autocrlf("input"), AutocrlfSetting::Input);
        assert_eq!(parse_autocrlf("false\n"), AutocrlfSetting::False);
        assert_eq!(parse_autocrlf(""), AutocrlfSetting::False);
        assert_eq!(parse_autocrlf("TRUE"), AutocrlfSetting::True);
    }

    #[test]
    fn checkin_normalizes_matrix() {
        use AutocrlfSetting as A;
        use EolTextAttr as T;
        use LineEndingKind as K;
        // Explicit text attr: always normalizes, even when the index has CRLF.
        assert!(checkin_normalizes(T::Set, false, A::False, K::Crlf, Some(K::Crlf)));
        // -text / binary attr: never.
        assert!(!checkin_normalizes(T::Unset, false, A::True, K::Crlf, None));
        // Binary content: never, regardless of attrs.
        assert!(!checkin_normalizes(T::Set, false, A::True, K::Binary, None));
        // text=auto: yes, unless the indexed blob already contains CRLF.
        assert!(checkin_normalizes(T::Auto, false, A::False, K::Crlf, Some(K::Lf)));
        assert!(checkin_normalizes(T::Auto, false, A::False, K::Crlf, None));
        assert!(!checkin_normalizes(T::Auto, false, A::False, K::Crlf, Some(K::Crlf)));
        assert!(!checkin_normalizes(T::Auto, false, A::False, K::Crlf, Some(K::Mixed)));
        // No attr: core.autocrlf decides, with the same index-CRLF exemption.
        assert!(checkin_normalizes(T::Unspecified, false, A::True, K::Crlf, Some(K::Lf)));
        assert!(checkin_normalizes(T::Unspecified, false, A::Input, K::Crlf, None));
        assert!(!checkin_normalizes(T::Unspecified, false, A::False, K::Crlf, None));
        assert!(!checkin_normalizes(T::Unspecified, false, A::True, K::Crlf, Some(K::Crlf)));
        // An eol= attribute alone implies text: always normalizes.
        assert!(checkin_normalizes(T::Unspecified, true, A::False, K::Crlf, Some(K::Crlf)));
    }

    #[test]
    fn classify_normalized_treats_crlf_as_lf() {
        use LineEndingKind as K;
        assert_eq!(classify_line_endings_normalized("a\r\nb\r\n"), K::Lf);
        assert_eq!(classify_line_endings_normalized("a\r\nb\n"), K::Lf);
        assert_eq!(classify_line_endings_normalized("a\nb\n"), K::Lf);
        // Lone CR is never converted by git.
        assert_eq!(classify_line_endings_normalized("a\rb\r"), K::Cr);
        assert_eq!(classify_line_endings_normalized("a\r\nb\r"), K::Mixed);
        assert_eq!(classify_line_endings_normalized("no newline"), K::None);
        assert_eq!(classify_line_endings_normalized("bin\0ary\r\n"), K::Binary);
    }

    #[test]
    fn parse_cat_file_batch_found_missing_and_binary() {
        // Two found objects (one containing NUL bytes and a newline) + one missing.
        let mut out: Vec<u8> = Vec::new();
        out.extend_from_slice(b"1111111111111111111111111111111111111111 blob 5\nab\ncd");
        out.push(b'\n');
        out.extend_from_slice(b":gone.txt missing\n");
        out.extend_from_slice(b"2222222222222222222222222222222222222222 blob 3\na\0b");
        out.push(b'\n');
        let parsed = parse_cat_file_batch(&out).expect("framing ok");
        assert_eq!(parsed.len(), 3);
        assert_eq!(parsed[0].as_deref(), Some(b"ab\ncd".as_slice()));
        assert_eq!(parsed[1], None);
        assert_eq!(parsed[2].as_deref(), Some(b"a\0b".as_slice()));
    }

    #[test]
    fn parse_cat_file_batch_rejects_truncated_output() {
        let out = b"1111111111111111111111111111111111111111 blob 99\nshort\n";
        assert_eq!(parse_cat_file_batch(out), None);
    }

    #[test]
    fn parse_check_attr_z_shapes() {
        use EolTextAttr as T;
        // path NUL attr NUL value NUL triples, one per (path, attr).
        let stdout = "a.txt\0text\0set\0a.txt\0eol\0unspecified\0\
                      b.bin\0text\0unset\0b.bin\0eol\0unspecified\0\
                      c.txt\0text\0auto\0c.txt\0eol\0lf\0\
                      d.txt\0text\0unspecified\0d.txt\0eol\0unspecified\0";
        let map = parse_check_attr_z(stdout);
        assert_eq!(map["a.txt"], (T::Set, false));
        assert_eq!(map["b.bin"], (T::Unset, false));
        assert_eq!(map["c.txt"], (T::Auto, true));
        assert_eq!(map["d.txt"], (T::Unspecified, false));
    }

    #[test]
    fn parse_check_attr_filter_lfs_shapes() {
        // path NUL attr NUL value NUL triples, exactly like check-attr -z.
        let stdout = "a.png\0filter\0lfs\0b.txt\0filter\0unspecified\0c.bin\0filter\0lfs\0";
        let set = parse_check_attr_filter_lfs(stdout);
        assert!(set.contains("a.png"));
        assert!(set.contains("c.bin"));
        assert!(!set.contains("b.txt"));
        assert_eq!(set.len(), 2);
        // Empty output (no paths sent / all unspecified) parses to empty.
        assert!(parse_check_attr_filter_lfs("").is_empty());
    }

    #[test]
    fn derive_line_ending_entry_transitions() {
        use AutocrlfSetting as A;
        use EolTextAttr as T;
        use LineEndingKind as K;
        let d = |working: Option<&[u8]>, index: Option<&[u8]>, head: Option<&[u8]>, a: A| {
            derive_line_ending_entry("f.txt", working, index, head, T::Unspecified, false, a)
        };
        // Plain flip, no policy: index LF, working CRLF -> unstaged LF->CRLF.
        let e = d(Some(b"a\r\nb\r\n"), Some(b"a\nb\n"), Some(b"a\nb\n"), A::False);
        assert_eq!(e.unstaged, Some(LineEndingTransition { from: K::Lf, to: K::Crlf }));
        assert_eq!(e.staged, None);
        assert_eq!(e.working_raw, Some(K::Crlf));
        assert!(!e.mixed);
        // Same bytes under autocrlf=true: the CRLF is policy, no transition.
        let e = d(Some(b"a\r\nb\r\n"), Some(b"a\nb\n"), Some(b"a\nb\n"), A::True);
        assert_eq!(e.unstaged, None);
        assert_eq!(e.working_raw, Some(K::Crlf)); // label still shows disk truth
        // Staged flip: HEAD LF vs index CRLF -> staged LF->CRLF.
        let e = d(Some(b"a\r\n"), Some(b"a\r\n"), Some(b"a\n"), A::False);
        assert_eq!(e.staged, Some(LineEndingTransition { from: K::Lf, to: K::Crlf }));
        // Newly mixed staged counts as a transition.
        let e = d(None, Some(b"a\r\nb\n"), Some(b"a\nb\n"), A::False);
        assert_eq!(e.staged, Some(LineEndingTransition { from: K::Lf, to: K::Mixed }));
        // Mixed working file flags `mixed`.
        let e = d(Some(b"a\r\nb\n"), Some(b"a\r\nb\n"), None, A::False);
        assert!(e.mixed);
        // Untracked (no index/HEAD): no transitions, raw label only.
        let e = d(Some(b"a\r\n"), None, None, A::False);
        assert_eq!(e.unstaged, None);
        assert_eq!(e.staged, None);
        assert_eq!(e.working_raw, Some(K::Crlf));
        // A side with no line breaks never forms a transition.
        let e = d(Some(b"one line"), Some(b"a\n"), None, A::False);
        assert_eq!(e.unstaged, None);
    }

    // --- line-ending conversion ----------------------------------------------

    #[test]
    fn convert_line_endings_lf_to_crlf_and_back() {
        assert_eq!(convert_line_endings(b"a\nb\nc\n", LineEndingKind::Crlf).unwrap(), b"a\r\nb\r\nc\r\n");
        assert_eq!(convert_line_endings(b"a\r\nb\r\nc\r\n", LineEndingKind::Lf).unwrap(), b"a\nb\nc\n");
    }

    #[test]
    fn convert_line_endings_mixed_input_becomes_uniform() {
        // CRLF + bare LF + lone CR all become the target.
        assert_eq!(convert_line_endings(b"a\r\nb\nc\rd\n", LineEndingKind::Lf).unwrap(), b"a\nb\nc\nd\n");
        assert_eq!(
            convert_line_endings(b"a\r\nb\nc\rd\n", LineEndingKind::Crlf).unwrap(),
            b"a\r\nb\r\nc\r\nd\r\n"
        );
    }

    #[test]
    fn convert_line_endings_preserves_missing_trailing_newline() {
        // No EOL is added or removed; only existing EOLs change kind.
        assert_eq!(convert_line_endings(b"a\r\nb", LineEndingKind::Lf).unwrap(), b"a\nb");
        assert_eq!(convert_line_endings(b"", LineEndingKind::Lf).unwrap(), b"");
        assert_eq!(convert_line_endings(b"no breaks", LineEndingKind::Crlf).unwrap(), b"no breaks");
    }

    #[test]
    fn convert_line_endings_to_cr_and_noop() {
        assert_eq!(convert_line_endings(b"a\nb\r\n", LineEndingKind::Cr).unwrap(), b"a\rb\r");
        // Already uniform at the target: content is unchanged.
        assert_eq!(convert_line_endings(b"a\nb\n", LineEndingKind::Lf).unwrap(), b"a\nb\n");
    }

    #[test]
    fn convert_line_endings_refuses_binary_and_bad_targets() {
        // NUL in the sniff window: binary, refuse.
        assert_eq!(convert_line_endings(b"a\0b\r\n", LineEndingKind::Lf), None);
        // Only Lf/Crlf/Cr are meaningful conversion targets.
        assert_eq!(convert_line_endings(b"a\nb\n", LineEndingKind::Mixed), None);
        assert_eq!(convert_line_endings(b"a\nb\n", LineEndingKind::None), None);
        assert_eq!(convert_line_endings(b"a\nb\n", LineEndingKind::Binary), None);
    }
}
