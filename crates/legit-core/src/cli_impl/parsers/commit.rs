//! Parser for `git cat-file -p <sha>` and `git verify-commit --raw <sha>`
//! output (DESIGN-v0.3.md §F.2, §C.3).
//!
//! `CommitDetails` is assembled from two subprocess runs:
//!   1. `git cat-file -p <sha>` — raw commit object (headers + body).
//!   2. `git verify-commit --raw <sha>` (stderr) — signature status; run only
//!      when the cat-file output contains a `gpgsig`-family header.

use crate::error::ParseError;
use crate::types::{
    Commit, CommitId, KeyId, Signature, SignatureStatus, SignatureVerification,
};

// ---------------------------------------------------------------------------
// Intermediate type (not exported to the domain layer)
// ---------------------------------------------------------------------------

/// The result of parsing `git cat-file -p <sha>`. The caller uses this to
/// decide whether to run `git verify-commit` (via `has_signature_header`),
/// then assembles the final `CommitDetails`.
pub struct ParsedCatFile {
    pub commit: Commit,
    /// True when the object contained a `gpgsig`, `gpgsig-sha256`, or
    /// `mergetag` header — i.e. signature verification is worth attempting.
    pub has_signature_header: bool,
    /// The verbatim raw output (stored in `CommitDetails.raw_object`).
    pub raw_object: String,
}

// ---------------------------------------------------------------------------
// cat-file parser
// ---------------------------------------------------------------------------

/// Parse the stdout of `git cat-file -p <sha>`.
///
/// A commit object looks like:
/// ```text
/// tree <sha>
/// parent <sha>
/// author Name <email> <unix-ts> <±HHMM>
/// committer Name <email> <unix-ts> <±HHMM>
/// gpgsig -----BEGIN PGP SIGNATURE-----
///  <base64 continuation lines, each prefixed with a space>
///  -----END PGP SIGNATURE-----
///
/// Subject line
///
/// Body paragraph.
/// ```
pub fn parse_cat_file(sha: &str, raw: &str) -> Result<ParsedCatFile, ParseError> {
    let (headers_raw, message_raw) = split_object(raw, sha)?;

    let mut parents: Vec<CommitId> = Vec::new();
    let mut author_line: Option<&str> = None;
    let mut committer_line: Option<&str> = None;
    let mut has_sig = false;

    let mut lines = headers_raw.lines().peekable();
    while let Some(line) = lines.next() {
        if line.is_empty() {
            break;
        }
        let key = line.split_once(' ').map(|(k, _)| k).unwrap_or(line);
        match key {
            "tree" => {}
            "parent" => {
                if let Some((_, sha_val)) = line.split_once(' ') {
                    parents.push(CommitId::new(sha_val.trim()));
                }
            }
            "author" => author_line = Some(line),
            "committer" => committer_line = Some(line),
            "gpgsig" | "gpgsig-sha256" | "mergetag" => {
                has_sig = true;
                // Continuation lines begin with a single space.
                while lines.peek().map(|l| l.starts_with(' ')).unwrap_or(false) {
                    lines.next();
                }
            }
            _ => {
                while lines.peek().map(|l| l.starts_with(' ')).unwrap_or(false) {
                    lines.next();
                }
            }
        }
    }

    let author = author_line
        .ok_or_else(|| ParseError::new("missing author header", sha))
        .and_then(|l| parse_identity_line(l, "author"))?;

    let committer = committer_line
        .ok_or_else(|| ParseError::new("missing committer header", sha))
        .and_then(|l| parse_identity_line(l, "committer"))?;

    let author_ts = author.timestamp;
    let message = message_raw.trim_end_matches('\n').to_string();

    Ok(ParsedCatFile {
        commit: Commit {
            id: CommitId::new(sha),
            parents,
            author,
            committer,
            message,
            timestamp: author_ts,
            signature: None, // filled in by the caller after verify-commit
            has_signature: has_sig,
            decorations: vec![],
        },
        has_signature_header: has_sig,
        raw_object: raw.to_string(),
    })
}

// ---------------------------------------------------------------------------
// Batched signature-presence scan (`cat-file --batch`)
// ---------------------------------------------------------------------------

