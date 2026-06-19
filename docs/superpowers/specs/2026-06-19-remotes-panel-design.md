# Remotes panel — design

**Date:** 2026-06-19
**Status:** Approved (design); pending implementation plan.

## Context

LeGit recently gained remote **sync** (fetch/pull/push + ahead-behind) with auth
driven by git profiles. What's still missing from BACKLOG §1 is **remote
management**: there is no UI to add/remove/rename remotes or change their URLs —
the only way is the interactive Git Console. This spec covers a dedicated
**Remotes panel** for the active repository.

Goal: a repo-scoped panel that lists each remote with its fetch/push URLs and
lets the user add, remove, rename, edit URLs, fetch, and prune — reusing the
existing sync backend where possible and keeping the Commits sync toolbar in
sync after changes.

## Scope

**In:**
- List remotes with **fetch URL** and **push URL**.
- **Add** (`git remote add`), **Remove** (`git remote remove`), **Rename**
  (`git remote rename`).
- **Set URL** — fetch and/or push (`git remote set-url [--push]`).
- **Fetch this remote** — reuses the existing `fetch` op for a single remote.
- **Prune** stale remote-tracking refs (`git remote prune`).

**Out (not now):**
- Per-remote branch listing / ahead-behind breakdown.
- Choosing the push remote from the sync toolbar (toolbar keeps its current
  derivation; this panel just keeps the underlying data correct).
- Multiple push URLs per remote (git allows several `set-url --add --push`;
  we model a single push URL — the common case).
- Credential/profile editing (lives in the profile system already).

## Architecture

Follows the project's standard vertical slice (CLAUDE.md): `GitBackend` method →
`cli_impl` via `GitRunner` (+ pure parser) → Tauri command (registered in
`lib.rs`) → hand-written wrapper in `lib/commands.ts` + type in `lib/types.ts` →
UI panel. Chosen over a command-only layer because remotes are git *operations*,
not config-mirror reads, so they belong alongside fetch/pull/push in the trait.

### Backend — `crates/legit-core`

