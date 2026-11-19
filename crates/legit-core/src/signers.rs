//! SSH signer trust: SSHSIG public-key extraction and
//! `gpg.ssh.allowedSignersFile` handling (design/2026-11-19-trusted-ssh-signers.md).

use crate::config::ConfigScope;
use crate::error::GitError;
use crate::executor::GitExecutor;
use crate::fs::{FsError, HostPath, RepoFs};
use crate::types::{AllowedSigner, SshSignerKey, UnrecognizedSignerLine};
use base64::engine::general_purpose::{STANDARD as B64, STANDARD_NO_PAD as B64_NO_PAD};
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use specta::Type;

pub const KEY_ALLOWED_SIGNERS: &str = "gpg.ssh.allowedSignersFile";
/// Config value written on bootstrap; `~` is expanded by git on the host.
pub const BOOTSTRAP_SIGNERS_PATH: &str = "~/.config/git/allowed_signers";

/// Where `gpg.ssh.allowedSignersFile` resolves for a repo (effective config).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub enum SignersFileTarget {
    /// `path` is already tilde-expanded (read with `--type=path`).
    Configured { path: String, scope: ConfigScope },
    Unconfigured,
}

/// Everything the trust dialog needs for an Untrusted commit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct SignerTrustInfo {
    /// Committer email (the identity git matches against the signers file).
    pub principal: String,
    /// `None` when the commit's signature is not an SSHSIG (e.g. GPG).
    pub key: Option<SshSignerKey>,
    pub target: SignersFileTarget,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub enum TrustSignerOutcome {
    Added { path: String },
    AlreadyTrusted { path: String },
}

/// One allowed-signers file, parsed for the settings view.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct AllowedSignersView {
    pub path: String,
    pub exists: bool,
    pub signers: Vec<AllowedSigner>,
    pub unrecognized: Vec<UnrecognizedSignerLine>,
}

const ARMOR_BEGIN: &str = "-----BEGIN SSH SIGNATURE-----";
const ARMOR_END: &str = "-----END SSH SIGNATURE-----";

/// The `gpgsig` header's armored block from `git cat-file -p` output, when it
/// is an SSH signature. GPG armor and signature-less objects yield `None`.
pub fn extract_sshsig_armor(raw_object: &str) -> Option<String> {
    let mut lines = raw_object.lines();
    while let Some(line) = lines.next() {
        if line.is_empty() {
            return None;
        }
        if let Some(first) = line.strip_prefix("gpgsig ") {
            if first != ARMOR_BEGIN {
                return None;
            }
            let mut armor = String::from(first);
            for cont in lines.by_ref() {
                match cont.strip_prefix(' ') {
                    Some(c) => {
                        armor.push('\n');
                        armor.push_str(c);
                    }
                    None => break,
                }
            }
            return Some(armor);
        }
    }
    None
}

/// The signer's public key embedded in an armored SSHSIG blob. Any deviation
/// from the expected format (wrong armor, bad base64, wrong magic/version,
/// truncated wire data) yields `None`.
pub fn parse_sshsig_pubkey(armor: &str) -> Option<SshSignerKey> {
    let mut body = String::new();
    let mut in_body = false;
    for line in armor.lines() {
        let t = line.trim();
        if t == ARMOR_BEGIN {
            in_body = true;
        } else if t == ARMOR_END {
            break;
        } else if in_body {
            body.push_str(t);
        }
    }
    if !in_body {
        return None;
    }
    let blob = B64.decode(body.as_bytes()).ok()?;
    let rest = blob.strip_prefix(b"SSHSIG")?;
    let (version, rest) = read_u32(rest)?;
    if version != 1 {
        return None;
    }
    let (key_blob, _) = read_wire_string(rest)?;
    let (key_type, _) = read_wire_string(key_blob)?;
    Some(SshSignerKey {
        key_type: String::from_utf8(key_type.to_vec()).ok()?,
        key_b64: B64.encode(key_blob),
        fingerprint: format!("SHA256:{}", B64_NO_PAD.encode(Sha256::digest(key_blob))),
    })
}

/// The entry line LeGit writes when trusting a signer.
pub fn format_signer_entry(principal: &str, key_type: &str, key_b64: &str) -> String {
    format!("{principal} namespaces=\"git\" {key_type} {key_b64}")
}

