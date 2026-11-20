# Large Staged File Warning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Do NOT create git commits at any point** - the user commits manually; leave changes in the working tree. Do not create or switch branches.

**Goal:** A non-blocking commit-composer banner listing staged files whose index blob exceeds a configurable threshold (default 10 MB).

**Architecture:** New backend method measuring staged INDEX blobs (`ls-files -z --stage` + stdin-fed `cat-file --batch-check=%(objectsize)`, two invocations total, LFS pointers therefore exempt by construction); threshold lives in settings (global u32 MB + per-repo override) and is compared frontend-side; banner reuses the composer's existing warning-banner pattern.

**Tech Stack:** Rust (legit-core parser + flow, src-tauri command/settings), React + TypeScript, specta bindings.

**Spec:** `design/2026-11-19-large-staged-file-warning.md`.

## Global Constraints

- Never commit or push; leave all changes uncommitted (user rule, overrides skill defaults).
- Default threshold **10** MB; **0 disables**; MB = 10^6 bytes; display with one decimal ("23.4 MB").
- Non-blocking: the commit button stays enabled.
- Colours only via `var(--token)`; sizes via `--fz-*`/em; no em-dashes or center dots anywhere.
- Busy/loading feedback rules don't apply (the banner is data-driven, no spinner).
- Output-only Rust types: no field-level `#[serde(default)]`.
- The template to mirror for the setting is `line_ending_chips_in_changes` (global field in `GlobalSettings` with per-repo override in `RepoSettings`) - follow it in every layer: struct fields, `with_patch`/patch structs, settings store setter, section components, manifest entries.

## Review Focus

1. Submodule gitlinks (mode `160000`): feeding a commit SHA to `cat-file --batch-check` in the superproject can report missing - gitlink entries must be skipped (Task 1 test).
2. Conflict stages (stage > 0) during a merge: duplicated paths must not produce bogus warnings - non-zero stages skipped (Task 1 test).
3. Paths with spaces and non-ASCII: `-z` records must parse whole (Task 1 test).
4. Empty staged set: no `cat-file` process may spawn (Task 2 flow test).
5. A `<sha> missing` batch-check response (e.g. racing a gc) must skip that entry, never panic or misalign the zip (Task 1 test).

---

### Task 1: Parser for staged blob sizes

**Files:**
- Create: `crates/legit-core/src/cli_impl/parsers/staged_sizes.rs` (+ `pub mod staged_sizes;` in `parsers/mod.rs`)
- Modify: `crates/legit-core/src/types.rs`

**Interfaces:**
- Produces (types.rs): `pub struct StagedBlobSize { pub path: PathBuf, pub size: u64 }` (`Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type`).
- Produces (parsers/staged_sizes.rs):
  - `pub const LS_FILES_STAGE_SIZES_ARGS: [&str; 3] = ["ls-files", "-z", "--stage"];`
  - `pub const BATCH_CHECK_SIZE_ARGS: [&str; 2] = ["cat-file", "--batch-check=%(objectsize)"];`
  - `pub fn parse_staged_blobs(stdout: &str) -> Vec<(String, PathBuf)>` - `(sha, path)` for stage-0 BLOB entries only: record format `<mode> <sha> <stage>\t<path>` split on `\0`; skips mode `160000` (gitlink), stage != 0, and an all-zero sha.
  - `pub fn zip_blob_sizes(blobs: &[(String, PathBuf)], batch_stdout: &str) -> Vec<StagedBlobSize>` - pairs each blob with its batch-check line in order; a line that is not a plain number (e.g. `<sha> missing`) skips that entry without shifting the rest (batch-check answers line-per-query, so pairing is by index).

- [ ] **Step 1: Write failing unit tests** in the new file's `#[cfg(test)]`:
  - `parses_stage0_blobs_only`: input with a `100644` entry, a `100755` entry with a space in the path (`"my file.bin"`), a `160000` gitlink, a stage-1 conflict entry, and a `100644` entry with an all-zero sha -> exactly the two blob entries, paths intact.
  - `zips_sizes_by_index`: three blobs, batch stdout `"12\n<sha> missing\n10485760\n"` -> entries 1 and 3 with sizes 12 and 10485760; the missing one absent.
