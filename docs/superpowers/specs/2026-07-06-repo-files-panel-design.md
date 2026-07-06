# Repo Files panel — design

**Date:** 2026-07-06
**Status:** Implemented 2026-07-06. Selecting a file shows its current
**working-tree** content in File View (a new `repo_file_worktree` command +
`FileViewPanel` working-tree mode, rev optional), which works for tracked,
untracked and ignored files. Distinct per-kind icons were added at the user's
request (`FileCheck`/`FilePlus`/`FileX`) via a new `renderFileIcon` render-prop
on `FileTree`.

## Context

Every path-based action in LeGit (Blame, File History, File View) is reached by
*summoning* it with a `path` (or `{path, rev}`) from a panel that already lists
that file: Changed Files, Working Changes, Search results, Blame. The
consequence is that you can only inspect a file that is currently changed, that
appears in a commit you are looking at, or that you found by name in the Search
panel's "File paths" mode (which is tracked-only). There is no way to **browse
the whole repository tree and act on an arbitrary file** that has not been
touched recently.

Goal: a repo-scoped **Files** panel that lists the entire repository folder as a
tree, visually distinguishes tracked / untracked / (optionally) ignored files,
and offers per-file inspect actions (History, Blame, File View), gitignore /
untrack actions, and copy-path / reveal-in-file-manager. It makes it easy to run
these actions on a file that is not part of a recent commit.

## Scope

**In:**
- A tree of the repo's files, reusing the existing `shared/FileTree`
  (virtualized, tree/flat toggle, single-child chain compression).
- Three file classes, visually distinguished: **Tracked** (normal), **Untracked**
  (accent / "new"), **Ignored** (dimmed).
- Header controls: a **name filter box**, the **tree/flat** toggle, and a
  **"Show ignored"** toggle (default **off**).
- Per-row actions (context menu + hover buttons):
  - **History** / **Blame** — summon `file-history` / `blame`. **Tracked files
    only**; disabled with a tooltip for untracked/ignored.
  - **File View** — summon `file-view` (working-tree content for untracked,
    at-HEAD for tracked).
  - **Copy path** — `navigator.clipboard.writeText(path)`.
  - **Reveal in file manager** — `plugin-shell` opens the containing directory.
  - **Add to .gitignore** (untracked file/folder) — append `path` / `path/` to
    the root `.gitignore`.
  - **Stop tracking & ignore** (tracked file) — `git rm --cached -- <path>` then
    append to `.gitignore`. Explicitly labelled so the tracked-file gotcha is
    clear.
- Ignore / untrack actions gated by the global destructive-confirmation setting
  (`useConfirmDestructive()`).

**Out (not now → BACKLOG):**
- Nested `.gitignore` / `.git/info/exclude` targets (root `.gitignore` only).
- Staging an untracked file from the browser (overlaps Working Changes).
- True select-in-manager (`revealItemInDir` via the opener plugin) — MVP opens
  the containing folder via `plugin-shell`.

## Architecture

Follows the project's standard vertical slice (CLAUDE.md): `GitBackend` method →
`cli_impl` via `GitRunner` (+ pure, unit-tested helpers) → Tauri command
(registered in `lib.rs`) → hand-written wrapper in `lib/commands.ts` + type in
`lib/types.ts` → UI panel. No new Tauri plugins are required (`plugin-shell` is
already present; clipboard uses the webview `navigator.clipboard`).

### Backend — `crates/legit-core`

**`types.rs`**
```rust
pub enum RepoFileKind { Tracked, Untracked, Ignored }

pub struct RepoFileEntry {
    pub path: String,
    pub kind: RepoFileKind,
}
```

