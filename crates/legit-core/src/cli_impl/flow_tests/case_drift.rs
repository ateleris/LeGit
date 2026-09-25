use super::*;

// ---------------------------------------------------------------------------
// case drift - scan gate + staged case rename
// ---------------------------------------------------------------------------

#[tokio::test]
async fn case_drift_does_not_scan_on_case_sensitive_fs() {
    let fake = FakeExecutor::default();
    // core.ignorecase unset (exit 1) = case-sensitive filesystem: the scan
    // must end here - no ls-files, no directory listings.
    fake.expect(
        &["config", "--type=bool", "--get", "core.ignorecase"],
        out(1, "", ""),
    );
    let (b, exec) = backend(fake);
    assert_eq!(b.case_drift().await.unwrap(), Vec::new());
    exec.assert_done();
}

#[tokio::test]
async fn case_drift_scans_disk_listings_when_ignorecase() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("Test.c"), "x").unwrap();
    let fake = FakeExecutor::default();
    fake.expect(
        &["config", "--type=bool", "--get", "core.ignorecase"],
        ok("true\n"),
    );
    fake.expect(
        &["rev-parse", "--show-toplevel"],
        ok(&format!("{}\n", root.path().display())),
    );
    fake.expect(&["ls-files", "-z"], ok("test.c\0"));
    let (b, exec) = backend(fake);
    assert_eq!(
        b.case_drift().await.unwrap(),
        vec![CaseDriftEntry {
            index_path: "test.c".into(),
            disk_path: "Test.c".into(),
            is_dir: false,
        }]
    );
    exec.assert_done();
}

#[tokio::test]
async fn stage_case_rename_runs_git_mv() {
    let fake = FakeExecutor::default();
    fake.expect(&["mv", "--", "test.c", "Test.c"], ok(""));
    let (b, exec) = backend(fake);
    b.stage_case_rename("test.c", "Test.c").await.unwrap();
    exec.assert_done();
}

#[tokio::test]
async fn stage_case_rename_falls_back_through_a_temp_name() {
    // Some git/filesystem combinations refuse the direct case-only move
    // ("destination exists"); the fix goes through a temp name then.
    let fake = FakeExecutor::default();
    fake.expect(
        &["mv", "--", "test.c", "Test.c"],
        fail(128, "fatal: destination exists, source=test.c, destination=Test.c"),
    );
    fake.expect(&["mv", "--", "test.c", "Test.c.legit-casefix-tmp"], ok(""));
    fake.expect(&["mv", "--", "Test.c.legit-casefix-tmp", "Test.c"], ok(""));
    let (b, exec) = backend(fake);
    b.stage_case_rename("test.c", "Test.c").await.unwrap();
    exec.assert_done();
}

#[tokio::test]
async fn stage_case_rename_restores_the_original_name_when_the_fallback_fails() {
    // If the second temp-name step fails the file must not stay parked under
    // the temp name: restore the original, and the whole op errors.
    let fake = FakeExecutor::default();
    fake.expect(&["mv", "--", "test.c", "Test.c"], fail(128, "refused"));
    fake.expect(&["mv", "--", "test.c", "Test.c.legit-casefix-tmp"], ok(""));
    fake.expect(
        &["mv", "--", "Test.c.legit-casefix-tmp", "Test.c"],
        fail(128, "boom"),
    );
    fake.expect(&["mv", "--", "Test.c.legit-casefix-tmp", "test.c"], ok(""));
    let (b, exec) = backend(fake);
    assert!(b.stage_case_rename("test.c", "Test.c").await.is_err());
    exec.assert_done();
}

#[tokio::test]
async fn stage_case_rename_rejects_non_case_only_input() {
    // Guards are pure: nothing may reach git.
    let (b, exec) = backend(FakeExecutor::default());
    assert!(b.stage_case_rename("a.c", "b.c").await.is_err(), "different names");
    assert!(b.stage_case_rename("a.c", "a.c").await.is_err(), "identical names");
    assert!(b.stage_case_rename("../a.c", "../A.c").await.is_err(), "path escape");
    assert!(b.stage_case_rename("/abs/a.c", "/abs/A.c").await.is_err(), "absolute path");
    exec.assert_done();
}

#[tokio::test]
async fn pure_rename_unstaged_diff_skips_the_untracked_fallbacks() {
    // The case-drift state: index == HEAD (pricing.txt), disk has Pricing.txt,
    // so the pair diff is empty (pure rename). The empty-output fallbacks
    // (`ls-files` untracked probe -> `--no-index` whole file; nested-repo
    // probe) must NOT fire for a request that carries a rename source - they
    // turned the rename notice into a whole-file diff. `assert_done` pins
    // that the pair diff is the ONLY git invocation.
    let fake = FakeExecutor::default();
    fake.expect(
        &["-c", "diff.submodule=short", "diff", "--no-color", "--no-ext-diff", "-U3", "--find-renames", "--", "pricing.txt", "Pricing.txt"],
        ok(""),
    );
    let (b, exec) = backend(fake);

    let entry = b
        .file_diff(
            &DiffSource::WorkingUnstaged,
            Path::new("Pricing.txt"),
            Some(Path::new("pricing.txt")),
            3,
        )
        .await
        .unwrap();
    let DiffEntry::Text(text) = entry else { panic!("expected Text: {entry:?}") };
    assert!(text.hunks.is_empty(), "a pure rename has no hunks: {text:?}");
    exec.assert_done();
}

#[tokio::test]
async fn discard_case_rename_round_trips_through_the_index_spelling() {
    // Discarding case drift = renaming the disk file back to the tracked
    // spelling without touching the index. A direct `git mv <disk> <index>`
    // refuses ("not under version control": the source must be the INDEX
    // spelling), so the discard goes index-spelling -> temp -> index-spelling;
    // git finds the drifted disk file case-insensitively in step one.
    let fake = FakeExecutor::default();
    fake.expect(&["mv", "--", "test.c", "test.c.legit-casefix-tmp"], ok(""));
    fake.expect(&["mv", "--", "test.c.legit-casefix-tmp", "test.c"], ok(""));
    let (b, exec) = backend(fake);
    b.discard_case_rename("test.c", "Test.c").await.unwrap();
    exec.assert_done();
}

#[tokio::test]
async fn discard_case_rename_reports_a_file_left_under_the_temp_name() {
    // If the second step fails the file sits at the temp name with a staged
    // rename - the error must say so (a silent half-state is a house-rule
    // violation).
    let fake = FakeExecutor::default();
    fake.expect(&["mv", "--", "test.c", "test.c.legit-casefix-tmp"], ok(""));
    fake.expect(
        &["mv", "--", "test.c.legit-casefix-tmp", "test.c"],
        fail(128, "boom"),
    );
    let (b, exec) = backend(fake);
    let err = b.discard_case_rename("test.c", "Test.c").await.unwrap_err();
    assert!(
        format!("{err:?}").contains("legit-casefix-tmp"),
        "the error must name the temp file: {err:?}"
    );
    exec.assert_done();
}

#[tokio::test]
async fn discard_case_rename_rejects_non_case_only_input() {
    let (b, exec) = backend(FakeExecutor::default());
    assert!(b.discard_case_rename("a.c", "b.c").await.is_err(), "different names");
    assert!(b.discard_case_rename("a.c", "a.c").await.is_err(), "identical names");
    assert!(b.discard_case_rename("../a.c", "../A.c").await.is_err(), "path escape");
    exec.assert_done();
}
