use super::*;

// ---------------------------------------------------------------------------
// gitmodules_consistency - staged .gitmodules vs staged gitlinks
// ---------------------------------------------------------------------------

const RAW_DIFF: [&str; 5] = ["diff", "--cached", "--raw", "-z", "--no-renames"];
const STAGED_GITMODULES: [&str; 6] =
    ["config", "--blob", ":.gitmodules", "-z", "--get-regexp", "^submodule\\."];

#[tokio::test]
async fn gitmodules_check_skips_when_staged_diff_is_irrelevant() {
    // A commit touching neither .gitmodules nor a gitlink must cost exactly
    // one gate diff - assert_done pins that config/ls-files never run.
    let fake = FakeExecutor::default();
    fake.expect(
        &RAW_DIFF,
        ok(":100644 100644 aaa bbb M\0src/main.rs\0"),
    );
    let (b, exec) = backend(fake);

    let findings = b.gitmodules_consistency().await.unwrap();
    assert_eq!(findings, vec![]);
    exec.assert_done();
}

#[tokio::test]
async fn gitmodules_check_flags_orphaned_gitlink() {
    // .gitmodules changed; the staged blob has no sections left (config
    // exits 1) while a gitlink is still staged - the Aug-4 "sure" breakage.
    let fake = FakeExecutor::default();
    fake.expect(&RAW_DIFF, ok(":100644 100644 aaa bbb M\0.gitmodules\0"));
    fake.expect(&STAGED_GITMODULES, fail(1, ""));
    fake.expect(
        &["ls-files", "--stage", "-z"],
        ok("160000 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 0\tsubs/x\0"),
    );
    let (b, exec) = backend(fake);

    let findings = b.gitmodules_consistency().await.unwrap();
    assert_eq!(
        findings,
        vec![GitmodulesFinding::GitlinkWithoutEntry { path: "subs/x".into() }]
    );
    exec.assert_done();
}

#[tokio::test]
async fn gitmodules_check_flags_dangling_entry() {
    let fake = FakeExecutor::default();
    fake.expect(&RAW_DIFF, ok(":100644 100644 aaa bbb M\0.gitmodules\0"));
    fake.expect(
        &STAGED_GITMODULES,
        ok("submodule.lib.path\nvendor/lib\0submodule.lib.url\nhttps://x.invalid/lib.git\0"),
    );
    fake.expect(&["ls-files", "--stage", "-z"], ok(""));
    let (b, exec) = backend(fake);

    let findings = b.gitmodules_consistency().await.unwrap();
    assert_eq!(
        findings,
        vec![GitmodulesFinding::EntryWithoutGitlink {
            name: "lib".into(),
            path: "vendor/lib".into(),
        }]
    );
    exec.assert_done();
}

#[tokio::test]
async fn gitmodules_check_gate_failure_falls_through_to_the_full_check() {
    // The gate diff is an optimization: if it fails (e.g. unborn HEAD on
    // some git versions), the check proceeds rather than erroring or
    // silently skipping.
    let fake = FakeExecutor::default();
    fake.expect(&RAW_DIFF, fail(128, "fatal: bad revision 'HEAD'\n"));
    fake.expect(&STAGED_GITMODULES, fail(1, ""));
    fake.expect(&["ls-files", "--stage", "-z"], ok(""));
    let (b, exec) = backend(fake);

    let findings = b.gitmodules_consistency().await.unwrap();
    assert_eq!(findings, vec![]);
    exec.assert_done();
}

// ---------------------------------------------------------------------------
// submodules - enumeration orchestration
// ---------------------------------------------------------------------------

#[tokio::test]
async fn submodules_without_gitlinks_or_gitmodules_stops_after_config_probe() {
    // A repo without submodules answers from the index listing plus one
    // `.gitmodules` probe (exit 1 = "no matches / no file", a normal state
    // that must not log as a failure): the local config read, the status
    // read, and the probes must not run - assert_done encodes that.
    let sha_a = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let fake = FakeExecutor::default();
    fake.expect(
        &["ls-files", "--stage", "-z"],
        ok(&format!("100644 {sha_a} 0\tREADME.md\0100644 {sha_a} 0\tsrc/main.rs\0")),
    );
    fake.expect(
        &["config", "-f", ".gitmodules", "-z", "--get-regexp", "^submodule\\."],
        fail(1, ""),
    );
    let (b, exec) = backend(fake);

    assert!(b.submodules().await.unwrap().is_empty());
    exec.assert_done();
}

#[tokio::test]
async fn submodules_surfaces_declared_but_never_added_entry() {
    // `.gitmodules` declares a path but no gitlink exists in the index (the
    // half-added state: config written/staged, submodule never `git add`ed).
    // The row must still surface so the Refs panel can show it - the
    // no-gitlink fast path applies only when nothing is declared either.
    let sha_a = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let fake = FakeExecutor::default();
    fake.expect(
        &["ls-files", "--stage", "-z"],
        ok(&format!("100644 {sha_a} 0\t.gitmodules\0")),
    );
    fake.expect(
        &["config", "-f", ".gitmodules", "-z", "--get-regexp", "^submodule\\."],
        ok("submodule.lib.path\nlib\0submodule.lib.url\nhttps://x.invalid/lib.git\0"),
    );
    fake.expect(&["config", "-z", "--get-regexp", "^submodule\\."], fail(1, ""));
    fake.expect(
        &["status", "--porcelain=v2", "-z", "--untracked-files=all"],
        ok("? lib/\0"),
    );
    let (b, exec) = backend(fake);

    let subs = b.submodules().await.unwrap();
    assert_eq!(subs.len(), 1);
    let s = &subs[0];
    assert_eq!(s.name, "lib");
    assert_eq!(s.path, std::path::PathBuf::from("lib"));
    assert_eq!(s.recorded_sha, None, "no gitlink in the index");
    assert!(!s.state.initialized && !s.state.populated);
    // assert_done proves no per-path probe ran (there is nothing to probe).
    exec.assert_done();
}

