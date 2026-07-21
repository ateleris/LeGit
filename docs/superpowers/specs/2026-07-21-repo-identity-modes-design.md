# Repo identity modes (Global / Profile / Custom) - design

Status: approved design, 2026-07-21. Companion to the profile-flow-cleanup plan
(`docs/superpowers/plans/2026-07-21-profile-flow-cleanup.md`), which should land
first (shared profile query, delete confirmation, in-use warning).

## Problem

Repo Settings currently has two overlapping surfaces for the same git config
keys:

- `RepoProfileSection`: pick "Use global config" or a profile; applying writes
  the 8 managed keys to `.git/config`.
- `SigningSettings scope="repo"`: a standalone editor that writes signing keys
  to `.git/config` regardless of profile state.

Editing the signing section while a profile is applied silently creates Drift
from that profile. There is also no repo-scope editor for identity or
credential.helper outside profiles: a repo with hand-made local config shows as
"Unmanaged" (a warning state) with no way to edit it in place, only "save as
profile" or overwrite.

Global Settings solved the same shape of problem with one combined, edit-only
"Identity, signing & credentials (global)" form (`GlobalGitConfigSection`,
see `design/2026-07-13-global-default-profile.md`).

## Decision

Repo Settings gets ONE section for identity/signing/credentials with three
mutually exclusive modes, selected by a dropdown:

