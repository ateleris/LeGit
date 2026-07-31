# File History from the Browsed Rev Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Do NOT use subagent-driven-development (user rule). Do NOT commit at any point (user rule): leave all changes staged/unstaged for the user's review.

**Goal:** "File history" opened from the Files panel's browse-at-commit mode walks the log from the browsed rev instead of HEAD, so files not in HEAD's ancestry get a history and the history matches the tree being viewed.

**Architecture:** Thread an optional `start_rev` through the existing file-history vertical slice (GitBackend trait -> cli_impl -> Tauri command -> `repoFileHistory` wrapper -> File History panel), and make the Files panel send `{ path, rev }` in rev mode. No new files; four call-site groups.

**Tech Stack:** Rust (legit-core, src-tauri), TypeScript/React (panels), React Query.

**Spec:** `docs/superpowers/specs/2026-07-31-file-history-from-browsed-rev-design.md`

## Global Constraints

- Never commit or push - leave changes for the user to review (overrides the step templates of any skill).
- No em-dashes in any output or code comment; use "-" or restructure.
- No literal colors and no fixed-px sizing in UI code: theme tokens (`var(--token)`) and `--fz-*` / em sizing only. The new header note reuses existing classes/tokens, adding none.
- Rust verification from WSL: `cargo test -p legit-core`, `cargo check -p legit-app`. Frontend: `npx tsc --noEmit` from WSL. Do not run `npm install` from WSL.
- `src/lib/bindings.ts` is regenerated when the app runs, not at build: do NOT hand-edit it. The hand-written wrapper in `src/lib/commands.ts` is what the frontend calls.

---

### Task 1: `start_rev` through legit-core

**Files:**
- Modify: `crates/legit-core/src/backend.rs:66-72` (trait `file_history`)
- Modify: `crates/legit-core/src/cli_impl/mod.rs:1642-1672` (impl)
- Test: `crates/legit-core/src/cli_impl/flow_tests.rs` (~line 1370 block, existing call at :1392)
- Test: `crates/legit-core/tests/git_flows.rs` (existing calls at :1442 and :1470)

**Interfaces:**
- Produces: `async fn file_history(&self, path: &Path, max_count: u32, skip: u32, start_rev: Option<&str>) -> Result<Vec<FileHistoryEntry>, GitError>` - `start_rev` is inserted into the git argument vector immediately before `--`; `None` keeps the exact argument vector git receives today (HEAD walk).

- [ ] **Step 1: Write the failing flow test (exact argument vector with a start rev)**

In `crates/legit-core/src/cli_impl/flow_tests.rs`, after `file_history_runs_follow_name_status_with_paging` (ends ~line 1397), add:

```rust
#[tokio::test]
async fn file_history_with_start_rev_walks_from_that_rev() {
    let fake = FakeExecutor::default();
    fake.expect(
        &[
            "log",
            "--follow",
            "-M",
            "--name-status",
            "--format=%x1e%H%n%an%n%at%n%s",
            "--max-count=200",
            "--skip=0",
            "abc123",
            "--",
            "src/a.rs",
        ],
        ok("\x1eaaa\nAlice\n1783288808\nmodify\n\nM\tsrc/a.rs\n"),
    );
    let (b, exec) = backend(fake);

    let entries = b
        .file_history(Path::new("src/a.rs"), 200, 0, Some("abc123"))
        .await
        .unwrap();
    assert_eq!(entries.len(), 1);
    exec.assert_done();
}
```

Also update the existing call in `file_history_runs_follow_name_status_with_paging` (line 1392) to the new arity:

```rust
    let entries = b.file_history(Path::new("src/a.rs"), 200, 0, None).await.unwrap();
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p legit-core file_history_with_start_rev 2>&1 | tail -20`
Expected: COMPILE ERROR - the trait method takes 3 arguments, not 4.

- [ ] **Step 3: Implement the trait + impl change**

In `crates/legit-core/src/backend.rs`, extend the method and its doc comment (lines 62-72):

```rust
    /// A single file's commit history, newest first, following renames
    /// (`git log --follow --name-status`). Each entry carries the file's path
    /// AS OF THAT COMMIT, so pre-rename commits address the old name. `skip`
    /// and `max_count` page the walk. `start_rev` starts the walk at that
    /// revision instead of HEAD (browse-at-commit mode): only commits
    /// reachable from it appear, matching the tree being browsed.
    async fn file_history(
        &self,
        path: &Path,
        max_count: u32,
        skip: u32,
        start_rev: Option<&str>,
    ) -> Result<Vec<FileHistoryEntry>, GitError>;
```

In `crates/legit-core/src/cli_impl/mod.rs`, update the impl signature the same way and insert the rev right before the `--` separator (current body at lines 1655-1661):