/// Parse an allowed-signers file. Blank and `#` comment lines are skipped
/// silently; every other line either parses as `principals [options] keytype
/// base64 [comment]` or is returned as unrecognized (including
/// `cert-authority` entries and lines with whitespace inside quoted options,
/// which token-based parsing cannot represent).
pub fn parse_allowed_signers(text: &str) -> (Vec<AllowedSigner>, Vec<UnrecognizedSignerLine>) {
    let mut signers = Vec::new();
    let mut unrecognized = Vec::new();
    for (i, line) in text.lines().enumerate() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let line_index = i as u32;
        match parse_signer_line(line_index, trimmed) {
            Some(s) => signers.push(s),
            None => {
                unrecognized.push(UnrecognizedSignerLine { line_index, text: line.to_string() })
            }
        }
    }
    (signers, unrecognized)
}

fn parse_signer_line(line_index: u32, line: &str) -> Option<AllowedSigner> {
    let mut tokens = line.split_whitespace();
    let principal = tokens.next()?;
    if principal == "cert-authority" {
        return None;
    }
    let mut key_type = tokens.next()?;
    while key_type == "cert-authority" || key_type.contains('=') && !is_key_type(key_type) {
        if key_type == "cert-authority" {
            return None;
        }
        key_type = tokens.next()?;
    }
    if !is_key_type(key_type) {
        return None;
    }
    let key_b64 = tokens.next()?;
    let blob = B64.decode(key_b64.as_bytes()).ok()?;
    Some(AllowedSigner {
        line_index,
        principal: principal.to_string(),
        key_type: key_type.to_string(),
        key_b64: key_b64.to_string(),
        fingerprint: format!("SHA256:{}", B64_NO_PAD.encode(Sha256::digest(&blob))),
    })
}

fn is_key_type(token: &str) -> bool {
    token.starts_with("ssh-") || token.starts_with("ecdsa-") || token.starts_with("sk-")
}

/// Append a trust entry. `None` means an exact principal+key duplicate
/// already exists. All existing bytes are preserved; exactly one `\n`
/// separates the new line from the previous content.
pub fn append_signer(
    text: &str,
    principal: &str,
    key_type: &str,
    key_b64: &str,
) -> Option<String> {
    let (signers, _) = parse_allowed_signers(text);
    if signers.iter().any(|s| s.principal == principal && s.key_b64 == key_b64) {
        return None;
    }
    let mut out = String::from(text);
    if !out.is_empty() && !out.ends_with('\n') {
        out.push('\n');
    }
    out.push_str(&format_signer_entry(principal, key_type, key_b64));
    out.push('\n');
    Some(out)
}

/// A principal LeGit is willing to write: one token, nothing that could
/// smuggle extra fields or comments into the entry line. The committer email
/// comes from the (possibly crafted) commit object, so this is a security
/// check, not cosmetics.
pub fn valid_principal(principal: &str) -> bool {
    !principal.is_empty()
        && !principal.starts_with('#')
        && !principal.contains(|c: char| c.is_whitespace() || c.is_control() || c == '"')
}

/// Absolute on either host family (unix `/`, windows drive or UNC).
pub fn is_absolute_host_path(path: &str) -> bool {
    path.starts_with('/')
        || path.starts_with("\\\\")
        || (path.len() >= 3
            && path.as_bytes()[0].is_ascii_alphabetic()
            && path.as_bytes()[1] == b':'
            && (path.as_bytes()[2] == b'/' || path.as_bytes()[2] == b'\\'))
}

/// Remove exactly the line at `line_index`, but only when it still parses to
/// a recognized signer with `expected_principal` and `expected_key_b64`
/// (guards against the file having changed since it was listed, including a
/// line shift onto another key of the same principal). `None` on any
/// mismatch.
pub fn remove_signer_line(
    text: &str,
    line_index: u32,
    expected_principal: &str,
    expected_key_b64: &str,
) -> Option<String> {
    let (signers, _) = parse_allowed_signers(text);
    signers.iter().find(|s| {
        s.line_index == line_index
            && s.principal == expected_principal
            && s.key_b64 == expected_key_b64
    })?;
    Some(
        text.split_inclusive('\n')
            .enumerate()
            .filter(|(i, _)| *i as u32 != line_index)
            .map(|(_, l)| l)
            .collect(),
    )
}

