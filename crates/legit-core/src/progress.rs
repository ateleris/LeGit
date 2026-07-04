//! Parsing of git's transfer progress meter (fetch / pull / push / clone).
//!
//! Git writes the meter to stderr only when `--progress` is passed (stderr is
//! a pipe, never a TTY, for us) and separates updates with `\r`, terminating a
//! phase with `, done.\n`. Lines produced by the *remote* side arrive with a
//! `remote: ` prefix through the sideband. This module is deliberately at the
//! crate root (not `cli_impl/parsers`): the runner itself parses segments as
//! they stream, below the backend layer.

use serde::{Deserialize, Serialize};
use specta::Type;

/// One parsed progress update, e.g. "Receiving objects:  45% (450/1000)".
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct RemoteProgress {
    /// The phase label as git prints it (e.g. `Receiving objects`,
    /// `Resolving deltas`, `Writing objects`, `Compressing objects`).
    pub phase: String,
    /// The percentage when the phase reports one (counting phases may not).
    pub percent: Option<u8>,
}

/// Parse a single stderr segment (one `\r`- or `\n`-delimited chunk) into a
/// progress update. Non-progress lines (hint:, error:, branch listings, …)
/// return `None`. A leading `remote: ` sideband prefix is stripped so the
/// remote's own counting/compressing phases report too.
pub fn parse_progress(segment: &str) -> Option<RemoteProgress> {
    let s = segment.trim();
    let s = s.strip_prefix("remote:").map(str::trim_start).unwrap_or(s);

    let (phase, rest) = s.split_once(':')?;
    let phase = phase.trim();
    if !KNOWN_PHASES.contains(&phase) {
        return None;
    }

    let rest = rest.trim_start();
    let percent = rest
        .split_once('%')
        .and_then(|(num, _)| num.trim().parse::<u8>().ok())
        .filter(|p| *p <= 100);

    Some(RemoteProgress {
        phase: phase.to_string(),
        percent,
    })
}

/// The phase labels git's progress meter uses across clone/fetch/push.
/// (`git config` can localize git's output, but the runner pins
/// `LANG/LC_ALL=C.UTF-8`, so the English labels are stable for us.)
const KNOWN_PHASES: &[&str] = &[
    "Enumerating objects",
    "Counting objects",
    "Compressing objects",
    "Receiving objects",
    "Resolving deltas",
    "Writing objects",
    "Unpacking objects",
    "Updating files",
];

/// Incremental splitter for a progress-bearing stderr stream: segments are
/// delimited by `\r` (git's in-place meter updates) as well as `\n`. Feed it
/// raw chunks as they arrive; it handles a segment or a `\r\n` pair split
/// across chunks, and drops the empty segment a CRLF would otherwise produce.
#[derive(Default)]
pub struct SegmentSplitter {
    buf: Vec<u8>,
}

impl SegmentSplitter {
    /// Consume a chunk, invoking `on_segment` for each completed segment.
    pub fn feed(&mut self, bytes: &[u8], on_segment: &mut impl FnMut(&str)) {
        for &b in bytes {
            if b == b'\r' || b == b'\n' {
                self.flush(on_segment);
            } else {
                self.buf.push(b);
            }
        }
    }

    /// Flush a trailing unterminated segment at end of stream.
    pub fn finish(&mut self, on_segment: &mut impl FnMut(&str)) {
        self.flush(on_segment);
    }

    fn flush(&mut self, on_segment: &mut impl FnMut(&str)) {
        if self.buf.is_empty() {
            return;
        }
        let seg = String::from_utf8_lossy(&self.buf).into_owned();
        on_segment(&seg);
        self.buf.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(phase: &str, percent: Option<u8>) -> RemoteProgress {
        RemoteProgress { phase: phase.to_string(), percent }
    }

    fn split_all(chunks: &[&[u8]]) -> Vec<String> {
        let mut out = Vec::new();
        let mut splitter = SegmentSplitter::default();
        let mut push = |s: &str| out.push(s.to_string());
        for chunk in chunks {
            splitter.feed(chunk, &mut push);
        }
        splitter.finish(&mut push);
        out
    }

    #[test]
    fn splits_on_cr_and_lf() {
        assert_eq!(
            split_all(&[b"a: 1%\ra: 2%\ra: 100%, done.\nnext line\n"]),
            vec!["a: 1%", "a: 2%", "a: 100%, done.", "next line"],
        );
    }

    #[test]
    fn crlf_produces_no_empty_segment() {
        assert_eq!(split_all(&[b"one\r\ntwo\r\n"]), vec!["one", "two"]);
    }

    #[test]
    fn segment_split_across_chunks_is_reassembled() {
        assert_eq!(
            split_all(&[b"Receiving obj", b"ects:  5%\rReceiving objects: 10%\r"]),
            vec!["Receiving objects:  5%", "Receiving objects: 10%"],
        );
    }

    #[test]
    fn trailing_unterminated_segment_flushes_on_finish() {
        assert_eq!(split_all(&[b"partial"]), vec!["partial"]);
    }

    #[test]
    fn receiving_objects_with_percent() {
        assert_eq!(
            parse_progress("Receiving objects:  45% (450/1000)"),
            Some(p("Receiving objects", Some(45))),
        );
    }

    #[test]
    fn done_line_reports_100() {
        assert_eq!(
            parse_progress("Resolving deltas: 100% (8/8), done."),
            Some(p("Resolving deltas", Some(100))),
        );
    }

    #[test]
    fn counting_without_percent_has_no_number() {
        assert_eq!(
            parse_progress("Counting objects: 5"),
            Some(p("Counting objects", None)),
        );
    }

    #[test]
    fn remote_sideband_prefix_is_stripped() {
        assert_eq!(
            parse_progress("remote: Compressing objects:  50% (10/20)"),
            Some(p("Compressing objects", Some(50))),
        );
    }

    #[test]
    fn push_writing_objects() {
        assert_eq!(
            parse_progress("Writing objects:  12% (3/25), 1.2 MiB | 2.5 MiB/s"),
            Some(p("Writing objects", Some(12))),
        );
    }

    #[test]
    fn non_progress_lines_are_none() {
        assert_eq!(parse_progress("From https://example.com/repo"), None);
        assert_eq!(parse_progress(" * branch            main       -> FETCH_HEAD"), None);
        assert_eq!(parse_progress("error: failed to push some refs"), None);
        assert_eq!(parse_progress("hint: Updates were rejected"), None);
        assert_eq!(parse_progress("remote: Total 3 (delta 0), reused 0 (delta 0)"), None);
        assert_eq!(parse_progress(""), None);
    }

    #[test]
    fn out_of_range_percent_is_dropped_not_progress_line_kept() {
        // A malformed percentage keeps the phase but drops the number.
        assert_eq!(
            parse_progress("Receiving objects:  999% (1/1)"),
            Some(p("Receiving objects", None)),
        );
    }
}