#[tokio::test]
async fn submodules_enumerates_without_git_submodule_status() {
    let sha_a = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let fake = FakeExecutor::default();
    fake.expect(
        &["ls-files", "--stage", "-z"],
        ok(&format!("100644 {sha_a} 0\tREADME.md\0160000 {sha_a} 0\tlib\0")),
    );
    fake.expect(
        &["config", "-f", ".gitmodules", "-z", "--get-regexp", "^submodule\\."],
        ok("submodule.lib.path\nlib\0submodule.lib.url\nhttps://x.invalid/lib.git\0"),
    );
    fake.expect(
        &["config", "-z", "--get-regexp", "^submodule\\."],
        ok("submodule.lib.url\nhttps://x.invalid/lib.git\0submodule.lib.active\ntrue\0"),
    );
    fake.expect(
        &["status", "--porcelain=v2", "-z", "--untracked-files=all"],
        ok("1 .M S.M. 160000 160000 160000 aaaaaaa aaaaaaa lib\0"),
    );
    fake.expect(
        &["-C", "lib", "rev-parse", "--show-prefix", "HEAD"],
        ok(&format!("\n{sha_a}\n")),
    );
    fake.expect(&["-C", "lib", "rev-parse", "--abbrev-ref", "HEAD"], ok("HEAD\n"));
    let (b, exec) = backend(fake);

    let subs = b.submodules().await.unwrap();
    assert_eq!(subs.len(), 1);
    let s = &subs[0];
    assert_eq!(s.name, "lib");
    assert!(s.state.initialized && s.state.populated && s.state.dirty_tracked);
    assert!(!s.state.pointer_moved);
    assert_eq!(s.head_branch, None, "abbrev-ref HEAD means detached");
    // assert_done proves no `git submodule status` / describe ever ran.
    exec.assert_done();
}

#[tokio::test]
async fn submodules_survives_missing_gitmodules_and_failed_probe() {
    let sha_a = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let fake = FakeExecutor::default();
    fake.expect(
        &["ls-files", "--stage", "-z"],
        ok(&format!("160000 {sha_a} 0\tlib\0")),
    );
    // No .gitmodules: git config exits 1 - must degrade to empty, not error.
    fake.expect(
        &["config", "-f", ".gitmodules", "-z", "--get-regexp", "^submodule\\."],
        fail(1, ""),
    );
    fake.expect(&["config", "-z", "--get-regexp", "^submodule\\."], fail(1, ""));
    fake.expect(
        &["status", "--porcelain=v2", "-z", "--untracked-files=all"],
        ok(""),
    );
    // Unpopulated empty dir: git walks up into the superproject and reports
    // a non-empty prefix - the probe must classify that as unpopulated (and
    // must NOT go on to ask for the branch).
    fake.expect(
        &["-C", "lib", "rev-parse", "--show-prefix", "HEAD"],
        ok("lib/\ncccccccccccccccccccccccccccccccccccccccc\n"),
    );
    let (b, exec) = backend(fake);

    let subs = b.submodules().await.unwrap();
    assert_eq!(subs.len(), 1);
    assert!(subs[0].state.orphan_gitlink);
    assert!(!subs[0].state.populated);
    exec.assert_done();
}

#[tokio::test]
async fn submodule_log_lists_range_and_flags_missing_target() {
    let sha_a = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let sha_b = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    let fake = FakeExecutor::default();
    // Target present: existence probe, then the range log.
    fake.expect(&["-C", "lib", "cat-file", "-e", &format!("{sha_b}^{{commit}}")], ok(""));
    fake.expect(
        &["-C", "lib", "log", "--format=%H%x00%s%x00", "--max-count=100", &format!("{sha_a}..{sha_b}")],
        ok(&format!("{sha_b}\0bump\0")),
    );
    // Target missing: the probe fails, no log runs.
    fake.expect(
        &["-C", "lib", "cat-file", "-e", &format!("{sha_b}^{{commit}}")],
        fail(128, "fatal: Not a valid object name"),
    );
    let (b, exec) = backend(fake);

    let log = b
        .submodule_log(Path::new("lib"), Some(&CommitId::new(sha_a)), &CommitId::new(sha_b))
        .await
        .unwrap();
    let SubmoduleLog::Commits { commits } = log else { panic!("{log:?}") };
    assert_eq!(commits.len(), 1);
    assert_eq!(commits[0].subject, "bump");

    let log = b
        .submodule_log(Path::new("lib"), Some(&CommitId::new(sha_a)), &CommitId::new(sha_b))
        .await
        .unwrap();
    assert!(matches!(log, SubmoduleLog::TargetMissing));
    exec.assert_done();
}

