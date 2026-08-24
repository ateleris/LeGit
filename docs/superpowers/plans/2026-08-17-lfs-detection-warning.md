# LFS Detection: Missing-git-lfs Warning + Files Panel LFS Icons - Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Do NOT use subagent-driven-development (user rule).

**Goal:** Detect that a repo uses Git LFS; warn via an app-chrome banner when git-lfs is missing or unregistered; mark LFS-tracked files with a distinct icon in the Files panel.

**Architecture:** Two new backend probes on the `GitBackend` trait (`lfs_status`, `lfs_tracked_subset`), exposed as two Tauri commands. A new `LfsWarningBanner` (sibling of `OpStateStrip`) driven by a pure `shouldShowLfsWarning` decision; session dismissals in a tiny zustand store, a persistent per-repo opt-out in `RepoSettings`. Files panel swaps in a `FileBox` icon for LFS-tracked paths via the existing `renderFileIcon` override.

**Tech Stack:** Rust (tokio, serde, specta), Tauri 2, React + TypeScript, @tanstack/react-query, zustand, vitest, lucide-react.

**Spec:** `docs/superpowers/specs/2026-08-17-lfs-detection-warning-design.md`

## Global Constraints

- **NEVER commit or push.** No git commit steps exist in this plan; leave all changes uncommitted for the user's review. Instruct any subagent the same.
- **No em-dashes** in any output, including code comments and docs; use a hyphen or colon.
- New theme tokens go in **4 places**: `src/theme/tokens.ts`, `src/theme/defaults.ts`, `src/styles/theme.css`, and BOTH `themes/Light.legit-theme.json` + `themes/Dark.legit-theme.json` (contract tests enforce this).
- No literal colours anywhere in UI code; only `var(--token)` (enforced by `src/theme/noLiteralColors.test.ts`).
- All dimensions scale with `--ui-font-size` / `em` / `--fz-*`; the plan's JSX mirrors `OpStateStrip.tsx`'s existing spacing.
- Rust tests run from WSL: `cargo test -p legit-core`. Vitest runs from WSL via PowerShell interop: `powershell.exe -NoProfile -Command "cd <repo>; npx vitest run <file>"`. Never `npm install` from WSL.
- Backend commands need BOTH the `#[tauri::command] #[specta::specta]` registration in `src-tauri/src/lib.rs` AND hand-written wrappers/types in `src/lib/commands.ts` / `src/lib/types.ts`.

---

### Task 1: `LfsStatus` type, trait methods, `lfs_status` implementation

**Files:**
- Modify: `crates/legit-core/src/types.rs` (append near `TrackingStatus`, ~line 842)
- Modify: `crates/legit-core/src/backend.rs` (add two methods near `superproject_path`, ~line 229)
- Modify: `crates/legit-core/src/cli_impl/mod.rs` (impl inside `impl<E: GitExecutor> GitBackend for GitCliBackend<E>`, near `superproject_path` ~line 1903)
- Test: `crates/legit-core/src/cli_impl/flow_tests.rs` (append tests at end)

**Interfaces:**
- Consumes: `self.runner().await` (`Arc<E: GitExecutor>`), `runner.run`, `runner.run_expecting`, `Self::ensure_success`, existing `FakeExecutor` helpers `ok(..)`, `fail(..)`, `backend(fake)`.
- Produces (later tasks rely on these exact names):
  - `pub struct LfsStatus { pub uses_lfs: bool, pub installed: bool, pub version: Option<String>, pub initialized: bool }` (exported via the existing `pub use types::*;` in `lib.rs`)
  - `async fn lfs_status(&self) -> Result<LfsStatus, GitError>` on `GitBackend`
  - `async fn lfs_tracked_subset(&self, paths: &[String]) -> Result<Vec<String>, GitError>` on `GitBackend` (declared here; implemented in Task 2)

