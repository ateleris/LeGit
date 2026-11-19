//! Signer-trust flows: resolve `gpg.ssh.allowedSignersFile`, append trust
//! entries, bootstrap the file + global config when unconfigured.

use super::*;
use crate::signers::{SignersFileTarget, TrustSignerOutcome};
use crate::types::CommitId;
use legit_core_test_fixtures::*;

mod legit_core_test_fixtures {
    // Captured from a real `ssh-keygen -Y sign -n git` run (same sample as the
    // signers unit tests).
    pub const SAMPLE_ARMOR: &str = "-----BEGIN SSH SIGNATURE-----\n\
U1NIU0lHAAAAAQAAADMAAAALc3NoLWVkMjU1MTkAAAAgGgs4DPYouR7YDhk0ErtrScaFek\n\
TSkA31EP6lvsqOj/IAAAADZ2l0AAAAAAAAAAZzaGE1MTIAAABTAAAAC3NzaC1lZDI1NTE5\n\
AAAAQOZ6F+q2sc+tO2hVJv1guIGe8QxCQSpj8ld6EMp76g8TcMrESD0QUnEik2fDQGrvuV\n\
I887k4vDkdncGGeN6+Vwo=\n\
-----END SSH SIGNATURE-----";

    pub const PGP_ARMOR: &str =
        "-----BEGIN PGP SIGNATURE-----\naGVsbG8=\n-----END PGP SIGNATURE-----";

    pub fn armored_object(armor: &str) -> String {
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
}

const SHA: &str = "abc123def456abc123def456abc123def456abc1";
const RESOLVE_ARGS: &[&str] =
    &["config", "--show-scope", "--type=path", "--get-all", "gpg.ssh.allowedSignersFile"];

#[tokio::test]
async fn trust_info_sequence() {
    let script = FakeExecutor::default();
    script
        .expect(&["cat-file", "-p", SHA], ok(&armored_object(SAMPLE_ARMOR)))
        .expect(RESOLVE_ARGS, ok("local\t/home/u/.ssh/signers\n"));
    let (backend, exec) = backend(script);

    let info = backend.signer_trust_info(&CommitId::new(SHA)).await.unwrap();
    assert_eq!(info.principal, "alice@example.com");
    let key = info.key.expect("ssh signature must yield a key");
    assert_eq!(key.key_type, "ssh-ed25519");
    assert_eq!(
        info.target,
        SignersFileTarget::Configured {
            path: "/home/u/.ssh/signers".into(),
            scope: crate::config::ConfigScope::Local,
        }
    );
    exec.assert_done();
}

#[tokio::test]
async fn gpg_signed_commit_yields_no_key() {
    let script = FakeExecutor::default();
    script
        .expect(&["cat-file", "-p", SHA], ok(&armored_object(PGP_ARMOR)))
        .expect(RESOLVE_ARGS, ok("global\t/x\n"));
    let (backend, exec) = backend(script);

    let info = backend.signer_trust_info(&CommitId::new(SHA)).await.unwrap();
    assert_eq!(info.key, None);
    exec.assert_done();
}

#[tokio::test]
async fn trust_appends_to_configured_file() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("signers");
    std::fs::write(&file, "x@y ssh-ed25519 AAAAQQ==\n").unwrap();
    let path = file.to_str().unwrap().to_string();

    let script = FakeExecutor::default();
    script.expect(RESOLVE_ARGS, ok(&format!("global\t{path}\n")));
    let (backend, exec) = backend(script);

    let outcome =
        backend.trust_signer("carol@example.com", "ssh-ed25519", "AAAATEST", false).await.unwrap();
    assert_eq!(outcome, TrustSignerOutcome::Added { path: path.clone() });
    assert_eq!(
        std::fs::read_to_string(&file).unwrap(),
        "x@y ssh-ed25519 AAAAQQ==\ncarol@example.com namespaces=\"git\" ssh-ed25519 AAAATEST\n"
    );
    // assert_done also proves no `config --global` write ran.
    exec.assert_done();
}

#[tokio::test]
async fn trust_duplicate_is_noop() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("signers");
    let seeded = "carol@example.com namespaces=\"git\" ssh-ed25519 AAAATEST\n";
    std::fs::write(&file, seeded).unwrap();
    let path = file.to_str().unwrap().to_string();

    let script = FakeExecutor::default();
    script.expect(RESOLVE_ARGS, ok(&format!("global\t{path}\n")));
    let (backend, exec) = backend(script);

    let outcome =
        backend.trust_signer("carol@example.com", "ssh-ed25519", "AAAATEST", false).await.unwrap();
    assert_eq!(outcome, TrustSignerOutcome::AlreadyTrusted { path });
    assert_eq!(std::fs::read_to_string(&file).unwrap(), seeded);
    exec.assert_done();
}