/// Parse `git config --show-scope --type=path --get-all` stdout. Git's
/// effective value is the LAST entry; `worktree` and `command` scopes map to
/// `Local` (repo-scoped for our purposes).
pub fn parse_signers_target(stdout: &str) -> SignersFileTarget {
    let Some(line) = stdout.lines().filter(|l| !l.trim().is_empty()).next_back() else {
        return SignersFileTarget::Unconfigured;
    };
    let Some((scope, path)) = line.split_once('\t') else {
        return SignersFileTarget::Unconfigured;
    };
    let scope = match scope {
        "global" => ConfigScope::Global,
        "system" => ConfigScope::System,
        _ => ConfigScope::Local,
    };
    SignersFileTarget::Configured { path: path.trim().to_string(), scope }
}

/// Resolve the repo-effective allowed-signers file on `exec`'s host.
pub async fn resolve_signers_target<E: GitExecutor + ?Sized>(
    exec: &E,
) -> Result<SignersFileTarget, GitError> {
    // exit 1 = key unset anywhere.
    let out = exec
        .run_expecting(
            &["config", "--show-scope", "--type=path", "--get-all", KEY_ALLOWED_SIGNERS],
            &[1],
        )
        .await?;
    if !out.success {
        return Ok(SignersFileTarget::Unconfigured);
    }
    Ok(parse_signers_target(&out.stdout))
}

/// Tilde-expand a path the way git would on `exec`'s host (`--type=path`).
pub async fn expand_config_path<E: GitExecutor + ?Sized>(
    exec: &E,
    raw: &str,
) -> Result<String, GitError> {
    let carg = format!("legit.expandpath={raw}");
    let out = exec
        .run(&["-c", &carg, "config", "--type=path", "--get", "legit.expandpath"])
        .await?;
    if !out.success {
        return Err(GitError::Internal(format!(
            "could not expand path {raw:?}: {}",
            out.stderr.trim()
        )));
    }
    Ok(out.stdout.trim().to_string())
}

fn fs_err(e: FsError) -> GitError {
    GitError::Internal(e.to_string())
}

/// `None` when the file does not exist.
async fn read_signers_bytes(fs: &dyn RepoFs, path: &str) -> Result<Option<Vec<u8>>, GitError> {
    let hp = HostPath(path.to_string());
    match fs.stat(&hp).await.map_err(fs_err)? {
        None => Ok(None),
        Some(_) => Ok(Some(fs.read(&hp, None).await.map_err(fs_err)?)),
    }
}

/// Lossy decode, for DISPLAY only - never for a read-modify-write.
async fn read_signers_text(fs: &dyn RepoFs, path: &str) -> Result<Option<String>, GitError> {
    Ok(read_signers_bytes(fs, path)
        .await?
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned()))
}

/// Strict decode for mutations: a lossy round-trip would silently corrupt
/// non-UTF-8 bytes (e.g. a Latin-1 comment), breaking byte preservation.
async fn read_signers_text_strict(
    fs: &dyn RepoFs,
    path: &str,
) -> Result<Option<String>, GitError> {
    match read_signers_bytes(fs, path).await? {
        None => Ok(None),
        Some(bytes) => String::from_utf8(bytes).map(Some).map_err(|_| {
            GitError::Internal(format!(
                "the allowed-signers file {path} is not valid UTF-8; refusing to modify it"
            ))
        }),
    }
}

/// Parse one allowed-signers file for display.
pub async fn list_signers(fs: &dyn RepoFs, path: &str) -> Result<AllowedSignersView, GitError> {
    match read_signers_text(fs, path).await? {
        None => Ok(AllowedSignersView {
            path: path.to_string(),
            exists: false,
            signers: vec![],
            unrecognized: vec![],
        }),
        Some(text) => {
            let (signers, unrecognized) = parse_allowed_signers(&text);
            Ok(AllowedSignersView { path: path.to_string(), exists: true, signers, unrecognized })
        }
    }
}

/// Append a trust entry to the file at `path` (created when missing).
pub async fn add_signer(
    fs: &dyn RepoFs,
    path: &str,
    principal: &str,
    key_type: &str,
    key_b64: &str,
) -> Result<TrustSignerOutcome, GitError> {
    let text = read_signers_text_strict(fs, path).await?.unwrap_or_default();
    match append_signer(&text, principal, key_type, key_b64) {
        None => Ok(TrustSignerOutcome::AlreadyTrusted { path: path.to_string() }),
        Some(new_text) => {
            fs.write(&HostPath(path.to_string()), new_text.as_bytes()).await.map_err(fs_err)?;
            Ok(TrustSignerOutcome::Added { path: path.to_string() })
        }
    }
}