**`backend.rs` (trait) + `cli_impl`**
- `list_repo_files(&self, show_ignored: bool) -> Result<Vec<RepoFileEntry>>`
  - `git ls-files -z` → Tracked.
  - `git ls-files -z --others --exclude-standard` → Untracked.
  - if `show_ignored`: `git ls-files -z --others --ignored --exclude-standard`
    → Ignored.
  - Merge + classify in a **pure function** (`classify_repo_files`) that takes
    the three NUL-separated lists and returns the sorted, de-duplicated
    `Vec<RepoFileEntry>`. Unit-tested per the "decision logic in pure functions"
    convention. The format-string constant lives next to the parser.
- `add_to_gitignore(&self, path: &str, is_dir: bool) -> Result<()>`
  - Line to write is computed by a **pure helper** (`gitignore_line`): `path`
    for a file, `path/` for a folder. Appends to the repo-root `.gitignore`
    (create if missing, ensure a trailing newline before appending, skip if the
    exact line is already present). File I/O via the runner's repo root.
- `untrack_path(&self, path: &str) -> Result<()>`
  - `git rm --cached -- <path>`, then `add_to_gitignore(path, is_dir)`. If the
    gitignore step fails after `rm --cached` succeeded, append the fact to the
    primary result via `append_error_note` — never silent.

### Commands — `src-tauri`

`list_repo_files`, `add_to_gitignore`, `untrack_path` as
`#[tauri::command] #[specta::specta]`, registered in `lib.rs`
(`collect_commands!`). Wrappers in `src/lib/commands.ts`; types mirrored in
`src/lib/types.ts`.

### Frontend — `src/panels/Files/`

- **Registry** (`registry.tsx`): `{ id: "files", title: "Files", scope: "repo",
  summons: ["blame", "file-history", "file-view"], defaultPlacement:
  { direction: "left", referencePanel: "log" } }`; component wired into
  `REPO_DOCKVIEW_COMPONENTS`.
- **`FilesPanel.tsx`**: React Query `[repoId, "files", showIgnored]` calling
  `list_repo_files`; feeds the classified list into `shared/FileTree`. Header
  holds the filter box + tree/flat toggle + "Show ignored" toggle.
- **`FileTree` extension**: extend its status vocabulary so it can render
  `untracked` / `ignored` classes (tracked = normal, untracked = accent,
  ignored = dimmed). All colours resolve from theme tokens; add tokens in the
  4 required places if new ones are needed.
- Row actions dispatch through `useSummonStore` (inspect trio) and the new
  commands (ignore/untrack), with copy/reveal as described. Destructive
  entries reuse the shared confirm pattern gated by `useConfirmDestructive()`.

## Data freshness

React Query key `[repoId, "files", showIgnored]`, short `staleTime`. The file
set changes on working-tree edits (new/deleted files) and on commits/checkouts
(the tracked set changes), so `list_repo_files` is invalidated by the
**watcher**: add its query domain to the watcher's emitted domains on the Rust
side so external `git` activity refreshes the tree too.

## Error handling

- Git messages surface unchanged via `formatAppError` (no JSON envelope).
- `untrack_path`'s two-step flow uses `append_error_note` so a failed gitignore
  write after a successful `rm --cached` tells the user both what happened and
  where their file went.
- Adding a line that already exists is a no-op, not an error.

## Testing

- **`cli_impl/flow_tests.rs`** (FakeExecutor): assert the exact `ls-files`
  sequence for `show_ignored` true/false, and that `untrack_path` runs
  `rm --cached` **then** writes the gitignore line.
- **`crates/legit-core/tests/git_flows.rs`** (real git, tempdir): a repo with
  tracked, untracked, and ignored files classifies correctly; `add_to_gitignore`
  and `untrack_path` produce the expected `.gitignore` content and index state.
- **Vitest**: the classification/merge helper and the `gitignore_line` helper
  (if any classification logic also lives frontend-side). FileTree rendering of
  the new classes.

## Deferred (→ BACKLOG on completion)

- Nested `.gitignore` and `.git/info/exclude` targets.
- Stage-from-browser for untracked files.
- `revealItemInDir` (select the file in the OS manager) via the opener plugin.