- [ ] **Step 1: Add the type and both trait declarations** (they must exist for the tests to compile; `lfs_tracked_subset`'s body comes in Task 2, so give it a temporary `unimplemented!()`-free stub only if the compiler demands one - it will not: trait methods without an impl fail compilation, so implement BOTH signatures in this task, `lfs_tracked_subset` as `Ok(vec![])` marked with a `// Task 2 replaces this body.` comment).

In `crates/legit-core/src/types.rs`:

```rust
/// Repo LFS probe. `uses_lfs` comes from tracked `.gitattributes`
/// (`filter=lfs`); the binary/config probes run only when it is true
/// (false means installed/version/initialized report false/None unprobed).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct LfsStatus {
    /// Any tracked `.gitattributes` contains `filter=lfs`.
    pub uses_lfs: bool,
    /// `git lfs version` succeeded.
    pub installed: bool,
    /// First line of `git lfs version` stdout (e.g. `git-lfs/3.4.1 (...)`).
    pub version: Option<String>,
    /// `filter.lfs.smudge` is set in git config (repo context, so local
    /// config counts) - i.e. `git lfs install` has been run.
    pub initialized: bool,
}
```

In `crates/legit-core/src/backend.rs` (after `superproject_path`):

```rust
    /// Whether tracked `.gitattributes` declare LFS (`filter=lfs`), plus
    /// whether the `git-lfs` binary and its smudge-filter config are
    /// available. Missing binary / unset config are ANSWERS (status fields),
    /// never errors; probes are skipped when the repo does not use LFS.
    async fn lfs_status(&self) -> Result<LfsStatus, GitError>;

    /// The subset of `paths` whose effective `filter` attribute is `lfs`
    /// (`git check-attr -z --stdin filter`), in input order. Worktree
    /// attributes - callers must not apply the result to at-revision views.
    async fn lfs_tracked_subset(&self, paths: &[String]) -> Result<Vec<String>, GitError>;
```

`LfsStatus` reaches `backend.rs` through the existing `use crate::types::*;`-style import at the top of the file - check what form the file uses and match it.

- [ ] **Step 2: Write the failing flow tests** (append to `crates/legit-core/src/cli_impl/flow_tests.rs`; the file's `use super::*;` provides the backend, `ok`/`fail`/`backend` helpers are defined at its top):

```rust
#[tokio::test]
async fn lfs_status_short_circuits_when_repo_does_not_use_lfs() {
    let fake = FakeExecutor::default();
    // git grep exits 1 for "no hits" - an answer, not a failure.
    fake.expect(
        &["grep", "-l", "-e", "filter=lfs", "--", ":(glob)**/.gitattributes"],
        fail(1, ""),
    );
    let (backend, exec) = backend(fake);
    let status = backend.lfs_status().await.expect("lfs_status");
    assert!(!status.uses_lfs);
    assert!(!status.installed);
    assert_eq!(status.version, None);
    assert!(!status.initialized);
    // assert_done proves no `lfs version` / `config` probe ran.
    exec.assert_done();
}

#[tokio::test]
async fn lfs_status_probes_binary_and_config_when_lfs_used() {
    let fake = FakeExecutor::default();
    fake.expect(
        &["grep", "-l", "-e", "filter=lfs", "--", ":(glob)**/.gitattributes"],
        ok("assets/.gitattributes\n"),
    );
    fake.expect(
        &["lfs", "version"],
        ok("git-lfs/3.4.1 (GitHub; linux amd64; go 1.21.8)\n"),
    );
    fake.expect(
        &["config", "--get", "filter.lfs.smudge"],
        ok("git-lfs smudge -- %f\n"),
    );
    let (backend, exec) = backend(fake);
    let status = backend.lfs_status().await.expect("lfs_status");
    assert!(status.uses_lfs);
    assert!(status.installed);
    assert_eq!(
        status.version.as_deref(),
        Some("git-lfs/3.4.1 (GitHub; linux amd64; go 1.21.8)")
    );
    assert!(status.initialized);
    exec.assert_done();
}

#[tokio::test]
async fn lfs_status_reports_missing_binary_as_status_not_error() {
    let fake = FakeExecutor::default();
    fake.expect(
        &["grep", "-l", "-e", "filter=lfs", "--", ":(glob)**/.gitattributes"],
        ok(".gitattributes\n"),
    );
    // "git: 'lfs' is not a git command" - exit 1, and that IS the answer.
    fake.expect(
        &["lfs", "version"],
        fail(1, "git: 'lfs' is not a git command. See 'git --help'.\n"),
    );
    fake.expect(&["config", "--get", "filter.lfs.smudge"], fail(1, ""));
    let (backend, exec) = backend(fake);
    let status = backend.lfs_status().await.expect("must not error");
    assert!(status.uses_lfs);
    assert!(!status.installed);
    assert_eq!(status.version, None);
    assert!(!status.initialized);
    exec.assert_done();
}
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cargo test -p legit-core lfs_status`
Expected: compile error (methods missing) or test failures - either counts as the failing state.

- [ ] **Step 4: Implement `lfs_status` (and the Task-2 stub) in `cli_impl/mod.rs`**

Inside `impl<E: GitExecutor> GitBackend for GitCliBackend<E>`, next to `superproject_path`:

```rust
    async fn lfs_status(&self) -> Result<LfsStatus, GitError> {
        let runner = self.runner().await;
        // `:(glob)**/.gitattributes` matches the root file and nested ones
        // (a leading `**/` matches zero or more directories). git grep
        // searches tracked files, which is the right scope: `git lfs track`
        // always writes .gitattributes, and LFS rules are committed.
        // Exit 1 = "no hits" - an answer (run_expecting logs it as OK).
        let grep = runner
            .run_expecting(
                &["grep", "-l", "-e", "filter=lfs", "--", ":(glob)**/.gitattributes"],
                &[1],
            )
            .await?;
        let uses_lfs = match grep.exit_code {
            Some(0) => true,
            Some(1) => false,
            _ => {
                Self::ensure_success(&grep)?;
                false
            }
        };
        if !uses_lfs {
            return Ok(LfsStatus {
                uses_lfs: false,
                installed: false,
                version: None,
                initialized: false,
            });
        }
        // A missing git-lfs makes this exit non-zero ("git: 'lfs' is not a
        // git command") - that IS the probe result, never an error.
        let ver = runner.run(&["lfs", "version"]).await?;
        let installed = ver.success;
        let version = if installed {
            ver.stdout
                .lines()
                .next()
                .map(|l| l.trim().to_string())
                .filter(|l| !l.is_empty())
        } else {
            None
        };
        // Unset key exits 1 (expected). Set + non-empty = `git lfs install`
        // has registered the smudge filter for this repo's context.
        let cfg = runner
            .run_expecting(&["config", "--get", "filter.lfs.smudge"], &[1])
            .await?;
        let initialized = cfg.success && !cfg.stdout.trim().is_empty();
        Ok(LfsStatus { uses_lfs, installed, version, initialized })
    }

    async fn lfs_tracked_subset(&self, paths: &[String]) -> Result<Vec<String>, GitError> {
        // Task 2 replaces this body.
        let _ = paths;
        Ok(vec![])
    }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cargo test -p legit-core lfs_status`
Expected: 3 passed.

- [ ] **Step 6: Do NOT commit.** Leave changes for user review (global constraint).

---

### Task 2: check-attr `filter` parser + `lfs_tracked_subset`

**Files:**
- Modify: `crates/legit-core/src/cli_impl/mod.rs` (pure parser next to `parse_check_attr_z` ~line 3330; unit test in the tests module near `parse_check_attr_z_shapes` ~line 4305; replace the Task-1 stub body)
- Test: `crates/legit-core/src/cli_impl/flow_tests.rs`

**Interfaces:**
- Consumes: `runner.run_with_stdin`, `Self::ensure_success`, `HashSet` (`std::collections::HashSet` - add the import to `mod.rs` if not already present).
- Produces: `pub fn parse_check_attr_filter_lfs(stdout: &str) -> HashSet<String>`; the final `lfs_tracked_subset` behavior Task 4's command composes.

- [ ] **Step 1: Write the failing unit test** (in the existing `#[cfg(test)]` module of `cli_impl/mod.rs`, next to `parse_check_attr_z_shapes`):

```rust
    #[test]
    fn parse_check_attr_filter_lfs_shapes() {
        // path NUL attr NUL value NUL triples, exactly like check-attr -z.
        let stdout = "a.png\0filter\0lfs\0b.txt\0filter\0unspecified\0c.bin\0filter\0lfs\0";
        let set = parse_check_attr_filter_lfs(stdout);
        assert!(set.contains("a.png"));
        assert!(set.contains("c.bin"));
        assert!(!set.contains("b.txt"));
        assert_eq!(set.len(), 2);
        // Empty output (no paths sent / all unspecified) parses to empty.
        assert!(parse_check_attr_filter_lfs("").is_empty());
    }
```

- [ ] **Step 2: Write the failing flow test** (append to `flow_tests.rs`):

```rust
#[tokio::test]
async fn lfs_tracked_subset_filters_by_check_attr_and_keeps_input_order() {
    let fake = FakeExecutor::default();
    fake.expect(
        &["check-attr", "-z", "--stdin", "filter"],
        ok("a.png\0filter\0lfs\0b.txt\0filter\0unspecified\0z.bin\0filter\0lfs\0"),
    );
    let (backend, exec) = backend(fake);
    let subset = backend
        .lfs_tracked_subset(&["a.png".into(), "b.txt".into(), "z.bin".into()])
        .await
        .expect("subset");
    assert_eq!(subset, vec!["a.png".to_string(), "z.bin".to_string()]);
    exec.assert_done();
}

#[tokio::test]
async fn lfs_tracked_subset_skips_git_entirely_for_no_paths() {
    let (backend, exec) = backend(FakeExecutor::default());
    let subset = backend.lfs_tracked_subset(&[]).await.expect("subset");
    assert!(subset.is_empty());
    exec.assert_done();
}
```

- [ ] **Step 3: Run to verify failure**

Run: `cargo test -p legit-core lfs_tracked -- --nocapture` and `cargo test -p legit-core parse_check_attr_filter`
Expected: compile error (parser missing) or failures.

- [ ] **Step 4: Implement parser + real method body**

Parser (place directly under `parse_check_attr_z` so the check-attr contract lives in one place):

```rust
/// Parse `git check-attr -z --stdin filter` output (path NUL attr NUL value
/// NUL triples) into the set of paths whose `filter` attribute resolves to
/// `lfs`. Output shape validated against the real binary in git_flows.rs.
pub fn parse_check_attr_filter_lfs(stdout: &str) -> HashSet<String> {
    let mut set = HashSet::new();
    let mut it = stdout.split('\0');
    while let (Some(path), Some(attr), Some(value)) = (it.next(), it.next(), it.next()) {
        if path.is_empty() {
            break;
        }
        if attr == "filter" && value == "lfs" {
            set.insert(path.to_string());
        }
    }
    set
}
```

Replace the Task-1 stub:

```rust
    async fn lfs_tracked_subset(&self, paths: &[String]) -> Result<Vec<String>, GitError> {
        if paths.is_empty() {
            return Ok(vec![]);
        }
        let runner = self.runner().await;
        let stdin: String = paths.iter().map(|p| format!("{p}\0")).collect();
        let out = runner
            .run_with_stdin(&["check-attr", "-z", "--stdin", "filter"], &stdin)
            .await?;
        Self::ensure_success(&out)?;
        let lfs = parse_check_attr_filter_lfs(&out.stdout);
        Ok(paths.iter().filter(|p| lfs.contains(p.as_str())).cloned().collect())
    }
```

- [ ] **Step 5: Run to verify pass**

Run: `cargo test -p legit-core lfs` (runs Task 1 + 2 tests together)
Expected: all pass.

- [ ] **Step 6: Do NOT commit.**

---

### Task 3: Real-git pins in `git_flows.rs`

**Files:**
- Test: `crates/legit-core/tests/git_flows.rs` (append; `TestRepo` helper at the top of the file provides `init/write/commit_all`, `repo.path`, `repo.backend`)

**Interfaces:**
- Consumes: `GitBackend::lfs_status` / `lfs_tracked_subset` (Tasks 1-2). `LfsStatus` needs no new import: assertions only touch its fields via the backend call.

These pin the encoded assumptions against the real binary: git grep's exit-1-no-hits contract, `:(glob)**/.gitattributes` matching root AND nested files, and check-attr's output shape. They must pass whether or not git-lfs is installed on the machine: nothing asserts the machine-dependent value of `installed`.

- [ ] **Step 1: Write the tests**

```rust
#[tokio::test]
async fn lfs_status_detects_usage_from_root_and_nested_gitattributes() {
    let repo = TestRepo::init().await;
    repo.write("readme.md", "hi\n");
    repo.commit_all("init").await;

    // No .gitattributes anywhere: grep exits 1 ("no hits") - must classify
    // as "does not use LFS", not as an error.
    let status = repo.backend.lfs_status().await.expect("no-lfs repo");
    assert!(!status.uses_lfs);
    assert!(!status.installed);
    assert_eq!(status.version, None);
    assert!(!status.initialized);

    // Rules in a NESTED .gitattributes must be found (monorepo layout).
    std::fs::create_dir_all(repo.path.join("assets")).expect("mkdir assets");
    repo.write("assets/.gitattributes", "*.png filter=lfs diff=lfs merge=lfs -text\n");
    repo.commit_all("track pngs via lfs (nested)").await;
    let status = repo.backend.lfs_status().await.expect("nested lfs repo");
    assert!(status.uses_lfs);
    // installed/initialized are machine-dependent (git-lfs may be absent
    // here) - assert structure only: a missing binary must not report a
    // version, and the call itself must never error.
    if !status.installed {
        assert_eq!(status.version, None);
    }

    // Root .gitattributes works too.
    repo.write(".gitattributes", "*.bin filter=lfs diff=lfs merge=lfs -text\n");
    repo.commit_all("track bins via lfs (root)").await;
    assert!(repo.backend.lfs_status().await.expect("root lfs repo").uses_lfs);
}

#[tokio::test]
async fn lfs_tracked_subset_matches_check_attr_against_real_git() {
    let repo = TestRepo::init().await;
    repo.write(".gitattributes", "*.png filter=lfs diff=lfs merge=lfs -text\n");
    repo.write("logo.png", "not a real png\n");
    repo.write("notes.txt", "text\n");
    repo.commit_all("seed").await;

    let subset = repo
        .backend
        .lfs_tracked_subset(&["logo.png".to_string(), "notes.txt".to_string()])
        .await
        .expect("check-attr");
    assert_eq!(subset, vec!["logo.png".to_string()]);
}
```

- [ ] **Step 2: Run to verify they pass** (implementation exists; failure here means an encoded assumption is wrong - fix `cli_impl`, not the test)

Run: `cargo test -p legit-core --test git_flows lfs`
Expected: 2 passed. If the `:(glob)` pathspec assumption fails against real git, STOP and re-derive the grep invocation (this is exactly what this harness exists to catch), then update Task 1's format string AND flow tests to match.

- [ ] **Step 3: Do NOT commit.**

---

### Task 4: Tauri commands, registration, `RepoSettings` field

**Files:**
- Create: `src-tauri/src/commands/lfs.rs`
- Modify: `src-tauri/src/commands/mod.rs` (add `pub mod lfs;` between `pub mod inspect;` and `pub mod line_endings;`, and `pub use lfs::*;` in the matching spot of the re-export block)
- Modify: `src-tauri/src/lib.rs` (register both commands inside `collect_commands![...]`, e.g. directly after the `commands::repo_line_endings_view,` group)
- Modify: `src-tauri/src/state.rs` (append field to `RepoSettings`, ~line 463)

**Interfaces:**
- Consumes: `GitBackend::lfs_status` / `lfs_tracked_subset` / `list_repo_files`, `AppState::get_session`, `AppError::Git`, `legit_core::LfsStatus`.
- Produces (frontend tasks rely on these exact names):
  - Tauri command `repo_lfs_status(repo_id: String) -> LfsStatus`
  - Tauri command `repo_lfs_files(repo_id: String, show_ignored: bool) -> Vec<String>`
  - `RepoSettings.suppress_lfs_warning: Option<bool>`

Design note (deviation from the spec's first draft, recorded there too): `repo_lfs_files` takes `show_ignored` and lists the repo's files itself (`list_repo_files` + `lfs_tracked_subset`) instead of accepting a client-side `paths` array. This makes the frontend query self-contained: it can never race a stale paths snapshot from a previous listing render.

- [ ] **Step 1: Create `src-tauri/src/commands/lfs.rs`**

```rust
//! Repo LFS probes (spec: 2026-08-17-lfs-detection-warning-design.md):
//! does the repo declare LFS, is git-lfs usable, which files are
//! LFS-tracked.

use crate::error::AppError;
use crate::state::AppState;
use legit_core::LfsStatus;

/// LFS usage/availability for the repo. A missing binary or unset config is
/// an answer (status fields), never an error - only a broken repo errors.
#[tauri::command]
#[specta::specta]
pub async fn repo_lfs_status(
    state: tauri::State<'_, AppState>,
    repo_id: String,
) -> Result<LfsStatus, AppError> {
    let session = state.get_session(&repo_id).await?;
    session.backend.lfs_status().await.map_err(AppError::Git)
}

/// The LFS-tracked subset of the repo's file listing (worktree attributes).
/// Backs the Files panel's LFS icons; `show_ignored` mirrors the listing
/// the panel displays. Lists files server-side so the result can never race
/// a stale client-side paths snapshot.
#[tauri::command]
#[specta::specta]
pub async fn repo_lfs_files(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    show_ignored: bool,
) -> Result<Vec<String>, AppError> {
    let session = state.get_session(&repo_id).await?;
    let files = session
        .backend
        .list_repo_files(show_ignored)
        .await
        .map_err(AppError::Git)?;
    // Submodules/nested repos have no blob content - attributes don't apply.
    let paths: Vec<String> = files
        .iter()
        .filter(|f| !f.submodule)
        .map(|f| f.path.to_string_lossy().into_owned())
        .collect();
    session
        .backend
        .lfs_tracked_subset(&paths)
        .await
        .map_err(AppError::Git)
}
```

- [ ] **Step 2: Wire up `mod.rs` and `lib.rs`** as listed in Files above (two lines each).

- [ ] **Step 3: Add the settings field** in `src-tauri/src/state.rs`, after `auto_push_tags`:

```rust
    /// Suppress the "uses LFS but git-lfs unavailable" warning banner for
    /// this repo (None = warn, the default; set via the banner's
    /// "Don't warn for this repo" or the Repo Settings panel).
    #[serde(default)]
    pub suppress_lfs_warning: Option<bool>,
```

- [ ] **Step 4: Verify it compiles**

Run: `cargo check --workspace`
Expected: clean (warnings at worst). This is thin glue over Task 1-3-tested logic; no dedicated unit seam exists for it (matches every other command in `commands/`).

- [ ] **Step 5: Do NOT commit.**

---

### Task 5: Frontend types, command wrappers, pure warning logic

**Files:**
- Modify: `src/lib/types.ts` (add `LfsStatus`; extend `RepoSettings`)
- Modify: `src/lib/commands.ts` (two wrappers; add `LfsStatus` to the type import from `./types`)
- Create: `src/lib/lfsWarning.ts`
- Test: `src/lib/lfsWarning.test.ts`

**Interfaces:**
- Consumes: Task 4's command names and payload key casing (Tauri args are camelCase in `invoke`: `repoId`, `showIgnored`).
- Produces:
  - `interface LfsStatus { uses_lfs: boolean; installed: boolean; version: string | null; initialized: boolean }`
  - `RepoSettings.suppress_lfs_warning?: boolean | null`
  - `repoLfsStatus(repoId): Promise<LfsStatus>`, `repoLfsFiles(repoId, showIgnored): Promise<string[]>`
  - `lfsWarningKind(status): "not-installed" | "not-initialized" | null`
  - `shouldShowLfsWarning(status, sessionDismissed, suppressSetting): boolean`
  - `lfsWarningMessage(kind): string`

- [ ] **Step 1: Write the failing test** `src/lib/lfsWarning.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { lfsWarningKind, lfsWarningMessage, shouldShowLfsWarning } from "./lfsWarning";
import type { LfsStatus } from "./types";

const status = (over: Partial<LfsStatus>): LfsStatus => ({
  uses_lfs: true,
  installed: true,
  version: "git-lfs/3.4.1",
  initialized: true,
  ...over,
});

describe("lfsWarningKind", () => {
  it("is null while the query has no data yet", () => {
    expect(lfsWarningKind(undefined)).toBeNull();
  });
  it("is null for repos that do not use LFS, whatever the probes say", () => {
    expect(lfsWarningKind(status({ uses_lfs: false, installed: false, initialized: false }))).toBeNull();
  });
  it("reports a missing binary (even when config is also unset)", () => {
    expect(lfsWarningKind(status({ installed: false, version: null, initialized: false }))).toBe("not-installed");
  });
  it("reports installed-but-not-initialized", () => {
    expect(lfsWarningKind(status({ initialized: false }))).toBe("not-initialized");
  });
  it("is null when everything is available", () => {
    expect(lfsWarningKind(status({}))).toBeNull();
  });
});

describe("shouldShowLfsWarning", () => {
  const broken = status({ installed: false, version: null });
  it("shows for a broken setup with no dismissals", () => {
    expect(shouldShowLfsWarning(broken, false, null)).toBe(true);
  });
  it("shows when the setting is undefined (settings not loaded yet counts as warn)", () => {
    expect(shouldShowLfsWarning(broken, false, undefined)).toBe(true);
  });
  it("session dismissal wins", () => {
    expect(shouldShowLfsWarning(broken, true, null)).toBe(false);
  });
  it("per-repo opt-out wins", () => {
    expect(shouldShowLfsWarning(broken, false, true)).toBe(false);
  });
  it("an explicit false setting still warns (re-armed)", () => {
    expect(shouldShowLfsWarning(broken, false, false)).toBe(true);
  });
  it("never shows for a healthy repo", () => {
    expect(shouldShowLfsWarning(status({}), false, null)).toBe(false);
  });
});

describe("lfsWarningMessage", () => {
  it("has distinct non-empty messages per kind", () => {
    const a = lfsWarningMessage("not-installed");
    const b = lfsWarningMessage("not-initialized");
    expect(a.length).toBeGreaterThan(0);
    expect(b.length).toBeGreaterThan(0);
    expect(a).not.toBe(b);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `powershell.exe -NoProfile -Command "cd <repo>; npx vitest run src/lib/lfsWarning.test.ts"`
Expected: FAIL (module `./lfsWarning` not found).

- [ ] **Step 3: Implement**

`src/lib/types.ts` - add near the other backend-mirrored interfaces:

```ts
/** Repo LFS probe (mirror of legit-core's LfsStatus). `uses_lfs` comes from
 * tracked .gitattributes; binary/config probes are skipped (false/null)
 * when the repo does not use LFS. */
export interface LfsStatus {
  uses_lfs: boolean;
  installed: boolean;
  version: string | null;
  initialized: boolean;
}
```

`RepoSettings` in `src/lib/types.ts` - after `auto_push_tags`:

```ts
  /** Suppress the missing-git-lfs warning banner (null = warn). */
  suppress_lfs_warning?: boolean | null;
```

`src/lib/commands.ts` (add `LfsStatus` to the existing type import from `./types`):

```ts
export const repoLfsStatus = (repoId: string) =>
  invoke<LfsStatus>("repo_lfs_status", { repoId });

export const repoLfsFiles = (repoId: string, showIgnored: boolean) =>
  invoke<string[]>("repo_lfs_files", { repoId, showIgnored });
```

`src/lib/lfsWarning.ts`:

```ts
import type { LfsStatus } from "./types";

/** Why the missing-git-lfs banner applies - drives the message shown. */
export type LfsWarningKind = "not-installed" | "not-initialized";

/** The warning that applies to `status`, or null. Pure so the banner's
 * decision rule is unit-testable (see lfsWarning.test.ts). */
export function lfsWarningKind(status: LfsStatus | undefined): LfsWarningKind | null {
  if (!status || !status.uses_lfs) return null;
  if (!status.installed) return "not-installed";
  if (!status.initialized) return "not-initialized";
  return null;
}

/** Whether the banner should render, combining the probe result with the
 * session dismissal and the persisted per-repo opt-out (only an explicit
 * `true` suppresses - null/undefined mean "warn", the default). */
export function shouldShowLfsWarning(
  status: LfsStatus | undefined,
  sessionDismissed: boolean,
  suppressSetting: boolean | null | undefined,
): boolean {
  if (sessionDismissed || suppressSetting === true) return false;
  return lfsWarningKind(status) !== null;
}

export function lfsWarningMessage(kind: LfsWarningKind): string {
  return kind === "not-installed"
    ? "This repository uses Git LFS, but git-lfs is not installed. Files checked out without it are pointer stubs, and commits may store real content in place of pointers."
    : "This repository uses Git LFS, but git-lfs is not set up (git lfs install has not been run). Checkouts will leave pointer stubs instead of real content.";
}
```

- [ ] **Step 4: Run to verify pass**

Run: `powershell.exe -NoProfile -Command "cd <repo>; npx vitest run src/lib/lfsWarning.test.ts"`
Expected: PASS.

- [ ] **Step 5: Do NOT commit.**

---

### Task 6: Theme tokens (`banner.warning.bg` / `banner.warning.fg`)

**Files:**
- Modify: `src/theme/tokens.ts` (after `op.banner.fg`, ~line 119)
- Modify: `src/theme/defaults.ts` (after `"op.banner.fg"`, ~line 181)
- Modify: `src/styles/theme.css` (after `--op-banner-fg`, ~line 181)
- Modify: `themes/Dark.legit-theme.json` AND `themes/Light.legit-theme.json` (after `"op.banner.fg"`, ~line 147 in each)

**Interfaces:**
- Produces: CSS vars `--banner-warning-bg` / `--banner-warning-fg` (token dots become hyphens), consumed by Task 7's component. Generic names on purpose: reusable by future app-chrome warnings.

- [ ] **Step 1: Add the token descriptors** in `src/theme/tokens.ts`:

```ts
  { name: "banner.warning.bg", group: "App", documentation: "Background of app-chrome warning banners (e.g. the missing-git-lfs warning below the repo tabs)." },
  { name: "banner.warning.fg", group: "App", documentation: "Text of app-chrome warning banners, including their buttons' text and border." },
```

- [ ] **Step 2: Add the default bindings** in `src/theme/defaults.ts` (token -> palette-entry name; `warning` and `diff-hunk-header` both exist in the palette contract):

```ts
    "banner.warning.bg": "diff-hunk-header",
    "banner.warning.fg": "warning",
```

- [ ] **Step 3: Add the `:root` fallbacks** in `src/styles/theme.css` (must mirror the built-in Dark theme bindings):

```css
  --banner-warning-bg: var(--palette-diff-hunk-header);
  --banner-warning-fg: var(--palette-warning);
```

- [ ] **Step 4: Add the same two bindings to BOTH bundled themes** (`themes/Dark.legit-theme.json` and `themes/Light.legit-theme.json`, in their `tokens` maps):

```json
    "banner.warning.bg": "diff-hunk-header",
    "banner.warning.fg": "warning",
```

- [ ] **Step 5: Run the contract suite to verify completeness**

Run: `powershell.exe -NoProfile -Command "cd <repo>; npx vitest run src/theme/contract.test.ts"`
Expected: PASS (it fails if any of the 4 places is missing a token).

- [ ] **Step 6: Do NOT commit.**

---

### Task 7: Session-dismiss store, `LfsWarningBanner`, AppLayout mounts

**Files:**
- Create: `src/store/lfsWarning.ts`
- Create: `src/panels/LfsWarningBanner.tsx`
- Modify: `src/panels/AppLayout.tsx` (import + render after BOTH `<OpStateStrip />` mounts, ~lines 330 and 362)

**Interfaces:**
- Consumes: `repoLfsStatus`, `lfsWarningKind` / `lfsWarningMessage` / `shouldShowLfsWarning`, `useRepoStore` (`activeRepoId`, `repoSettings`, `updateRepoSetting`), `ToolbarButton` (`./shared/ToolbarButton`), tokens from Task 6.
- Produces: `useLfsWarningStore` (`dismissed: Record<string, true>`, `dismiss(repoId)`), `LfsWarningBanner` component. Query cache key `[repoId, "lfs"]` - Task 8/9 reuse it.

- [ ] **Step 1: Create `src/store/lfsWarning.ts`**

```ts
import { create } from "zustand";

/** Session-scoped dismissals of the missing-git-lfs banner. Deliberately
 * NOT persisted: while the condition holds, the warning returns on the next
 * app launch (the persistent opt-out lives in RepoSettings instead). */
interface LfsWarningState {
  dismissed: Record<string, true>;
  dismiss: (repoId: string) => void;
}

export const useLfsWarningStore = create<LfsWarningState>((set) => ({
  dismissed: {},
  dismiss: (repoId) =>
    set((s) => ({ dismissed: { ...s.dismissed, [repoId]: true } })),
}));
```

- [ ] **Step 2: Create `src/panels/LfsWarningBanner.tsx`**

```tsx
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRepoStore } from "../store/repos";
import { useLfsWarningStore } from "../store/lfsWarning";
import { repoLfsStatus } from "../lib/commands";
import type { LfsStatus } from "../lib/types";
import {
  lfsWarningKind,
  lfsWarningMessage,
  shouldShowLfsWarning,
} from "../lib/lfsWarning";
import { ToolbarButton } from "./shared/ToolbarButton";

// Ghost buttons sit on banner-warning-bg, not a panel surface, so their
// text and border follow the banner's own foreground token (same rationale
// as OpStateStrip's BANNER_BUTTON_STYLE).
const BANNER_BUTTON_STYLE: React.CSSProperties = {
  color: "var(--banner-warning-fg)",
  borderColor: "var(--banner-warning-fg)",
};

/**
 * App-chrome warning below the repo tabs: the active repo declares Git LFS
 * (`filter=lfs` in tracked .gitattributes) but git-lfs is missing or not
 * set up, so checkouts leave pointer stubs and commits can store real
 * content in place of pointers. X dismisses for the session; "Don't warn
 * for this repo" persists (re-arm in Repo Settings). Auto-hides once a
 * re-check finds the condition resolved. Renders nothing otherwise.
 */
export function LfsWarningBanner() {
  const activeRepoId = useRepoStore((s) => s.activeRepoId);
  const suppressSetting = useRepoStore((s) =>
    activeRepoId ? s.repoSettings[activeRepoId]?.suppress_lfs_warning : null,
  );
  const updateRepoSetting = useRepoStore((s) => s.updateRepoSetting);
  const sessionDismissed = useLfsWarningStore((s) =>
    activeRepoId ? !!s.dismissed[activeRepoId] : false,
  );
  const dismiss = useLfsWarningStore((s) => s.dismiss);
  const queryClient = useQueryClient();

  // Rare-change data (.gitattributes edits, LFS installs): long staleTime,
  // deliberately not watcher-invalidated - Re-check and repo activation
  // cover the gaps. Key shared with the Files panel's probe.
  const { data: status } = useQuery<LfsStatus>({
    queryKey: [activeRepoId, "lfs"],
    queryFn: () => repoLfsStatus(activeRepoId!),
    enabled: !!activeRepoId,
    staleTime: 300_000,
  });

  if (
    !activeRepoId ||
    !shouldShowLfsWarning(status, sessionDismissed, suppressSetting)
  ) {
    return null;
  }
  const kind = lfsWarningKind(status);
  if (!kind) return null;

  return (
    <div
      data-testid="lfs-warning-banner"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "4px 8px",
        background: "var(--banner-warning-bg)",
        color: "var(--banner-warning-fg)",
        fontSize: "var(--fz-sm)",
      }}
    >
      <span
        style={{
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          minWidth: 0,
        }}
      >
        {lfsWarningMessage(kind)}
      </span>
      <span style={{ display: "flex", gap: 4, marginLeft: "auto" }}>
        <ToolbarButton
          label="Re-check"
          title="Probe git-lfs again"
          onClick={() =>
            queryClient.invalidateQueries({ queryKey: [activeRepoId, "lfs"] })
          }
          style={BANNER_BUTTON_STYLE}
        />
        <ToolbarButton
          label="Don't warn for this repo"
          title="Never warn for this repository (re-arm in Repo Settings)"
          onClick={() =>
            void updateRepoSetting(activeRepoId, "suppress_lfs_warning", true)
          }
          style={BANNER_BUTTON_STYLE}
        />
        <ToolbarButton
          label="Dismiss"
          title="Hide until the next app launch"
          onClick={() => dismiss(activeRepoId)}
          style={BANNER_BUTTON_STYLE}
        />
      </span>
    </div>
  );
}
```

- [ ] **Step 3: Mount in `AppLayout.tsx`** - add the import next to `OpStateStrip`'s and render `<LfsWarningBanner />` immediately after `<OpStateStrip />` in BOTH layout modes (side mode ~line 330 and top mode ~line 362).

- [ ] **Step 4: Verify compile**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 5: Do NOT commit.**

---

### Task 8: Repo Settings re-arm section

**Files:**
- Modify: `src/panels/Settings/RepoSettingsPanel.tsx` (new section component after `AutoPushTagsRepoSection` ~line 463; render it after `<AutoPushTagsRepoSection ... />` ~line 118)

**Interfaces:**
- Consumes: existing in-file helpers/imports (`Section`, `FieldNote`, `useDelayedBusy`, `updateRepoSettings`, `useRepoStore`, `RepoSettings` type). No new imports needed.

- [ ] **Step 1: Add the section component**

```tsx
function LfsWarningRepoSection({
  repoId,
  repoSettings,
}: {
  repoId: string;
  repoSettings: RepoSettings | null;
}) {
  const loadRepoSettings = useRepoStore((s) => s.loadRepoSettings);
  const { busy: saving, run } = useDelayedBusy();
  const suppressed = repoSettings?.suppress_lfs_warning === true;

  // Stored as true (suppressed) or null (warn - the default); never false,
  // so old settings files and the banner's `=== true` check stay aligned.
  const setSuppressed = (value: boolean) => {
    if (!repoSettings) return;
    return run(async () => {
      await updateRepoSettings(repoId, {
        ...repoSettings,
        suppress_lfs_warning: value ? true : null,
      });
      await loadRepoSettings(repoId);
    });
  };

  return (
    <Section title="Git LFS">
      <FieldNote>writes to: repos/&lt;hash&gt;/settings.json (this repo only)</FieldNote>
      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          marginTop: 8,
          cursor: saving ? "default" : "pointer",
          opacity: saving ? 0.5 : 1,
        }}
      >
        <input
          type="checkbox"
          checked={!suppressed}
          disabled={saving}
          onChange={(e) => setSuppressed(!e.target.checked)}
        />
        <span style={{ fontSize: "var(--fz-lg)" }}>
          Warn when this repository uses Git LFS but git-lfs is unavailable
        </span>
      </label>
    </Section>
  );
}
```

- [ ] **Step 2: Render it** after `<AutoPushTagsRepoSection repoId={activeRepo.id} repoSettings={repoSettings} />`:

```tsx
          <LfsWarningRepoSection repoId={activeRepo.id} repoSettings={repoSettings} />