/// SHAs whose commit objects carry a signature header, from the raw stdout of
/// `git cat-file --batch` fed one SHA per line. Presence only - the same
/// header set `parse_cat_file` treats as verification-worthy (`gpgsig`,
/// `gpgsig-sha256`, `mergetag`) - detected without ever spawning a verifier;
/// this is what makes per-row "signed" chips affordable where `%G?` was not.
///
/// Operates on BYTES: `--batch` frames each object as
/// `<sha> <type> <size>\n<size raw bytes>\n`, and commit objects may contain
/// non-UTF-8 identities, so byte counts must be applied to the unconverted
/// stream (`run_with_stdin_bytes`). Unknown SHAs print `<sha> missing` and are
/// skipped. Best-effort by design - the log must render even if enrichment
/// misbehaves - so a framing inconsistency ends the scan and returns what
/// parsed so far instead of erroring.
pub fn parse_batch_signature_presence(stdout: &[u8]) -> std::collections::HashSet<String> {
    let mut signed = std::collections::HashSet::new();
    let mut pos = 0usize;
    while pos < stdout.len() {
        // Header line: `<sha> <type> <size>` or `<sha> missing`.
        let Some(nl) = stdout[pos..].iter().position(|&b| b == b'\n') else { break };
        let Ok(header) = std::str::from_utf8(&stdout[pos..pos + nl]) else { break };
        pos += nl + 1;
        let mut fields = header.split(' ');
        let (Some(sha), Some(kind)) = (fields.next(), fields.next()) else { break };
        if kind == "missing" {
            continue;
        }
        let Some(size) = fields.next().and_then(|s| s.parse::<usize>().ok()) else { break };
        let Some(end) = pos.checked_add(size).filter(|&e| e <= stdout.len()) else { break };
        if kind == "commit" && object_has_signature_header(&stdout[pos..end]) {
            signed.insert(sha.to_string());
        }
        // +1: --batch appends a LF after each object's content.
        pos = end + 1;
    }
    signed
}

/// True when a raw commit object's header section (everything before the
/// first blank line) contains a signature header. Continuation lines start
/// with a space, so a `gpgsig`-prefixed line IS the header, and the message
/// (which could echo the word) is never scanned.
fn object_has_signature_header(object: &[u8]) -> bool {
    let headers_end = object
        .windows(2)
        .position(|w| w == b"\n\n")
        .unwrap_or(object.len());
    object[..headers_end].split(|&b| b == b'\n').any(|line| {
        line.starts_with(b"gpgsig ")
            || line.starts_with(b"gpgsig-sha256 ")
            || line.starts_with(b"mergetag ")
    })
}

/// Split a raw commit object at the first blank line into (headers, message).
fn split_object<'a>(raw: &'a str, sha: &str) -> Result<(&'a str, &'a str), ParseError> {
    raw.find("\n\n")
        .map(|pos| (&raw[..pos], &raw[pos + 2..]))
        .ok_or_else(|| ParseError::new("commit object has no blank-line separator", sha))
}

/// Parse an `author` or `committer` header line.
/// Format: `author Name <email> <unix-ts> <±HHMM>`
fn parse_identity_line(line: &str, prefix: &str) -> Result<Signature, ParseError> {
    let rest = line
        .strip_prefix(prefix)
        .and_then(|s| s.strip_prefix(' '))
        .unwrap_or_else(|| line.splitn(2, ' ').nth(1).unwrap_or(line));

    let tokens: Vec<&str> = rest.split(' ').collect();
    if tokens.len() < 3 {
        return Err(ParseError::new(format!("malformed {prefix} line"), line));
    }

    let tz_str = tokens[tokens.len() - 1];
    let ts_str = tokens[tokens.len() - 2];
    let name_email = tokens[..tokens.len() - 2].join(" ");

    let (name, email) = parse_name_email(&name_email, line)?;

    let timestamp: i64 = ts_str
        .parse()
        .map_err(|_| ParseError::new(format!("bad {prefix} timestamp"), ts_str))?;

    let tz_offset_minutes = parse_tz_offset(tz_str)
        .ok_or_else(|| ParseError::new(format!("bad {prefix} tz offset"), tz_str))?;

    Ok(Signature {
        name,
        email,
        timestamp,
        tz_offset_minutes,
    })
}

