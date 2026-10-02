//! Real-git validation of the settings-sync sequences (`legit_core::sync`):
//! the unit tests encode our assumptions about git's exit codes and stderr
//! text; these check them against the real binary with a bare "remote" and
//! two clones, the way the sync engine uses them.

use legit_core::sync::{
    first_remote, rebase_in_progress, sync_commit, sync_pull, sync_push, SyncCommitOutcome,
    SyncPullOutcome, SyncPushOutcome, SYNC_SETTINGS_FILE, SYNC_THEMES_DIR,
};
use legit_core::{GitExecutor, GitRunner};
use std::path::{Path, PathBuf};
use tempfile::TempDir;

const PINNED_CONFIG: [(&str, &str); 5] = [
    ("user.name", "LeGit Test"),
    ("user.email", "test@example.invalid"),
    ("commit.gpgsign", "false"),
    ("tag.gpgsign", "false"),
    ("core.autocrlf", "false"),
];

async fn git(cwd: &Path, args: &[&str]) -> String {
    let runner = GitRunner::for_repo("git", cwd);
    let out = runner.run(args).await.expect("spawn git");
    assert!(out.success, "`git {args:?}` in {cwd:?} failed: {}", out.stderr);
    out.stdout
}

async fn pin(repo: &Path) {
    for (key, value) in PINNED_CONFIG {
        git(repo, &["config", key, value]).await;
    }
}

fn runner(repo: &Path) -> GitRunner {
    GitRunner::for_repo("git", repo)
}

struct Fixture {
    _dir: TempDir,
    a: PathBuf,
    b: PathBuf,
}

/// Bare origin + clone `a` that seeds an initial `legit-sync.json` commit,
/// + clone `b` taken after the seed so both clones track origin/main.
async fn fixture() -> Fixture {
    let dir = tempfile::tempdir().expect("tempdir");
    let root = dir.path().to_path_buf();
    git(&root, &["init", "--bare", "-b", "main", "origin.git"]).await;
    let bare = root.join("origin.git");
    git(&root, &["clone", bare.to_str().unwrap(), "a"]).await;
    let a = root.join("a");
    pin(&a).await;
    tokio::fs::write(a.join(SYNC_SETTINGS_FILE), "{\n  \"seed\": true\n}\n")
        .await
        .unwrap();
    assert_eq!(sync_commit(&runner(&a)).await.unwrap(), SyncCommitOutcome::Committed);
    assert_eq!(
        sync_push(&runner(&a), "origin").await.unwrap(),
        SyncPushOutcome::Pushed
    );
    git(&root, &["clone", bare.to_str().unwrap(), "b"]).await;
    let b = root.join("b");
    pin(&b).await;
    Fixture { _dir: dir, a, b }
}

#[tokio::test]
async fn full_cycle_between_two_clones() {
    let f = fixture().await;
    tokio::fs::write(f.a.join(SYNC_SETTINGS_FILE), "{\n  \"v\": 1\n}\n").await.unwrap();
    assert_eq!(sync_commit(&runner(&f.a)).await.unwrap(), SyncCommitOutcome::Committed);
    assert_eq!(sync_push(&runner(&f.a), "origin").await.unwrap(), SyncPushOutcome::Pushed);

    assert_eq!(sync_pull(&runner(&f.b)).await.unwrap(), SyncPullOutcome::Pulled);
    let b_content = tokio::fs::read_to_string(f.b.join(SYNC_SETTINGS_FILE)).await.unwrap();
    assert_eq!(b_content, "{\n  \"v\": 1\n}\n");
}