// ---------------------------------------------------------------------------
// submodule operations
// ---------------------------------------------------------------------------

#[tokio::test]
async fn submodule_update_builds_flags_and_pathspec() {
    let fake = FakeExecutor::default();
    fake.expect(
        &["submodule", "update", "--init", "--recursive", "--", "lib"],
        ok(""),
    );
    // No flags, no paths: bare bulk update.
    fake.expect(&["submodule", "update"], ok(""));
    let (b, exec) = backend(fake);

    b.submodule_update(
        SubmoduleUpdateOptions {
            init: true,
            recursive: true,
            paths: vec![PathBuf::from("lib")],
            attach_branch: false,
        },
        OperationId("op1".into()),
    )
    .await
    .unwrap();
    b.submodule_update(SubmoduleUpdateOptions::default(), OperationId("op2".into()))
        .await
        .unwrap();
    exec.assert_done();
}

#[tokio::test]
async fn submodule_update_attach_enumerates_then_checks_out() {
    let rec = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let fake = FakeExecutor::default();
    // -- the update itself --
    fake.expect(&["submodule", "update", "--", "lib"], ok(""));
    // -- attach pass: enumerate, then probe only the detached submodule --
    fake.expect(&["ls-files", "--stage", "-z"], ok(&format!("160000 {rec} 0\tlib\0")));
    fake.expect(
        &["config", "-f", ".gitmodules", "-z", "--get-regexp", "^submodule\\."],
        ok("submodule.lib.path\nlib\0submodule.lib.url\nu\0submodule.lib.branch\nmain\0"),
    );
    fake.expect(&["config", "-z", "--get-regexp", "^submodule\\."], ok("submodule.lib.url\nu\0"));
    fake.expect(&["status", "--porcelain=v2", "-z", "--untracked-files=all"], ok(""));
    fake.expect(&["-C", "lib", "rev-parse", "--show-prefix", "HEAD"], ok(&format!("\n{rec}\n")));
    fake.expect(&["-C", "lib", "rev-parse", "--abbrev-ref", "HEAD"], ok("HEAD\n"));
    fake.expect(&["-C", "lib", "symbolic-ref", "-q", "--short", "HEAD"], fail(1, ""));
    fake.expect(
        &["-C", "lib", "for-each-ref", "refs/heads", "--points-at", "HEAD", "--format=%(refname:short)"],
        ok("main\n"),
    );
    fake.expect(&["-C", "lib", "checkout", "main"], ok("Switched to branch 'main'"));
    let (b, exec) = backend(fake);

    b.submodule_update(
        SubmoduleUpdateOptions {
            init: false,
            recursive: false,
            paths: vec![PathBuf::from("lib")],
            attach_branch: true,
        },
        OperationId("op".into()),
    )
    .await
    .unwrap();
    exec.assert_done();
}

#[tokio::test]
async fn submodule_sync_fetch_build_expected_argv() {
    let fake = FakeExecutor::default();
    fake.expect(&["submodule", "sync", "--recursive", "--", "lib"], ok(""));
    fake.expect(&["-C", "lib", "fetch"], ok(""));
    let (b, exec) = backend(fake);

    b.submodule_sync(&[PathBuf::from("lib")], true).await.unwrap();
    b.submodule_fetch(Path::new("lib"), OperationId("op".into())).await.unwrap();
    exec.assert_done();
}

#[tokio::test]
async fn superproject_path_maps_empty_output_to_none() {
    let fake = FakeExecutor::default();
    fake.expect(&["rev-parse", "--show-superproject-working-tree"], ok("/home/u/super\n"));
    fake.expect(&["rev-parse", "--show-superproject-working-tree"], ok("\n"));
    let (b, exec) = backend(fake);

    assert_eq!(
        b.superproject_path().await.unwrap(),
        Some(PathBuf::from("/home/u/super"))
    );
    assert_eq!(b.superproject_path().await.unwrap(), None);
    exec.assert_done();
}

#[tokio::test]
async fn discard_resets_submodule_pointers_via_submodule_update() {
    let fake = FakeExecutor::default();
    // status: a moved submodule pointer, a modified file, an untracked file.
    fake.expect(
        &["status", "--porcelain=v2", "-z", "--untracked-files=all"],
        ok("1 .M SC.. 160000 160000 160000 aaaaaaa bbbbbbb lib\01 .M N... 100644 100644 100644 aaaaaaa bbbbbbb tracked.txt\0? untracked.txt\0"),
    );
    fake.expect(&["restore", "--worktree", "--", "tracked.txt"], ok(""));
    fake.expect(&["clean", "-f", "--", "untracked.txt"], ok(""));
    // The gitlink is NOT restore-able: it goes through submodule update.
    // --no-fetch: discarding must never touch the network; --checkout is the
    // explicit non-integrating mode.
    fake.expect(
        &["submodule", "update", "--checkout", "--no-fetch", "--", "lib"],
        ok(""),
    );
    let (b, exec) = backend(fake);

    b.discard(&[
        PathBuf::from("lib"),
        PathBuf::from("tracked.txt"),
        PathBuf::from("untracked.txt"),
    ])
    .await
    .unwrap();
    exec.assert_done();
}

