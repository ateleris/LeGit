# LFS detection: missing-git-lfs warning + Files panel LFS icons

Date: 2026-08-17
Status: approved (design), pending implementation
Related backlog: "Git LFS-aware content views" release blocker (this spec covers
the detection/warning half plus Files panel icons; pointer-blob placeholder
rendering in content views is a separate follow-up spec).

## Problem

Git LFS swaps large files for ~3-line pointer blobs via clean/smudge filters
declared in `.gitattributes` (`filter=lfs`). When the `git-lfs` binary is
missing (or `git lfs install` was never run, so `filter.lfs.smudge` is not in
git config), checkouts silently leave raw pointer files in the working tree
and `git add` can commit real content where a pointer belongs. Users get no
signal from LeGit today. Separately, there is no visual cue in the Files panel
that a file is LFS-tracked.

## Scope

1. Detect that a repo uses LFS and whether git-lfs is usable; warn via an
   app-chrome banner when it is not.
2. Mark LFS-tracked files with a distinct icon in the Files panel (v1: Files
   panel only; other file rows may adopt the same data later).

Out of scope (separate backlog items): pointer-blob placeholder rendering in
File View / Blame / Diff-at-revision, smudge-on-demand, rich binary previews.

## Detection (approach: git-native, decided over self-parsing)

Git itself answers all attribute questions so nested `.gitattributes`,
negations, and pattern precedence are correct for free. Self-parsing
`.gitattributes` (extending `parse_attr_line`) was rejected: it would
reimplement wildmatch semantics and today only reads the root file. A hybrid
(root-file parse for the banner) was rejected because the banner is the
data-safety feature and must not miss nested attribute files (e.g.
`assets/.gitattributes` in monorepos).

Known accepted gap: LFS rules living only in `.git/info/attributes` or the
global attributes file are not detected by the repo-level check. `git lfs
track` always writes `.gitattributes`, so this is a non-case in practice.

## Backend

### `repo_lfs_status(repoId) -> LfsStatus`

New command in `src-tauri/src/commands/lfs.rs`. Like `git_status_check`, it
never returns Err for a missing binary: it returns a status object.

```rust
pub struct LfsStatus {
    pub uses_lfs: bool,          // any tracked .gitattributes contains filter=lfs
    pub installed: bool,         // `git lfs version` succeeded
    pub version: Option<String>, // parsed from `git lfs version` stdout
    pub initialized: bool,       // `git config --get filter.lfs.smudge` is set
}
```

- `uses_lfs`: `git grep -l -e filter=lfs -- ':(glob)**/.gitattributes'`
  (the glob matches the root file and nested ones). Exit 1 means "no hits"
  and is classified as `false`, not as a failure (git grep exits 0 = hits,
  1 = none, >1 = error).
- `installed` / `version`: `git lfs version` through the repo's runner. A
  non-zero exit ("git: 'lfs' is not a git command") IS the probe result.
- `initialized`: `git config --get filter.lfs.smudge` run in repo context so
  local config counts (exit 1 = unset = false).
- Short-circuit: when `uses_lfs` is false, skip the binary and config probes.
  Non-LFS repos pay exactly one `git grep` per (stale) query.
- Placement (decided during planning): the WHOLE probe is a `GitBackend`
  trait method (`lfs_status`) implemented in `cli_impl` - all three steps
  are git invocations through the executor seam, and only there can
  `flow_tests.rs` pin the command sequence and the short-circuit as the
  Testing section requires. The `git_status_check` keep-it-command-side
  precedent does not apply: that probe targets an arbitrary candidate
  binary path with an unbound runner, not the open repo's git.

### `repo_lfs_files(repoId, show_ignored) -> Vec<String>`