```rust
        let mut args = vec!["log"];
        args.extend(parsers::file_history::FILE_HISTORY_FLAGS);
        args.push(&fmt_arg);
        args.push(&max_arg);
        args.push(&skip_arg);
        // Walk from an explicit rev (browse-at-commit mode) instead of HEAD.
        if let Some(rev) = start_rev {
            args.push(rev);
        }
        args.push("--");
        args.push(&path_str);
```

- [ ] **Step 4: Fix the two existing real-git call sites to the new arity**

In `crates/legit-core/tests/git_flows.rs`, the calls at lines 1442 and 1470 gain a trailing `None`:

```rust
        .file_history(std::path::Path::new("b.txt"), 200, 0, None)
```

- [ ] **Step 5: Run the flow tests to verify they pass**

Run: `cargo test -p legit-core file_history 2>&1 | tail -20`
Expected: PASS (both flow tests; the git_flows tests also compile and pass).

- [ ] **Step 6: Add the real-git cases (the bug repro and the semantics pins)**

In `crates/legit-core/tests/git_flows.rs`, after `file_history_follows_renames_and_reports_the_path_at_each_commit` (ends ~line 1475), add three tests:

```rust
/// The bug this feature fixes: a file that only exists on a side branch has
/// NO history from HEAD (the panel showed empty while the user was browsing
/// that branch's tree). Walking from the browsed rev finds it.
#[tokio::test]
async fn file_history_from_a_rev_outside_head_ancestry_finds_the_file() {
    let repo = TestRepo::init().await;
    repo.write("base.txt", "base\n");
    repo.commit_all("base").await;
    repo.git(&["switch", "-c", "side"]).await;
    repo.write("only-on-side.txt", "v1\n");
    repo.commit_all("add side file").await;
    let side_tip = repo.head().await;
    repo.git(&["switch", "main"]).await;
    repo.write("base.txt", "base2\n");
    repo.commit_all("advance main").await;

    let from_head = repo
        .backend
        .file_history(std::path::Path::new("only-on-side.txt"), 200, 0, None)
        .await
        .unwrap();
    assert!(from_head.is_empty(), "pre-fix behavior: HEAD walk finds nothing");

    let from_rev = repo
        .backend
        .file_history(std::path::Path::new("only-on-side.txt"), 200, 0, Some(&side_tip))
        .await
        .unwrap();
    let subjects: Vec<&str> = from_rev.iter().map(|e| e.summary.as_str()).collect();
    assert_eq!(subjects, ["add side file"]);
}

/// Start-rev scoping: the walk excludes commits newer than the rev, so the
/// history matches the browsed tree. Also pins the verified-against-real-git
/// fact (2026-07-31) that a deleted file's HEAD walk is NOT empty - the
/// original backlog claim was imprecise, deletion alone never was the bug.
#[tokio::test]
async fn file_history_from_a_rev_excludes_later_commits() {
    let repo = TestRepo::init().await;
    repo.write("a.txt", "v1\n");
    repo.commit_all("add a").await;
    repo.write("a.txt", "v2\n");
    repo.commit_all("modify a").await;
    let pre_delete = repo.head().await;
    repo.git(&["rm", "a.txt"]).await;
    repo.commit_all("delete a").await;

    let from_head = repo
        .backend
        .file_history(std::path::Path::new("a.txt"), 200, 0, None)
        .await
        .unwrap();
    let head_subjects: Vec<&str> = from_head.iter().map(|e| e.summary.as_str()).collect();
    assert_eq!(head_subjects, ["delete a", "modify a", "add a"]);

    let from_rev = repo
        .backend
        .file_history(std::path::Path::new("a.txt"), 200, 0, Some(&pre_delete))
        .await
        .unwrap();
    let subjects: Vec<&str> = from_rev.iter().map(|e| e.summary.as_str()).collect();
    assert_eq!(subjects, ["modify a", "add a"]);
}

/// `--follow` keeps tracking renames when the walk starts at an explicit rev.
#[tokio::test]
async fn file_history_from_a_rev_still_follows_renames() {
    let repo = TestRepo::init().await;
    repo.write("a.txt", "v1\n");
    repo.commit_all("add a").await;
    repo.git(&["mv", "a.txt", "b.txt"]).await;
    repo.commit_all("rename a to b").await;
    repo.write("b.txt", "v2\n");
    repo.commit_all("modify b").await;
    let rev = repo.head().await;
    repo.write("b.txt", "v3\n");
    repo.commit_all("later change").await;

    let history = repo
        .backend
        .file_history(std::path::Path::new("b.txt"), 200, 0, Some(&rev))
        .await
        .unwrap();
    let subjects: Vec<&str> = history.iter().map(|e| e.summary.as_str()).collect();
    assert_eq!(subjects, ["modify b", "rename a to b", "add a"]);
    assert_eq!(history[2].path, "a.txt");
}
```

