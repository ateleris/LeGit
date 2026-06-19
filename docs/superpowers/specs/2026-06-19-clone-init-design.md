# Clone / Init — design

**Date:** 2026-06-19
**Status:** Approved (design); pending implementation plan.

## Context

LeGit can open existing repositories and now manage remotes and sync, but it
cannot **acquire** a repo from scratch — BACKLOG §5 ("Getting a repo": clone,
init). This is the capstone of the remote-handling work: clone a remote repo or
init a new one, then open it. Both flow into the existing repo-open path.

## Scope

**In:**
- **Init** a new repo in a chosen directory, then open + activate it.
- **Clone** a URL into a chosen directory, then open + activate it. Busy state +
  **Cancel** (clone is the network op; init is local/instant).
- **Optional profile** on both: a selector whose first/default item is a built-in
  **"Use global config"** sentinel, followed by the user's profiles. Picking a
  real profile injects its auth into the clone (`git clone -c …`) and **applies
  it to the new repo** afterward — writing its managed keys to local config **and
  recording it as the repo's selected profile** (`git_profile_id`), so it shows
  as active in Repo Settings. For init, the chosen profile is applied (and
  selected) after creation. The sentinel means "no profile" — clone/init use
  global config and write no managed keys.

**Out (not now):**
- Live streaming clone progress (busy + Cancel only).
- Clone options like `--depth`, `--branch`, `--recurse-submodules`.
- `git init --bare` / initial-branch selection.

## Key decisions

1. **No `GitBackend`/parser changes.** clone/init aren't repo-scoped — no session
   or backend exists yet. They run a **transient `GitRunner`** directly in the
   command layer (exactly how `open_repo` already probes with a raw runner), then
   funnel into the existing open/register flow.

2. **Profile auth at clone time via `-c`.** The repo doesn't exist yet, so a
   profile can't be "applied" first. Instead its auth keys are injected as
   per-command config: `git clone -c core.sshCommand="ssh -i <key> …"
   -c credential.helper="" -c credential.helper=<helper> <url> <target>`
   (the empty `credential.helper` resets inherited global helpers, mirroring
   `write_credential_helper`). After the clone succeeds and the repo opens, the
   profile is **applied** to it — writing all managed keys to local config **and
   recording it as the repo's selected profile** (`git_profile_id`), so Repo
   Settings shows it as active. Selecting None skips both — clone uses global
   config.

3. **Session-less cancellation.** `AppState` gains
   `transient_ops: Mutex<HashMap<OperationId, Arc<GitRunner>>>`. `repo_clone`
   registers its runner before running, removes it after; `cancel_clone(op_id)`
   looks it up and calls `runner.cancel()`. (Reusable for any future
   session-less network op.)

## Architecture

### Backend — `src-tauri`

- **Refactor** `commands/repo.rs`: extract the register half of `open_repo`
  (probe `rev-parse --show-toplevel` → reuse-or-`open_session` →
  recent/`currently_open`/active bookkeeping) into a shared
  `register_open_repo(state, app, git_path, probe_path) -> RepoSummary`.
  `open_repo` calls it.
- `repo_init(path, profile_id: Option<String>) -> RepoSummary`:
  `git init <path>` (transient runner) → `register_open_repo` → if `profile_id`,
  apply it to the new session → return summary. Local/instant.
- `repo_clone(url, parent_dir, name, profile_id: Option<String>, op_id) ->
  RepoSummary`:
  - Build args: `["clone"]` + the profile's auth `-c` overrides (if any) + `url`
    + `name`; cwd = `parent_dir`.
  - Register the transient runner in `transient_ops[op_id]`; `run_with_op`;
    remove in a `finally`-style guard.
  - On success: `register_open_repo(parent_dir/name)`; if `profile_id`, apply it;
    return summary. Map failures via `classify_remote_error`.
- `cancel_clone(op_id) -> bool` — `transient_ops` lookup → `runner.cancel()`.
- Register `repo_init`, `repo_clone`, `cancel_clone` in `lib.rs`.

**Supporting extractions (reuse, not new logic):**
- Make `classify_remote_error` **`pub`** in `legit-core` (re-exported) so the
  clone command can reuse it (today it's private to `cli_impl`).
- In `commands/profiles.rs`: add `pub fn clone_auth_config_args(&GitProfile) ->
  Vec<String>` returning the `-c key=value` token pairs for `core.sshCommand`
  (reusing `synth_ssh_command`) and `credential.helper` (reset-then-set). Extract
  `apply_profile_core(&AppState, &RepoSession, profile_id)` from
  `apply_profile_to_repo` so `repo_init`/`repo_clone` apply a profile without
  going through the command wrapper. This helper keeps **both** halves of the
  existing apply flow — `write_managed` (managed keys → local config) **and**
  `set_repo_profile_id` (record `git_profile_id`) — so the cloned/init'd repo
  shows the chosen profile as active in Repo Settings.

### Frontend

- `commands.ts`: `repoInit(path, profileId)`, `repoClone(url, parentDir, name,
  profileId, opId)`, `cancelClone(opId)`.
- **Repositories panel** (`src/panels/Repositories/RepositoriesPanel.tsx`): add
  **Clone…** and **Init…** buttons beside "Open repository…", each toggling an
  inline form. Fetch profiles once via `listGitProfiles()` to populate the
  selector; its first item is the **"Use global config"** sentinel (default,
  maps to `profile_id = null`), then the user's profiles.
  - *Clone form:* URL, parent dir (Browse), auto-derived editable **target name**
    (from the URL: strip trailing `.git` and `/`, take the last path segment),
    **Profile** select (sentinel default), Clone → spinner + **Cancel**
    (frontend-minted `op_id` + `cancelClone`).
  - *Init form:* directory (Browse), **Profile** select (sentinel default), Init.
  - On success: `refresh()` + activate the new repo (the backend already did the
    open bookkeeping). Errors render in the panel's existing error area; a
    cancelled clone shows no error.

- **Profile-selector consistency (`RepoProfileSection`)**: relabel the existing
  "Inherit (no profile)" option to **"Use global config"** so the sentinel reads
  the same everywhere. Behavior is unchanged — selecting it still calls
  `clear_repo_profile` (unset local managed keys + drop `git_profile_id`), which
  is exactly "delete local settings so global is used". No backend change.

## Error handling

- Clone auth/rejection → `classify_remote_error` → inline message. For
  `AuthFailed` with no profile selected, the hint suggests selecting a profile or
  fixing global credentials.
- Init/clone into a non-empty or existing target → git's error shown inline.
- Cancelled clone → no error toast/message.

## Testing

- **Rust unit:** `clone_auth_config_args` — none / ssh-only / helper-only / both
  produce the expected `-c` tokens (helper case includes the empty reset entry).
- **Build:** `cargo test` + `cargo check`; `tsc --noEmit` clean; bindings
  regenerate the three commands.
- **Manual:** init a new folder (with/without profile) → repo opens & activates,
  identity set when a profile was chosen; clone a public repo (None) → busy →
  opens; clone a private repo with the right profile → authenticates, opens, and
  the profile is applied (local config has its keys); clone with no/wrong creds →
  inline `AuthFailed`; **Cancel** a slow clone aborts it.

## Out-of-scope follow-ups (BACKLOG)

- Streaming clone progress (%).
- Clone options: `--depth`, `--branch`, submodules.
- `git init --bare`, initial-branch name.