fn parse_name_email(s: &str, ctx: &str) -> Result<(String, String), ParseError> {
    let lt = s.rfind('<').ok_or_else(|| ParseError::new("no '<' in identity", ctx))?;
    let gt = s.rfind('>').ok_or_else(|| ParseError::new("no '>' in identity", ctx))?;
    if gt < lt {
        return Err(ParseError::new("malformed identity brackets", ctx));
    }
    Ok((s[..lt].trim().to_string(), s[lt + 1..gt].to_string()))
}

/// Parse a git tz offset like `+0200` or `-0400` into minutes from UTC.
fn parse_tz_offset(s: &str) -> Option<i32> {
    if s.len() != 5 {
        return None;
    }
    let sign: i32 = match s.as_bytes()[0] {
        b'+' => 1,
        b'-' => -1,
        _ => return None,
    };
    let hours: i32 = s[1..3].parse().ok()?;
    let minutes: i32 = s[3..5].parse().ok()?;
    Some(sign * (hours * 60 + minutes))
}

// ---------------------------------------------------------------------------
// verify-commit parser
// ---------------------------------------------------------------------------

/// Parse the stderr of `git verify-commit --raw <sha>`.
///
/// Returns `None` when stderr is empty (unsigned commit or git unavailable).
pub fn parse_verify_commit(stderr: &str) -> Option<SignatureVerification> {
    if stderr.trim().is_empty() {
        return None;
    }

    let mut status = SignatureStatus::NoSignature;
    let mut signer: Option<String> = None;
    let mut key_id: Option<KeyId> = None;

    for line in stderr.lines() {
        let line = line.trim();

        if let Some(rest) = line.strip_prefix("[GNUPG:] GOODSIG ") {
            status = SignatureStatus::Good;
            let mut parts = rest.splitn(2, ' ');
            if let Some(fp) = parts.next() {
                key_id = Some(KeyId(fp.to_string()));
            }
            signer = parts.next().map(|s| s.to_string());
        } else if let Some(rest) = line.strip_prefix("[GNUPG:] BADSIG ") {
            status = SignatureStatus::BadSignature;
            let mut parts = rest.splitn(2, ' ');
            if let Some(fp) = parts.next() {
                key_id = Some(KeyId(fp.to_string()));
            }
            signer = parts.next().map(|s| s.to_string());
        } else if line.contains("EXPKEYSIG") {
            status = SignatureStatus::Expired;
        } else if line.contains("REVKEYSIG") {
            status = SignatureStatus::Revoked;
        } else if line.contains("NO_PUBKEY") || line.contains("ERRSIG") {
            if !matches!(status, SignatureStatus::Good | SignatureStatus::BadSignature) {
                status = SignatureStatus::UnknownKey;
            }
        } else if let Some(rest) = line.strip_prefix("Good \"git\" signature") {
            // SSH signatures (gpg.format=ssh). Captured LIVE from git 2.52
            // (the previous "[SSH:] GOOD_SIGNATURE" match was assumed, wrong,
            // and never emitted by real git - same lesson as ssh -T probing):
            //   Good "git" signature for <principal> with <TYPE> key <fp>
            //   Good "git" signature with <TYPE> key <fp>
            // The "for <principal>" form means the signer matched
            // allowedSignersFile; without it the signature is VALID but the
            // signer is not trusted (accompanied by "No principal matched."
            // and/or "Unable to open allowed keys file ...") -> Untrusted.
            if let Some(i) = rest.rfind(" key ") {
                key_id = Some(KeyId(rest[i + 5..].trim().to_string()));
            }
            if let Some(after_for) = rest.strip_prefix(" for ") {
                status = SignatureStatus::Good;
                let principal = after_for
                    .rfind(" with ")
                    .map(|i| &after_for[..i])
                    .unwrap_or(after_for);
                signer = Some(principal.trim().to_string());
            } else if status == SignatureStatus::NoSignature {
                status = SignatureStatus::Untrusted;
            }
        } else if line.starts_with("Could not verify signature")
            || line.starts_with("Signature verification failed")
        {
            // Tampered content / corrupt ssh signature (captured live):
            //   Could not verify signature.
            //   Signature verification failed: incorrect signature
            status = SignatureStatus::BadSignature;
        }
    }

    Some(SignatureVerification {
        status,
        signer,
        key_id,
        raw: Some(stderr.to_string()),
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    const SHA: &str = "abc123def456abc123def456abc123def456abc1";

    fn object(extra_headers: &str, message: &str) -> String {
        format!(
            "tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\n\
             {extra_headers}\
             author Alice <alice@example.com> 1710504000 +0200\n\
             committer Bob <bob@example.com> 1710504001 +0000\n\
             \n\
             {message}"
        )
    }

    #[test]
    fn basic_commit() {
        let raw = object("", "Subject\n\nBody text.\n");
        let p = parse_cat_file(SHA, &raw).unwrap();
        assert_eq!(p.commit.id.as_str(), SHA);
        assert!(p.commit.parents.is_empty());
        assert_eq!(p.commit.author.name, "Alice");
        assert_eq!(p.commit.author.email, "alice@example.com");
        assert_eq!(p.commit.author.timestamp, 1710504000);
        assert_eq!(p.commit.author.tz_offset_minutes, 120);
        assert_eq!(p.commit.committer.tz_offset_minutes, 0);
        assert!(p.commit.message.starts_with("Subject"));
        assert!(p.commit.message.contains("Body text."));
        assert!(!p.has_signature_header);
        assert!(p.commit.signature.is_none());
    }

    #[test]
    fn commit_with_parent() {
        let parent = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
        let raw = object(&format!("parent {parent}\n"), "Fix something\n");
        let p = parse_cat_file(SHA, &raw).unwrap();
        assert_eq!(p.commit.parents.len(), 1);
        assert_eq!(p.commit.parents[0].as_str(), parent);
    }

    #[test]
    fn merge_commit_two_parents() {
        let p1 = "aaaa0000aaaa0000aaaa0000aaaa0000aaaa0000";
        let p2 = "bbbb1111bbbb1111bbbb1111bbbb1111bbbb1111";
        let raw = object(
            &format!("parent {p1}\nparent {p2}\n"),
            "Merge branch 'feat'\n",
        );
        let p = parse_cat_file(SHA, &raw).unwrap();
        assert_eq!(p.commit.parents.len(), 2);
        assert_eq!(p.commit.parents[0].as_str(), p1);
        assert_eq!(p.commit.parents[1].as_str(), p2);
    }

    #[test]
    fn signed_commit_sets_flag() {
        let raw = object(
            "gpgsig -----BEGIN PGP SIGNATURE-----\n iQEcBAABCAAGBQJ...\n -----END PGP SIGNATURE-----\n",
            "Signed commit\n",
        );
        let p = parse_cat_file(SHA, &raw).unwrap();
        assert!(p.has_signature_header);
    }

    #[test]
    fn unicode_names_and_message() {
        let raw = format!(
            "tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\n\
             author 山田 太郎 <yamada@example.jp> 1710504000 +0900\n\
             committer 田中 花子 <tanaka@example.jp> 1710504001 +0000\n\
             \n\
             日本語コミット\n\
             \n\
             Ünïcödé bödÿ 🦀\n"
        );
        let p = parse_cat_file(SHA, &raw).unwrap();
        assert_eq!(p.commit.author.name, "山田 太郎");
        assert!(p.commit.message.contains("🦀"));
    }

    #[test]
    fn empty_body() {
        let raw = object("", "Only a subject\n");
        let p = parse_cat_file(SHA, &raw).unwrap();
        assert!(p.commit.message.starts_with("Only a subject"));
    }

    #[test]
    fn long_message_preserved() {
        let body: String = std::iter::repeat("x").take(8192).collect();
        let raw = object("", &format!("Subject\n\n{body}\n"));
        let p = parse_cat_file(SHA, &raw).unwrap();
        assert!(p.commit.message.len() > 8000);
    }

    #[test]
    fn negative_tz_offset() {
        let raw = format!(
            "tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\n\
             author Alice <alice@example.com> 1710504000 -0500\n\
             committer Alice <alice@example.com> 1710504000 -0500\n\
             \n\
             Tz test\n"
        );
        let p = parse_cat_file(SHA, &raw).unwrap();
        assert_eq!(p.commit.author.tz_offset_minutes, -300);
    }

    #[test]
    fn raw_object_preserved() {
        let raw = object("", "Test\n");
        let p = parse_cat_file(SHA, &raw).unwrap();
        assert_eq!(p.raw_object, raw);
    }

    #[test]
    fn missing_blank_line_is_error() {
        let raw = "tree abc\nauthor A <a@b.com> 0 +0000\ncommitter A <a@b.com> 0 +0000\nNo message";
        assert!(parse_cat_file(SHA, raw).is_err());
    }

    #[test]
    fn verify_gpg_good() {
        let stderr = "[GNUPG:] GOODSIG ABCDEF1234567890 Alice <alice@example.com>\n";
        let v = parse_verify_commit(stderr).unwrap();
        assert_eq!(v.status, SignatureStatus::Good);
        assert_eq!(v.key_id.unwrap().0, "ABCDEF1234567890");
        assert!(v.signer.unwrap().contains("Alice"));
    }

    #[test]
    fn verify_gpg_bad() {
        let stderr = "[GNUPG:] BADSIG ABCDEF1234567890 Someone <s@example.com>\n";
        let v = parse_verify_commit(stderr).unwrap();
        assert_eq!(v.status, SignatureStatus::BadSignature);
    }

    #[test]
    fn verify_unknown_key() {
        let stderr = "[GNUPG:] ERRSIG ABCDEF1234 4 10 01 123456 9\n[GNUPG:] NO_PUBKEY ABCDEF1234\n";
        let v = parse_verify_commit(stderr).unwrap();
        assert_eq!(v.status, SignatureStatus::UnknownKey);
    }

    #[test]
    fn verify_empty_is_none() {
        assert!(parse_verify_commit("").is_none());
        assert!(parse_verify_commit("  \n  ").is_none());
    }

    // SSH verification outputs below were captured LIVE from
    // `git verify-commit --raw` (git 2.52, gpg.format=ssh) - never encode
    // these from documentation (the old "[SSH:] GOOD_SIGNATURE" format was
    // assumed, wrong, and classified every ssh-signed commit as NoSignature).

    #[test]
    fn verify_ssh_good_trusted_principal() {
        // Signer matched allowedSignersFile; exit code 0.
        let stderr = "Good \"git\" signature for simon@example.com with ED25519 key SHA256:OfRkdI/ogfETTsQmkALPa6b4UqaINmHWzWIzUd0NKcU\n";
        let v = parse_verify_commit(stderr).unwrap();
        assert_eq!(v.status, SignatureStatus::Good);
        assert_eq!(v.signer.as_deref(), Some("simon@example.com"));
        assert_eq!(
            v.key_id.unwrap().0,
            "SHA256:OfRkdI/ogfETTsQmkALPa6b4UqaINmHWzWIzUd0NKcU"
        );
    }

    #[test]
    fn verify_ssh_valid_but_unmatched_principal_is_untrusted() {
        // Valid signature, but the key is not in allowedSignersFile; exit 1.
        let stderr = "Good \"git\" signature with ED25519 key SHA256:K/GIgJD4qQ6D3G0fuetL+HRwJQU6BU/EFK2wHNl/I0o\nNo principal matched.\n";
        let v = parse_verify_commit(stderr).unwrap();
        assert_eq!(v.status, SignatureStatus::Untrusted);
        assert!(v.signer.is_none());
        assert_eq!(
            v.key_id.unwrap().0,
            "SHA256:K/GIgJD4qQ6D3G0fuetL+HRwJQU6BU/EFK2wHNl/I0o"
        );
    }

    #[test]
    fn verify_ssh_missing_signers_file_is_untrusted() {
        // gpg.ssh.allowedSignersFile unset/empty; exit 1.
        let stderr = "Good \"git\" signature with ED25519 key SHA256:OfRkdI/ogfETTsQmkALPa6b4UqaINmHWzWIzUd0NKcU\nUnable to open allowed keys file \"\": No such file or directory\nsig_find_principals: sshsig_find_principal: No such file or directory\nNo principal matched.\n";
        let v = parse_verify_commit(stderr).unwrap();
        assert_eq!(v.status, SignatureStatus::Untrusted);
    }

    #[test]
    fn verify_ssh_bad_signature() {
        // Tampered commit content; exit 1.
        let stderr = "Could not verify signature.\nSignature verification failed: incorrect signature\n";
        let v = parse_verify_commit(stderr).unwrap();
        assert_eq!(v.status, SignatureStatus::BadSignature);
    }

    // --- parse_batch_signature_presence -----------------------------------

    const SHA_B: &str = "def456abc123def456abc123def456abc123def4";

    /// One `cat-file --batch` entry: `<sha> commit <byte-size>\n<object>\n`.
    fn batch_entry(sha: &str, object: &[u8]) -> Vec<u8> {
        let mut v = format!("{sha} commit {}\n", object.len()).into_bytes();
        v.extend_from_slice(object);
        v.push(b'\n');
        v
    }

    const SIGNED_HEADERS: &str =
        "gpgsig -----BEGIN PGP SIGNATURE-----\n iQEcBAABCAAG...\n -----END PGP SIGNATURE-----\n";

    #[test]
    fn batch_presence_flags_only_signed_commits() {
        let mut out = batch_entry(SHA, object(SIGNED_HEADERS, "Signed\n").as_bytes());
        out.extend(batch_entry(SHA_B, object("", "Unsigned\n").as_bytes()));
        let signed = parse_batch_signature_presence(&out);
        assert!(signed.contains(SHA));
        assert!(!signed.contains(SHA_B));
    }

    #[test]
    fn batch_presence_detects_sha256_and_mergetag_variants() {
        for hdr in ["gpgsig-sha256 -----BEGIN...\n more\n", "mergetag object abc\n type commit\n"] {
            let out = batch_entry(SHA, object(hdr, "Msg\n").as_bytes());
            assert!(parse_batch_signature_presence(&out).contains(SHA), "header {hdr:?}");
        }
    }

    #[test]
    fn batch_presence_skips_missing_entries() {
        let mut out = b"0000000000000000000000000000000000000000 missing\n".to_vec();
        out.extend(batch_entry(SHA, object(SIGNED_HEADERS, "After missing\n").as_bytes()));
        let signed = parse_batch_signature_presence(&out);
        assert_eq!(signed.len(), 1);
        assert!(signed.contains(SHA));
    }

    #[test]
    fn batch_presence_never_scans_the_message() {
        // A message line starting with "gpgsig " must not count: only the
        // header section (before the first blank line) is signature-bearing.
        let obj = object("", "gpgsig looks like a header but is message text\n");
        let out = batch_entry(SHA, obj.as_bytes());
        assert!(parse_batch_signature_presence(&out).is_empty());
    }

    #[test]
    fn batch_presence_survives_non_utf8_object_content() {
        // Byte-size framing must hold even when an object's identity bytes
        // are not valid UTF-8 (0xE9 = latin-1 'é'): the NEXT entry still
        // parses. This is why the scan runs on raw bytes.
        let mut latin1 = object("", "Caf").into_bytes();
        latin1.push(0xE9);
        latin1.push(b'\n');
        let mut out = batch_entry(SHA_B, &latin1);
        out.extend(batch_entry(SHA, object(SIGNED_HEADERS, "Signed\n").as_bytes()));
        let signed = parse_batch_signature_presence(&out);
        assert!(signed.contains(SHA));
        assert!(!signed.contains(SHA_B));
    }

    #[test]
    fn batch_presence_ignores_non_commit_objects_and_truncation() {
        // A non-commit object is never flagged even when its content happens
        // to carry a gpgsig-looking line; truncated output (framing claims
        // more bytes than present) ends the scan without panicking.
        let obj = object(SIGNED_HEADERS, "Ok\n");
        let mut out = format!("{SHA} tag {}\n", obj.len()).into_bytes();
        out.extend_from_slice(obj.as_bytes());
        out.push(b'\n');
        assert!(parse_batch_signature_presence(&out).is_empty());

        let truncated = format!("{SHA} commit 5000\ntoo short").into_bytes();
        assert!(parse_batch_signature_presence(&truncated).is_empty());
    }

    #[test]
    fn batch_presence_empty_input() {
        assert!(parse_batch_signature_presence(b"").is_empty());
    }
}