```

- [ ] **Step 3: Verify compile**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 4: Do NOT commit.**

---

### Task 9: Files panel LFS icons

**Files:**
- Modify: `src/panels/Files/FilesPanel.tsx` (imports; two queries after the `atRev` query ~line 101; `renderFileIcon` ~line 145)

**Interfaces:**
- Consumes: `repoLfsStatus` / `repoLfsFiles` wrappers, `LfsStatus` type, query key `[repo?.id, "lfs"]` (shared with the banner - one probe per repo), lucide `FileBox`.

- [ ] **Step 1: Extend imports** - add `FileBox` to the existing lucide import, `repoLfsFiles, repoLfsStatus` to the `../../lib/commands` import, and `LfsStatus` to the type import from `../../lib/types`.

- [ ] **Step 2: Add the queries** (after the `atRev` query):

```tsx
  // Shares [repoId, "lfs"] with LfsWarningBanner: one probe per repo.
  const lfsStatus = useQuery<LfsStatus>({
    queryKey: [repo?.id, "lfs"],
    queryFn: () => repoLfsStatus(repo!.id),
    enabled: !!repo,
    staleTime: 300_000,
  });
  const usesLfs = lfsStatus.data?.uses_lfs === true;

  // LFS-tracked paths for the icon override. Working-tree view only: the
  // subset comes from worktree attributes (check-attr has no --source
  // here), so applying it to browse-at-commit listings could mislabel.
  // Keyed under the "status" domain like the listing above, so watcher
  // invalidations refresh both together; the command lists files
  // server-side, so the subset never races a stale paths snapshot.
  // Non-LFS repos never fetch (enabled gate) - zero extra git calls.
  const lfsFiles = useQuery<string[]>({
    queryKey: [repo?.id, "status", "lfs-files", showIgnored],
    queryFn: () => repoLfsFiles(repo!.id, showIgnored),
    enabled: !!repo && rev === null && usesLfs,
    staleTime: 5_000,
  });
  const lfsPaths = useMemo(() => new Set(lfsFiles.data ?? []), [lfsFiles.data]);
