# Submodule Move Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline). Do NOT use subagent-driven-development (user rule). Spec: `design/2026-07-23-submodule-move.md`.

**Goal:** "Move" action on the submodule row: edit the path in place, LeGit wraps `git mv` with an occupied-target preflight and parent-dir creation, leaving the staged move for the user's commit.

**Architecture:** One backend method (`submodule_move`) on `GitBackend` + `GitCliBackend`, one Tauri command, one wrapper, and an `editing === "path"` state in the existing `SubmoduleRow` inline-edit pattern.

**Tech Stack:** Rust (legit-core + src-tauri), React/TypeScript, FakeExecutor flow tests, real-git tests.

## Global Constraints

- **NEVER commit or push** - leave everything for Simon's review.
- No em-dashes anywhere. Colours only via theme tokens (this plan adds none).
- Rust verification from WSL (`cargo test -p legit-core`, `cargo check --workspace`); frontend `npx tsc --noEmit` + vitest via `powershell.exe`.
- Hand-written wrappers/types (`commands.ts`); no new frontend types needed.

---

### Task 1: Backend `submodule_move` (TDD via flow tests)

**Files:**
- Modify: `crates/legit-core/src/backend.rs` (trait, next to `submodule_remove` ~line 245)
- Modify: `crates/legit-core/src/cli_impl/mod.rs` (impl next to `submodule_remove` ~line 1832)
- Modify: `crates/legit-core/src/cli_impl/flow_tests.rs` (2 new tests near the remove tests)

**Interfaces:**
- Produces: `async fn submodule_move(&self, from: &Path, to: &Path) -> Result<(), GitError>` - consumed by Task 3.

- [ ] **Step 1: Failing flow tests** (tempdir as fake repo root so the fs preflight is real):

```rust
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
```

- [ ] **Step 2:** `cargo test -p legit-core --lib flow_tests::submodule_move` - expect compile error (no such method).

- [ ] **Step 3: Trait method** in `backend.rs` next to `submodule_remove`:

```rust
    /// Move a submodule's path (`git mv`): moves the worktree, rewrites
    /// `.gitmodules`, moves the index gitlink, fixes the gitfile link, and
    /// STAGES it all. The submodule NAME (`.git/modules/<name>`) stays
    /// unchanged. Missing parent directories of `to` are created; an
    /// occupied target is refused before anything runs.
    async fn submodule_move(&self, from: &Path, to: &Path) -> Result<(), GitError>;
```

- [ ] **Step 4: Implementation** in `cli_impl/mod.rs` next to `submodule_remove`:

```rust
    async fn submodule_move(&self, from: &Path, to: &Path) -> Result<(), GitError> {
        // Reject anything that could escape the worktree (same rule as
        // `submodule_gitdir_path`): relative, normal components only.
        for p in [from, to] {
            if p.as_os_str().is_empty()
                || p.is_absolute()
                || p.components().any(|c| !matches!(c, std::path::Component::Normal(_)))
            {
                return Err(GitError::Internal(format!(
                    "invalid submodule path '{}'",
                    p.display()
                )));
            }
        }
        let runner = self.runner().await;
        let out = runner.run(&["rev-parse", "--show-toplevel"]).await?;
        Self::ensure_success(&out)?;
        drop(runner);
        let root = PathBuf::from(out.stdout.trim());
        let abs_to = root.join(to);
        if abs_to.exists() {
            return Err(GitError::Internal(format!(
                "target path '{}' already exists",
                to.display()
            )));
        }
        // `git mv` refuses "destination directory does not exist": create the
        // missing parents, remembering the topmost one we created so a failed
        // move can clean up after itself.
        let mut created: Option<PathBuf> = None;
        if let Some(parent) = abs_to.parent() {
            if !parent.exists() {
                let mut probe = parent.to_path_buf();
                while let Some(up) = probe.parent() {
                    if up.exists() {
                        break;
                    }
                    probe = up.to_path_buf();
                }
                std::fs::create_dir_all(parent).map_err(|e| {
                    GitError::Internal(format!(
                        "could not create '{}': {e}",
                        parent.display()
                    ))
                })?;
                created = Some(probe);
            }
        }
        let f = from.to_string_lossy().into_owned();
        let t = to.to_string_lossy().into_owned();
        match self.run_simple(&["mv", "--", &f, &t]).await {
            Ok(()) => Ok(()),
            Err(e) => {
                // Best-effort: remove the empty directories we just created;
                // a failed cleanup must not be silent (house rule).
                if let Some(dir) = created {
                    if let Err(rm) = std::fs::remove_dir_all(&dir) {
                        return Err(append_error_note(
                            e,
                            &format!(
                                "note: cleanup of created directory '{}' also failed: {rm}",
                                dir.display()
                            ),
                        ));
                    }
                }
                Err(e)
            }
        }
    }
```

- [ ] **Step 5:** `cargo test -p legit-core` - all pass.

---

### Task 2: Real-git validation

**Files:**
- Modify: `crates/legit-core/tests/git_flows.rs` (next to the other submodule tests)

- [ ] **Step 1: Test** - encodes: the one-command move works end to end; the gitdir key survives; dirt travels; occupied target refused with nothing changed.