Returns the LFS-tracked subset of the repo's file listing. The command
composes two backend calls: `list_repo_files(show_ignored)` (the same
listing the Files panel shows, submodule entries excluded - no blob content,
attributes don't apply), then `lfs_tracked_subset(paths)`:
`git check-attr -z --stdin filter` via `run_with_stdin` (same seam as the
line-endings feature), with a new pure parser next to `parse_check_attr_z`
keeping entries whose attr value is `lfs`, result in input order.

Decided during planning (supersedes the earlier `paths`-parameter draft):
the command lists files server-side instead of accepting a client-supplied
`paths` array, so the subset can never race a stale paths snapshot when a
watcher invalidation refetches the listing and the subset concurrently.

Both commands follow the standard vertical slice: trait method in
`backend.rs` -> `cli_impl` -> `#[tauri::command]` registered in `lib.rs` ->
wrapper in `src/lib/commands.ts` -> hand-mirrored type in `src/lib/types.ts`.

## Warning banner

New `LfsWarningBanner` component, a sibling of `OpStateStrip` in `AppLayout`
(both mount points), same visual language (`BANNER_BUTTON_STYLE`, renders
`null` when nothing applies).

Show condition for the active repo:

```
uses_lfs && (!installed || !initialized)
  && !sessionDismissed(repoId)
  && repoSettings.suppress_lfs_warning !== true
```

The decision is a pure function `shouldShowLfsWarning(status,
sessionDismissed, repoSetting)` in `src/lib/` with unit tests.

Message variants:
- Not installed: "This repository uses Git LFS, but git-lfs is not installed.
  Files checked out without it are pointer stubs, and commits may store real
  content in place of pointers."
- Installed but not initialized: same stakes; the fix named is running
  `git lfs install`.

Banner actions:
- **Re-check**: invalidates the `[repoId, "lfs"]` query.
- **Don't warn for this repo**: persists the per-repo opt-out.
- **X**: dismisses for this app session only.

The banner auto-disappears when a re-check finds the condition resolved.
This is a warning banner, not a destructive confirmation: it is NOT gated by
the "Destructive action confirmation" setting.

Theme: two new generic tokens, `banner.warning.bg` and `banner.warning.fg`,
added in all 4 contract places (`tokens.ts`, `defaults.ts`,
`styles/theme.css`, both bundled themes). The contract tests enforce
completeness.

## Dismissal state

- Session dismiss: in-memory set of repoIds in a small zustand store, not
  persisted.
- Persistent opt-out: `suppress_lfs_warning: Option<bool>` on `RepoSettings`
  (`None` = warn, the default). Touches the usual 3 places: Rust struct,
  `src/lib/types.ts` mirror, and a `RepoSettingsPanel` section that doubles
  as the re-arm switch.
- The Repo Settings "Git LFS" section also shows the live probe result
  (uses LFS / binary version / initialized) with its own Re-check button on
  the shared `[repoId, "lfs"]` cache entry. Added after manual testing: the
  banner's Re-check only exists while the banner shows, so a condition that
  changes underneath the 5-minute staleTime (config edited or git-lfs
  installed/removed in a terminal) had no reachable re-probe trigger.

## Files panel LFS icons

Only when `repo_lfs_status` reports `uses_lfs` does the Files panel fetch
`repo_lfs_files` for its current listing. `renderFileIcon` swaps in the LFS
icon for those paths, exactly like the existing submodule `GitFork` override.

- Icon: lucide `FileBox`, registered in `src/icons/index.tsx` (inherits
  `size="1em"` / `currentColor` conventions).
- Color: the same token tracked files use (`--subtle-fg`); the shape carries
  the distinction, no new token needed.
- Label: aria-label/tooltip "Tracked (LFS)".
- Non-LFS repos: zero extra git calls, zero rendering change.

## Freshness

- `repo_lfs_status`: React Query under `[repoId, "lfs"]`, staleTime ~5 min.
  `.gitattributes` edits and LFS installs are rare; the banner Re-check and
  refetch-on-activation cover the gaps. Not wired into watcher invalidation
  in v1 (avoids running probes on every status change).
- `repo_lfs_files`: keyed under the status domain
  (`[repoId, "status", "lfs-files", showIgnored]`), so the watcher's status
  invalidations refresh it together with the file listing; short staleTime
  like the listing. Enabled only when `uses_lfs` is true and the panel shows
  the working tree (worktree attributes must not label at-revision views).

## Error handling

- `repo_lfs_status` never throws for missing binary or unset config; only a
  genuinely broken repo (e.g. `git grep` exit >1) surfaces as a query error,
  and the banner simply does not render in that case (the underlying failure
  is visible in the Git Command Log via the runner as usual).
- `repo_lfs_files` failure degrades to "no LFS icons" (empty set), never
  blocks the Files panel.

## Testing

- Pure unit: the check-attr `filter` parser; `shouldShowLfsWarning`.
- `cli_impl/flow_tests.rs` (FakeExecutor): status probe command sequence,
  including "git grep exit 1 = no hits, not an error" and the short-circuit
  (no `lfs version` / `config` invocations when `uses_lfs` is false).
- `crates/legit-core/tests/git_flows.rs` (real git): repo with nested
  `assets/.gitattributes` containing `filter=lfs` -> `uses_lfs` true; repo
  without -> false; check-attr batch returns exactly the matching paths.
  These tests must pass whether or not git-lfs is installed on the machine:
  probe results are asserted structurally (types/reachability), never by
  the machine-dependent value of `installed`.
- Theme contract + no-literal-colors suites cover the new tokens
  automatically.
- No E2E spec: every decision point has a unit or flow seam.