#[tokio::test]
async fn offline_divergence_converges_via_rebase() {
    let f = fixture().await;
    // b changes a theme while "offline" (commit without push)...
    tokio::fs::create_dir_all(f.b.join(SYNC_THEMES_DIR)).await.unwrap();
    tokio::fs::write(f.b.join(SYNC_THEMES_DIR).join("x.legit-theme.json"), "{}\n")
        .await
        .unwrap();
    assert_eq!(sync_commit(&runner(&f.b)).await.unwrap(), SyncCommitOutcome::Committed);
    // ...while a changes the settings file and pushes.
    tokio::fs::write(f.a.join(SYNC_SETTINGS_FILE), "{\n  \"from\": \"a\"\n}\n").await.unwrap();
    assert_eq!(sync_commit(&runner(&f.a)).await.unwrap(), SyncCommitOutcome::Committed);
    assert_eq!(sync_push(&runner(&f.a), "origin").await.unwrap(), SyncPushOutcome::Pushed);

    assert_eq!(sync_push(&runner(&f.b), "origin").await.unwrap(), SyncPushOutcome::Rejected);
    assert_eq!(sync_pull(&runner(&f.b)).await.unwrap(), SyncPullOutcome::Pulled);
    assert_eq!(sync_push(&runner(&f.b), "origin").await.unwrap(), SyncPushOutcome::Pushed);

    assert_eq!(sync_pull(&runner(&f.a)).await.unwrap(), SyncPullOutcome::Pulled);
    for repo in [&f.a, &f.b] {
        assert!(repo.join(SYNC_THEMES_DIR).join("x.legit-theme.json").exists());
        let content = tokio::fs::read_to_string(repo.join(SYNC_SETTINGS_FILE)).await.unwrap();
        assert_eq!(content, "{\n  \"from\": \"a\"\n}\n");
    }
}

#[tokio::test]
async fn conflict_reaches_conflict_outcome_and_rebase_in_progress() {
    let f = fixture().await;
    tokio::fs::write(f.a.join(SYNC_SETTINGS_FILE), "{\n  \"v\": \"a\"\n}\n").await.unwrap();
    assert_eq!(sync_commit(&runner(&f.a)).await.unwrap(), SyncCommitOutcome::Committed);
    assert_eq!(sync_push(&runner(&f.a), "origin").await.unwrap(), SyncPushOutcome::Pushed);

    tokio::fs::write(f.b.join(SYNC_SETTINGS_FILE), "{\n  \"v\": \"b\"\n}\n").await.unwrap();
    assert_eq!(sync_commit(&runner(&f.b)).await.unwrap(), SyncCommitOutcome::Committed);
    assert_eq!(sync_push(&runner(&f.b), "origin").await.unwrap(), SyncPushOutcome::Rejected);
    assert_eq!(sync_pull(&runner(&f.b)).await.unwrap(), SyncPullOutcome::Conflict);

    assert!(rebase_in_progress(&runner(&f.b)).await.unwrap());
    let content = tokio::fs::read_to_string(f.b.join(SYNC_SETTINGS_FILE)).await.unwrap();
    assert!(content.contains("<<<<<<<"), "expected conflict markers, got:\n{content}");
}

#[tokio::test]
async fn no_upstream_is_its_own_outcome() {
    let dir = tempfile::tempdir().expect("tempdir");
    let repo = dir.path().join("solo");
    tokio::fs::create_dir_all(&repo).await.unwrap();
    git(&repo, &["init", "-b", "main"]).await;
    pin(&repo).await;
    // A reachable remote but no upstream for the branch: the fetch succeeds
    // and the missing tracking information is the failure that remains.
    git(dir.path(), &["init", "--bare", "-b", "main", "reachable.git"]).await;
    git(&repo, &["remote", "add", "origin", "../reachable.git"]).await;
    tokio::fs::write(repo.join(SYNC_SETTINGS_FILE), "{}\n").await.unwrap();
    assert_eq!(sync_commit(&runner(&repo)).await.unwrap(), SyncCommitOutcome::Committed);
    assert_eq!(sync_pull(&runner(&repo)).await.unwrap(), SyncPullOutcome::NoUpstream);
}

#[tokio::test]
async fn leftover_staged_changes_commit_on_next_cycle() {
    // A kill between add and commit leaves staged changes; the next cycle
    // must commit them instead of reporting a clean tree.
    let f = fixture().await;
    tokio::fs::write(f.a.join(SYNC_SETTINGS_FILE), "{\n  \"leftover\": true\n}\n")
        .await
        .unwrap();
    git(&f.a, &["add", "-A", "--", SYNC_SETTINGS_FILE]).await;
    assert_eq!(sync_commit(&runner(&f.a)).await.unwrap(), SyncCommitOutcome::Committed);
}

#[tokio::test]
async fn commit_identity_is_fixed() {
    let f = fixture().await;
    let author = git(&f.a, &["log", "-1", "--format=%an <%ae>"]).await;
    assert_eq!(author.trim(), "LeGit Sync <sync@legit.local>");
}

#[tokio::test]
async fn first_remote_sees_a_clone_origin() {
    let f = fixture().await;
    assert_eq!(first_remote(&runner(&f.a)).await.unwrap().as_deref(), Some("origin"));
}
