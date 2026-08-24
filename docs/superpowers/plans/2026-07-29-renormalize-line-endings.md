# Renormalize Line Endings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans
> to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for
> tracking. Do NOT use subagent-driven-development (banned for this project).

**Goal:** Add the two missing actions to Repo Settings' "Line endings (this
repo)" section: write a covers-all `.gitattributes` rule and run
`git add --renormalize`, with a dry-run preview, leaving results staged.

**Architecture:** The renormalize flow (dry run, then real add) is a composed
flow behind `GitBackend` so `FakeExecutor` can assert the command sequence;
real-git assumptions are pinned in `tests/git_flows.rs`. The `.gitattributes`
writer and the preview's unstaged-changes count live in the command layer
(`src-tauri/src/commands/line_endings.rs`), following that file's existing
pattern. The UI is a new focused component wired into `LineEndingsRepoSection`.

**Tech Stack:** Rust (tokio, async-trait, serde, specta), Tauri 2 commands,
React + TypeScript.

Spec: `docs/superpowers/specs/2026-07-29-renormalize-line-endings-design.md`.

> **Executed 2026-07-29, with one design deviation** (spec updated to match):
> the real-git harness disproved two assumptions this plan was written on.
> `git add --renormalize -n` lists EVERY tracked file (useless as a preview),
> and `* text=auto` alone does not clear phantom CRLF modifications from
> status. The implemented preview simulates the renormalize on a throwaway
> index (`write-tree` / `read-tree` + `GIT_INDEX_FILE` / `diff-index`), the
> outcome comes from a `write-tree` + `diff-index` bracket around the real
> run, path parsing uses `--name-only -z` (no sq-unquoting), and the UI keeps
> the action enabled at zero content changes because a renormalize still
> clears phantom-modified entries. Task steps below reflect the ORIGINAL
> plan; the code and the spec are the source of truth.

## Global Constraints

- **NEVER commit or push.** All plan steps end at "tests pass"; the user
  commits manually. This overrides the usual TDD commit cadence.
- No em-dashes anywhere (prose, comments, generated files); use `-` or `:`.
- Frontend colours only via `var(--token)`; sizes via `--fz-*` / em; enforced
  by `src/theme/noLiteralColors.test.ts`.
- Busy indicators delayed ~150 ms with a `useRef` re-entry guard.
- Rust verification from WSL: `cargo test -p legit-core` and
  `cargo test -p legit-app`. Frontend: `npx tsc --noEmit`; vitest via
  `powershell.exe -Command "cd <repo>; npm test"`.
- Both git invocations pass `-c core.quotepath=false`.

---

### Task 1: Dry-run parser + outcome type (legit-core)

**Files:**
- Create: `crates/legit-core/src/cli_impl/parsers/renormalize.rs`
- Modify: `crates/legit-core/src/cli_impl/parsers/mod.rs` (add `pub mod renormalize;`)
- Modify: `crates/legit-core/src/types.rs` (add `RenormalizeOutcome`)
- Modify: `crates/legit-core/src/lib.rs` (re-export parser fn + args consts, mirroring how `parse_check_attr_z` is re-exported)

**Interfaces:**
- Produces: `parse_add_dry_run(text: &str) -> Vec<String>`,
  `RENORMALIZE_PREVIEW_ARGS: [&str; 7]`, `RENORMALIZE_ARGS: [&str; 6]`,
  `RenormalizeOutcome { restaged: Vec<String> }`.