/// Remove one listed entry; errors when the file changed since it was listed.
pub async fn remove_signer(
    fs: &dyn RepoFs,
    path: &str,
    line_index: u32,
    expected_principal: &str,
    expected_key_b64: &str,
) -> Result<(), GitError> {
    let text = read_signers_text_strict(fs, path).await?.ok_or_else(|| {
        GitError::Internal(format!("allowed-signers file not found: {path}"))
    })?;
    let new_text = remove_signer_line(&text, line_index, expected_principal, expected_key_b64)
        .ok_or_else(|| {
        GitError::Internal(
            "the allowed-signers file changed since it was listed - reload and try again".into(),
        )
    })?;
    fs.write(&HostPath(path.to_string()), new_text.as_bytes()).await.map_err(fs_err)
}

/// Create the LeGit-managed signers file and point the host's global git
/// config at it. Returns the expanded path.
pub async fn bootstrap_signers_file<E: GitExecutor + ?Sized>(
    exec: &E,
    fs: &dyn RepoFs,
) -> Result<String, GitError> {
    let out = exec
        .run(&["config", "--global", KEY_ALLOWED_SIGNERS, BOOTSTRAP_SIGNERS_PATH])
        .await?;
    if !out.success {
        return Err(GitError::Internal(format!(
            "could not set {KEY_ALLOWED_SIGNERS}: {}",
            out.stderr.trim()
        )));
    }
    let path = expand_config_path(exec, BOOTSTRAP_SIGNERS_PATH).await?;
    if let Some(parent) = parent_dir(&path) {
        fs.create_dir_all(&HostPath(parent.to_string())).await.map_err(fs_err)?;
    }
    Ok(path)
}

fn parent_dir(path: &str) -> Option<&str> {
    let cut = path.rfind(['/', '\\'])?;
    (cut > 0).then(|| &path[..cut])
}

/// The whole trust flow: resolve the effective signers file (bootstrapping it
/// when allowed) and append the entry.
pub async fn trust_signer_flow<E: GitExecutor + ?Sized>(
    exec: &E,
    fs: &dyn RepoFs,
    principal: &str,
    key_type: &str,
    key_b64: &str,
    bootstrap: bool,
) -> Result<TrustSignerOutcome, GitError> {
    if !valid_principal(principal) {
        return Err(GitError::Internal(format!(
            "refusing to trust a malformed principal: {principal:?}"
        )));
    }
    let path = match resolve_signers_target(exec).await? {
        SignersFileTarget::Configured { path, .. } => path,
        SignersFileTarget::Unconfigured if bootstrap => bootstrap_signers_file(exec, fs).await?,
        SignersFileTarget::Unconfigured => {
            return Err(GitError::Internal(
                "no allowed-signers file is configured for this repository".into(),
            ))
        }
    };
    // git resolves a relative config value against the repo top-level when it
    // verifies; writing it against the process cwd would miss that file.
    let path = if is_absolute_host_path(&path) {
        path
    } else {
        let out = exec.run(&["rev-parse", "--show-toplevel"]).await?;
        if !out.success {
            return Err(GitError::Internal(format!(
                "could not resolve the repository root for the relative allowed-signers path {path:?}: {}",
                out.stderr.trim()
            )));
        }
        format!("{}/{path}", out.stdout.trim())
    };
    add_signer(fs, &path, principal, key_type, key_b64).await
}

fn read_u32(data: &[u8]) -> Option<(u32, &[u8])> {
    let (head, rest) = (data.get(..4)?, &data[4..]);
    Some((u32::from_be_bytes(head.try_into().ok()?), rest))
}