// ---------------------------------------------------------------------------
// submodule lifecycle: add / set-url / set-branch
// ---------------------------------------------------------------------------

#[tokio::test]
async fn submodule_add_builds_branch_flag_and_operands() {
    let fake = FakeExecutor::default();
    fake.expect(
        &["submodule", "add", "-b", "main", "--", "https://x.invalid/lib.git", "vendor/lib"],
        ok(""),
    );
    fake.expect(
        &["submodule", "add", "--", "https://x.invalid/lib.git", "lib"],
        ok(""),
    );
    let (b, exec) = backend(fake);

    b.submodule_add("https://x.invalid/lib.git", Path::new("vendor/lib"), Some("main"), OperationId("a".into()))
        .await
        .unwrap();
    b.submodule_add("https://x.invalid/lib.git", Path::new("lib"), None, OperationId("b".into()))
        .await
        .unwrap();
    exec.assert_done();
}

#[tokio::test]
async fn submodule_set_url_syncs_afterwards() {
    let fake = FakeExecutor::default();
    fake.expect(&["submodule", "set-url", "--", "lib", "https://new.invalid/lib.git"], ok(""));
    // set-url edits .gitmodules only: without sync the local config and the
    // submodule's origin keep the old URL.
    fake.expect(&["submodule", "sync", "--", "lib"], ok(""));
    let (b, exec) = backend(fake);

    b.submodule_set_url(Path::new("lib"), "https://new.invalid/lib.git").await.unwrap();
    exec.assert_done();
}

#[tokio::test]
async fn submodule_set_branch_sets_and_clears() {
    let fake = FakeExecutor::default();
    fake.expect(&["submodule", "set-branch", "--branch", "dev", "--", "lib"], ok(""));
    fake.expect(&["submodule", "set-branch", "--default", "--", "lib"], ok(""));
    let (b, exec) = backend(fake);

    b.submodule_set_branch(Path::new("lib"), Some("dev")).await.unwrap();
    b.submodule_set_branch(Path::new("lib"), None).await.unwrap();
    exec.assert_done();
}

#[tokio::test]
async fn submodule_update_remote_integrates_then_stages_pointers() {
    let sha_a = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let fake = FakeExecutor::default();
    // -- submodules() enumeration: one clean, initialized submodule --
    fake.expect(&["ls-files", "--stage", "-z"], ok(&format!("160000 {sha_a} 0\tlib\0")));
    fake.expect(
        &["config", "-f", ".gitmodules", "-z", "--get-regexp", "^submodule\\."],
        ok("submodule.lib.path\nlib\0submodule.lib.url\nu\0"),
    );
    fake.expect(&["config", "-z", "--get-regexp", "^submodule\\."], ok("submodule.lib.url\nu\0"));
    fake.expect(&["status", "--porcelain=v2", "-z", "--untracked-files=all"], ok(""));
    fake.expect(&["-C", "lib", "rev-parse", "--show-prefix", "HEAD"], ok(&format!("\n{sha_a}\n")));
    fake.expect(&["-C", "lib", "rev-parse", "--abbrev-ref", "HEAD"], ok("main\n"));
    // -- clean: per-path remote move with the strategy flag, then stage --
    fake.expect(&["submodule", "update", "--remote", "--rebase", "--", "lib"], ok(""));
    fake.expect(&["add", "--", "lib"], ok(""));
    let (b, exec) = backend(fake);

    let results = b
        .submodule_update_remote(
            &[PathBuf::from("lib")],
            SubmoduleUpdateStrategy::Rebase,
            SwitchDirtyBehavior::AutoStash,
            false,
            OperationId("a".into()),
        )
        .await
        .unwrap();
    assert_eq!(results.len(), 1);
    assert!(matches!(results[0].status, SubmoduleAutoUpdateStatus::Updated), "{results:?}");
    exec.assert_done();
}

// ---------------------------------------------------------------------------
// submodule remove - magit-grade staged sequence
// ---------------------------------------------------------------------------

#[tokio::test]
async fn submodule_remove_runs_absorb_deinit_rm_in_order() {
    let fake = FakeExecutor::default();
    // Clean submodule: the full sequence runs, gitdir deletion NEVER runs here.
    fake.expect(
        &["status", "--porcelain=v2", "-z", "--untracked-files=all"],
        ok("1 .M SC.. 160000 160000 160000 aaaaaaa bbbbbbb other\0"),
    );
    fake.expect(&["submodule", "absorbgitdirs", "--", "lib"], ok(""));
    fake.expect(&["submodule", "deinit", "-f", "--", "lib"], ok(""));
    fake.expect(&["rm", "-f", "--", "lib"], ok(""));
    let (b, exec) = backend(fake);

    b.submodule_remove(Path::new("lib")).await.unwrap();
    exec.assert_done();
}

#[tokio::test]
async fn submodule_remove_refuses_dirty_without_running_anything() {
    let fake = FakeExecutor::default();
    // Dirty (untracked content inside): refuse BEFORE any mutation.
    fake.expect(
        &["status", "--porcelain=v2", "-z", "--untracked-files=all"],
        ok("1 .M S..U 160000 160000 160000 aaaaaaa aaaaaaa lib\0"),
    );
    let (b, exec) = backend(fake);

    let err = b.submodule_remove(Path::new("lib")).await.unwrap_err();
    assert!(
        matches!(err, GitError::WouldOverwriteLocalChanges(_)),
        "{err:?}"
    );
    // assert_done proves absorb/deinit/rm never ran.
    exec.assert_done();
}

