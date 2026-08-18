# LFS Track/Pattern-Management UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (inline). NO subagent-driven-development, NO git commits (user rules).

**Goal:** List/track/untrack LFS patterns (root `.gitattributes`) from the Repo Settings Git LFS section.

**Spec:** `docs/superpowers/specs/2026-08-17-lfs-track-management-design.md`

## Global Constraints

Same as the previous LFS plans: no commits, no em-dashes, tokens-only colors, `--fz-*` sizes; vitest via PowerShell interop, cargo/tsc from WSL. Commands need lib.rs registration + hand-written wrappers/types.

### Task 1: pure `.gitattributes` pattern logic (TDD, in `src-tauri/src/commands/lfs.rs`)

**Produces:** `split_attr_line(line) -> Option<(String, Vec<&str>)>` (double-quote-aware), `parse_lfs_patterns(text) -> Vec<String>`, `format_track_line(pattern) -> String` (quotes on whitespace), `add_lfs_pattern(existing, pattern) -> Option<String>` (None = duplicate), `remove_lfs_pattern(existing, pattern) -> Result<Option<String>, String>` (Err = extra attrs on the line; Ok(None) = absent). Standard attr set constant: `filter=lfs diff=lfs merge=lfs -text`.

- [ ] Step 1: append a `#[cfg(test)] mod tests` to `commands/lfs.rs` covering: parse plain + quoted + mixed non-LFS lines + comments; add appends with trailing newline / creates from empty / quotes whitespace pattern / duplicate returns None (also when existing line is quoted); remove drops the standard line / keeps others / Ok(None) on absent / Err on extra attribute (`*.png filter=lfs text=auto`) / matches quoted lines.
- [ ] Step 2: `cargo test -p legit-app lfs` (or `cargo test --manifest-path src-tauri/Cargo.toml lfs` - use the package name from src-tauri/Cargo.toml) - expect compile failure.
- [ ] Step 3: implement the five functions per spec.
- [ ] Step 4: tests pass. No commit.

### Task 2: view type + three commands + registration

**Produces:** `LfsPatternsView { root_patterns: Vec<String>, nested_files: Vec<String> }` (derive Debug, Clone, Serialize, Deserialize, specta::Type - defined in `commands/lfs.rs` like `GitStatus` in `git_setup.rs`); commands `repo_lfs_patterns(repo_id)`, `repo_lfs_track(repo_id, pattern)`, `repo_lfs_untrack(repo_id, pattern)`, all returning `Result<LfsPatternsView, AppError>`.

- [ ] Shared `async fn patterns_view(session) -> LfsPatternsView`: root = `tokio::fs::read_to_string(session.path.join(".gitattributes")).await.unwrap_or_default()` -> `parse_lfs_patterns`; nested = runner `run_expecting(["grep","-l","-e","filter=lfs","--",":(glob)**/.gitattributes"], &[1])`, exit 0 -> stdout lines minus `.gitattributes`, else empty.
- [ ] Track: trim; validate (empty / contains `\n` or `\0` / starts with `#` or `!` -> `AppError::ParseArgs(<message>)`); read existing, `add_lfs_pattern`, write via `tokio::fs::write` only when Some; return view.
- [ ] Untrack: read existing, `remove_lfs_pattern`; Err(msg) -> `AppError::ParseArgs(msg)`; Ok(Some) -> write; return view.
- [ ] Register both commands in `lib.rs` `collect_commands!` next to `repo_lfs_status`.
- [ ] `cargo check --workspace` clean. No commit.

### Task 3: frontend wrappers + settings UI

- [ ] `src/lib/types.ts`: `export interface LfsPatternsView { root_patterns: string[]; nested_files: string[] }`.
- [ ] `src/lib/commands.ts`: `repoLfsPatterns(repoId)`, `repoLfsTrack(repoId, pattern)`, `repoLfsUntrack(repoId, pattern)` (invoke keys `repo_lfs_patterns` / `repo_lfs_track` / `repo_lfs_untrack`, camelCase args `repoId`, `pattern`).
- [ ] `RepoSettingsPanel.tsx` - extend `LfsWarningRepoSection`: patterns query `[repoId, "status", "lfs-patterns"]` (staleTime 5_000, enabled when the management block shows); management block rendered when `lfs?.installed && lfs?.initialized`; pattern rows (monospace, `Untrack` Button per row), input + `Track` Button (disabled while busy), local error string under the input via `formatAppError`, nested-files read-only line, caption about newly-added-files-only + uncommitted-edit. After track/untrack: `queryClient.setQueryData([repoId, "status", "lfs-patterns"], view)` and `invalidateQueries({ queryKey: [repoId, "lfs"] })`.
- [ ] `npx tsc --noEmit` clean. No commit.

### Task 4: verify + docs

- [ ] `cargo test` for the src-tauri package, `cargo check --workspace`, `npx tsc --noEmit`, full `npm test` via PowerShell.
- [ ] BACKLOG: mark the track/pattern-management item shipped (keep locking + context-menu entry as the open on-demand remainder).
- [ ] Report manual test steps (LeGit-Test-LFS: see `*.png` listed; track `*.bin`; untrack it; nested `assets/.gitattributes` listed read-only; `.gitattributes` edit appears in Working Changes).