fn read_wire_string(data: &[u8]) -> Option<(&[u8], &[u8])> {
    let (len, rest) = read_u32(data)?;
    let len = len as usize;
    Some((rest.get(..len)?, &rest[len..]))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Captured from a real `ssh-keygen -Y sign -n git` run (ed25519).
    const SAMPLE_ARMOR: &str = "-----BEGIN SSH SIGNATURE-----\n\
U1NIU0lHAAAAAQAAADMAAAALc3NoLWVkMjU1MTkAAAAgGgs4DPYouR7YDhk0ErtrScaFek\n\
TSkA31EP6lvsqOj/IAAAADZ2l0AAAAAAAAAAZzaGE1MTIAAABTAAAAC3NzaC1lZDI1NTE5\n\
AAAAQOZ6F+q2sc+tO2hVJv1guIGe8QxCQSpj8ld6EMp76g8TcMrESD0QUnEik2fDQGrvuV\n\
I887k4vDkdncGGeN6+Vwo=\n\
-----END SSH SIGNATURE-----";

    const SAMPLE_KEY_B64: &str =
        "AAAAC3NzaC1lZDI1NTE5AAAAIBoLOAz2KLke2A4ZNBK7a0nGhXpE0pAN9RD+pb7Kjo/y";
    const SAMPLE_FINGERPRINT: &str = "SHA256:z32N43bv72WO4aL/FvB4GVxkbkSYGUzMh1XCuQCfTjs";

    fn armored_object(armor: &str) -> String {
        let mut headers = String::from("tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\n");
        let mut lines = armor.lines();
        headers.push_str(&format!("gpgsig {}\n", lines.next().unwrap()));
        for l in lines {
            headers.push_str(&format!(" {l}\n"));
        }
        headers.push_str(
            "author Alice <alice@example.com> 1710504000 +0200\n\
             committer Alice <alice@example.com> 1710504000 +0200\n\
             \n\
             Subject\n",
        );
        headers
    }

    #[test]
    fn parses_real_sshsig_pubkey() {
        let key = parse_sshsig_pubkey(SAMPLE_ARMOR).expect("sample must parse");
        assert_eq!(key.key_type, "ssh-ed25519");
        assert_eq!(key.key_b64, SAMPLE_KEY_B64);
        assert_eq!(key.fingerprint, SAMPLE_FINGERPRINT);
    }

    #[test]
    fn rejects_gpg_armor() {
        let armor = "-----BEGIN PGP SIGNATURE-----\naGVsbG8=\n-----END PGP SIGNATURE-----";
        assert_eq!(parse_sshsig_pubkey(armor), None);
    }

    #[test]
    fn rejects_truncated_blob() {
        let lines: Vec<&str> = SAMPLE_ARMOR.lines().collect();
        let truncated = [&lines[..4], &[lines[lines.len() - 1]]].concat().join("\n");
        assert_eq!(parse_sshsig_pubkey(&truncated), None);
    }

    const FILE: &str = "# team roster\n\
alice@example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBoLOAz2KLke2A4ZNBK7a0nGhXpE0pAN9RD+pb7Kjo/y alice laptop\n\
\n\
bob@x.ch,bob@y.ch namespaces=\"git\" valid-after=\"20240101\" ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQDJ bob\n\
cert-authority *@corp.example ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n\
not a parseable line\n";

    #[test]
    fn parses_mixed_file() {
        let (signers, unrecognized) = parse_allowed_signers(FILE);
        assert_eq!(signers.len(), 2);
        assert_eq!(signers[0].line_index, 1);
        assert_eq!(signers[0].principal, "alice@example.com");
        assert_eq!(signers[0].key_type, "ssh-ed25519");
        assert_eq!(signers[0].key_b64, SAMPLE_KEY_B64);
        assert_eq!(signers[0].fingerprint, SAMPLE_FINGERPRINT);
        assert_eq!(signers[1].line_index, 3);
        assert_eq!(signers[1].principal, "bob@x.ch,bob@y.ch");
        assert_eq!(signers[1].key_type, "ssh-rsa");
        let idx: Vec<u32> = unrecognized.iter().map(|u| u.line_index).collect();
        assert_eq!(idx, [4, 5]);
        assert_eq!(unrecognized[1].text, "not a parseable line");
    }

    #[test]
    fn append_preserves_bytes() {
        let out = append_signer(FILE, "carol@example.com", "ssh-ed25519", "AAAATEST").unwrap();
        assert_eq!(
            out,
            format!("{FILE}carol@example.com namespaces=\"git\" ssh-ed25519 AAAATEST\n")
        );
    }

    #[test]
    fn append_detects_duplicate() {
        assert_eq!(append_signer(FILE, "alice@example.com", "ssh-ed25519", SAMPLE_KEY_B64), None);
        assert!(append_signer(FILE, "carol@example.com", "ssh-ed25519", SAMPLE_KEY_B64).is_some());
    }

    #[test]
    fn remove_exact_line() {
        let out =
            remove_signer_line(FILE, 3, "bob@x.ch,bob@y.ch", "AAAAB3NzaC1yc2EAAAADAQABAAABgQDJ")
                .unwrap();
        let expected: String = FILE
            .split_inclusive('\n')
            .enumerate()
            .filter(|(i, _)| *i != 3)
            .map(|(_, l)| l)
            .collect();
        assert_eq!(out, expected);
    }

    #[test]
    fn remove_refuses_mismatch() {
        assert_eq!(remove_signer_line(FILE, 3, "alice@example.com", "AAAAB3NzaC1yc2EAAAADAQABAAABgQDJ"), None);
        assert_eq!(remove_signer_line(FILE, 0, "alice@example.com", SAMPLE_KEY_B64), None);
    }

    // An external edit can shift line indices; with two keys under the SAME
    // principal, index+principal alone would delete the neighbouring key.
    #[test]
    fn remove_requires_matching_key() {
        let two = "a@x ssh-ed25519 AAAAQQ==\na@x ssh-ed25519 AAAATEST\n";
        assert_eq!(remove_signer_line(two, 0, "a@x", "AAAATEST"), None);
        assert_eq!(
            remove_signer_line(two, 0, "a@x", "AAAAQQ==").as_deref(),
            Some("a@x ssh-ed25519 AAAATEST\n")
        );
    }

    #[test]
    fn principal_validation() {
        assert!(valid_principal("alice@example.com"));
        assert!(valid_principal("bob@x.ch,bob@y.ch"));
        assert!(!valid_principal(""));
        assert!(!valid_principal("a@x cert-authority"));
        assert!(!valid_principal("a\"x@y"));
        assert!(!valid_principal("a@x\n"));
        assert!(!valid_principal("#a@x"));
    }

    #[test]
    fn absolute_path_detection() {
        assert!(is_absolute_host_path("/home/u/signers"));
        assert!(is_absolute_host_path("C:\\Users\\u\\signers"));
        assert!(is_absolute_host_path("C:/Users/u/signers"));
        assert!(is_absolute_host_path("\\\\server\\share\\f"));
        assert!(!is_absolute_host_path("rel/signers"));
        assert!(!is_absolute_host_path("~/signers"));
        assert!(!is_absolute_host_path(""));
    }

    #[test]
    fn append_to_empty_and_no_trailing_newline() {
        assert_eq!(
            append_signer("", "c@x", "ssh-ed25519", "AAAATEST").unwrap(),
            "c@x namespaces=\"git\" ssh-ed25519 AAAATEST\n"
        );
        assert_eq!(
            append_signer("a@x ssh-ed25519 AAAAQQ==", "c@x", "ssh-ed25519", "AAAATEST").unwrap(),
            "a@x ssh-ed25519 AAAAQQ==\nc@x namespaces=\"git\" ssh-ed25519 AAAATEST\n"
        );
    }

    #[test]
    fn signers_target_takes_last_entry_and_maps_scopes() {
        use crate::config::ConfigScope;
        assert_eq!(
            parse_signers_target("system\t/etc/signers\nglobal\t/home/u/signers\n"),
            SignersFileTarget::Configured {
                path: "/home/u/signers".into(),
                scope: ConfigScope::Global
            }
        );
        assert_eq!(
            parse_signers_target("worktree\t/wt/signers\n"),
            SignersFileTarget::Configured { path: "/wt/signers".into(), scope: ConfigScope::Local }
        );
        assert_eq!(parse_signers_target(""), SignersFileTarget::Unconfigured);
    }

    #[test]
    fn extracts_armor_from_cat_file_output() {
        let raw = armored_object(SAMPLE_ARMOR);
        assert_eq!(extract_sshsig_armor(&raw).as_deref(), Some(SAMPLE_ARMOR));

        let unsigned = "tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\n\
                        author A <a@x> 1 +0000\ncommitter A <a@x> 1 +0000\n\nSubject\n";
        assert_eq!(extract_sshsig_armor(unsigned), None);

        let gpg = armored_object(
            "-----BEGIN PGP SIGNATURE-----\naGVsbG8=\n-----END PGP SIGNATURE-----",
        );
        assert_eq!(extract_sshsig_armor(&gpg), None);
    }
}