#[tokio::test]
async fn trust_bootstrap_sequence() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("cfg").join("git").join("allowed_signers");
    let path = file.to_str().unwrap().to_string();

    let script = FakeExecutor::default();
    script
        .expect(RESOLVE_ARGS, fail(1, ""))
        .expect(
            &["config", "--global", "gpg.ssh.allowedSignersFile", "~/.config/git/allowed_signers"],
            ok(""),
        )
        .expect(
            &[
                "-c",
                "legit.expandpath=~/.config/git/allowed_signers",
                "config",
                "--type=path",
                "--get",
                "legit.expandpath",
            ],
            ok(&format!("{path}\n")),
        );
    let (backend, exec) = backend(script);

    let outcome =
        backend.trust_signer("carol@example.com", "ssh-ed25519", "AAAATEST", true).await.unwrap();
    assert_eq!(outcome, TrustSignerOutcome::Added { path });
    assert_eq!(
        std::fs::read_to_string(&file).unwrap(),
        "carol@example.com namespaces=\"git\" ssh-ed25519 AAAATEST\n"
    );
    exec.assert_done();
}

// A crafted committer email must never reach the signers file: whitespace
// would smuggle extra tokens (e.g. `cert-authority`) into the entry. The
// refusal happens before any git call.
#[tokio::test]
async fn trust_rejects_malformed_principal() {
    let (backend, exec) = backend(FakeExecutor::default());
    let err = backend
        .trust_signer("a@x cert-authority", "ssh-ed25519", "AAAATEST", false)
        .await
        .unwrap_err();
    assert!(err.to_string().contains("principal"), "unexpected error: {err}");
    exec.assert_done();
}

// git returns a relative config value verbatim and resolves it against the
// repo top-level when verifying; writing it against the process cwd would
// land in an unrelated directory.
#[tokio::test]
async fn trust_resolves_relative_signers_path_against_toplevel() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap().to_string();
    std::fs::write(dir.path().join("signers"), "").unwrap();

    let script = FakeExecutor::default();
    script
        .expect(RESOLVE_ARGS, ok("local\tsigners\n"))
        .expect(&["rev-parse", "--show-toplevel"], ok(&format!("{root}\n")));
    let (backend, exec) = backend(script);

    let outcome =
        backend.trust_signer("carol@example.com", "ssh-ed25519", "AAAATEST", false).await.unwrap();
    let expected = format!("{root}/signers");
    assert_eq!(outcome, TrustSignerOutcome::Added { path: expected.clone() });
    assert_eq!(
        std::fs::read_to_string(dir.path().join("signers")).unwrap(),
        "carol@example.com namespaces=\"git\" ssh-ed25519 AAAATEST\n"
    );
    exec.assert_done();
}

// Byte preservation includes bytes that are not UTF-8 (a Latin-1 comment in
// a hand-maintained file): a lossy round-trip would corrupt them, so the
// mutation is refused instead.
#[tokio::test]
async fn trust_refuses_non_utf8_file() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("signers");
    let original: &[u8] = b"# caf\xe9\na@x ssh-ed25519 AAAAQQ==\n";
    std::fs::write(&file, original).unwrap();
    let path = file.to_str().unwrap().to_string();

    let script = FakeExecutor::default();
    script.expect(RESOLVE_ARGS, ok(&format!("global\t{path}\n")));
    let (backend, exec) = backend(script);

    let err = backend
        .trust_signer("carol@example.com", "ssh-ed25519", "AAAATEST", false)
        .await
        .unwrap_err();
    assert!(err.to_string().contains("UTF-8"), "unexpected error: {err}");
    assert_eq!(std::fs::read(&file).unwrap(), original, "file must be untouched");
    exec.assert_done();
}

#[tokio::test]
async fn trust_unconfigured_without_bootstrap_errors() {
    let script = FakeExecutor::default();
    script.expect(RESOLVE_ARGS, fail(1, ""));
    let (backend, exec) = backend(script);

    let err = backend.trust_signer("c@x", "ssh-ed25519", "AAAATEST", false).await.unwrap_err();
    assert!(err.to_string().contains("allowed-signers"), "unexpected error: {err}");
    exec.assert_done();
}