**`types.rs`**
```rust
pub struct Remote {
    pub name: String,
    pub fetch_url: String,
    pub push_url: String,
}
```
`git remote -v` always prints a `(fetch)` and a `(push)` line per remote, so both
URLs are always populated (they're equal unless a separate push URL was set).

**`backend.rs` (GitBackend trait) + `cli_impl/mod.rs`**
- `list_remotes() -> Result<Vec<Remote>, GitError>` — `git remote -v`, parsed by a
  new pure `cli_impl/parsers/remotes.rs`.
- `add_remote(name, url)` → `git remote add <name> <url>`.
- `remove_remote(name)` → `git remote remove <name>`.
- `rename_remote(old, new)` → `git remote rename <old> <new>`.
- `set_remote_url(name, url, push: bool)` → `git remote set-url [--push] <name> <url>`.
- `prune_remote(name, op_id: OperationId)` → `git remote prune <name>` — a network
  op, so it goes through `run_with_op` and maps failures via
  `classify_remote_error` (cancellable), like the sync ops.
- **Per-remote fetch reuses the existing** `fetch(FetchOptions { all: false,
  remote: Some(name), prune }, op_id)` — no new fetch path.

The non-network mutations (add/remove/rename/set-url) and `list_remotes` use the
plain `run` path and map non-zero exits to `GitError::CommandFailed` (mirroring
the existing `run_pathspec` helper). `prune` is the only one needing
`run_with_op` + remote-error classification.

**Parser `parsers/remotes.rs`** — `parse_remotes(stdout) -> Vec<Remote>`. Groups
the `(fetch)`/`(push)` lines by remote name. Unit tests: no remotes; one remote;
multiple remotes; a remote whose push URL differs from its fetch URL.

### Backend — `src-tauri`

Extend `src-tauri/src/commands/remote.rs` (already exists for sync) with:
`repo_list_remotes`, `repo_add_remote`, `repo_remove_remote`,
`repo_rename_remote`, `repo_set_remote_url`, `repo_prune_remote`. Pattern matches
the existing `working.rs`/`remote.rs` commands (`state.get_session` →
`session.backend.<m>` → `map_err(AppError::Git)`). `repo_prune_remote` takes an
`op_id: String` (→ `OperationId`) like `repo_fetch`; cancellation reuses
`console_cancel`. Mutations return `()`; `repo_list_remotes` returns
`Vec<Remote>`. Register all in `lib.rs` `collect_commands!`.

### Frontend — `src/lib`

- `types.ts`: `Remote { name; fetch_url; push_url }`.
- `commands.ts`: `repoListRemotes`, `repoAddRemote`, `repoRemoveRemote`,
  `repoRenameRemote`, `repoSetRemoteUrl(repoId, name, url, push)`,
  `repoPruneRemote(repoId, name, opId)`. Per-remote fetch reuses `repoFetch` with
  `{ all: false, remote: name, prune }`.

### Frontend — `Remotes` panel

- Register `{ id: "remotes", title: "Remotes", scope: "repo" }` in
  `registry.tsx` (`REPO_PANELS` + `REPO_DOCKVIEW_COMPONENTS`). New
  `src/panels/Remotes/RemotesPanel.tsx`, wrapped like the other panels.
- Data: `useQuery([repoId, "remotes"], repoListRemotes)`, `staleTime: 5_000`.
- Layout (one row per remote):
  - **name** + **fetch URL** + **push URL** (monospace, ellipsised, full value on
    hover).
  - Per-row actions: **Fetch** and **Prune** (spinner while running + **Cancel**
    via a frontend-minted `op_id` and `consoleCancel`, exactly like the Commits
    sync toolbar), **Edit URLs** (inline fetch/push fields → `set_remote_url`,
    push only written when changed), **Rename** (inline name field), **Remove**
    (inline confirm — it drops the remote's tracking refs).
  - **Add remote** form at the bottom: name + URL → `add_remote`.
- Errors shown **inline** near the action (matching the Settings sections'
  `legit-error`), not as toasts — this is a focused management surface. Busy
  states disable the row's actions.
- Reuses existing theme tokens (`--subtle-fg`, `--panel-border`, `--accent`,
  `--error-fg`, `--success-fg`); **no new tokens**.

### Data freshness / integration

After any mutation (add/remove/rename/set-url) and after fetch/prune, invalidate
`["remotes", "branches", "tracking", "log"]` for the repo via
`invalidateRepoDomains`, so the Commits **sync toolbar**'s remote derivation and
ahead/behind indicator stay correct. (`invalidateRepoDomains` already prefix-
matches, so `"remotes"` works as a domain.)

## Error handling

- Add/remove/rename/set-url: git validates names/URLs; non-zero exits surface as
  inline errors (e.g. "remote origin already exists"). No client-side name regex
  beyond trimming/empty checks — let git be the source of truth.
- Fetch/Prune: network ops → `AuthFailed` / `PushRejected`-style classification
  already exists; show the message inline. A user-cancelled op shows no error.
- Remove is the only destructive action → inline confirm before running.

## Testing

- **Rust unit:** `parse_remotes` (none / one / many / differing push URL);
  arg-builder coverage for `set_remote_url` (`--push` vs not).
- **Build:** `cargo test` + `cargo build`; `tsc --noEmit` clean; confirm
  `bindings.ts` regenerates the new commands on a debug run.
- **Manual (real repo):** add a remote → appears with URLs; edit fetch/push URL →
  reflected; **Fetch** a remote → tracking refs update; **Prune** → stale refs
  removed; **Rename** → name changes and the Commits toolbar still resolves it;
  **Remove** (confirm) → gone, and the sync toolbar's remote derivation updates.

## Out-of-scope follow-ups (BACKLOG)

- Push-remote picker in the sync toolbar.
- Per-remote tracked-branch / ahead-behind view.
- Multiple push URLs per remote.
