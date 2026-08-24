# Interactive Rebase Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (inline). NO subagent-driven-development, NO git commits (user rules). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Newest-first plan rows with drag-to-reorder, reword as a plan step (carrier commits + `fixup -C`), and a pushed-commits warning + transplant notice in the Interactive Rebase panel.

**Architecture:** Reword messages never touch the shell-interpreted todo: per reword the backend creates an unreferenced carrier commit (`commit-tree`, message as plain argv, author copied via env) and the hex-only todo gains `pick <orig>` + `fixup -C <carrier>`. One new probe command (`repo_rebase_range_info`) backs both the pushed chips and the transplant notice. The panel flips to display order = newest first; git's todo order stays internal.

**Tech Stack:** Rust (legit-core + tauri commands), React/TS, HTML5 DnD, vitest + cargo test.

**Spec:** `docs/superpowers/specs/2026-08-18-interactive-rebase-polish-design.md`

## Global Constraints

- NO git commits/pushes; NO em-dashes anywhere; colors only via `var(--token)` (no new tokens needed); sizes via `--fz-*`/em.
- cargo/tsc from WSL; vitest via `powershell.exe -NoProfile -Command "Set-Location <repo>; npx vitest run <path>"`.
- The injected todo stays HEX-ONLY (single-quoted printf); message text must never enter it.
- git floor for rewords: `fixup -C` needs git >= 2.32; reword-free plans keep working on older git.
- New commands: register in `src-tauri/src/lib.rs` `collect_commands!`; wrapper in `src/lib/commands.ts`; hand-mirrored types in `src/lib/types.ts`.

---

### Task 1: Types + pure plan validation and todo building (Rust, TDD)

**Files:**
- Modify: `crates/legit-core/src/types.rs` (RebaseAction::Reword, RebaseStep.message, RebaseRangeInfo)
- Modify: `crates/legit-core/src/cli_impl/mod.rs` (`validate_rebase_plan` extraction, `build_rebase_todo` signature)
- Modify: existing unit tests for `build_rebase_todo` in `cli_impl/mod.rs`'s `#[cfg(test)]` block (find with `grep -n "build_rebase_todo" crates/legit-core/src/cli_impl/mod.rs`)

**Interfaces:**
- Produces: `RebaseAction::Reword`; `RebaseStep { action, sha, message: Option<String> }` (serde default); `RebaseRangeInfo { unpushed: Option<Vec<String>>, transplant: bool }`; `fn validate_rebase_plan(plan: &[RebaseStep]) -> Result<(), GitError>`; `fn build_rebase_todo(plan: &[RebaseStep], carriers: &HashMap<String, String>) -> Result<String, GitError>` (carriers: reword sha -> carrier sha).

- [ ] **Step 1: Types.** In `types.rs`:

```rust
// RebaseAction gains:
    /// Pick + replace the message (and keep the author) - expands to
    /// `pick <sha>` + `fixup -C <carrier>` in the todo; there is no
    /// single-line `reword` (it would open an editor).
    Reword,
// keyword(): a reword IS a pick at the todo level; its message rides the
// fixup -C line built next to it.
            RebaseAction::Reword => "pick",
```

`RebaseStep` gains (update the doc comment: rewording IS a step now; drop the "deliberately not a step" sentence):

```rust
    /// New commit message; required (non-blank) for `Reword`, refused
    /// otherwise. `#[serde(default)]` keeps old callers/tests compiling.
    #[serde(default)]
    pub message: Option<String>,
```

Keep `RebaseStep::new` as-is but set `message: None`; add:

```rust
    pub fn reword(sha: impl Into<String>, message: impl Into<String>) -> Self {
        Self { action: RebaseAction::Reword, sha: CommitId::new(sha), message: Some(message.into()) }
    }
```

Add near the other IPC structs:

```rust
/// Probe for the interactive-rebase panel: which range commits are already
/// on the upstream (warn before rewriting), and whether the base is NOT an
/// ancestor of HEAD (the rebase then RELOCATES the range onto the base).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct RebaseRangeInfo {
    /// Range commits NOT reachable from `@{upstream}`; None = no upstream.
    pub unpushed: Option<Vec<String>>,
    /// True when the base is not an ancestor of HEAD (transplant).
    pub transplant: bool,
}
```

- [ ] **Step 2: Failing unit tests.** In the `cli_impl/mod.rs` test module next to the existing `build_rebase_todo` tests (adapt those to the new signature with `&HashMap::new()`):

```rust
#[test]
fn validate_rebase_plan_rules() {
    use crate::types::RebaseStep as S;
    // Reword counts as a kept first step.
    assert!(validate_rebase_plan(&[S::reword("aaaa", "msg")]).is_ok());
    // Blank / missing reword message refused.
    assert!(validate_rebase_plan(&[S::reword("aaaa", "  \n")]).is_err());
    let mut no_msg = S::new(RebaseAction::Reword, "aaaa");
    no_msg.message = None;
    assert!(validate_rebase_plan(&[no_msg]).is_err());
    // Message on a non-reword step refused (would silently do nothing).
    let mut pick_msg = S::new(RebaseAction::Pick, "aaaa");
    pick_msg.message = Some("m".into());
    assert!(validate_rebase_plan(&[pick_msg]).is_err());
    // Moved rules still hold: empty plan, all dropped, squash-first, non-hex.
    assert!(validate_rebase_plan(&[]).is_err());
    assert!(validate_rebase_plan(&[S::new(RebaseAction::Drop, "aaaa")]).is_err());
    assert!(validate_rebase_plan(&[S::new(RebaseAction::Squash, "aaaa")]).is_err());
    assert!(validate_rebase_plan(&[S::new(RebaseAction::Pick, "zz")]).is_err());
}