```

- [ ] **Step 3: Extend `renderFileIcon`** - replace its body's icon/label selection with:

```tsx
      const kind = kindByPath.get(file.path);
      const meta = ICON_META[kind ?? "tracked"];
      // Submodules / nested repos get the fork glyph (same as the FileTree
      // status icons use for submodule changes); LFS-tracked files get the
      // box glyph (content stored outside the object db). The colour still
      // follows the kind so untracked nested repos keep the "new" tint.
      const isLfs = lfsPaths.has(file.path);
      const Icon = submodulePaths.has(file.path) ? GitFork : isLfs ? FileBox : meta.Icon;
      const label = submodulePaths.has(file.path)
        ? `${kind} submodule`
        : isLfs
          ? `${kind} (LFS)`
          : kind;
      return <Icon size={iconSize} color={meta.color} aria-label={label} />;
```

and update the `useCallback` dependency array to `[kindByPath, submodulePaths, lfsPaths, iconSize]`.

- [ ] **Step 4: Verify compile + full frontend suite**

Run: `npx tsc --noEmit`, then `powershell.exe -NoProfile -Command "cd <repo>; npm test"`
Expected: both clean (noLiteralColors + contract suites included).

- [ ] **Step 5: Do NOT commit.**

---

### Task 10: Full verification + doc sync

**Files:**
- Modify: `BACKLOG.md` (release blocker #4: mark the warning + icons halves done, keep the pointer-blob placeholder remainder)
- Modify: `docs/superpowers/specs/2026-08-17-lfs-detection-warning-design.md` (already records the `repo_lfs_files(show_ignored)` deviation; verify it matches what was built)

- [ ] **Step 1: Run everything**

- `cargo test -p legit-core` (unit + flow + real-git)
- `cargo check --workspace`
- `npx tsc --noEmit`
- `powershell.exe -NoProfile -Command "cd <repo>; npm test"`

Expected: all green. Report any failure verbatim; do not claim success without output.

- [ ] **Step 2: Update `BACKLOG.md`** - in release blocker #4, record: detection (`repo_lfs_status`), the warning banner (session dismiss + per-repo opt-out), and Files panel LFS icons are DONE; the open remainder is the pointer-blob placeholder in content views (File View / Blame / Diff-at-revision) and optional smudge-on-demand.

- [ ] **Step 3: Manual test instructions for the user** (LeGit runs only from PowerShell; a human must eyeball this): in `../LeGit-Test`, add `*.png filter=lfs diff=lfs merge=lfs -text` to a committed `.gitattributes`, open the repo in LeGit on a machine without git-lfs (or temporarily rename the binary): the warning banner should appear under the repo tabs; Re-check / session X / "Don't warn for this repo" + the Repo Settings re-arm checkbox should behave as specced; a committed `logo.png` should show the box icon in the Files panel. Do not leave `../LeGit-Test` in a mutated state without asking.

- [ ] **Step 4: Do NOT commit anything.** Leave the whole feature staged/unstaged for the user's review.