1. **Use global config** (inherit): no local overrides.
2. **A profile**: the profile manages the keys (today's Active).
3. **Custom (this repo)**: deliberate local config, edited in a repo-scope
   twin of the combined global form.

The combined editor is shown ONLY in Custom mode. In Global and Profile modes
the section shows a collapsed, expandable read-only summary of the effective
values instead. The standalone `SigningSettings scope="repo"` section is
removed from Repo Settings (the component remains for Global Settings).

### Mode model: purely detection-driven (no new stored state, no drift)

The mode is computed from the repo's live local config by key matching alone.
There is NO drift concept anywhere: as soon as the local config does not
exactly match a profile, it IS custom. `compute_match` simplifies to three
kinds:

- `inherit` (no managed keys set locally) -> **Global**
- `active` (local config exactly matches a profile's keys) -> **Profile**
- `custom` (some managed keys set, matching no profile) -> **Custom**

Today's "Unmanaged" and "Drift" states both become plain Custom: warning
states promoted to a first-class mode with an editor. The drift kind, its
per-key diff payload, and every "diverged from profile X" reference are
removed from backend and UI.

The stored `git_profile_id` keeps exactly one job: tiebreaker when the local
config exactly matches more than one profile (identical definitions). It is
set by apply/clone as today and cleared by "Use global config"; nothing else
reads or writes it, and a stale hint has no visible effect. There is no stored mode enum: live config
stays the single source of truth (the stored `git_profile_id` remains a hint,
exactly as documented in `state.rs`), so terminal edits can never make the
selector lie. Consequences accepted as honest behavior:

- A Custom config whose keys are all empty IS Global, and shows as Global.
- A Custom config that exactly matches profile X shows as profile X.

### Decisions from the design discussion

- **Non-custom UI:** collapsed, expandable summary (not always-open, not
  hidden). Expanding shows read-only rows of the effective managed keys plus
  an "Edit in Global Settings" link that summons the Global Settings panel
  (profile mode scrolls to the profiles section; global mode to the combined
  form).
- **Switching to Custom is non-destructive and write-free:** picking Custom
  just opens the editor prefilled with the current live local values; no
  backend call at all. The mode flips to Custom the moment a save makes the
  config match no profile. "Like profile X but tweak one key" is select
  Custom, change the key, save. (Selecting Custom and saving nothing leaves
  detection unchanged, which is honest: nothing changed.)
- **Custom edits all 8 profile keys**, including the auth SSH key
  (`core.sshCommand`): repo scope is exactly where SSH auth belongs. This is
  one key more than the global form, which deliberately never writes
  `core.sshCommand` globally.

## UI specification

### Section: "Identity, signing & credentials (this repo)"

Lives in Repo Settings' Git group, replacing `RepoProfileSection` and the
repo-scope `SigningSettings` entry. Content top to bottom:

1. **Status badge:** `Active: <profile>` (success colour), `Custom (this
   repo)` (neutral), or `Inherit (global identity)` with the
   resolved-identity note / nothing-set warning. No drift badge exists.
2. **Mode dropdown:** `Use global config` | one entry per profile | `Custom
   (this repo)`. Value reflects the detected mode.
3. **Mode body:**
   - **Global / Profile:** collapsed summary row ("Show effective values")
     expanding to read-only rows for the 8 managed keys. Profile mode shows
     the profile's defined values; Global mode shows the inherited values
     (global scope, falling back to system). Below the rows: an "Edit in
     Global Settings" link (uses `summon`). No inputs.
   - **Custom:** the combined editor (below).

### Mode transitions (all detection-honest actions)

- **-> Profile:** existing flow unchanged: preview diff, confirm, apply
  (`preview_apply_profile` + `apply_profile_to_repo`).
- **-> Global:** existing flow unchanged: confirm, unset all managed keys,
  clear the stored hint (`clear_repo_profile`). Destructive-gated as today.
- **-> Custom:** pure UI: the editor opens prefilled with the live local
  values. No backend call, no confirm (nothing is destroyed). Detection
  flips to Custom when a save diverges from every profile.

A repo whose config was edited outside LeGit (terminal, another tool) simply
shows as Custom with the editor prefilled from the live values; re-selecting
a profile in the dropdown re-applies it (existing preview + confirm). No
separate remediation UI.

### Custom editor

Repo-scope twin of `GlobalGitConfigSection`, one bordered form, single Save:

- Fields: `user.name`, `user.email`, `commit.gpgsign` (radio on/off/unset),
  `gpg.format` (radio ssh/openpgp/x509/unset), `user.signingkey` (with
  Browse), `gpg.ssh.allowedSignersFile` (with Browse, shown when format is
  ssh), auth SSH key (`core.sshCommand`, with Browse + the profile editor's
  "Generate new key" tools), `credential.helper` (via the shared
  `CredentialHelperField`).
- Reuses the exported primitives: `ConfigRow`, `ResolvedBadge`, `RadioGroup`
  (from `SigningSettings.tsx`), `Field`/`WithBrowse` (from the profile
  editor), `CredentialHelperField`, `GenerateSshKeyForm`/`SshKeyActions`.
- Empty field = unset at local scope (falls back to global/system); the
  inherited value is shown as placeholder/badge per key.
- **Preview and confirm before writing**, like the global form: the confirm
  lists every key change (`local -> draft`); only changed keys are written.
- "Save as profile" stays available in Custom mode (existing
  `create_profile_from_repo`), which also selects the new profile (mode
  flips to Profile/Active).

### Global Settings reorder

In `GlobalSettingsPanel.tsx`, the Git group order changes from

```
Git executable / GlobalGitConfigSection / ConnectedAccountsSection / LineEndings / GlobalProfilesSection
```

to

```
Git executable / ConnectedAccountsSection / GlobalGitConfigSection / LineEndings / GlobalProfilesSection
```

(a one-line swap: "Connected accounts" moves between "Git executable (default
for all repos)" and "Identity, signing & credentials (global)").

## Backend specification

All in `src-tauri/src/commands/profiles.rs` unless noted. `ManagedKeys`
already crosses IPC (inside `ProfileStatus`) and is reused as the draft type.

1. **`repo_managed_config_view(repo_id) -> ManagedConfigView`**
   Read-only. `ManagedConfigView { local: ManagedKeys, inherited: ManagedKeys }`.
   `local` via the existing `read_local_managed`. `inherited` reads each key
   at global scope with system-scope fallback (existing `read_config_scope`
   with `--global` / `--system`); `credential_helper` uses the existing
   last-non-empty-entry rule from `credential_helper.rs`. Serves the
   Global-mode summary and the Custom editor's prefill + placeholders.
2. **`write_repo_managed_config(repo_id, draft: ManagedKeys) -> ProfileStatus`**
   Writes only the keys that differ from current local values (same
   set/unset mechanics as `write_managed`, selection via the existing pure
   `diff_keys`) and returns the refreshed status. Does not touch the stored
   `git_profile_id` (it is only a match tiebreaker). The auth SSH key writes
   through the existing `synth_ssh_command` round-trip. No separate preview
   command: the editor computes its confirm list client-side exactly like
   `GlobalGitConfigSection` does, and the server-side diff makes the write
   correct regardless.
3. **`compute_match` simplification (existing code):** the `drift` kind and
   its `diffs` payload are removed; `unmanaged` is renamed to `custom`. The
   resulting kinds are `active` (with the tiebreaking rule above), `custom`,
   and `inherit`. `ProfileStatus` and the hand-mirrored TypeScript type
   shrink accordingly; existing `compute_match` unit tests are updated, not
   deleted.

Registration: `collect_commands![]` in `src-tauri/src/lib.rs` + hand-written
wrappers in `src/lib/commands.ts` + hand-mirrored types (`ManagedConfigView`)
in `src/lib/types.ts`.

## Frontend structure

- Create `src/panels/Settings/RepoIdentitySection.tsx`: the new section
  (mode dropdown, badge, transitions) plus two focused subcomponents:
  `EffectiveValuesSummary` (collapsed read-only view, shared by Global and
  Profile modes) and `CustomConfigEditor` (the combined form). If the file
  grows past a comfortable size, the subcomponents move to sibling files.
- Delete `src/panels/Settings/RepoProfileSection.tsx` (logic absorbed).
- `RepoSettingsPanel.tsx`: render `RepoIdentitySection`, drop the
  `SigningSettings scope="repo"` line.
- `SigningSettings.tsx`: the repo-scope branch becomes dead; remove the
  `scope="repo"` code path (keep the global branch and the exported
  primitives).
- Profile list via the shared `useGitProfiles()` query (from the
  profile-flow-cleanup plan); profile mutations continue to invalidate it,
  which re-derives the detected mode (the section reloads its status when
  the profile list changes).
- `GlobalSettingsPanel.tsx`: the Connected-accounts swap (above).

## Error handling

- All command failures surface through `formatAppError` in the section's
  existing error slot; git's stderr must remain visible.
- The Custom save confirm is busy-guarded like the profile apply flow
  (re-entry guard, delayed busy indicator per the 150 ms convention).
- `write_repo_managed_config` failures mid-write leave a partially written
  config; the returned error prefixes the failing key into the git error
  text (small `note_failed_key` helper preserving the `GitError` variant and
  stderr) and the section refreshes its status afterwards regardless (the
  detection model keeps the UI honest even after a partial write).

## Testing

- **Pure unit tests (Rust):** mode classification is already covered by
  `compute_match` tests; add cases asserting the write-only-diffs key
  selection for `write_repo_managed_config` (pure helper extracted, e.g.
  `keys_to_write(local, draft) -> Vec<..>`), and `ManagedConfigView`
  inherited-coalescing (global beats system per key).
- **Pure write-selection tests (Rust, in `profiles.rs`):** `src-tauri`
  commands call `GitRunner` directly (no executor seam there), so the
  "which keys get written" decision is tested purely: `diff_keys` with a
  mixed draft (one set, one unset, six untouched) returns exactly the two
  expected entries, and `normalize_draft` trims/nullifies and normalizes
  the auth key path. The write loop is a trivial map over that diff.
- **Real-git harness (`tests/git_flows.rs`):** custom write round-trip in a
  tempdir repo: write two keys locally, verify `git config --local` sees
  them and resolution falls back to global for the rest; unset via empty
  draft returns resolution to global values.
- **Frontend (vitest):** pure mode-mapping helper (`ProfileStatus["match"]`
  kind -> dropdown value) unit-tested; theme contract suites must stay green
  (no new tokens expected; the section reuses existing ones).
- **Manual smoke (user, from PowerShell):** switch a repo through all three
  modes; edit `.git/config` in a terminal while a profile is active and
  confirm the section shows plain Custom with the editor prefilled;
  re-apply the profile from the dropdown; custom-edit one key on top of a
  former profile; save as profile; confirm Global Settings section order.

## Out of scope

- No change to profile CRUD, clone/init profile pickers, or the global form.
- No stored mode enum, no migration of existing `settings.json` files
  (existing `git_profile_id` hints keep working unchanged).
- Line endings stay a separate section at both scopes (deliberate, per the
  global-identity design note).
- BACKLOG candidates if they come up later: multi-value credential.helper
  editing at repo scope; per-key "reset to inherited" buttons in the custom
  editor.