- [ ] **Step 2: Run** `cargo test -p legit-core staged_sizes` - FAILS (functions missing).
- [ ] **Step 3: Implement** the type, constants and both functions.
- [ ] **Step 4: Run** `cargo test -p legit-core staged_sizes` - PASS.

### Task 2: Backend method + flow test + real-git pin

**Files:**
- Modify: `crates/legit-core/src/backend.rs`, `crates/legit-core/src/cli_impl/mod.rs` (delegation), `crates/legit-core/src/cli_impl/changes.rs` (inherent method - it owns the other `ls-files` status work)
- Create: test module additions in `crates/legit-core/src/cli_impl/flow_tests/changes.rs`
- Modify: `crates/legit-core/tests/suite/git_flows_suite.rs`

**Interfaces:**
- Produces: `async fn staged_blob_sizes(&self) -> Result<Vec<StagedBlobSize>, GitError>` on `GitBackend` - runs `LS_FILES_STAGE_SIZES_ARGS`; when `parse_staged_blobs` yields no entries returns `Ok(vec![])` WITHOUT spawning cat-file; otherwise feeds the shas (one per line, trailing newline) via `run_with_stdin(&BATCH_CHECK_SIZE_ARGS, ...)` and returns `zip_blob_sizes`.

- [ ] **Step 1: Write failing flow tests** (in `flow_tests/changes.rs`, using the shared `backend()` helper and `expect_stdin`):
  - `staged_blob_sizes_sequence`: scripts ls-files output with two blobs + one gitlink, expects `cat-file --batch-check=%(objectsize)` with stdin exactly `"<sha1>\n<sha2>\n"`, returns two size lines; asserts the two `StagedBlobSize` results and `assert_done`.
  - `staged_blob_sizes_empty_skips_batch`: ls-files returns only a gitlink -> `Ok(vec![])`, `assert_done` proves no cat-file ran (Review Focus 4).