- [ ] **Step 7: Run the full legit-core suite**

Run: `cargo test -p legit-core 2>&1 | tail -15`
Expected: PASS, no failures anywhere in the crate.

---

### Task 2: Tauri command + frontend wrapper

**Files:**
- Modify: `src-tauri/src/commands/inspect.rs:116-133` (`repo_file_history`)
- Modify: `src/lib/commands.ts:539-546` (`repoFileHistory`)

**Interfaces:**
- Consumes: Task 1's `file_history(..., start_rev: Option<&str>)`.
- Produces: Tauri command `repo_file_history(repo_id, path, max_count, skip, start_rev: Option<String>)`; TS wrapper `repoFileHistory(repoId: string, path: string, maxCount: number, skip: number, startRev?: string)`.

- [ ] **Step 1: Extend the Tauri command**

In `src-tauri/src/commands/inspect.rs`, add the parameter and pass it through (`Option<String>` keeps the IPC field optional, `None` = HEAD walk):

```rust
/// A single file's commit history (newest first), following renames. `path`
/// is repo-relative; `max_count`/`skip` page the walk. `start_rev` walks
/// from that revision instead of HEAD (browse-at-commit mode).
#[tauri::command]
#[specta::specta]
pub async fn repo_file_history(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    path: PathBuf,
    max_count: u32,
    skip: u32,
    start_rev: Option<String>,
) -> Result<Vec<legit_core::FileHistoryEntry>, AppError> {
    let session = state.get_session(&repo_id).await?;
    session
        .backend
        .file_history(&path, max_count, skip, start_rev.as_deref())
        .await
        .map_err(AppError::Git)
}
```

- [ ] **Step 2: Verify the app crate compiles**

Run: `cargo check -p legit-app 2>&1 | tail -10`
Expected: no errors. (This also proves no other backend caller was missed - the compiler finds any stale 3-arg call.)

- [ ] **Step 3: Extend the hand-written wrapper**

In `src/lib/commands.ts`, add the optional parameter (existing wrappers pass `?? null` for optionals - follow that pattern):

```typescript
/** A single file's commit history (newest first), following renames.
 *  `startRev` walks from that revision instead of HEAD (browse-at-commit). */
export const repoFileHistory = (
  repoId: string,
  path: string,
  maxCount: number,
  skip: number,
  startRev?: string,
) =>
  invoke<FileHistoryEntry[]>("repo_file_history", {
    repoId,
    path,
    maxCount,
    skip,
    startRev: startRev ?? null,
  });
```

Do NOT touch `src/lib/bindings.ts` (regenerated when the app next runs in debug). No `src/lib/types.ts` change - `FileHistoryEntry` is unchanged.

- [ ] **Step 4: Type-check the frontend**

Run: `npx tsc --noEmit 2>&1 | tail -5`
Expected: clean (existing callers pass 4 args; the 5th is optional).

---

### Task 3: File History panel accepts and shows the rev

**Files:**
- Modify: `src/panels/FileHistory/FileHistoryPanel.tsx` (payload type :29-31, state :51-53, repo reset :57-62, `onReceive` :64-76, query :78-84, toolbar :142-157)

**Interfaces:**
- Consumes: Task 2's `repoFileHistory(..., startRev?)`.
- Produces: summon payload `FileHistoryRequest { path: string; rev?: string | null }` for panel id `"file-history"` (a bare string payload stays valid and means HEAD walk). Task 4 sends this shape.

- [ ] **Step 1: Extend the payload type and state**

```typescript
/** Summon payload for showing a file's history (a bare string = the path,
 *  walked from HEAD). `rev` walks from that revision instead - the Files
 *  panel's browse-at-commit mode sends it so the history matches the tree
 *  being browsed. */
export interface FileHistoryRequest {
  path: string;
  rev?: string | null;
}
```

In `FileHistoryBody`, next to the `path` state (line 51):

```typescript
  const [path, setPath] = useState<string | null>(null);
  // Non-null: walk from this rev instead of HEAD (browse-at-commit mode).
  const [rev, setRev] = useState<string | null>(null);
```

- [ ] **Step 2: Reset and receive the rev**

Repo-change reset effect (lines 57-62) additionally clears it:

```typescript
    setPath(null);
    setRev(null);
    setPageCount(1);
```

`onReceive` (lines 64-75) - a bare-string payload clears the rev, an object payload adopts it:

