# Settings sync via a designated git repository

Status: spec, awaiting review. Demand: one user running LeGit on three
computers wants one configuration everywhere, with a git repo as the
transport (2026-10-02; sharpens the BACKLOG "Settings sync via a
user-configured directory path" entry).

## Goal

The user designates a local checkout of a git repository as the settings
sync repo. LeGit keeps the shareable part of the global configuration
(prefs + user themes) in that repo: it imports changes from the repo at
startup and exports, commits, and pushes local changes as they happen.
All three machines point at clones of the same remote and converge.

## Non-goals (v1)

- The read-only "inherit from a plain folder" team variant stays in the
  backlog; this spec is only the personal writable git mode.
- HTTP(S)/WebDAV endpoints (rejected 2026-08-21, unchanged).
- Repo-scoped settings, git profiles, connected accounts, layouts: not
  synced (see field classification). Named layouts remain the recorded
  phase-2 candidate.
- A sync repo on a remote host (WSL): the path must be on the app
  machine. Remote-host sync would need the Host seam and has no demand.
- Multi-writer team use. Single human writer; concurrent writes are a
  rare race, not the design center.

## Model: local store, git mirror

The existing `global-settings.json` stays the single runtime store;
nothing about settings resolution changes. Sync is a mirror layered on
top:

- **Export** (on every settings change, debounced): write the shareable
  subset to `legit-sync.json` in the sync repo, mirror user themes into
  its `themes/` dir, `git add` + `commit` when something changed, then
  push in the background, best-effort. Debounce: 30s of quiet, capped at
  5 minutes after the burst's first change - a settings-tweaking session
  becomes one or two commits, not one per pause. Generous is safe:
  local persistence is eager, and the startup capture (below) picks up
  whatever a quit cuts off.
- **Import** (at startup, and on manual "Sync now"): first CAPTURE -
  write the doc from local settings and commit if that changed anything,
  so drift the debounce never exported (or changes a kill left staged)
  rebases like any offline commit instead of being silently reverted by
  the adopt; then `git pull --rebase`, merge `legit-sync.json` over the
  local settings (shareable keys only), reconcile themes, and push
  anything left unpushed. The initial ADOPT of a repo skips the capture:
  there, the repo's content winning is the point.

The repo is the merge point. Local edits are committed immediately even
when offline, so divergent histories meet as commits and git's rebase
does the ordering; after a successful pull the repo content is
authoritative for shareable keys.

Push NEVER happens on close: a network operation at shutdown can hang,
need credentials, or hit a rejected push with no UI left. Commit on
change + background push after commit gives the same durability without
those failure modes.

## Sync repo layout

```
legit-sync.json          envelope: { format: "legit-sync",
                         formatVersion: 1, settings: {...},
                         themes: ["name", ...] }
themes/<name>.legit-theme.json
```

`settings` holds the shareable subset of `GlobalSettings` under its
JSON field names. `themes` is the manifest of synced theme names;
deletion propagation needs it (see Themes).

## Field classification

Mechanism: serialize `GlobalSettings`, strip the keys in a new const
`GLOBAL_SETTINGS_NEVER_SYNCED`, write the rest. Import merges the
synced object over the serialized local settings, ignoring never-synced
and unknown keys, then deserializes through the same
`normalized()` clamping as `with_patch` (a malformed or out-of-range
synced value can never corrupt a machine). Import is an internal merge,
NOT `with_patch`: some synced fields (`active_theme`,
`watcher_enabled`, ...) are command-owned and would be refused by the
patch API, which only guards the IPC surface.

Never synced (machine/session state, machine-bound paths, identity):

- `git_path_override`, `external_editor_command`
- `last_open_repos`, `currently_open`, `active_open_repo`,
  `last_clone_parent_dir`
- `global_region_size_top`, `global_region_size_left`,
  `global_dock_collapsed`, `file_history_window_size`
- `gitProfiles` (identities + machine-bound key paths),
  `connected_accounts` (keychain-backed; metadata alone is a lie)
- `settings_sync_path` itself (a local path; syncing it would overwrite
  every machine's pointer with one machine's path)

Everything else syncs, including the remembered view toggles
(`files_view_mode`, `changed_files_view_mode`, `files_show_ignored`,
`branch_list_view`, `refs_sort_mode`, `tags_sort_mode`,
`working_changes_section_order`, `suppressed_auto_open_panels`) -
decided 2026-10-02.

A test pins the classification: every `GLOBAL_SETTINGS_NEVER_SYNCED`
key must exist in the serialized struct, and the full synced-key list
is asserted literally, so adding a `GlobalSettings` field fails the
suite until the new field is consciously classified.

## Themes

User themes are the most shareable artifact and `active_theme` syncs,
so the theme files must travel too. Built-in themes never sync.

- **Export**: the user theme dir is authoritative. Copy every user
  theme into the repo's `themes/`, delete repo themes with no local
  counterpart, set the manifest to the resulting list.
- **Import**: copy repo themes over the user dir (overwrite by name).
  Deletions propagate via the manifest plus local bookkeeping: a local
  sync-state file remembers the manifest from the last sync; a theme
  present in that remembered manifest but absent from the pulled one
  was deleted on another machine, so delete it locally. A purely local
  theme (created here, never synced) is untouched by import and joins
  the repo on the next export.
- After an import that changed anything, emit the settings-changed and
  themes-changed events so the UI refetches.

## Sync engine and git mechanics

Split along the project's standard seam:

- **Git sequences live in legit-core** as a sync-dedicated module over
  `GitExecutor` (same pattern as `cli_impl` domains): `sync_pull`
  (fetch + rebase, fast-fail), `sync_commit` (add -A on the two known
  paths, commit when the tree changed), `sync_push` (push; classify
  non-fast-forward), plus the pure decision functions (did the pull
  change the file, is the repo in a conflicted state). Both test gates
  apply: `FakeExecutor` flow tests for the exact command sequences and
  `tests/git_flows.rs` cases against the real binary (incl. the
  rejected-push -> pull --rebase -> retry path and a rebase conflict).
- **The engine lives in src-tauri** (`sync.rs`): debounce (about 2s)
  after each `persist_global_settings`/theme write, the state machine
  (InSync / Ahead / Offline / Conflict / Error with message; a network
  failure is Offline, quiet and expected, never Error), the startup import
  (a detached task that never delays or blocks the app; it is NOT killed on
  a timeout, because aborting git mid-rebase/mid-commit would leave
  REBASE_HEAD or index.lock behind - the status simply reads Offline until
  the import reports), and `sync-state.json` in app-data (last manifest,
  timestamps). All cycles are serialized behind one engine mutex: the
  debounced export must never write the working tree while a pull runs.
- Commits are made with a fixed per-invocation env identity
  (`GIT_AUTHOR_NAME`/`GIT_COMMITTER_NAME` "LeGit Sync", matching email),
  so sync never depends on the machine's git config. Message:
  "Sync settings". Network ops run with the same credential-broker env
  as repo sessions, so SSH keys and askpass prompts work; auth prompts
  can appear at startup or after a change, never at shutdown.
- Push failure handling: on non-fast-forward, one `pull --rebase` then
  one retry push. On rebase conflict: abort the rebase is NOT done
  automatically (the conflict markers are the user's merge input);
  state becomes Conflict, local values keep running, and the notice
  offers "Open sync repo in LeGit" - recovery is the app's own normal
  git workflow. Any other failure: state Error with git's stderr
  (formatAppError rules apply), repo stays ahead, next change or "Sync
  now" retries.
- Failures toast once per distinct state change, not per retry.

## Designating the repo (first run)

A new global setting `settings_sync_path: Option<String>` (set via its
own command, not the generic patch: changing it has side effects).
Validation on set: the path exists, is a git repo (`.git` present), and
has a remote. Then:

- Repo already contains `legit-sync.json`: ADOPT - import it over the
  local settings. The confirm dialog says exactly that ("replaces this
  machine's synced preferences with the repo's").
- Repo is empty of sync files: SEED - export the local settings as the
  first commit and push.

The dialog always shows which direction will run (workflow prompt:
always shown, not gated by the destructive-confirmation setting).
Clearing the path stops syncing and leaves both sides as they are.

## Settings UI

One new section, Global Settings > Application > "Settings sync"
(manifest entry + section component, keywords: sync, share, machines,
computers, git, repository):

- Path row: current path, "Choose..." (Tauri dialog), "Stop syncing".
- Status readout: In sync (last sync time) / Ahead, push failed /
  Conflict / Error, with the message, plus "Sync now" and "Open sync
  repo in LeGit" buttons (the latter opens it as a normal repo tab).

## What can go wrong, and what happens

| Situation | Behavior |
| --- | --- |
| Offline session | Commits accumulate locally; state Offline; pushed on next successful sync |
| Startup pull slow or failing (network) | App runs with local state; status Offline, no toast; the detached import updates the status whenever it finishes |
| Auth failure (revoked key, expired token) | State Error with git's message - loud, never a quiet Offline |
| Push rejected (other machine pushed) | pull --rebase, retry once; usually resolves silently |
| Rebase conflict (same key changed on two machines while offline) | State Conflict, local values win at runtime, user resolves in LeGit itself |
| Sync repo deleted/moved on disk | State Error with the IO message; settings keep working locally |
| Malformed/out-of-range values pulled | Unknown keys ignored, values clamped by `normalized()` |

## Testing

- Pure functions, unit-tested: the strip/merge of settings JSON, the
  never-synced classification pin, the theme manifest diff (what to
  copy, what to delete), sync-state transitions.
- `flow_tests/sync.rs`: exact command sequences for pull/commit/push,
  the rejected-push retry, "no commit when nothing changed", the env
  identity on commits.
- `tests/git_flows.rs`: real-git cases for the full cycle between two
  clones of a bare fixture, incl. offline divergence converging via
  rebase and a genuine conflict reaching the Conflict state.
- Frontend: settings section renders per state; manifest integrity
  suites cover the new entry.