// ---------------------------------------------------------------------------
// submodule move - preflight + git mv sequencing
// ---------------------------------------------------------------------------

#[tokio::test]
async fn submodule_move_creates_parents_then_runs_git_mv() {
    let root = tempfile::tempdir().unwrap();
    let root_str = root.path().to_string_lossy().into_owned();
    let fake = FakeExecutor::default();
    fake.expect(&["rev-parse", "--show-toplevel"], ok(&format!("{root_str}\n")));
    fake.expect(&["mv", "--", "lib", "vendor/lib"], ok(""));
    let (b, exec) = backend(fake);

    b.submodule_move(Path::new("lib"), Path::new("vendor/lib")).await.unwrap();
    // The missing parent was created for git mv.
    assert!(root.path().join("vendor").is_dir());
    exec.assert_done();
}

#[tokio::test]
async fn submodule_move_refuses_occupied_target_and_escaping_paths() {
    let root = tempfile::tempdir().unwrap();
    std::fs::create_dir(root.path().join("vendor")).unwrap();
    std::fs::write(root.path().join("vendor/lib"), b"occupied").unwrap();
    let root_str = root.path().to_string_lossy().into_owned();
    let fake = FakeExecutor::default();
    // Occupied target: the root lookup runs, `mv` never does.
    fake.expect(&["rev-parse", "--show-toplevel"], ok(&format!("{root_str}\n")));
    let (b, exec) = backend(fake);

    let err = b.submodule_move(Path::new("lib"), Path::new("vendor/lib")).await.unwrap_err();
    assert!(err.to_string().contains("already exists"), "{err:?}");
    // Path escape: refused before ANY git command (assert_done proves it).
    let err = b.submodule_move(Path::new("lib"), Path::new("../outside")).await.unwrap_err();
    assert!(matches!(err, GitError::Internal(_)), "{err:?}");
    exec.assert_done();
}

// ---------------------------------------------------------------------------
// submodule auto-update - rollback sequencing (the tier-4 data-safety core)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn submodule_auto_update_pop_conflict_rolls_back_and_reapplies() {
    let rec = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; // recorded (new)
    let old = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"; // checked out (old)
    let stash = "cccccccccccccccccccccccccccccccccccccccc";
    let fake = FakeExecutor::default();
    // -- submodules() enumeration --
    fake.expect(&["ls-files", "--stage", "-z"], ok(&format!("160000 {rec} 0\tlib\0")));
    fake.expect(
        &["config", "-f", ".gitmodules", "-z", "--get-regexp", "^submodule\\."],
        ok("submodule.lib.path\nlib\0submodule.lib.url\nu\0"),
    );
    fake.expect(&["config", "-z", "--get-regexp", "^submodule\\."], ok("submodule.lib.url\nu\0"));
    fake.expect(
        &["status", "--porcelain=v2", "-z", "--untracked-files=all"],
        // Pointer moved AND tracked modifications inside.
        ok("1 .M SCM. 160000 160000 160000 aaaaaaa bbbbbbb lib\0"),
    );
    fake.expect(&["-C", "lib", "rev-parse", "--show-prefix", "HEAD"], ok(&format!("\n{old}\n")));
    fake.expect(&["-C", "lib", "rev-parse", "--abbrev-ref", "HEAD"], ok("HEAD\n"));
    // -- auto-stash (marker-matched list-diff verified) --
    fake.expect(&["-C", "lib", "stash", "list", "--format=%H %s"], ok(""));
    fake.expect(
        &["-C", "lib", "stash", "push", "--include-untracked", "-m", "legit: auto-stash before submodule update"],
        ok("Saved"),
    );
    fake.expect(
        &["-C", "lib", "stash", "list", "--format=%H %s"],
        ok(&format!("{stash} On main: legit: auto-stash before submodule update\n")),
    );
    // -- update to recorded, pop by SHA-resolved selector: CONFLICT --
    fake.expect(&["submodule", "update", "--", "lib"], ok(""));
    fake.expect(&["-C", "lib", "stash", "list", "--format=%H %gd"], ok(&format!("{stash} stash@{{0}}\n")));
    fake.expect(&["-C", "lib", "stash", "pop", "stash@{0}"], fail(1, "CONFLICT (content): merge conflict"));
    // -- ROLLBACK: hard-reset to old (stash survived the pop), pop cleanly --
    fake.expect(&["-C", "lib", "reset", "--hard", old], ok(""));
    fake.expect(&["-C", "lib", "stash", "list", "--format=%H %gd"], ok(&format!("{stash} stash@{{0}}\n")));
    fake.expect(&["-C", "lib", "stash", "pop", "stash@{0}"], ok("Dropped"));
    let (b, exec) = backend(fake);

    let results = b.submodule_auto_update(SwitchDirtyBehavior::AutoStash, false).await.unwrap();
    assert_eq!(results.len(), 1);
    assert!(
        matches!(results[0].status, SubmoduleAutoUpdateStatus::RolledBack { .. }),
        "{results:?}"
    );
    // assert_done: no bare `stash pop`, no second update, nothing after the
    // clean reapply.
    exec.assert_done();
}