```typescript
  const onReceive = useCallback((payload: unknown) => {
    if (typeof payload === "string") {
      setPath(payload);
      setRev(null);
      setPageCount(1);
      return;
    }
    const p = payload as Partial<FileHistoryRequest> | null;
    if (p && typeof p.path === "string") {
      setPath(p.path);
      setRev(typeof p.rev === "string" ? p.rev : null);
      setPageCount(1);
    }
  }, []);
```

- [ ] **Step 3: Thread the rev through the query**

Lines 78-84 - the rev joins the key (a different rev is a different walk) and the call:

```typescript
  const { data: entries = [], isFetching, isError, error, refetch } = useQuery<FileHistoryEntry[]>({
    // Under the "log" domain: history changes exactly when the log/worktree do.
    queryKey: [repo?.id, "log", "file-history", path, rev, pageCount],
    queryFn: () => repoFileHistory(repo!.id, path!, PAGE_SIZE * pageCount, 0, rev ?? undefined),
    enabled: !!repo && !!path,
    staleTime: 5_000,
  });
```

- [ ] **Step 4: Show the walk's origin in the toolbar**

In the toolbar (after the path `<span>`, before the closing `</div>` at line 157), mirroring the Files panel's "at `abc12345`" note (`FilesPanel.tsx:239-247` - same classes, no new tokens, `--fz-*` sizing only):

```tsx
        {rev !== null && (
          <span
            className="legit-subtle"
            style={{ fontSize: "var(--fz-sm)", fontFamily: "monospace", flexShrink: 0 }}
            title={`History walked from ${rev} (browse-at-commit mode)`}
          >
            from {rev.slice(0, 8)}
          </span>
        )}
```

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit 2>&1 | tail -5`
Expected: clean.

---

### Task 4: Files panel sends the rev in browse-at-commit mode

**Files:**
- Modify: `src/panels/Files/FilesPanel.tsx` (payload helper :187-190, row-click :203, context menu :330)

**Interfaces:**
- Consumes: Task 3's `FileHistoryRequest` payload shape (`{ path, rev }`) - identical to the shape the Blame panel already accepts from `blamePayload`.

- [ ] **Step 1: Rename `blamePayload` to `revPayload`**

It now feeds Blame AND File History; the name should say what it builds, not who consumes it. Lines 187-190:

```typescript
  // Payload for the rev-following panels (Blame, File History): a bare path
  // in worktree mode, `{ path, rev }` in browse-at-commit mode so those
  // panels walk from the browsed rev.
  const revPayload = useCallback(
    (path: string) => (rev === null ? path : { path, rev }),
    [rev],
  );
```

Update its three references (lines 205, 209 dependency array, 331).

- [ ] **Step 2: Send it to the history panel from both entry points**

Row click (line 203):

```typescript
        useSummonStore.getState().notifyIfOpen("file-history", revPayload(file.path));
```

Context menu (line 330):

```typescript
                    onHistory={() => useSummonStore.getState().summon("file-history", revPayload(file.path))}
```

- [ ] **Step 3: Type-check and run the frontend suites**

Run: `npx tsc --noEmit 2>&1 | tail -5`
Expected: clean.

Run (WSL, PowerShell interop - do not hand this to the user): `powershell.exe -Command "cd C:\NOT_WORK\LeGit; npx vitest run 2>&1 | Select-Object -Last 15"`
Expected: all suites pass (theme contract and no-literal-colors suites in particular - the new toolbar note uses existing classes only).

---

### Task 5: Whole-slice verification and wrap-up

**Files:**
- Modify: `BACKLOG.md:149-153` (remove the shipped item)

- [ ] **Step 1: Run the full Rust and frontend verification**

Run: `cargo test -p legit-core 2>&1 | tail -5` then `cargo check -p legit-app 2>&1 | tail -5` then `npx tsc --noEmit 2>&1 | tail -5`
Expected: all clean.

- [ ] **Step 2: Remove the shipped backlog item**

In `BACKLOG.md`, delete the "Files panel rev mode: file history from the browsed rev" bullet (lines 149-153) - completed items are removed, git history keeps the record. Do not touch neighboring items.

- [ ] **Step 3: Manual smoke test (user, PowerShell)**

Ask the user to run the app from PowerShell and verify in `../LeGit-Test` (inspect its state first; do not reset it):
1. Files panel -> browse a commit (`at <sha>` chip visible), pick a file, "File history": the panel shows entries and a "from `<sha8>`" note; entries newer than the browsed rev are absent.
2. A file that exists only on a side branch/old tag: browse that rev, "File history" is non-empty (pre-fix it was empty).
3. Back to working tree, "File history" on any file: no "from" note, full history as before.

- [ ] **Step 4: Leave everything uncommitted**

Do NOT commit or push. Summarize the changed files for the user's review.