#[test]
fn build_rebase_todo_expands_rewords() {
    use crate::types::RebaseStep as S;
    let carriers = HashMap::from([("bbbb".to_string(), "cccc".to_string())]);
    let todo = build_rebase_todo(
        &[S::new(RebaseAction::Pick, "aaaa"), S::reword("bbbb", "new message")],
        &carriers,
    )
    .expect("todo");
    assert_eq!(todo, "pick aaaa\\npick bbbb\\nfixup -C cccc\\n");
    // A reword without its carrier is a programmer error, not a git run.
    assert!(build_rebase_todo(&[S::reword("bbbb", "m")], &HashMap::new()).is_err());
}
```

- [ ] **Step 3: Run to verify failure.** `cargo test -p legit-core validate_rebase_plan rebase_todo` - compile failure (Reword / new signature missing).

- [ ] **Step 4: Implement.** Split the current `build_rebase_todo` validations out:

```rust
/// Plan-validity rules, checked BEFORE anything runs (also mirrored for UX
/// by planError in planModel.ts - keep in sync):
/// - non-empty; not everything dropped;
/// - the first kept step must be a pick OR reword (squash/fixup meld into
///   a predecessor that would not exist);
/// - shas are plain hex (the todo is shell-interpolated);
/// - reword steps carry a non-blank message, non-reword steps carry none.
fn validate_rebase_plan(plan: &[RebaseStep]) -> Result<(), GitError> {
    if plan.is_empty() {
        return Err(GitError::Internal("interactive rebase plan is empty".into()));
    }
    let mut first_kept = true;
    for step in plan {
        let sha = step.sha.as_str();
        if sha.is_empty() || !sha.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(GitError::Internal(format!(
                "interactive rebase plan contains a non-hex sha: {sha:?}"
            )));
        }
        if matches!(step.action, RebaseAction::Squash | RebaseAction::Fixup) && first_kept {
            return Err(GitError::Internal(
                "interactive rebase plan starts with squash/fixup (nothing to meld into)".into(),
            ));
        }
        if step.action != RebaseAction::Drop {
            first_kept = false;
        }
        match (step.action, &step.message) {
            (RebaseAction::Reword, Some(m)) if !m.trim().is_empty() => {}
            (RebaseAction::Reword, _) => {
                return Err(GitError::Internal(
                    "a reword step needs a non-empty message".into(),
                ));
            }
            (_, Some(_)) => {
                return Err(GitError::Internal(
                    "only reword steps may carry a message".into(),
                ));
            }
            (_, None) => {}
        }
    }
    if first_kept {
        return Err(GitError::Internal("interactive rebase plan drops every commit".into()));
    }
    Ok(())
}
```

and reduce `build_rebase_todo` to assembly (it re-validates hex defensively for carriers):

```rust
/// Build the printf format string for the injected todo. Assumes
/// `validate_rebase_plan` passed; `carriers` maps each reword step's sha to
/// its message-carrier commit (created by `rebase_interactive`). A reword
/// emits `pick <sha>` + `fixup -C <carrier>` - fixup -C takes message AND
/// author from the carrier without opening an editor (git >= 2.32).
fn build_rebase_todo(
    plan: &[RebaseStep],
    carriers: &HashMap<String, String>,
) -> Result<String, GitError> {
    let mut todo = String::new();
    for step in plan {
        let sha = step.sha.as_str();
        todo.push_str(step.action.keyword());
        todo.push(' ');
        todo.push_str(sha);
        todo.push_str("\\n");
        if step.action == RebaseAction::Reword {
            let carrier = carriers.get(sha).ok_or_else(|| {
                GitError::Internal(format!("no message carrier for reword {sha}"))
            })?;
            if carrier.is_empty() || !carrier.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Err(GitError::Internal(format!(
                    "carrier commit id is not hex: {carrier:?}"
                )));
            }
            todo.push_str("fixup -C ");
            todo.push_str(carrier);
            todo.push_str("\\n");
        }
    }
    Ok(todo)
}
```

Existing `build_rebase_todo` unit tests: keep the assembly ones (pass `&HashMap::new()`), move the validation assertions onto `validate_rebase_plan`.

- [ ] **Step 5: Tests pass.** `cargo test -p legit-core validate_rebase_plan rebase_todo` PASS; `cargo test -p legit-core` no regressions. No commit.

### Task 2: `rebase_interactive` carriers (flow tests + real git)

**Files:**
- Modify: `crates/legit-core/src/cli_impl/mod.rs` (`rebase_interactive`, author parse helper)
- Modify: `crates/legit-core/src/cli_impl/flow_tests.rs`
- Modify: `crates/legit-core/tests/git_flows.rs`
- Modify: `crates/legit-core/src/backend.rs` (trait doc only: rewords via carrier commits, git >= 2.32)

**Interfaces:**
- Consumes: `validate_rebase_plan`, `build_rebase_todo(plan, carriers)` (Task 1); `GitExecutor::run_with_env`.
- Produces: reword-capable `rebase_interactive`; `fn parse_author_fields(s: &str) -> Option<(String, String, String)>`.

- [ ] **Step 1: Failing flow test.** In `flow_tests.rs` (FakeExecutor asserts env via `expect_env`; plain `expect` for env-less calls):

```rust
#[tokio::test]
async fn interactive_rebase_reword_creates_carrier_and_expands_todo() {
    let fake = FakeExecutor::default();
    // 1. Coverage check (unchanged).
    fake.expect(
        &["rev-list", "--parents", "abc..HEAD"],
        ok("1111 abc\n2222 1111\n"),
    );
    // 2. Author of the reworded commit.
    fake.expect(
        &["log", "-1", "--format=%an%x00%ae%x00%aD", "2222"],
        ok("Ada\0ada@example.com\0Mon, 1 Jan 2024 10:00:00 +0100\n"),
    );
    // 3. Carrier: same tree, parent = original, message as plain argv,
    //    author preserved via env.
    fake.expect_env(
        &["commit-tree", "2222^{tree}", "-p", "2222", "-m", "new subject\n\nnew body"],
        &[
            ("GIT_AUTHOR_NAME", "Ada"),
            ("GIT_AUTHOR_EMAIL", "ada@example.com"),
            ("GIT_AUTHOR_DATE", "Mon, 1 Jan 2024 10:00:00 +0100"),
        ],
        ok("cccc\n"),
    );
    // 4. The rebase itself, todo carrying the fixup -C line.
    fake.expect_env(
        &["rebase", "-i", "--autostash", "abc"],
        &[
            ("GIT_SEQUENCE_EDITOR", "printf 'pick 1111\\npick 2222\\nfixup -C cccc\\n' >"),
            ("GIT_EDITOR", "true"),
        ],
        ok("Successfully rebased and updated refs/heads/main.\n"),
    );
    let (b, exec) = backend(fake);
    let plan = [
        RebaseStep::new(RebaseAction::Pick, "1111"),
        RebaseStep::reword("2222", "new subject\n\nnew body"),
    ];
    let outcome = b.rebase_interactive("abc", &plan).await.expect("rebase");
    assert!(matches!(outcome, RebaseOutcome::Completed));
    exec.assert_done();
}

