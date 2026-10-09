use super::*;

// ---------------------------------------------------------------------------
// hooks_report - dir resolution + core.hooksPath + listing (LocalFs reads a
// real tempdir hooks directory)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn hooks_report_resolves_dir_redirection_and_listing() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("pre-commit"), "#!/bin/sh\n").unwrap();
    std::fs::write(dir.path().join("pre-commit.sample"), "x").unwrap();

    let fake = FakeExecutor::default();
    fake.expect(
        &["rev-parse", "--path-format=absolute", "--git-path", "hooks"],
        ok(&format!("{}\n", dir.path().display())),
    );
    fake.expect(&["config", "--get", "core.hooksPath"], ok(".husky\n"));
    let (b, exec) = backend(fake);

    let report = b.hooks_report().await.unwrap();
    assert_eq!(report.dir, dir.path().display().to_string());
    assert_eq!(report.hooks_path.as_deref(), Some(".husky"));
    assert_eq!(report.hooks.len(), 1, "{:?}", report.hooks);
    assert_eq!(report.hooks[0].name, "pre-commit");
    exec.assert_done();
}

// ---------------------------------------------------------------------------
// remove_hook - default-dir-only deletion with name validation
// ---------------------------------------------------------------------------

#[tokio::test]
async fn remove_hook_deletes_the_file_from_the_default_dir() {
    let dir = tempfile::tempdir().unwrap();
    let hook = dir.path().join("pre-commit");
    std::fs::write(&hook, "#!/bin/sh\nexit 1\n").unwrap();

    let fake = FakeExecutor::default();
    // Unset core.hooksPath (exit 1) = the default dir, where removal is allowed.
    fake.expect(&["config", "--get", "core.hooksPath"], fail(1, ""));
    fake.expect(
        &["rev-parse", "--path-format=absolute", "--git-path", "hooks"],
        ok(&format!("{}\n", dir.path().display())),
    );
    let (b, exec) = backend(fake);

    b.remove_hook("pre-commit").await.unwrap();
    assert!(!hook.exists());
    exec.assert_done();
}

#[tokio::test]
async fn remove_hook_refuses_a_redirected_hooks_dir() {
    let fake = FakeExecutor::default();
    // No rev-parse scripted: the refusal must come before any resolution.
    fake.expect(&["config", "--get", "core.hooksPath"], ok(".husky\n"));
    let (b, exec) = backend(fake);

    let err = b.remove_hook("pre-commit").await.unwrap_err();
    assert!(matches!(err, GitError::Internal(_)), "{err:?}");
    exec.assert_done();
}

#[tokio::test]
async fn remove_hook_refuses_non_hook_names_before_running_anything() {
    // Nothing scripted: an invalid name must never reach git or the fs.
    let (b, exec) = backend(FakeExecutor::default());

    for name in ["pre-commit.sample", "../config", "sub/pre-commit", ""] {
        let err = b.remove_hook(name).await.unwrap_err();
        assert!(matches!(err, GitError::Internal(_)), "{name}: {err:?}");
    }
    exec.assert_done();
}

#[tokio::test]
async fn hooks_report_missing_dir_and_unset_hooks_path_is_empty_not_error() {
    let fake = FakeExecutor::default();
    fake.expect(
        &["rev-parse", "--path-format=absolute", "--git-path", "hooks"],
        ok("/nonexistent/hooks\n"),
    );
    // Unset core.hooksPath exits 1 - an expected outcome, not a failure.
    fake.expect(&["config", "--get", "core.hooksPath"], fail(1, ""));
    let (b, exec) = backend(fake);

    let report = b.hooks_report().await.unwrap();
    assert_eq!(report.hooks_path, None);
    assert!(report.hooks.is_empty(), "{:?}", report.hooks);
    exec.assert_done();
}