- [ ] **Step 2: Run** `cargo test -p legit-core --lib flow_tests::changes` - new tests FAIL.
- [ ] **Step 3: Implement** trait method, inherent body, mod.rs delegation.
- [ ] **Step 4: Run** - PASS.
- [ ] **Step 5: Real-git case** in `git_flows_suite.rs`: new test `staged_blob_sizes_reports_index_blobs` - stage a 1_000_000-byte file and a 12-byte file (`repo.write` + `git add`), assert both exact sizes; then overwrite the big file in the worktree with 5 bytes WITHOUT re-adding and assert the reported size is still 1_000_000 (index, not worktree - the spec's core claim).
- [ ] **Step 6: Run** `cargo test -p legit-core --test git_flows staged_blob_sizes` - PASS, then `cargo test -p legit-core` - full crate green.

### Task 3: Tauri command + bindings

**Files:**
- Modify: `src-tauri/src/commands/changes.rs`-equivalent (whichever commands file hosts `repo_status`; follow it), `src-tauri/src/lib.rs` (`collect_commands!`), generated `src/lib/bindings.ts`

**Interfaces:**
- Produces: `#[tauri::command] #[specta::specta] repo_staged_blob_sizes(state, repo_id: String) -> Result<Vec<StagedBlobSize>, AppError>` - pure session->backend delegation (no new tests; flow tests own the behavior).

- [ ] **Step 1: Implement + register** the command.
- [ ] **Step 2: Regenerate bindings:** `LEGIT_UPDATE_BINDINGS=1 cargo test -p legit-app bindings`, then `cargo test -p legit-app` green.

### Task 4: Threshold setting (global + per-repo override)

**Files:**
- Modify: `src-tauri/src/state.rs` (both structs + `with_patch`/patch plumbing + `normalized()`), `src/store/settings.ts` (one-line setter), generated bindings

**Interfaces:**
- Produces: `GlobalSettings.large_file_warn_mb: u32`, `#[serde(default = "default_large_file_warn_mb")]` (fn returns 10); `RepoSettings.large_file_warn_mb: Option<u32>` with `#[serde(default)]` (None = inherit). Mirror `line_ending_chips_in_changes` in every layer it appears, including the patch structs and any pinned settings tests. No clamp needed (0 = disabled is valid; u32 bounds suffice) - note that in `normalized()` only if the template field has a line there.
- Produces (frontend): the generated `RepoSettings`/`GlobalSettings` TS fields; a `setLargeFileWarnMb(mb: number)` setter in `store/settings.ts` following its siblings.

- [ ] **Step 1: Add the Rust fields + patch plumbing;** run `cargo test -p legit-app` - any pinned settings test failures name what else to touch; fix until green.
- [ ] **Step 2: Regenerate bindings** (`LEGIT_UPDATE_BINDINGS=1 cargo test -p legit-app bindings`); add the store setter.

### Task 5: Pure helper + composer banner + settings UI

**Files:**
- Create: `src/panels/WorkingChanges/largeFileWarning.ts` + `src/panels/WorkingChanges/largeFileWarning.test.ts`
- Modify: `src/panels/WorkingChanges/CommitComposer.tsx`
- Modify: the global settings section hosting `line_ending_chips_in_changes`'s UI + the repo override's section in `RepoSections.tsx`, plus their manifest entries' `keywords` (add "large", "file", "size", "warning", "commit", "megabyte")

**Interfaces:**
- Consumes: `api.repoStagedBlobSizes(repoId)`, `StagedBlobSize` TS type, settings fields from Task 4.
- Produces (largeFileWarning.ts):
  - `export function largeStagedFiles(sizes: StagedBlobSize[], thresholdMb: number): StagedBlobSize[]` - empty when `thresholdMb <= 0`; otherwise entries with `size > thresholdMb * 1_000_000`, sorted largest first.
  - `export function formatMb(bytes: number): string` -> `"23.4 MB"` (one decimal, 10^6).

- [ ] **Step 1: Write failing vitest** `largeFileWarning.test.ts`: threshold 10 with sizes 10_000_000 (not over - strict >), 10_000_001 (over), 500 (under) -> exactly the one entry; threshold 0 -> always empty; `formatMb(23_400_000) === "23.4 MB"`, `formatMb(10_000_001) === "10.0 MB"`.
- [ ] **Step 2: Run** (powershell interop) - FAIL; **implement**; run - PASS.
- [ ] **Step 3: Composer banner:** in `CommitComposer`, read the effective threshold (`repoSettings?.largeFileWarnMb ?? globalSetting`), `useQuery({ queryKey: [repo.id, "status", "staged-sizes"], queryFn: () => api.repoStagedBlobSizes(repo.id), enabled: stagedCount > 0 && threshold > 0, staleTime: STALE }` matching the sibling status queries). Render above the message box, mirroring the `identityMissing` banner markup: WarningIcon + `"N staged file(s) larger than {threshold} MB:"` + one `path (23.4 MB)` line per file (monospace path, `legit-subtle` size). No button; commit stays enabled.
- [ ] **Step 4: Settings UI:** number input "Warn when a staged file exceeds (MB)" with a "0 disables" note in the global section; the standard inherit/override control in the repo section; manifest keywords updated.
- [ ] **Step 5: Run** `npx tsc --noEmit` and the vitest files touched (`largeFileWarning`, `settingsManifest`, `settingsSearch`) - green.

### Task 6: Changelog + full gates

- [ ] **Step 1: CHANGELOG** `## [Unreleased]` / Added: `- Warning in the commit composer when a staged file exceeds a size threshold (default 10 MB, configurable globally and per repo; LFS-tracked files don't trigger it)`
- [ ] **Step 2: Full gates:** `cargo test -p legit-core && cargo test -p legit-app`, full vitest via powershell interop, `npx tsc --noEmit`. Report any failure verbatim.