#[tokio::test]
async fn interactive_rebase_runs_nothing_on_a_blank_reword_message() {
    let (b, exec) = backend(FakeExecutor::default());
    let plan = [RebaseStep::reword("1111", "   ")];
    assert!(b.rebase_interactive("abc", &plan).await.is_err());
    exec.assert_done(); // not even the rev-list ran
}

#[tokio::test]
async fn interactive_rebase_creates_no_carrier_when_coverage_fails() {
    let fake = FakeExecutor::default();
    fake.expect(&["rev-list", "--parents", "abc..HEAD"], ok("1111 abc\n"));
    let (b, exec) = backend(fake);
    // Plan claims a commit the range does not have: refused BEFORE any
    // commit-tree runs.
    let plan = [RebaseStep::reword("9999", "msg")];
    assert!(b.rebase_interactive("abc", &plan).await.is_err());
    exec.assert_done();
}
```

Check the exact env-pair shape of the existing rebase expectation (`grep -n "GIT_SEQUENCE_EDITOR" flow_tests.rs`) and mirror it (EDITOR_ACCEPT_ENV\[0\] is `("GIT_EDITOR", "true")`).

- [ ] **Step 2: Run to verify failure.** `cargo test -p legit-core interactive_rebase` - the new tests fail (reword ctor exists from Task 1; sequencing not implemented).

- [ ] **Step 3: Implement.** Author parse helper (near the other pure helpers, with a unit test in the same module):

```rust
/// Parse `git log -1 --format=%an%x00%ae%x00%aD` output into
/// (name, email, date). NUL-separated: names/emails may contain anything
/// printable, dates contain spaces.
fn parse_author_fields(s: &str) -> Option<(String, String, String)> {
    let mut it = s.trim_end_matches('\n').splitn(3, '\0');
    match (it.next(), it.next(), it.next()) {
        (Some(n), Some(e), Some(d)) if !n.is_empty() && !d.is_empty() => {
            Some((n.to_string(), e.to_string(), d.to_string()))
        }
        _ => None,
    }
}