```rust
#[tokio::test]
async fn submodule_move_relocates_worktree_gitmodules_and_stays_functional() {
    let (sup, _lib) = repo_with_submodule().await;
    // Dirty content must travel with the move.
    sup.write("lib/wip.txt", "uncommitted\n");

    sup.backend
        .submodule_move(Path::new("lib"), Path::new("vendor/lib"))
        .await
        .unwrap();

    // Worktree moved (dirt included), .gitmodules rewritten, change staged.
    assert!(sup.exists("vendor/lib/lib.txt"));
    assert!(sup.exists("vendor/lib/wip.txt"));
    assert!(!sup.exists("lib"));
    assert!(sup.read(".gitmodules").contains("path = vendor/lib"));
    let staged = sup.git(&["diff", "--cached", "--name-only"]).await;
    assert!(staged.contains(".gitmodules"), "{staged}");
    // The gitfile link still resolves: git works inside the moved submodule,
    // and the gitdir key kept the ORIGINAL name.
    let gitdir = sup.git(&["-C", "vendor/lib", "rev-parse", "--absolute-git-dir"]).await;
    assert!(
        gitdir.replace('\\', "/").contains(".git/modules/lib"),
        "gitdir key must keep the original name: {gitdir}"
    );
    // The enumeration sees the new path under the old name.
    let subs = sup.backend.submodules().await.unwrap();
    assert_eq!(subs.len(), 1);
    assert_eq!(subs[0].name, "lib");
    assert_eq!(subs[0].path, PathBuf::from("vendor/lib"));
    // A follow-up commit of the staged move succeeds.
    sup.git(&["commit", "-m", "move submodule"]).await;

    // Occupied target: refused, nothing changed.
    sup.write("taken", "occupied\n");
    let err = sup
        .backend
        .submodule_move(Path::new("vendor/lib"), Path::new("taken"))
        .await
        .unwrap_err();
    assert!(err.to_string().contains("already exists"), "{err:?}");
    assert!(sup.exists("vendor/lib/lib.txt"));
}
```

- [ ] **Step 2:** `cargo test -p legit-core --test git_flows submodule_move` - PASS. If the gitfile assertion fails, STOP and report (the premise that `git mv` fixes the link would be wrong).

---

### Task 3: Command, wrapper, UI

**Files:**
- Modify: `src-tauri/src/commands/submodules.rs` (new command next to `repo_submodule_remove`)
- Modify: `src-tauri/src/lib.rs` (register next to `commands::repo_submodule_remove`)
- Modify: `src/lib/commands.ts` (next to `repoSubmoduleSetUrl`)
- Modify: `src/panels/Submodules/SubmoduleRow.tsx` (`editing` union + "Move" button + input block)
- Modify: `src/panels/Submodules/SubmodulesSection.tsx` (`onMovePath` handler)

- [ ] **Step 1: Command**

```rust
/// Move a submodule to another path (`git mv`; stages the result).
#[tauri::command]
#[specta::specta]
pub async fn repo_submodule_move(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    from: String,
    to: String,
) -> Result<(), AppError> {
    let session = state.get_session(&repo_id).await?;
    session
        .backend
        .submodule_move(&PathBuf::from(from), &PathBuf::from(to))
        .await
        .map_err(AppError::Git)
}
```

Register `commands::repo_submodule_move,` in `lib.rs`.

- [ ] **Step 2: Wrapper** in `commands.ts`:

```ts
export const repoSubmoduleMove = (repoId: string, from: string, to: string) =>
  invoke<null>("repo_submodule_move", { repoId, from, to });
```

- [ ] **Step 3: Row UI** - `editing` union gains `"path"`; after the `"new-branch"` block:

```tsx
      {editing === "path" && (
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span className="legit-subtle" style={{ fontSize: "var(--fz-sm)", flexShrink: 0 }}>
            Move to
          </span>
          <InlineRenameInput
            initialValue={info.path}
            placeholder="new path for the submodule"
            disabled={busy}
            onSave={(v) => {
              setEditing(null);
              const to = v.trim();
              if (to && to !== info.path) onMovePath(to);
            }}
            onCancel={() => setEditing(null)}
            style={{ fontSize: "var(--fz-sm)", flex: 1 }}
            title="git mv: moves the working tree, updates .gitmodules, and stages the move"
          />
        </div>
      )}
```

New prop `onMovePath: (to: string) => void;` (doc: `/** Move the submodule to a new path (git mv; stages the result). */`), and a "Move" `ToolbarButton` next to "Set URL" (populated branch only):

```tsx
              <ToolbarButton
                label="Move"
                title="Move the submodule to another path in place (git mv; stages the move)"
                disabled={busy}
                onClick={() => setEditing(editing === "path" ? null : "path")}
              />
```

- [ ] **Step 4: Section handler** - import `repoSubmoduleMove`; on the row:

```tsx
              onMovePath={(to) =>
                run(async () => {
                  await repoSubmoduleMove(repo.id, s.path, to);
                  notify.success(`Moved '${s.path}' to '${to}' (staged)`);
                })
              }
```

- [ ] **Step 5:** `cargo check --workspace`, `npx tsc --noEmit`, vitest via PowerShell - all clean/pass.

---

### Task 4: Final verification

- [ ] `cargo test -p legit-core && cargo check --workspace`
- [ ] `npx tsc --noEmit` + `powershell.exe -Command "cd C:\NOT_WORK\LeGit; npm test -- --run"`
- [ ] Flip the spec status to implemented; report (no commits).