#[tokio::test]
async fn submodule_auto_update_failed_before_stash_list_read_skips() {
    // Regression: a failed BEFORE-push `stash list` used to read as an empty
    // list, so a leftover marker entry from an earlier crash could be adopted
    // as "ours" and popped. The update must abort loudly instead: Skipped,
    // and neither the stash push nor the move may run.
    let rec = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let old = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    let fake = FakeExecutor::default();
    // -- submodules() enumeration: pointer moved, dirty tracked --
    fake.expect(&["ls-files", "--stage", "-z"], ok(&format!("160000 {rec} 0\tlib\0")));
    fake.expect(
        &["config", "-f", ".gitmodules", "-z", "--get-regexp", "^submodule\\."],
        ok("submodule.lib.path\nlib\0submodule.lib.url\nu\0"),
    );
    fake.expect(&["config", "-z", "--get-regexp", "^submodule\\."], ok("submodule.lib.url\nu\0"));
    fake.expect(
        &["status", "--porcelain=v2", "-z", "--untracked-files=all"],
        ok("1 .M SCM. 160000 160000 160000 aaaaaaa bbbbbbb lib\0"),
    );
    fake.expect(&["-C", "lib", "rev-parse", "--show-prefix", "HEAD"], ok(&format!("\n{old}\n")));
    fake.expect(&["-C", "lib", "rev-parse", "--abbrev-ref", "HEAD"], ok("HEAD\n"));
    // -- the BEFORE stash-list read fails --
    fake.expect(
        &["-C", "lib", "stash", "list", "--format=%H %s"],
        fail(128, "fatal: unable to read the stash reflog"),
    );
    // assert_done proves no `stash push` and no `submodule update` ran.
    let (b, exec) = backend(fake);

    let results = b.submodule_auto_update(SwitchDirtyBehavior::AutoStash, false).await.unwrap();
    assert_eq!(results.len(), 1);
    let SubmoduleAutoUpdateStatus::Skipped { message } = &results[0].status else {
        panic!("expected Skipped, got {results:?}");
    };
    assert!(message.contains("stash list"), "{message}");
    assert!(message.contains("left untouched"), "{message}");
    exec.assert_done();
}

#[tokio::test]
async fn submodule_auto_update_failed_after_stash_list_read_is_loud() {
    // Regression: a failed AFTER-push `stash list` used to read as an empty
    // list, so `find_created_stash` saw nothing, the clean-tree branch moved
    // the submodule, and a plain Updated hid that the user's changes sat in
    // the submodule's stash. The outcome must be LOUD (ChangesInStash) and
    // the submodule must NOT move.
    let rec = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let old = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    let fake = FakeExecutor::default();
    // -- submodules() enumeration: pointer moved, dirty tracked --
    fake.expect(&["ls-files", "--stage", "-z"], ok(&format!("160000 {rec} 0\tlib\0")));
    fake.expect(
        &["config", "-f", ".gitmodules", "-z", "--get-regexp", "^submodule\\."],
        ok("submodule.lib.path\nlib\0submodule.lib.url\nu\0"),
    );
    fake.expect(&["config", "-z", "--get-regexp", "^submodule\\."], ok("submodule.lib.url\nu\0"));
    fake.expect(
        &["status", "--porcelain=v2", "-z", "--untracked-files=all"],
        ok("1 .M SCM. 160000 160000 160000 aaaaaaa bbbbbbb lib\0"),
    );
    fake.expect(&["-C", "lib", "rev-parse", "--show-prefix", "HEAD"], ok(&format!("\n{old}\n")));
    fake.expect(&["-C", "lib", "rev-parse", "--abbrev-ref", "HEAD"], ok("HEAD\n"));
    // -- auto-stash: before-list ok, push ok, AFTER-list read fails --
    fake.expect(&["-C", "lib", "stash", "list", "--format=%H %s"], ok(""));
    fake.expect(
        &["-C", "lib", "stash", "push", "--include-untracked", "-m", "legit: auto-stash before submodule update"],
        ok("Saved"),
    );
    fake.expect(
        &["-C", "lib", "stash", "list", "--format=%H %s"],
        fail(128, "fatal: unable to read the stash reflog"),
    );
    // assert_done proves no `submodule update` (no silent Updated) and no pop.
    let (b, exec) = backend(fake);

    let results = b.submodule_auto_update(SwitchDirtyBehavior::AutoStash, false).await.unwrap();
    assert_eq!(results.len(), 1);
    let SubmoduleAutoUpdateStatus::ChangesInStash { message } = &results[0].status else {
        panic!("expected ChangesInStash, got {results:?}");
    };
    assert!(message.contains("may have been auto-stashed"), "{message}");
    assert!(message.contains("stash list"), "{message}");
    exec.assert_done();
}

// ---------------------------------------------------------------------------
// submodule branch attach - opt-in re-attach after updates
// ---------------------------------------------------------------------------