#[test]
fn parses_author_fields() {
    assert_eq!(
        parse_author_fields("Ada\0ada@example.com\0Mon, 1 Jan 2024 10:00:00 +0100\n"),
        Some(("Ada".into(), "ada@example.com".into(), "Mon, 1 Jan 2024 10:00:00 +0100".into()))
    );
    assert_eq!(parse_author_fields("no separators"), None);
}
```

`rebase_interactive` body (replacing the current one; validation order per spec):

```rust
async fn rebase_interactive(
    &self,
    base: &str,
    plan: &[RebaseStep],
) -> Result<RebaseOutcome, GitError> {
    validate_rebase_plan(plan)?;
    // (existing comment about the injected todo replacing git's own)
    let range = format!("{base}..HEAD");
    let listed = self.run_checked(&["rev-list", "--parents", &range]).await?;
    verify_plan_covers_range(plan, &listed)?;
    // Message carriers for reword steps: an unreferenced commit with the
    // ORIGINAL's tree and the original as parent (empty diff, applies
    // anywhere) holding the new message + the original author. `fixup -C`
    // then takes message and author from it without opening an editor -
    // git's own non-interactive reword lane (what `--fixup=reword:`
    // compiles down to; needs git >= 2.32).
    let runner = self.runner().await;
    let mut carriers: HashMap<String, String> = HashMap::new();
    for step in plan {
        if step.action != RebaseAction::Reword {
            continue;
        }
        let sha = step.sha.as_str();
        let author = self
            .run_checked(&["log", "-1", "--format=%an%x00%ae%x00%aD", sha])
            .await?;
        let (name, email, date) = parse_author_fields(&author).ok_or_else(|| {
            GitError::Internal(format!("unexpected author format for {sha}: {author:?}"))
        })?;
        let tree = format!("{sha}^{{tree}}");
        let message = step.message.as_deref().unwrap_or_default();
        let out = runner
            .run_with_env(
                &["commit-tree", &tree, "-p", sha, "-m", message],
                &[
                    ("GIT_AUTHOR_NAME", &name),
                    ("GIT_AUTHOR_EMAIL", &email),
                    ("GIT_AUTHOR_DATE", &date),
                ],
            )
            .await?;
        if !out.success {
            return Err(GitError::CommandFailed {
                exit_code: out.exit_code.unwrap_or(-1),
                stderr: out.stderr.trim().to_string(),
            });
        }
        carriers.insert(sha.to_string(), out.stdout.trim().to_string());
    }
    let todo = build_rebase_todo(plan, &carriers)?;
    let editor = format!("printf '{todo}' >");
    let env = [("GIT_SEQUENCE_EDITOR", editor.as_str()), EDITOR_ACCEPT_ENV[0]];
    let (code, stdout, stderr) = self
        .run_classified_env(&["rebase", "-i", "--autostash", base], &env)
        .await?;
    // Older git rejects the `fixup -C` todo line at parse time ("invalid
    // line ...: fixup -C <sha>"); name the floor so the error is actionable
    // rather than cryptic. Only for plans that actually reword, and only
    // when the failure mentions the fixup line.
    match classify_rebase_output(code, &stdout, &stderr) {
        Err(e) if !carriers.is_empty() && stderr.to_lowercase().contains("fixup") => {
            Err(append_error_note(
                e,
                "note: rewording via interactive rebase needs git 2.32 or newer (the `fixup -C` todo command)",
            ))
        }
        other => other,
    }
}
```

- [ ] **Step 4: Flow tests pass.** `cargo test -p legit-core interactive_rebase` PASS (the pre-existing sequence test needs its expectations extended only if it used rewords - it does not; it must still pass unchanged).

- [ ] **Step 5: Real-git case.** Append to `tests/git_flows.rs`:

```rust
/// Reword via carrier + fixup -C, end to end: message replaced verbatim
/// (multi-line body), author preserved, trees untouched - combined with a
/// reorder so the empty-diff carrier property is exercised.
#[tokio::test]
async fn interactive_rebase_rewords_a_mid_history_commit() {
    let repo = TestRepo::init().await;
    repo.write("a.txt", "a\n");
    repo.commit_all("base").await;
    let base = repo.head().await;
    repo.write("b.txt", "b\n");
    repo.git(&["add", "-A"]).await;
    repo.git(&[
        "-c", "user.name=Ada Lovelace",
        "-c", "user.email=ada@example.invalid",
        "commit", "-m", "second",
    ]).await;
    let reworded = repo.head().await;
    repo.write("c.txt", "c\n");
    repo.commit_all("third").await;
    let third = repo.head().await;

    let plan = [
        // Reorder: third first, then the reworded second.
        RebaseStep::new(RebaseAction::Pick, &third),
        RebaseStep::reword(&reworded, "renamed subject\n\nwith a body line"),
    ];
    let outcome = repo.backend.rebase_interactive(&base, &plan).await.expect("rebase");
    assert!(matches!(outcome, RebaseOutcome::Completed), "got {outcome:?}");

    let log = repo.git(&["log", "--format=%s|%an|%ae", &format!("{base}..HEAD")]).await;
    let lines: Vec<&str> = log.trim().lines().collect();
    // Newest first: the reworded commit is on top after the reorder.
    assert_eq!(lines[0], "renamed subject|Ada Lovelace|ada@example.invalid");
    assert_eq!(lines[1], "third|LeGit Test|test@example.invalid");
    let body = repo.git(&["log", "-1", "--format=%b"]).await;
    assert_eq!(body.trim(), "with a body line");
    // Content untouched: all three files exist with their content.
    assert_eq!(repo.read("b.txt"), "b\n");
    assert_eq!(repo.read("c.txt"), "c\n");
}
```

- [ ] **Step 6: Run it.** `cargo test -p legit-core --test git_flows interactive_rebase` PASS (requires local git >= 2.32; `git --version` first if it fails oddly). Update the `backend.rs` trait doc for `rebase_interactive` (rewords, carriers, git floor). No commit.

### Task 3: `rebase_range_info` backend + command

**Files:**
- Modify: `crates/legit-core/src/backend.rs` (trait method), `crates/legit-core/src/cli_impl/mod.rs` (impl), `crates/legit-core/src/cli_impl/flow_tests.rs`, `crates/legit-core/tests/git_flows.rs`
- Modify: `src-tauri/src/commands/ops.rs` (command; follow the file's existing command shape), `src-tauri/src/lib.rs` (register)

**Interfaces:**
- Produces: `async fn rebase_range_info(&self, base: &str) -> Result<RebaseRangeInfo, GitError>`; command `repo_rebase_range_info(repo_id, base) -> Result<RebaseRangeInfo, AppError>`.

- [ ] **Step 1: Failing flow tests:**

```rust
#[tokio::test]
async fn rebase_range_info_reads_unpushed_and_ancestry() {
    let fake = FakeExecutor::default();
    fake.expect(&["rev-list", "abc..HEAD", "--not", "@{upstream}"], ok("1111\n2222\n"));
    fake.expect(&["merge-base", "--is-ancestor", "abc", "HEAD"], ok(""));
    let (b, exec) = backend(fake);
    let info = b.rebase_range_info("abc").await.expect("info");
    assert_eq!(info.unpushed, Some(vec!["1111".into(), "2222".into()]));
    assert!(!info.transplant);
    exec.assert_done();
}