- [ ] **Step 1: Write the failing tests** (in `renormalize.rs` `#[cfg(test)] mod tests`)

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_output_is_empty() {
        assert!(parse_add_dry_run("").is_empty());
    }

    #[test]
    fn parses_add_lines() {
        let text = "add 'a.txt'\nadd 'dir/b c.txt'\n";
        assert_eq!(parse_add_dry_run(text), vec!["a.txt", "dir/b c.txt"]);
    }

    #[test]
    fn unquotes_sq_escaped_single_quote() {
        // git sq-quotes `it's.txt` as `'it'\''s.txt'`.
        let text = "add 'it'\\''s.txt'\n";
        assert_eq!(parse_add_dry_run(text), vec!["it's.txt"]);
    }

    #[test]
    fn passes_non_ascii_through_raw() {
        // core.quotepath=false: no octal escaping.
        let text = "add 'u\u{308}ml ö.txt'\n";
        assert_eq!(parse_add_dry_run(text), vec!["u\u{308}ml ö.txt"]);
    }

    #[test]
    fn ignores_unrelated_lines() {
        let text = "warning: something\nadd 'a.txt'\n\n";
        assert_eq!(parse_add_dry_run(text), vec!["a.txt"]);
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p legit-core renormalize` - expected: compile error
(`parse_add_dry_run` not defined).

- [ ] **Step 3: Implement parser + args constants**

```rust
//! Parser for `git add --renormalize -n` (dry run) output - one
//! `add '<path>'` line per file that would be restaged.
//!
//! Both invocations pass `-c core.quotepath=false` so non-ASCII paths come
//! through raw instead of octal-escaped; paths containing single quotes are
//! still sq-quoted by git (`'it'\''s.txt'`) and unescaped here. The parsed
//! list is display/count-only: the real `add --renormalize` never consumes
//! it, so a hypothetical parse miss can never corrupt an operation.

/// Dry run: list files `--renormalize` would restage, without touching the
/// index. `--renormalize` implies `-u` (tracked files only).
pub const RENORMALIZE_PREVIEW_ARGS: [&str; 7] =
    ["-c", "core.quotepath=false", "add", "--renormalize", "-n", "--", "."];

/// The real thing: re-run the clean filter over all tracked files and
/// restage them (also stages pending unstaged modifications/deletions).
pub const RENORMALIZE_ARGS: [&str; 6] =
    ["-c", "core.quotepath=false", "add", "--renormalize", "--", "."];

/// Parse `git add -n` output into the listed paths.
pub fn parse_add_dry_run(text: &str) -> Vec<String> {
    text.lines()
        .filter_map(|line| {
            let rest = line.strip_prefix("add '")?;
            let inner = rest.strip_suffix('\'')?;
            Some(inner.replace("'\\''", "'"))
        })
        .collect()
}
```

And in `types.rs` (next to the other outcome types, same derive set as
`FileStatus`):

```rust
/// Result of `git add --renormalize`: the files git restaged through the
/// clean filter (captured via the dry run immediately beforehand). Empty
/// means the repo was already normalized: an outcome, not an error.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct RenormalizeOutcome {
    pub restaged: Vec<String>,
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cargo test -p legit-core renormalize` - expected: 5 passed.

### Task 2: Backend flow + FakeExecutor tests

**Files:**
- Modify: `crates/legit-core/src/backend.rs` (trait methods, near `stage`)
- Modify: `crates/legit-core/src/cli_impl/mod.rs` (impls, near the `stage` impl at ~1412)
- Modify: `crates/legit-core/src/cli_impl/flow_tests.rs`

**Interfaces:**
- Consumes: Task 1's consts/parser/type.
- Produces: `GitBackend::renormalize_preview(&self) -> Result<Vec<String>, GitError>`,
  `GitBackend::renormalize(&self) -> Result<RenormalizeOutcome, GitError>`.

- [ ] **Step 1: Write the failing flow tests**

```rust
#[tokio::test]
async fn renormalize_preview_runs_only_the_dry_run() {
    let fake = FakeExecutor::default();
    fake.expect(
        &["-c", "core.quotepath=false", "add", "--renormalize", "-n", "--", "."],
        ok("add 'a.txt'\nadd 'b c.txt'\n"),
    );
    let (backend, fake) = backend(fake);
    let files = backend.renormalize_preview().await.unwrap();
    assert_eq!(files, vec!["a.txt".to_string(), "b c.txt".to_string()]);
    fake.assert_done();
}

#[tokio::test]
async fn renormalize_runs_dry_run_then_add_and_nothing_else() {
    let fake = FakeExecutor::default();
    fake.expect(
        &["-c", "core.quotepath=false", "add", "--renormalize", "-n", "--", "."],
        ok("add 'a.txt'\n"),
    );
    fake.expect(
        &["-c", "core.quotepath=false", "add", "--renormalize", "--", "."],
        ok(""),
    );
    let (backend, fake) = backend(fake);
    let outcome = backend.renormalize().await.unwrap();
    assert_eq!(outcome.restaged, vec!["a.txt".to_string()]);
    fake.assert_done();
}

#[tokio::test]
async fn renormalize_add_failure_propagates_as_error() {
    let fake = FakeExecutor::default();
    fake.expect(
        &["-c", "core.quotepath=false", "add", "--renormalize", "-n", "--", "."],
        ok("add 'a.txt'\n"),
    );
    fake.expect(
        &["-c", "core.quotepath=false", "add", "--renormalize", "--", "."],
        fail(128, "fatal: unable to write index"),
    );
    let (backend, fake) = backend(fake);
    assert!(backend.renormalize().await.is_err());
    fake.assert_done();
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p legit-core flow_tests::renormalize` - expected: compile
error (methods not on trait).

- [ ] **Step 3: Implement trait + impls**

`backend.rs` (imports already include the types module; add
`RenormalizeOutcome`):

```rust
    /// List the tracked files `git add --renormalize` would restage (dry
    /// run). Display/count-only: `renormalize` re-runs its own dry run.
    async fn renormalize_preview(&self) -> Result<Vec<String>, GitError>;

    /// Re-run the clean filter over all tracked files
    /// (`git add --renormalize -- .`) and report which files were restaged.
    /// `--renormalize` implies `-u`, so pending unstaged modifications and
    /// deletions of tracked files are staged too - callers must warn first.
    async fn renormalize(&self) -> Result<RenormalizeOutcome, GitError>;
```

`cli_impl/mod.rs`:

```rust
    async fn renormalize_preview(&self) -> Result<Vec<String>, GitError> {
        let runner = self.runner().await;
        let out = runner.run(&parsers::renormalize::RENORMALIZE_PREVIEW_ARGS).await?;
        Self::ensure_success(&out)?;
        Ok(parsers::renormalize::parse_add_dry_run(&out.stdout))
    }

    async fn renormalize(&self) -> Result<RenormalizeOutcome, GitError> {
        let restaged = self.renormalize_preview().await?;
        let runner = self.runner().await;
        let out = runner.run(&parsers::renormalize::RENORMALIZE_ARGS).await?;
        Self::ensure_success(&out)?;
        Ok(RenormalizeOutcome { restaged })
    }
```

- [ ] **Step 4: Run to verify pass**

Run: `cargo test -p legit-core flow_tests::renormalize` - expected: 3 passed.

### Task 3: Real-git validation (`tests/git_flows.rs`)

**Files:**
- Modify: `crates/legit-core/tests/git_flows.rs` (add `RenormalizeOutcome` if
  needed to the big import; add tests at the end)

**Interfaces:**
- Consumes: `TestRepo::init/write/read/commit_all/git`, Task 2's methods.

- [ ] **Step 1: Write the tests** (they run against real git; "failing first"
  here means: write them, watch them fail to compile until Task 2 exists -
  Task 2 is done, so they should pass immediately if our git assumptions are
  right. If any FAILS, the assumption is wrong: fix the implementation, not
  the test.)

```rust
// --- renormalize -----------------------------------------------------------

#[tokio::test]
async fn renormalize_restages_crlf_blobs_as_lf() {
    let repo = TestRepo::init().await;
    repo.write("a.txt", "one\r\ntwo\r\n");
    repo.commit_all("crlf").await;
    repo.write(".gitattributes", "* text=auto\n");

    let preview = repo.backend.renormalize_preview().await.unwrap();
    assert_eq!(preview, vec!["a.txt".to_string()]);

    let outcome = repo.backend.renormalize().await.unwrap();
    assert_eq!(outcome.restaged, vec!["a.txt".to_string()]);

    let eol = repo.git(&["ls-files", "--eol", "a.txt"]).await;
    assert!(eol.contains("i/lf"), "index should be LF after renormalize: {eol}");
    // Working tree bytes untouched.
    assert_eq!(repo.read("a.txt"), "one\r\ntwo\r\n");
}

#[tokio::test]
async fn renormalize_on_normalized_repo_stages_nothing() {
    let repo = TestRepo::init().await;
    repo.write(".gitattributes", "* text=auto\n");
    repo.write("a.txt", "one\n");
    repo.commit_all("lf").await;

    assert!(repo.backend.renormalize_preview().await.unwrap().is_empty());
    let outcome = repo.backend.renormalize().await.unwrap();
    assert!(outcome.restaged.is_empty());
    let staged = repo.git(&["diff", "--cached", "--name-only"]).await;
    assert_eq!(staged.trim(), "");
}

#[tokio::test]
async fn covers_all_attributes_clear_phantom_modifications_without_touching_disk() {
    let repo = TestRepo::init().await;
    repo.write("a.txt", "one\ntwo\n");
    repo.commit_all("lf").await;
    // An editor re-saves the file with CRLF: with no attributes and
    // autocrlf=false this is a phantom "modified".
    repo.write("a.txt", "one\r\ntwo\r\n");
    let dirty = repo.backend.status().await.unwrap();
    assert!(dirty.iter().any(|s| s.path == Path::new("a.txt")));

    repo.write(".gitattributes", "* text=auto\n");
    let clean = repo.backend.status().await.unwrap();
    assert!(
        !clean.iter().any(|s| s.path == Path::new("a.txt")),
        "text=auto should make the CRLF-only change invisible to status"
    );
    assert_eq!(repo.read("a.txt"), "one\r\ntwo\r\n", "disk bytes must be untouched");
}

#[tokio::test]
async fn renormalize_preview_reports_non_ascii_paths_raw() {
    let repo = TestRepo::init().await;
    repo.write("ümlaut ö.txt", "x\r\n");
    repo.commit_all("crlf").await;
    repo.write(".gitattributes", "* text=auto\n");
    let files = repo.backend.renormalize_preview().await.unwrap();
    assert_eq!(files, vec!["ümlaut ö.txt".to_string()]);
}
```

- [ ] **Step 2: Run and confirm the assumptions hold**

Run: `cargo test -p legit-core --test git_flows renormalize` and
`cargo test -p legit-core --test git_flows covers_all` - expected: 4 passed.

### Task 4: Tauri commands + `.gitattributes` writer

**Files:**
- Modify: `src-tauri/src/commands/line_endings.rs`
- Modify: `src-tauri/src/lib.rs` (register 3 commands in `collect_commands!`
  next to `repo_line_endings_view` at ~line 67)

**Interfaces:**
- Consumes: `session.backend.renormalize_preview()/renormalize()`,
  `build_repo_view`, `parse_attr_line`, `FileStatus { staged, state }`.
- Produces (IPC): `repo_renormalize_preview(repo_id) -> RenormalizePreview`,
  `repo_renormalize(repo_id) -> RenormalizeOutcome`,
  `repo_write_gitattributes_eol(repo_id, eol: Option<String>) -> LineEndingsView`.

- [ ] **Step 1: Write failing unit tests for the pure writer** (in
  `line_endings.rs` `#[cfg(test)] mod tests`, same pattern as `ssh_keys.rs`)

```rust
#[cfg(test)]
mod tests {
    use super::insert_covers_all_rule;

    #[test]
    fn creates_new_file_with_rule() {
        assert_eq!(insert_covers_all_rule(None, Some("lf")).unwrap(), "* text=auto eol=lf\n");
        assert_eq!(insert_covers_all_rule(None, None).unwrap(), "* text=auto\n");
    }

    #[test]
    fn inserts_before_first_rule_keeping_leading_comments() {
        let existing = "# EOL policy\n\n*.bat eol=crlf\n*.png binary\n";
        let got = insert_covers_all_rule(Some(existing), Some("lf")).unwrap();
        assert_eq!(got, "# EOL policy\n\n* text=auto eol=lf\n*.bat eol=crlf\n*.png binary\n");
    }

    #[test]
    fn comment_only_file_appends_after_comments() {
        let got = insert_covers_all_rule(Some("# notes\n"), None).unwrap();
        assert_eq!(got, "# notes\n* text=auto\n");
    }

    #[test]
    fn refuses_existing_covers_all_rule() {
        assert!(insert_covers_all_rule(Some("* text=auto\n"), Some("lf")).is_err());
        // Also `-text` and plain `text` forms.
        assert!(insert_covers_all_rule(Some("* text\n"), None).is_err());
    }

    #[test]
    fn refuses_invalid_eol_value() {
        assert!(insert_covers_all_rule(None, Some("cr")).is_err());
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p legit-app insert_covers_all` - expected: compile error.

- [ ] **Step 3: Implement writer + commands**

```rust
/// Build new `.gitattributes` content with a covers-all
/// `* text=auto [eol=...]` rule inserted at the TOP (after any leading
/// comment/blank block): last matching rule wins in gitattributes, so
/// appending would silently override every specific rule below it.
/// Errors are plain strings for `AppError::Io`.
fn insert_covers_all_rule(existing: Option<&str>, eol: Option<&str>) -> Result<String, String> {
    if let Some(v) = eol {
        if v != "lf" && v != "crlf" {
            return Err(format!("invalid eol value: {v}"));
        }
    }
    let rule = match eol {
        Some(v) => format!("* text=auto eol={v}"),
        None => "* text=auto".to_string(),
    };
    let Some(existing) = existing else {
        return Ok(format!("{rule}\n"));
    };
    for line in existing.lines() {
        let t = line.trim();
        if t.is_empty() || t.starts_with('#') {
            continue;
        }
        if let Some(r) = parse_attr_line(t) {
            if r.pattern == "*" && r.text.is_some() {
                return Err("a covers-all `*` text rule already exists in .gitattributes".into());
            }
        }
    }
    let lines: Vec<&str> = existing.lines().collect();
    let insert_at = lines
        .iter()
        .position(|l| {
            let t = l.trim();
            !t.is_empty() && !t.starts_with('#')
        })
        .unwrap_or(lines.len());
    let mut out: Vec<String> = Vec::with_capacity(lines.len() + 1);
    out.extend(lines[..insert_at].iter().map(|s| s.to_string()));
    out.push(rule);
    out.extend(lines[insert_at..].iter().map(|s| s.to_string()));
    Ok(out.join("\n") + "\n")
}
```

Types + commands (imports: add `RenormalizeOutcome` to the
`legit_core::types` import):

```rust
/// Preview for the Normalize block: what renormalize would do, plus how
/// many tracked files carry unstaged changes (restaging stages those too).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct RenormalizePreview {
    pub files: Vec<String>,
    pub unstaged_changes: u32,
}

/// Dry-run preview of `git add --renormalize` for the Normalize block.
#[tauri::command]
#[specta::specta]
pub async fn repo_renormalize_preview(
    state: tauri::State<'_, AppState>,
    repo_id: String,
) -> Result<RenormalizePreview, AppError> {
    let session = state.get_session(&repo_id).await?;
    let files = session.backend.renormalize_preview().await.map_err(AppError::Git)?;
    let statuses = session.backend.status().await.map_err(AppError::Git)?;
    let unstaged_changes = statuses
        .iter()
        .filter(|s| !s.staged && matches!(s.state, FileState::Modified | FileState::Deleted))
        .count() as u32;
    Ok(RenormalizePreview { files, unstaged_changes })
}

/// Run `git add --renormalize -- .`: restages tracked files through the
/// clean filter. The result is left staged for review, never committed.
#[tauri::command]
#[specta::specta]
pub async fn repo_renormalize(
    state: tauri::State<'_, AppState>,
    repo_id: String,
) -> Result<RenormalizeOutcome, AppError> {
    let session = state.get_session(&repo_id).await?;
    session.backend.renormalize().await.map_err(AppError::Git)
}

/// Insert a covers-all `* text=auto [eol=...]` rule into `.gitattributes`
/// (created if missing; rule goes at the top so existing specific rules
/// keep winning). Returns the refreshed view, like `repo_write_line_endings`.
#[tauri::command]
#[specta::specta]
pub async fn repo_write_gitattributes_eol(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    eol: Option<String>,
) -> Result<LineEndingsView, AppError> {
    let session = state.get_session(&repo_id).await?;
    let path = session.path.join(".gitattributes");
    let existing = tokio::fs::read_to_string(&path).await.ok();
    let updated = insert_covers_all_rule(existing.as_deref(), eol.as_deref())
        .map_err(AppError::Io)?;
    tokio::fs::write(&path, updated)
        .await
        .map_err(|e| AppError::Io(e.to_string()))?;
    let runner = session.runner.read().await.clone();
    Ok(build_repo_view(&session.path, &runner).await)
}
```

Register in `src-tauri/src/lib.rs` `collect_commands!` next to the other
line-endings commands:

```rust
        commands::repo_renormalize_preview,
        commands::repo_renormalize,
        commands::repo_write_gitattributes_eol,
```

(Ensure `commands/mod.rs` re-exports them; it re-exports the module's pub
items already if it uses `pub use line_endings::*;` - verify and match.)

- [ ] **Step 4: Run to verify pass**

Run: `cargo test -p legit-app insert_covers_all` (5 passed) and
`cargo check -p legit-app` (commands compile + registered).

### Task 5: Frontend wrappers, Normalize block, integration

**Files:**
- Modify: `src/lib/types.ts` (mirror `RenormalizeOutcome`, `RenormalizePreview`)
- Modify: `src/lib/commands.ts` (3 wrappers next to `repoLineEndingsView`)
- Create: `src/panels/Settings/NormalizeLineEndingsBlock.tsx`
- Modify: `src/panels/Settings/RepoSettingsPanel.tsx` (render the block at the
  end of `LineEndingsRepoSection`, pass `view` + `setView`)

**Interfaces:**
- Consumes: Task 4's IPC commands; `useConfirmDestructive` (`store/settings.ts:90`),
  `invalidateRepoDomains(qc, repoId, ["status"])` (`lib/repoInvalidation`),
  `formatAppError`, `LineEndingsView`.

- [ ] **Step 1: types + wrappers**

`types.ts` (near `LineEndingsView`):

```ts
/** Result of `git add --renormalize` (matches legit-core `RenormalizeOutcome`). */
export interface RenormalizeOutcome {
  restaged: string[];
}

/** Dry-run preview for the Normalize block (`repo_renormalize_preview`). */
export interface RenormalizePreview {
  files: string[];
  /** Tracked files with unstaged changes - restaging stages those edits too. */
  unstaged_changes: number;
}
```

`commands.ts` (near `repoLineEndingsView`; extend the type-only import list):

```ts
/** Dry-run preview of `git add --renormalize` for the Normalize block. */
export const repoRenormalizePreview = (repoId: string) =>
  invoke<RenormalizePreview>("repo_renormalize_preview", { repoId });

/** Restage all tracked files through the clean filter; staged, not committed. */
export const repoRenormalize = (repoId: string) =>
  invoke<RenormalizeOutcome>("repo_renormalize", { repoId });

/** Insert a covers-all `* text=auto [eol=...]` rule into `.gitattributes`. */
export const repoWriteGitattributesEol = (repoId: string, eol: string | null) =>
  invoke<LineEndingsView>("repo_write_gitattributes_eol", { repoId, eol });
```

- [ ] **Step 2: NormalizeLineEndingsBlock component**

New file; matches the section's existing idiom (inline styles, tokens only,
`legit-subtle` / `legit-error` classes, gap 6/8 like its siblings). Full
component:

```tsx
import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  repoRenormalize,
  repoRenormalizePreview,
  repoWriteGitattributesEol,
} from "../../lib/commands";
import type { LineEndingsView, RenormalizePreview } from "../../lib/types";
import { formatAppError } from "../../lib/errors";
import { invalidateRepoDomains } from "../../lib/repoInvalidation";
import { useConfirmDestructive } from "../../store/settings";
import { Button } from "../shared/Button";

/** The Normalize block of the Repo Settings "Line endings" section:
 * dry-run preview + optional covers-all `.gitattributes` step + the
 * `git add --renormalize` action. Result is staged, never committed. */
export function NormalizeLineEndingsBlock({
  repoId,
  view,
  onViewChange,
}: {
  repoId: string;
  view: LineEndingsView;
  onViewChange: (v: LineEndingsView) => void;
}) {
  const [preview, setPreview] = useState<RenormalizePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [eolChoice, setEolChoice] = useState<"" | "lf" | "crlf">("");
  const confirmDestructive = useConfirmDestructive();
  const qc = useQueryClient();
  const runningRef = useRef(false);

  const loadPreview = useCallback(() => {
    repoRenormalizePreview(repoId)
      .then(setPreview)
      .catch((e) => setError(formatAppError(e)));
  }, [repoId]);

  // Follows the section's load/focus cycle: `view` is replaced on every
  // section load, so the preview refetches alongside it.
  useEffect(() => {
    loadPreview();
  }, [loadPreview, view]);

  // Delayed busy + re-entry guard (WorkingChangesPanel `run()` pattern).
  const run = async (fn: () => Promise<void>) => {
    if (runningRef.current) return;
    runningRef.current = true;
    const timer = setTimeout(() => setBusy(true), 150);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(formatAppError(e));
    } finally {
      clearTimeout(timer);
      setBusy(false);
      runningRef.current = false;
    }
  };

  const writeAttributes = () =>
    run(async () => {
      const updated = await repoWriteGitattributesEol(repoId, eolChoice === "" ? null : eolChoice);
      onViewChange(updated);
    });

  const executeRenormalize = () =>
    run(async () => {
      setConfirming(false);
      const result = await repoRenormalize(repoId);
      setOutcome(
        result.restaged.length === 0
          ? "Nothing to do - line endings are already normalized."
          : `Restaged ${result.restaged.length} file${result.restaged.length === 1 ? "" : "s"} - staged for review, nothing committed.`,
      );
      invalidateRepoDomains(qc, repoId, ["status"]);
      loadPreview();
    });

  const attrLine = eolChoice === "" ? "* text=auto" : `* text=auto eol=${eolChoice}`;
  const count = preview?.files.length ?? 0;

  return (
    <div style={{ marginTop: 14 }}>
      <div style={{ fontWeight: 600, fontSize: "var(--fz-md)" }}>Normalize line endings</div>
      <div className="legit-subtle" style={{ fontSize: "var(--fz-sm)", marginTop: 2 }}>
        Re-runs git's clean filter over all tracked files (git add --renormalize).
        The result is staged for review; the working tree is never rewritten.
      </div>

      {!view.gitattributes_covers_all && (
        <div style={{ marginTop: 8, padding: "6px 8px", background: "var(--button-hover-bg)", borderRadius: 4, fontSize: "var(--fz-md)" }}>
          <div>
            No covers-all rule in <code>.gitattributes</code> yet - without one,
            normalization has no policy to apply. Add:
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6, flexWrap: "wrap" }}>
            <code style={{ fontFamily: "monospace" }}>{attrLine}</code>
            <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
              eol:
              <select value={eolChoice} onChange={(e) => setEolChoice(e.target.value as "" | "lf" | "crlf")}>
                <option value="">platform default</option>
                <option value="lf">lf</option>
                <option value="crlf">crlf</option>
              </select>
            </label>
            <Button variant="primary" disabled={busy} onClick={writeAttributes}>
              Write .gitattributes
            </Button>
          </div>
          <div className="legit-subtle" style={{ fontSize: "var(--fz-sm)", marginTop: 4 }}>
            Inserted above existing rules so specific patterns keep winning.
            The file is left unstaged for you to commit.
          </div>
        </div>
      )}

      <div style={{ marginTop: 8, fontSize: "var(--fz-md)" }}>
        {preview === null ? (
          <span className="legit-subtle">Checking…</span>
        ) : count === 0 ? (
          <span className="legit-subtle">Line endings are already normalized - nothing to restage.</span>
        ) : (
          <details>
            <summary style={{ cursor: "pointer" }}>
              {count} tracked file{count === 1 ? "" : "s"} would be renormalized
            </summary>
            <ul style={{ margin: "4px 0 0", paddingLeft: "1.4em", fontFamily: "monospace", fontSize: "var(--fz-sm)" }}>
              {preview.files.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          </details>
        )}
      </div>

      {confirming ? (
        <div style={{ marginTop: 8, padding: "10px 12px", background: "var(--button-hover-bg)", border: "1px solid var(--panel-border)", borderRadius: 4 }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>
            Renormalize {count} file{count === 1 ? "" : "s"}?
          </div>
          <div style={{ fontSize: "var(--fz-md)", marginBottom: 8 }}>
            The result will be staged for review - nothing is committed.
            {preview !== null && preview.unstaged_changes > 0 && (
              <>
                {" "}Restaging will also stage the current unstaged changes of{" "}
                {preview.unstaged_changes} modified file{preview.unstaged_changes === 1 ? "" : "s"}.
              </>
            )}
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <Button variant="primary" disabled={busy} onClick={executeRenormalize}>Renormalize</Button>
            <button onClick={() => setConfirming(false)}>Cancel</button>
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
          <Button
            variant="primary"
            disabled={busy || count === 0}
            onClick={() => (confirmDestructive ? setConfirming(true) : executeRenormalize())}
          >
            Renormalize
          </Button>
        </div>
      )}

      {outcome && <div className="legit-success" style={{ marginTop: 6, fontSize: "var(--fz-md)" }}>{outcome}</div>}
      {error && <pre className="legit-error" style={{ marginTop: 6 }}>{error}</pre>}
    </div>
  );
}
```

(Verify the `Button` import path and `legit-success` class against
RepoSettingsPanel.tsx before using; both appear there today. If `useConfirmDestructive`
or `formatAppError` import paths differ, mirror RepoSettingsPanel's imports.)

- [ ] **Step 3: Integrate into `LineEndingsRepoSection`**

At the end of the section's JSX (after the save/cancel row and error output),
render:

```tsx
      <NormalizeLineEndingsBlock
        repoId={repoId}
        view={view}
        onViewChange={(v) => {
          setView(v);
          setDraftAutocrlf(v.autocrlf_local.value ?? null);
          setDraftEol(v.eol_local.value ?? null);
        }}
      />
```

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit` (WSL) - expected: clean.
Run: `powershell.exe -Command "cd <repo>; npm test"` - expected:
all vitest suites pass (theme contract + no-literal-colors included).
Run: `cargo test -p legit-core && cargo test -p legit-app` - expected: green.

## Self-review notes

- Spec coverage: parser/consts (Task 1), backend flow + sequence tests
  (Task 2), all five real-git assumptions (Task 3; insertion-position is
  covered by the pure writer tests in Task 4 instead of real git, which is
  where that logic lives), three IPC commands + writer (Task 4), UI incl.
  confirm gating, unstaged warning, delayed busy, status invalidation,
  outcome copy (Task 5). Out-of-scope list respected: no working-tree
  rewrites, no auto-commit, no Working Changes entry points.
- Type names consistent: `RenormalizeOutcome.restaged`,
  `RenormalizePreview.files/unstaged_changes` used identically in Rust and TS.