#[tokio::test]
async fn submodule_auto_update_attach_checks_out_configured_branch() {
    let rec = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let old = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    let fake = FakeExecutor::default();
    // -- submodules() enumeration: pointer moved, clean, tracked branch main --
    fake.expect(&["ls-files", "--stage", "-z"], ok(&format!("160000 {rec} 0\tlib\0")));
    fake.expect(
        &["config", "-f", ".gitmodules", "-z", "--get-regexp", "^submodule\\."],
        ok("submodule.lib.path\nlib\0submodule.lib.url\nu\0submodule.lib.branch\nmain\0"),
    );
    fake.expect(&["config", "-z", "--get-regexp", "^submodule\\."], ok("submodule.lib.url\nu\0"));
    fake.expect(
        &["status", "--porcelain=v2", "-z", "--untracked-files=all"],
        ok("1 .M SC.. 160000 160000 160000 aaaaaaa bbbbbbb lib\0"),
    );
    fake.expect(&["-C", "lib", "rev-parse", "--show-prefix", "HEAD"], ok(&format!("\n{old}\n")));
    fake.expect(&["-C", "lib", "rev-parse", "--abbrev-ref", "HEAD"], ok("HEAD\n"));
    // -- clean move to the recorded SHA --
    fake.expect(&["submodule", "update", "--", "lib"], ok(""));
    // -- attach: detached (symbolic-ref exits 1), main points at HEAD --
    fake.expect(&["-C", "lib", "symbolic-ref", "-q", "--short", "HEAD"], fail(1, ""));
    fake.expect(
        &["-C", "lib", "for-each-ref", "refs/heads", "--points-at", "HEAD", "--format=%(refname:short)"],
        ok("main\n"),
    );
    fake.expect(&["-C", "lib", "checkout", "main"], ok("Switched to branch 'main'"));
    let (b, exec) = backend(fake);

    let results = b
        .submodule_auto_update(SwitchDirtyBehavior::TryDirectly, true)
        .await
        .unwrap();
    assert_eq!(results.len(), 1);
    assert!(matches!(results[0].status, SubmoduleAutoUpdateStatus::Updated), "{results:?}");
    exec.assert_done();
}

#[tokio::test]
async fn submodule_auto_update_attach_ambiguous_match_stays_detached() {
    let rec = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let old = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    let fake = FakeExecutor::default();
    // No submodule.lib.branch: nothing configured, so 2 matches = ambiguous.
    fake.expect(&["ls-files", "--stage", "-z"], ok(&format!("160000 {rec} 0\tlib\0")));
    fake.expect(
        &["config", "-f", ".gitmodules", "-z", "--get-regexp", "^submodule\\."],
        ok("submodule.lib.path\nlib\0submodule.lib.url\nu\0"),
    );
    fake.expect(&["config", "-z", "--get-regexp", "^submodule\\."], ok("submodule.lib.url\nu\0"));
    fake.expect(
        &["status", "--porcelain=v2", "-z", "--untracked-files=all"],
        ok("1 .M SC.. 160000 160000 160000 aaaaaaa bbbbbbb lib\0"),
    );
    fake.expect(&["-C", "lib", "rev-parse", "--show-prefix", "HEAD"], ok(&format!("\n{old}\n")));
    fake.expect(&["-C", "lib", "rev-parse", "--abbrev-ref", "HEAD"], ok("HEAD\n"));
    fake.expect(&["submodule", "update", "--", "lib"], ok(""));
    fake.expect(&["-C", "lib", "symbolic-ref", "-q", "--short", "HEAD"], fail(1, ""));
    fake.expect(
        &["-C", "lib", "for-each-ref", "refs/heads", "--points-at", "HEAD", "--format=%(refname:short)"],
        ok("release\nhotfix\n"),
    );
    // assert_done proves NO checkout ran.
    let (b, exec) = backend(fake);

    let results = b
        .submodule_auto_update(SwitchDirtyBehavior::TryDirectly, true)
        .await
        .unwrap();
    assert!(matches!(results[0].status, SubmoduleAutoUpdateStatus::Updated), "{results:?}");
    exec.assert_done();
}