#[tokio::test]
async fn rebase_range_info_handles_no_upstream_and_transplant() {
    let fake = FakeExecutor::default();
    // exit 128: no upstream configured - an answer, not an error.
    fake.expect(&["rev-list", "abc..HEAD", "--not", "@{upstream}"], fail(128, "fatal: no upstream configured for branch 'main'"));
    // exit 1: base is NOT an ancestor - transplant.
    fake.expect(&["merge-base", "--is-ancestor", "abc", "HEAD"], out(1, "", ""));
    let (b, exec) = backend(fake);
    let info = b.rebase_range_info("abc").await.expect("info");
    assert_eq!(info.unpushed, None);
    assert!(info.transplant);
    exec.assert_done();
}
```

- [ ] **Step 2: Verify failure**, then implement in `cli_impl/mod.rs`:

```rust
async fn rebase_range_info(&self, base: &str) -> Result<RebaseRangeInfo, GitError> {
    let runner = self.runner().await;
    // Range commits NOT reachable from the upstream. Exit 128 = HEAD has
    // no upstream: no pushed-warning is possible, an answer not an error.
    let range = format!("{base}..HEAD");
    let unpushed = match runner
        .run_expecting(&["rev-list", &range, "--not", "@{upstream}"], &[128])
        .await?
    {
        o if o.success => Some(o.stdout.lines().map(str::to_string).collect()),
        _ => None,
    };
    // Exit 0 = base IS an ancestor of HEAD (plain history edit); exit 1 =
    // it is not (the rebase RELOCATES the range onto the base).
    let anc = runner
        .run_expecting(&["merge-base", "--is-ancestor", base, "HEAD"], &[1])
        .await?;
    Ok(RebaseRangeInfo { unpushed, transplant: !anc.success })
}
```

Trait method in `backend.rs` with the same doc. Command in `ops.rs` next to `repo_rebase_interactive` (same session/backend/map_err shape as its neighbors), registered in `lib.rs` next to it.

- [ ] **Step 3: Real-git case** in `git_flows.rs` (bare "remote" = plain `git init --bare` tempdir):

```rust
/// Pins the two probes behind the pushed-warning + transplant notice:
/// rev-list --not @{upstream} (exit 128 without an upstream) and
/// merge-base --is-ancestor's 0/1 exit contract.
#[tokio::test]
async fn rebase_range_info_probes_upstream_and_ancestry() {
    let repo = TestRepo::init().await;
    repo.write("a.txt", "a\n");
    repo.commit_all("base").await;
    let base = repo.head().await;
    repo.write("b.txt", "b\n");
    repo.commit_all("pushed-commit").await;

    // No upstream yet: unpushed = None; base is an ancestor.
    let info = repo.backend.rebase_range_info(&base).await.expect("info");
    assert_eq!(info.unpushed, None);
    assert!(!info.transplant);

    // Publish, then add one local-only commit: exactly it is unpushed.
    let remote = tempfile::tempdir().expect("tempdir");
    let remote_path = remote.path().to_string_lossy().into_owned();
    let remote_runner = GitRunner::for_repo("git", remote.path());
    let out = remote_runner.run(&["init", "--bare"]).await.expect("spawn git");
    assert!(out.success, "bare init failed: {}", out.stderr);
    repo.git(&["remote", "add", "origin", &remote_path]).await;
    repo.git(&["push", "-u", "origin", "main"]).await;
    repo.write("c.txt", "c\n");
    repo.commit_all("local-only").await;
    let local_only = repo.head().await;
    let info = repo.backend.rebase_range_info(&base).await.expect("info");
    assert_eq!(info.unpushed, Some(vec![local_only.clone()]));

    // A base on a parallel branch: transplant = true.
    repo.git(&["switch", "-c", "side", &base]).await;
    repo.write("side.txt", "s\n");
    repo.commit_all("side commit").await;
    let side = repo.head().await;
    repo.git(&["switch", "main"]).await;
    let info = repo.backend.rebase_range_info(&side).await.expect("info");
    assert!(info.transplant);
}
```

- [ ] **Step 4: All green.** `cargo test -p legit-core rebase_range_info` + `cargo check --workspace`. No commit.

### Task 4: Frontend plan model + panel rework (order flip + reword UX)

**Files:**
- Create: `src/panels/InteractiveRebase/planModel.ts` + `src/panels/InteractiveRebase/planModel.test.ts`
- Modify: `src/panels/InteractiveRebase/InteractiveRebasePanel.tsx`
- Modify: `src/lib/types.ts` (`RebaseAction` gains `"reword"`; `RebaseStep` gains `message?: string | null`; add `RebaseRangeInfo`)
- Modify: `src/lib/commands.ts` (`repoRebaseRangeInfo`)

**Interfaces:**
- Produces: `PlanRow { sha, shortSha, subject, action, originalMessage, message }`; `planError(todoOrderRows)`, `toTodoOrder(rows)`, `isUnchanged(rows, newestFirstIds)`, `pushedShas(rowShas, unpushed)` in planModel.ts. Panel rows are NEWEST FIRST from here on.

- [ ] **Step 1: types + wrapper.**

```ts
// types.ts
export type RebaseAction = "pick" | "reword" | "squash" | "fixup" | "drop";
// RebaseStep gains:
  /** New commit message; set exactly for reword steps. */
  message?: string | null;
