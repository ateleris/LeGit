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
        },
        has_signature_header: has_sig,
        raw_object: raw.to_string(),
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
        } else if let Some(rest) = line.strip_prefix("[SSH:] GOOD_SIGNATURE ") {
            status = SignatureStatus::Good;
            signer = Some(rest.trim().to_string());
        } else if line.starts_with("[SSH:] BAD_SIGNATURE") {
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

    #[test]
    fn verify_ssh_good() {
        let stderr = "[SSH:] GOOD_SIGNATURE SHA256:abc123key VALID\n";
        let v = parse_verify_commit(stderr).unwrap();
        assert_eq!(v.status, SignatureStatus::Good);
    }
}