#[tokio::test]
async fn submodule_update_remote_attach_skips_attached_and_survives_checkout_failure() {
    let sha_a = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let fake = FakeExecutor::default();
    // Two submodules: `lib` stays on its branch after --rebase (attach probe
    // succeeds, nothing further); `vendor` is detached and its checkout FAILS
    // (the status must still be Updated - attach is best-effort).
    fake.expect(
        &["ls-files", "--stage", "-z"],
        ok(&format!("160000 {sha_a} 0\tlib\0160000 {sha_a} 0\tvendor\0")),
    );
    fake.expect(
        &["config", "-f", ".gitmodules", "-z", "--get-regexp", "^submodule\\."],
        ok("submodule.lib.path\nlib\0submodule.lib.url\nu\0submodule.vendor.path\nvendor\0submodule.vendor.url\nv\0"),
    );
    fake.expect(
        &["config", "-z", "--get-regexp", "^submodule\\."],
        ok("submodule.lib.url\nu\0submodule.vendor.url\nv\0"),
    );
    fake.expect(&["status", "--porcelain=v2", "-z", "--untracked-files=all"], ok(""));
    fake.expect(&["-C", "lib", "rev-parse", "--show-prefix", "HEAD"], ok(&format!("\n{sha_a}\n")));
    fake.expect(&["-C", "lib", "rev-parse", "--abbrev-ref", "HEAD"], ok("main\n"));
    fake.expect(&["-C", "vendor", "rev-parse", "--show-prefix", "HEAD"], ok(&format!("\n{sha_a}\n")));
    fake.expect(&["-C", "vendor", "rev-parse", "--abbrev-ref", "HEAD"], ok("HEAD\n"));
    // -- lib: rebase onto the tracked branch, still attached afterwards --
    fake.expect(&["submodule", "update", "--remote", "--rebase", "--", "lib"], ok(""));
    fake.expect(&["-C", "lib", "symbolic-ref", "-q", "--short", "HEAD"], ok("main\n"));
    // -- vendor: detached; unique match; checkout fails --
    fake.expect(&["submodule", "update", "--remote", "--rebase", "--", "vendor"], ok(""));
    fake.expect(&["-C", "vendor", "symbolic-ref", "-q", "--short", "HEAD"], fail(1, ""));
    fake.expect(
        &["-C", "vendor", "for-each-ref", "refs/heads", "--points-at", "HEAD", "--format=%(refname:short)"],
        ok("main\n"),
    );
    fake.expect(
        &["-C", "vendor", "checkout", "main"],
        fail(1, "fatal: 'main' is already used by worktree"),
    );
    // -- both moved: stage both pointers --
    fake.expect(&["add", "--", "lib", "vendor"], ok(""));
    let (b, exec) = backend(fake);

    let results = b
        .submodule_update_remote(
            &[],
            SubmoduleUpdateStrategy::Rebase,
            SwitchDirtyBehavior::AutoStash,
            true,
            OperationId("a".into()),
        )
        .await
        .unwrap();
    assert_eq!(results.len(), 2);
    assert!(matches!(results[0].status, SubmoduleAutoUpdateStatus::Updated), "{results:?}");
    assert!(matches!(results[1].status, SubmoduleAutoUpdateStatus::Updated), "{results:?}");
    exec.assert_done();
}

// A submodule move can exit 0 while LFS downloads inside it failed
// (lfs.skipdownloaderrors / non-required filter): the per-submodule result
// must carry the stubs, never a silent Updated.
#[tokio::test]
async fn submodule_update_remote_exit_zero_with_lfs_errors_reports_stubs() {
    let sha_a = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let fake = FakeExecutor::default();
    fake.expect(
        &["ls-files", "--stage", "-z"],
        ok(&format!("160000 {sha_a} 0\tlib\0")),
    );
    fake.expect(
        &["config", "-f", ".gitmodules", "-z", "--get-regexp", "^submodule\\."],
        ok("submodule.lib.path\nlib\0submodule.lib.url\nu\0"),
    );
    fake.expect(
        &["config", "-z", "--get-regexp", "^submodule\\."],
        ok("submodule.lib.url\nu\0"),
    );
    fake.expect(&["status", "--porcelain=v2", "-z", "--untracked-files=all"], ok(""));
    fake.expect(&["-C", "lib", "rev-parse", "--show-prefix", "HEAD"], ok(&format!("\n{sha_a}\n")));
    fake.expect(&["-C", "lib", "rev-parse", "--abbrev-ref", "HEAD"], ok("main\n"));
    fake.expect(
        &["submodule", "update", "--remote", "--checkout", "--", "lib"],
        out(
            0,
            "",
            "Error downloading object: assets/big.bin (8f786a0): Smudge error: [404] Object does not exist on the server\n",
        ),
    );
    fake.expect(&["add", "--", "lib"], ok(""));
    let (b, exec) = backend(fake);

    let results = b
        .submodule_update_remote(
            &[],
            SubmoduleUpdateStrategy::Checkout,
            SwitchDirtyBehavior::TryDirectly,
            false,
            OperationId("a".into()),
        )
        .await
        .unwrap();
    assert!(matches!(results[0].status, SubmoduleAutoUpdateStatus::Updated), "{results:?}");
    let stubs = results[0].lfs_stubs.as_ref().expect("stubs reported");
    assert_eq!(stubs.files, vec!["assets/big.bin".to_string()]);
    assert!(stubs.missing_on_remote);
    exec.assert_done();
}

// Same for the bulk `submodule update` (init/recursive).
#[tokio::test]
async fn submodule_update_exit_zero_with_lfs_errors_reports_stubs() {
    let fake = FakeExecutor::default();
    fake.expect(
        &["submodule", "update", "--init"],
        out(
            0,
            "",
            "Error downloading object: lib/big.bin (8f786a0): Smudge error: [404] Object does not exist on the server\n",
        ),
    );
    let (b, exec) = backend(fake);

    let stubs = b
        .submodule_update(
            SubmoduleUpdateOptions {
                init: true,
                recursive: false,
                paths: vec![],
                attach_branch: false,
            },
            OperationId("a".into()),
        )
        .await
        .unwrap()
        .expect("stubs reported");
    assert_eq!(stubs.files, vec!["lib/big.bin".to_string()]);
    assert!(stubs.missing_on_remote);
    exec.assert_done();
}

#[tokio::test]
async fn submodule_create_branch_switches_with_c() {
    let fake = FakeExecutor::default();
    fake.expect(&["-C", "lib", "switch", "-c", "fix/detached"], ok(""));
    let (b, exec) = backend(fake);
    b.submodule_create_branch(Path::new("lib"), "fix/detached").await.unwrap();
    exec.assert_done();
}