// new:
/** Probe behind the rebase panel's pushed chips + transplant notice. */
export interface RebaseRangeInfo {
  /** Range commits NOT reachable from @{upstream}; null = no upstream. */
  unpushed: string[] | null;
  /** True when the base is not an ancestor of HEAD (the rebase relocates). */
  transplant: boolean;
}
```

```ts
// commands.ts (import RebaseRangeInfo)
/** Pushed-set + ancestry probe for the interactive-rebase panel. */
export const repoRebaseRangeInfo = (repoId: string, base: string) =>
  invoke<RebaseRangeInfo>("repo_rebase_range_info", { repoId, base });
```

- [ ] **Step 2: Failing planModel tests** (`planModel.test.ts`):

```ts
import { describe, expect, it } from "vitest";
import { isUnchanged, planError, pushedShas, toTodoOrder, type PlanRow } from "./planModel";

const row = (sha: string, action: PlanRow["action"] = "pick", message = ""): PlanRow => ({
  sha,
  shortSha: sha.slice(0, 8),
  subject: `s-${sha}`,
  action,
  originalMessage: `s-${sha}\n\nbody`,
  message,
});

describe("planModel", () => {
  it("toTodoOrder reverses display (newest first) into git order (oldest first)", () => {
    expect(toTodoOrder([row("c"), row("b"), row("a")]).map((r) => r.sha)).toEqual(["a", "b", "c"]);
  });

  it("planError: the first kept todo step may be a pick or a reword", () => {
    expect(planError([row("a", "reword", "msg"), row("b")])).toBeNull();
    expect(planError([row("a", "squash")])).toContain("below");
    expect(planError([row("a", "drop")])).toContain("dropped");
    expect(planError([])).toBeNull();
  });

  it("planError: rewords need a non-blank message", () => {
    expect(planError([row("a"), row("b", "reword", "  ")])).toContain("message");
    expect(planError([row("a"), row("b", "reword", "new msg")])).toBeNull();
  });

  it("isUnchanged: order, action, and reworded text all count", () => {
    const rows = [row("b"), row("a")];
    expect(isUnchanged(rows, ["b", "a"])).toBe(true);
    expect(isUnchanged([row("a"), row("b")], ["b", "a"])).toBe(false);
    // A reword whose text EQUALS the original message is no change.
    const same = { ...row("b", "reword"), message: "s-b\n\nbody" };
    expect(isUnchanged([same, row("a")], ["b", "a"])).toBe(true);
    const changed = { ...row("b", "reword"), message: "different" };
    expect(isUnchanged([changed, row("a")], ["b", "a"])).toBe(false);
  });

  it("pushedShas: plan shas minus the unpushed set; null upstream = none", () => {
    expect(pushedShas(["a", "b", "c"], ["b"])).toEqual(new Set(["a", "c"]));
    expect(pushedShas(["a"], null)).toEqual(new Set());
  });
});
```

- [ ] **Step 3: Run - fails** (module missing). Implement `planModel.ts`:

```ts
import type { RebaseAction } from "../../lib/types";

/** One editable plan row. DISPLAY order = newest first (matches the commit
 *  graph); `toTodoOrder` flips into git's oldest-first todo order at the
 *  boundaries (validation, submit). */
export interface PlanRow {
  sha: string;
  shortSha: string;
  subject: string;
  action: RebaseAction;
  /** Full original message (subject + body) - the reword prefill and the
   *  "did the reword actually change anything" baseline. */
  originalMessage: string;
  /** Reword draft; meaningful only while action === "reword". */
  message: string;
}

export function toTodoOrder(rows: readonly PlanRow[]): PlanRow[] {
  return [...rows].reverse();
}

/** Plan-validity rules in TODO order, mirroring `validate_rebase_plan` in
 *  legit-core (the enforcing copy) for immediate UX feedback - keep the two
 *  in sync. Messages are phrased for the DISPLAY order (newest first):
 *  todo-order "previous" is the row BELOW. */
export function planError(todoRows: readonly PlanRow[]): string | null {
  if (todoRows.length === 0) return null;
  const kept = todoRows.filter((r) => r.action !== "drop");
  if (kept.length === 0) return "Every commit is dropped: nothing to rebase onto.";
  if (kept[0].action !== "pick" && kept[0].action !== "reword")
    return "The last kept commit must be a pick or reword: squash/fixup meld into the commit below.";
  for (const r of todoRows) {
    if (r.action === "reword" && r.message.trim() === "")
      return `The reword of ${r.shortSha} needs a non-empty message.`;
  }
  return null;
}

/** True when running the plan would change nothing: original order, every
 *  action a pick, or a reword whose text equals the original message. */
export function isUnchanged(rows: readonly PlanRow[], newestFirstIds: readonly string[]): boolean {
  return rows.every((r, i) => {
    if (newestFirstIds[i] !== r.sha) return false;
    if (r.action === "pick") return true;
    if (r.action === "reword") return r.message === r.originalMessage;
    return false;
  });
}

/** Plan shas already on the upstream (null = no upstream = none). */
export function pushedShas(
  rowShas: readonly string[],
  unpushed: readonly string[] | null | undefined,
): Set<string> {
  if (unpushed == null) return new Set();
  const un = new Set(unpushed);
  return new Set(rowShas.filter((s) => !un.has(s)));
}
```

Run the tests - PASS.

- [ ] **Step 4: Panel rework.** In `InteractiveRebasePanel.tsx`:
  - Delete the local `PlanRow` + `planError`; import from `./planModel`.
  - `ACTIONS: RebaseAction[] = ["pick", "reword", "squash", "fixup", "drop"]`.
  - Rows build NEWEST FIRST (drop the `oldestFirst` reversal for row building; keep `commits` order):

```tsx
setRows(
  rangeError
    ? []
    : commits.map((c) => ({
        sha: c.id,
        shortSha: c.id.slice(0, 8),
        subject: c.message.split("\n")[0],
        action: "pick" as RebaseAction,
        originalMessage: c.message,
        message: "",
      })),
);
```

  - `setAction` prefills/clears the draft:

```tsx
const setAction = (index: number, action: RebaseAction) => {
  setRows((rs) =>
    rs.map((r, i) =>
      i === index
        ? { ...r, action, message: action === "reword" ? (r.action === "reword" ? r.message : r.originalMessage) : "" }
        : r,
    ),
  );
};
```

  - Validation + gates: `const error = planError(toTodoOrder(rows));` and `const unchanged = useMemo(() => isUnchanged(rows, commits.map((c) => c.id)), [rows, commits]);` (drop the old `oldestFirst` memo entirely).
  - Submit reverses and attaches messages:

```tsx
const plan: RebaseStep[] = toTodoOrder(rows).map((r) => ({
  action: r.action,
  sha: r.sha,
  message: r.action === "reword" ? r.message : null,
}));
```

  - Arrow buttons: titles become "Move up (applied later)" / "Move down (applied earlier)" (display up = newer = replayed later).
  - Toolbar caption: "applied top to bottom" becomes "applied bottom to top (newest on top, like the graph)".
  - Reword textarea, rendered right below the row's flex line when `r.action === "reword"` (wrap the row div's content: the existing flex line stays, the textarea is a sibling inside the bordered row container):

```tsx
{r.action === "reword" && (
  <textarea
    value={r.message}
    disabled={busy}
    rows={Math.min(8, Math.max(2, r.message.split("\n").length))}
    onChange={(e) =>
      setRows((rs) => rs.map((row2, i2) => (i2 === i ? { ...row2, message: e.target.value } : row2)))
    }
    style={{
      width: "100%",
      marginTop: 4,
      fontSize: "var(--fz-md)",
      fontFamily: "monospace",
      resize: "vertical",
      boxSizing: "border-box",
    }}
  />
)}
```

(The row container becomes `flexDirection: "column"` with the original line as an inner flex div - keep the existing gap/border/padding on the outer container.)
  - Update the panel docstring (rewording IS a step now; rows newest-first).

- [ ] **Step 5: Verify.** `npx tsc --noEmit` clean; planModel tests + full vitest PASS via PowerShell. No commit.

### Task 5: Drag-to-reorder

**Files:**
- Modify: `src/panels/InteractiveRebase/InteractiveRebasePanel.tsx`

**Interfaces:**
- Consumes: `move`-equivalent row state updates from Task 4. Reference implementation for the WebView2 quirks: `src/panels/Commits/columns/ColumnHeader.tsx` (custom MIME + `text/plain` fallback, `dragover` types check).

- [ ] **Step 1: Implement.** Panel-local constants + state:

```tsx
const ROW_DRAG_MIME = "application/x-legit-rebase-row";
const [dragIndex, setDragIndex] = useState<number | null>(null);
const [dropTarget, setDropTarget] = useState<{ index: number; side: "above" | "below" } | null>(null);

const applyDrop = (from: number, target: { index: number; side: "above" | "below" }) => {
  setRows((rs) => {
    const next = [...rs];
    const [moved] = next.splice(from, 1);
    let to = target.index + (target.side === "below" ? 1 : 0);
    if (from < to) to -= 1;
    next.splice(to, 0, moved);
    return next;
  });
};
```

Row container props (the outer bordered div from Task 4):

```tsx
draggable={!busy}
onDragStart={(e) => {
  setDragIndex(i);
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData(ROW_DRAG_MIME, String(i));
  e.dataTransfer.setData("text/plain", String(i));
}}
onDragEnd={() => { setDragIndex(null); setDropTarget(null); }}
onDragOver={(e) => {
  if (dragIndex === null || dragIndex === i) return;
  e.preventDefault(); // allow dropping
  e.dataTransfer.dropEffect = "move";
  const rect = e.currentTarget.getBoundingClientRect();
  setDropTarget({ index: i, side: e.clientY < rect.top + rect.height / 2 ? "above" : "below" });
}}
onDrop={(e) => {
  e.preventDefault();
  if (dragIndex !== null && dropTarget) applyDrop(dragIndex, dropTarget);
  setDragIndex(null);
  setDropTarget(null);
}}
```

Drop indicator on the row container style (hairline via existing token; no new tokens):

```tsx
borderTop:
  dropTarget?.index === i && dropTarget.side === "above"
    ? "2px solid var(--accent)"
    : "1px solid var(--panel-border)",
borderBottom:
  dropTarget?.index === i && dropTarget.side === "below"
    ? "2px solid var(--accent)"
    : "1px solid var(--panel-border)",
opacity: r.action === "drop" ? 0.5 : dragIndex === i ? 0.4 : 1,
cursor: busy ? undefined : "grab",
```

(Replace the single `border` shorthand with explicit `borderLeft/Right` 1px `var(--panel-border)` + the two conditional edges above, keeping `borderRadius: 4`.) The textarea must not start drags: `onDragStart={(e) => e.stopPropagation()}` + `draggable={false}` on the textarea (WebView2 lets text selection start a parent drag otherwise).

- [ ] **Step 2: Verify.** `npx tsc --noEmit` clean; full vitest still green (no unit seam for DnD wiring - the reorder state math is `applyDrop`; move it into planModel as `movedRows(rows, from, to)`? NO - keep as written, it is three lines and the arrow-button path already covers reorder state in manual testing). No commit.

### Task 6: Pushed chips + transplant notice + confirm on Start

**Files:**
- Modify: `src/panels/InteractiveRebase/InteractiveRebasePanel.tsx`

**Interfaces:**
- Consumes: `repoRebaseRangeInfo` (Task 4 wrapper), `pushedShas` (planModel), `confirmDialog` (`src/store/confirm.ts`: `confirmDialog({ title?, message, detail?, warning? }) -> Promise<boolean>`).

- [ ] **Step 1: Query + derived sets** (after the commits query):

```tsx
const { data: rangeInfo } = useQuery<RebaseRangeInfo>({
  queryKey: [repo?.id, "log", "rebase-range-info", base],
  queryFn: () => repoRebaseRangeInfo(repo!.id, base!),
  enabled: !!repo && !!base,
  staleTime: 5_000,
});
const pushed = useMemo(
  () => pushedShas(rows.map((r) => r.sha), rangeInfo?.unpushed),
  [rows, rangeInfo],
);
```

- [ ] **Step 2: Chip + notice rendering.** Chip inside the row's main flex line, after the subject span:

```tsx
{pushed.has(r.sha) && (
  <span
    className="legit-subtle"
    title="Already on the upstream - running this plan rewrites published history"
    style={{
      fontSize: "var(--fz-sm)",
      border: "1px solid var(--panel-border)",
      borderRadius: 3,
      padding: "0 4px",
      flexShrink: 0,
    }}
  >
    pushed
  </span>
)}
```

Transplant notice above the rows (first child of the body div, only when rows exist):

```tsx
{rangeInfo?.transplant && rows.length > 0 && (
  <span className="legit-subtle" style={{ fontSize: "var(--fz-sm)" }}>
    The base is not an ancestor of the current branch: these commits are
    REPLAYED ONTO {base.slice(0, 8)} and move to that commit's history.
  </span>
)}
```

- [ ] **Step 3: Confirm on Start.** At the top of `start()` (before `run`); deliberately NOT gated by the destructive-confirmation setting (history-warning house rule - same as amend-pushed):

```tsx
if (pushed.size > 0) {
  const ok = await confirmDialog({
    title: "Rewrite pushed commits?",
    message: `${pushed.size} of the ${rows.length} commits in this plan ${
      pushed.size === 1 ? "is" : "are"
    } already on the upstream. Running the plan rewrites them - the branch will need a force-push afterwards.`,
    detail: base.slice(0, 8),
  });
  if (!ok) return;
}
```

Import `confirmDialog` from `../../store/confirm` (check the exact export path/name against `store/confirm.ts` before wiring).

- [ ] **Step 4: Verify.** `npx tsc --noEmit`; full vitest green. No commit.

### Task 7: Full verification + docs + manual steps

- [ ] `cargo test -p legit-core && cargo test -p legit-app && cargo check --workspace` green.
- [ ] `npx tsc --noEmit` clean; full `npx vitest run` via PowerShell green.
- [ ] BACKLOG: mark release blocker #2 done (all three items + transplant notice; note the git >= 2.32 floor for rewords); update blocker #3's re-run note to "pending" wording pointing at the new manual steps below.
- [ ] Report manual test steps (rebase-playground in LeGit-Test, re-arm `git reset --hard 041b4e7`):
  1. Rows now list newest first, matching the graph; the toolbar says applied bottom to top.
  2. Drag "recipe step two" above "poem line three": indicator line, order changes, arrows still work; Start runs the reordered plan.
  3. Reword: set "rebase: add recipe.txt" to reword, textarea prefills the full message; edit subject + add a body line; Start; verify subject/body via the Commits panel and that the author is unchanged; verify an unedited reword (text identical) keeps Start disabled when nothing else changed.
  4. Pushed chips: `rebase-playground` has no upstream - no chips, no dialog. On `main` (has origin/main), summon a plan over pushed commits: chips appear and Start raises the "Rewrite pushed commits?" dialog (cancel out - do NOT rewrite main).
  5. Transplant notice: right-click a commit on `feature/api` while on `main`: the notice appears (do not start).
  6. Empty/blank reword message blocks Start with the footer error.
