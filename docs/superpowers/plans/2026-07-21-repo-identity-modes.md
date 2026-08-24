# Repo Identity Modes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Do NOT use subagent-driven-development (user rule).

**Goal:** One Repo Settings section with three detection-driven modes (Global / Profile / Custom) for identity, signing and credentials; no drift concept; combined repo-scope editor shown only in Custom mode; Connected accounts reordered in Global Settings.

**Architecture:** `compute_match` shrinks to three kinds (`inherit`/`active`/`custom`), computed from live local config by key matching alone (stored `git_profile_id` only tiebreaks identical profiles). A new read-only view command supplies local + inherited managed keys; a new write command persists only the keys a custom draft changes. The frontend replaces `RepoProfileSection` and the repo-scope `SigningSettings` with one `RepoIdentitySection` that shows a collapsed read-only summary in Global/Profile modes and a combined editor (modeled on `GlobalGitConfigSection`) in Custom mode.

**Tech Stack:** Rust + Tauri 2 commands (src-tauri), React 19 + TypeScript + @tanstack/react-query 5, vitest + cargo test.

**Spec:** `docs/superpowers/specs/2026-07-21-repo-identity-modes-design.md`

## Global Constraints

- Do NOT commit or push at any point. Leave all changes unstaged for the user's review (user rule, overrides the usual commit-per-task steps).
- No em-dashes in any generated text, code comments, or docs. Use hyphens or restructure. (Existing lines you do not touch may keep theirs.)
- PREREQUISITE: the profile-flow-cleanup plan (`docs/superpowers/plans/2026-07-21-profile-flow-cleanup.md`) is executed first. This plan consumes `useGitProfiles`/`invalidateGitProfiles` from `src/lib/useGitProfiles.ts` and assumes `repos_using_profile` is already registered in `collect_commands![]`.
- Every colour from theme tokens (`var(--token)`); this plan reuses existing tokens only (`--fz-sm`, `--fz-md`, `--subtle-fg`, `--success-fg`, `--panel-border`, `--button-hover-bg`, `--error-fg`).
- New IPC commands go in BOTH places: `collect_commands![]` in `src-tauri/src/lib.rs` AND hand-written wrappers in `src/lib/commands.ts`, with types hand-mirrored in `src/lib/types.ts` (never edit `bindings.ts` by hand).
- Run vitest from WSL via PowerShell interop: `powershell.exe -NoProfile -Command "Set-Location <repo>; npx vitest run <file>"`. `cargo test` and `npx tsc --noEmit` run directly in WSL.
- Rust code in this plan uses `->` in prose comments, never an em-dash.

---

### Task 1: Backend: remove drift from `ProfileMatch`

**Files:**
- Modify: `src-tauri/src/commands/profiles.rs` (module doc line 11, enum at lines 54-66, `compute_match` at lines 239-270, tests at lines 762-805)

**Interfaces:**
- Produces: `ProfileMatch` with exactly three variants: `Inherit`, `Active { profile_id: String }`, `Custom`. Serialized kinds (serde `tag = "kind"`, snake_case): `"inherit"`, `"active"`, `"custom"`. Task 4 mirrors this in TypeScript.
- `KeyDiff` and `diff_keys` remain (used by `preview_apply_profile` and Task 3).

- [ ] **Step 1: Update the tests to the three-kind model (they will fail to compile)**

In the `mod tests` of `src-tauri/src/commands/profiles.rs`, replace the three tests `match_drift_when_stored_diverges`, `match_unmanaged_when_no_profile_and_no_stored`, and `match_stale_stored_id_falls_back` with:

```rust
    #[test]
    fn match_custom_when_stored_profile_diverges() {
        // Formerly "drift": the config matches no profile, so it IS custom.
        let profiles = vec![signing_profile("p1", "work@x.com")];
        let local = email_only_local(Some("personal@y.com"));
        let m = compute_match(&local, &profiles, Some("p1"));
        assert!(matches!(m, ProfileMatch::Custom));
    }

    #[test]
    fn match_custom_when_no_profile_and_no_stored() {
        let profiles = vec![signing_profile("p1", "work@x.com")];
        let local = email_only_local(Some("nobody@z.com"));
        let m = compute_match(&local, &profiles, None);
        assert!(matches!(m, ProfileMatch::Custom));
    }

    #[test]
    fn match_stale_stored_id_is_custom() {
        // Stored id references a deleted profile; local matches no profile.
        let profiles = vec![signing_profile("p1", "work@x.com")];
        let local = email_only_local(Some("orphan@z.com"));
        let m = compute_match(&local, &profiles, Some("deleted-id"));
        assert!(matches!(m, ProfileMatch::Custom));
    }
```

Keep `match_inherit_when_all_unset`, `match_active_when_local_equals_projection`, and `match_prefers_stored_among_duplicates` unchanged.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p legit-app match_`
Expected: FAIL to compile (`ProfileMatch::Custom` not found)

- [ ] **Step 3: Shrink the enum and `compute_match`**

Replace the `ProfileMatch` enum (lines 54-66):

```rust
/// How the repo's live local config relates to the defined profiles.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ProfileMatch {
    /// No managed keys set locally - repo uses inherited (global) identity.
    Inherit,
    /// Local config exactly equals a profile's projection (the stored
    /// `git_profile_id` only tiebreaks identical profiles).
    Active { profile_id: String },
    /// Local has managed values matching no profile: a deliberate (or
    /// externally made) repo-specific configuration.
    Custom,
}
```

Replace `compute_match` (lines 239-270):

```rust
/// Compute the active/custom/inherit relationship (pure; unit-tested).
fn compute_match(
    local: &ManagedKeys,
    profiles: &[GitProfile],
    stored_id: Option<&str>,
) -> ProfileMatch {
    if is_all_unset(local) {
        return ProfileMatch::Inherit;
    }
    // Prefer the stored profile when it matches exactly (tiebreaker for
    // profiles with identical definitions).
    if let Some(sid) = stored_id {
        if let Some(p) = profiles.iter().find(|p| p.id == sid) {
            if projection(p) == *local {
                return ProfileMatch::Active { profile_id: sid.to_string() };
            }
        }
    }
    // Any profile matching exactly -> active.
    if let Some(p) = profiles.iter().find(|p| projection(p) == *local) {
        return ProfileMatch::Active { profile_id: p.id.clone() };
    }
    ProfileMatch::Custom
}
```

Update the module doc (line 11): replace `config degrades gracefully (drift/unmanaged) rather than lying.` with `config degrades gracefully (shown as custom) rather than lying.`

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p legit-app`
Expected: all PASS (the six `match_*` tests plus the rest of the crate)

---

### Task 2: Backend: `repo_managed_config_view`

**Files:**
- Modify: `src-tauri/src/commands/profiles.rs` (generalize `read_local_managed`, add `coalesce_inherited`, `ManagedConfigView`, the command, tests)
- Modify: `src-tauri/src/commands/credential_helper.rs:43` (`read_helper_at` visibility)
- Modify: `src-tauri/src/lib.rs` (`collect_commands![]`, after `commands::repos_using_profile`)
- Modify: `src/lib/commands.ts` and `src/lib/types.ts` (wrapper + mirror)

**Interfaces:**
- Consumes: `read_config_scope(runner, key, flags)` from `config_util.rs`; `read_helper_at(runner, flag)` from `credential_helper.rs`.
- Produces: IPC command `repo_managed_config_view(repo_id) -> ManagedConfigView { local: ManagedKeys, inherited: ManagedKeys }`; TS wrapper `repoManagedConfigView(repoId: string): Promise<ManagedConfigView>`; Rust fn `read_managed_scope(runner, flag)` reused by Task 3. Tasks 6-7 consume the wrapper.

- [ ] **Step 1: Write the failing coalescing test**

Append inside `mod tests` in `profiles.rs`:

```rust
    #[test]
    fn inherited_coalescing_global_beats_system() {
        let global = ManagedKeys {
            user_name: Some("Global Name".into()),
            ..ManagedKeys::all_unset()
        };
        let system = ManagedKeys {
            user_name: Some("System Name".into()),
            credential_helper: Some("manager".into()),
            ..ManagedKeys::all_unset()
        };
        let merged = coalesce_inherited(global, system);
        // Global wins where both are set; system fills the gaps.
        assert_eq!(merged.user_name.as_deref(), Some("Global Name"));
        assert_eq!(merged.credential_helper.as_deref(), Some("manager"));
        assert_eq!(merged.user_email, None);
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p legit-app inherited_coalescing`
Expected: FAIL to compile (`coalesce_inherited` not found)

- [ ] **Step 3: Implement scope-parametrized read, coalescing, and the command**

In `credential_helper.rs`, change line 43 from `async fn read_helper_at(` to `pub(crate) async fn read_helper_at(`.

In `profiles.rs`, replace `read_local_managed` (lines 105-132) and DELETE `read_local_credential_helper` (lines 134-153, now redundant: `read_helper_at(runner, "--local")` does the same `--get-all` + last-non-empty read):

```rust
/// Read the eight managed keys at one config scope (`--local`, `--global`,
/// or `--system`). For `core.sshCommand`, parse out the key path; if it isn't
/// a LeGit-shaped `ssh -i ...` command, keep the raw command string (so it
/// shows as a mismatch rather than a false match).
///
/// Profiles read and write LOCAL scope only, by decision: global scope holds
/// at most a directly edited identity (see `global_identity_view`), never a
/// profile's auth/signing bundle, so a machine-wide `credential.helper` or
/// `core.sshCommand` can't be applied by one click. The global/system reads
/// exist for the repo section's "inherited" view.
async fn read_managed_scope(runner: &GitRunner, flag: &'static str) -> ManagedKeys {
    let at = |key: &'static str| async move {
        read_config_scope(runner, key, &[flag]).await.value
    };
    let ssh_raw = at(KEY_SSH_COMMAND).await;
    ManagedKeys {
        user_name: at(KEY_USER_NAME).await,
        user_email: at(KEY_USER_EMAIL).await,
        gpg_format: at(signing::KEY_FORMAT).await,
        signing_key: at(signing::KEY_SIGNING_KEY).await,
        commit_gpgsign: at(signing::KEY_GPGSIGN).await,
        allowed_signers_file: at(signing::KEY_ALLOWED_SIGNERS).await,
        auth_ssh_key: ssh_raw.map(|cmd| {
            parse_ssh_key_from_command(&cmd)
                .map(|p| normalize_key_path(&p))
                .unwrap_or(cmd)
        }),
        credential_helper: crate::commands::credential_helper::read_helper_at(runner, flag).await,
    }
}

async fn read_local_managed(runner: &GitRunner) -> ManagedKeys {
    read_managed_scope(runner, "--local").await
}

/// Pure: per-key scope precedence for the inherited view (global beats system).
fn coalesce_inherited(global: ManagedKeys, system: ManagedKeys) -> ManagedKeys {
    ManagedKeys {
        user_name: global.user_name.or(system.user_name),
        user_email: global.user_email.or(system.user_email),
        gpg_format: global.gpg_format.or(system.gpg_format),
        signing_key: global.signing_key.or(system.signing_key),
        commit_gpgsign: global.commit_gpgsign.or(system.commit_gpgsign),
        allowed_signers_file: global.allowed_signers_file.or(system.allowed_signers_file),
        auth_ssh_key: global.auth_ssh_key.or(system.auth_ssh_key),
        credential_helper: global.credential_helper.or(system.credential_helper),
    }
}
```

Add next to the frontend-facing types (after `ProfileStatus`):

```rust
/// The repo section's data: live LOCAL values plus what the repo would
/// inherit without them (global scope, falling back to system).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct ManagedConfigView {
    pub local: ManagedKeys,
    pub inherited: ManagedKeys,
}
```

Add the command next to `detect_active_profile_for_repo`:

```rust
/// Read-only: local + inherited managed keys, for the repo identity section
/// (Global-mode summary, Custom-editor prefill and placeholders).
#[tauri::command]
#[specta::specta]
pub async fn repo_managed_config_view(
    state: tauri::State<'_, AppState>,
    repo_id: String,
) -> Result<ManagedConfigView, AppError> {
    let session = state.get_session(&repo_id).await?;
    let runner = session.runner.read().await.clone();
    let local = read_managed_scope(&runner, "--local").await;
    let global = read_managed_scope(&runner, "--global").await;
    let system = read_managed_scope(&runner, "--system").await;
    Ok(ManagedConfigView { local, inherited: coalesce_inherited(global, system) })
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p legit-app`
Expected: all PASS (including `inherited_coalescing_global_beats_system`)

- [ ] **Step 5: Register + wrap**

In `src-tauri/src/lib.rs`, inside `collect_commands![]`, after `commands::repos_using_profile,` add:

```rust
        commands::repo_managed_config_view,
```

(If `src-tauri/src/commands/mod.rs` re-exports profiles explicitly rather than via `pub use profiles::*;`, add `repo_managed_config_view` there too.)

Run: `cargo build -p legit-app`
Expected: compiles

In `src/lib/types.ts`, after the `ProfileStatus` interface add:

```ts
/** Local + inherited (global, falling back to system) managed keys. */
export interface ManagedConfigView {
  local: ManagedKeys;
  inherited: ManagedKeys;
}
```

In `src/lib/commands.ts`, next to the other profile wrappers:

```ts
export const repoManagedConfigView = (repoId: string) =>
  invoke<ManagedConfigView>("repo_managed_config_view", { repoId });
```

(Add `ManagedConfigView` to the type-import list at the top of `commands.ts`.)

Run: `npx tsc --noEmit`
Expected: no errors

---

### Task 3: Backend: `write_repo_managed_config`

**Files:**
- Modify: `src-tauri/src/commands/profiles.rs` (add `normalize_draft`, `write_one_managed`, `note_failed_key`, the command, tests)
- Modify: `src-tauri/src/lib.rs` (`collect_commands![]`)
- Modify: `src/lib/commands.ts` (wrapper)
- Modify: `crates/legit-core/tests/git_flows.rs` (real-git fallback test)

**Interfaces:**
- Consumes: `read_local_managed`, `diff_keys`, `write_config_local`, `write_credential_helper`, `synth_ssh_command`, `status_for` (all existing in `profiles.rs` / `config_util.rs`).
- Produces: IPC command `write_repo_managed_config(repo_id, draft: ManagedKeys) -> ProfileStatus`; TS wrapper `writeRepoManagedConfig(repoId: string, draft: ManagedKeys): Promise<ProfileStatus>`. Task 6 consumes the wrapper.

- [ ] **Step 1: Write the failing pure tests**

Append inside `mod tests` in `profiles.rs`:

```rust
    #[test]
    fn normalize_draft_trims_and_normalizes_key_path() {
        let raw = ManagedKeys {
            user_name: Some("  Name  ".into()),
            user_email: Some("   ".into()), // whitespace-only -> unset
            auth_ssh_key: Some(r"C:\Users\s\.ssh\id".into()),
            ..ManagedKeys::all_unset()
        };
        let n = normalize_draft(&raw);
        assert_eq!(n.user_name.as_deref(), Some("Name"));
        assert_eq!(n.user_email, None);
        assert_eq!(n.auth_ssh_key.as_deref(), Some("C:/Users/s/.ssh/id"));
    }

    #[test]
    fn mixed_draft_diffs_exactly_the_changed_keys() {
        // One key set, one unset, six untouched -> exactly two diffs.
        let current = ManagedKeys {
            user_email: Some("old@x.com".into()),
            signing_key: Some("KEEP".into()),
            ..ManagedKeys::all_unset()
        };
        let draft = ManagedKeys {
            user_name: Some("New Name".into()), // set
            user_email: None,                   // unset
            signing_key: Some("KEEP".into()),   // untouched
            ..ManagedKeys::all_unset()
        };
        let diffs = diff_keys(&current, &draft);
        let keys: Vec<&str> = diffs.iter().map(|d| d.key.as_str()).collect();
        assert_eq!(keys, vec![KEY_USER_NAME, KEY_USER_EMAIL]);
        assert_eq!(diffs[0].profile.as_deref(), Some("New Name"));
        assert_eq!(diffs[1].profile, None);
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p legit-app normalize_draft`
Expected: FAIL to compile (`normalize_draft` not found)

- [ ] **Step 3: Implement**

In `profiles.rs`, next to `projection`:

```rust
/// Clean a frontend draft exactly like a profile projection: trim, treat
/// empty as unset, normalize the auth key path.
fn normalize_draft(mk: &ManagedKeys) -> ManagedKeys {
    ManagedKeys {
        user_name: clean(&mk.user_name),
        user_email: clean(&mk.user_email),
        gpg_format: clean(&mk.gpg_format),
        signing_key: clean(&mk.signing_key),
        commit_gpgsign: clean(&mk.commit_gpgsign),
        allowed_signers_file: clean(&mk.allowed_signers_file),
        auth_ssh_key: clean(&mk.auth_ssh_key).map(|p| normalize_key_path(&p)),
        credential_helper: clean(&mk.credential_helper),
    }
}
```

Next to `write_managed`:

```rust
/// Write one managed key by its git key name. The value is the projected
/// form (key PATH for the auth key; synthesized into `core.sshCommand` here,
/// mirroring `write_managed`).
async fn write_one_managed(
    runner: &GitRunner,
    key: &str,
    value: Option<&str>,
) -> Result<(), AppError> {
    match key {
        KEY_SSH_COMMAND => {
            let ssh = value.map(synth_ssh_command);
            write_config_local(runner, KEY_SSH_COMMAND, ssh.as_deref()).await
        }
        KEY_CREDENTIAL_HELPER => write_credential_helper(runner, value).await,
        k => write_config_local(runner, k, value).await,
    }
}

/// Prefix the failing key into a git error so a partial write says where it
/// stopped (the config may be partially written; detection stays honest).
fn note_failed_key(e: AppError, key: &str) -> AppError {
    match e {
        AppError::Git(GitError::CommandFailed { exit_code, stderr }) => {
            AppError::Git(GitError::CommandFailed {
                exit_code,
                stderr: format!("while writing {key}: {stderr}"),
            })
        }
        other => other,
    }
}
```

The command, next to `clear_repo_profile`:

```rust
/// Custom-mode save: write only the keys the draft changes (relative to the
/// live local config) and return the refreshed status. Never touches the
/// stored `git_profile_id` (it is only a match tiebreaker).
#[tauri::command]
#[specta::specta]
pub async fn write_repo_managed_config(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    draft: ManagedKeys,
) -> Result<ProfileStatus, AppError> {
    let session = state.get_session(&repo_id).await?;
    let runner = session.runner.read().await.clone();
    let draft = normalize_draft(&draft);
    let current = read_local_managed(&runner).await;
    for d in diff_keys(&current, &draft) {
        // KeyDiff's `profile` side carries the draft value here.
        write_one_managed(&runner, &d.key, d.profile.as_deref())
            .await
            .map_err(|e| note_failed_key(e, &d.key))?;
    }
    let stored = session.settings.read().await.git_profile_id.clone();
    Ok(status_for(&state, &runner, stored).await)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p legit-app`
Expected: all PASS

- [ ] **Step 5: Real-git fallback test**

Append to `crates/legit-core/tests/git_flows.rs` (next to `global_config_unset_all_and_helper_round_trip`, same `GIT_CONFIG_GLOBAL` redirection technique):

```rust
/// Local-scope semantics the repo Custom editor depends on
/// (`src-tauri/commands/profiles.rs` `write_repo_managed_config`): a local
/// value overrides global, and unsetting it returns resolution to the global
/// value. `GIT_CONFIG_GLOBAL` redirects the global file into the tempdir so
/// the developer's real `~/.gitconfig` is never touched.
#[tokio::test]
async fn local_config_unset_falls_back_to_global() {
    let repo = TestRepo::init().await;
    let gcfg = repo.path.join("fake-global-config");
    let gcfg_s = gcfg.to_str().expect("utf8 tempdir path").to_string();
    let env: &[(&str, &str)] = &[("GIT_CONFIG_GLOBAL", &gcfg_s)];
    let runner = GitRunner::for_repo("git", &repo.path);

    let out = runner
        .run_with_env(&["config", "--global", "user.signingkey", "GLOBALKEY"], env)
        .await
        .expect("spawn git");
    assert!(out.success, "{}", out.stderr);
    let out = runner
        .run_with_env(&["config", "--local", "user.signingkey", "LOCALKEY"], env)
        .await
        .expect("spawn git");
    assert!(out.success, "{}", out.stderr);

    // Local wins while set...
    let out = runner
        .run_with_env(&["config", "--get", "user.signingkey"], env)
        .await
        .expect("spawn git");
    assert_eq!(out.stdout.trim(), "LOCALKEY");

    // ...and resolution falls back to global once unset.
    let out = runner
        .run_with_env(&["config", "--local", "--unset", "user.signingkey"], env)
        .await
        .expect("spawn git");
    assert!(out.success, "{}", out.stderr);
    let out = runner
        .run_with_env(&["config", "--get", "user.signingkey"], env)
        .await
        .expect("spawn git");
    assert_eq!(out.stdout.trim(), "GLOBALKEY", "unset local key must fall back to global");
}
```

Run: `cargo test -p legit-core local_config_unset_falls_back_to_global`
Expected: PASS

- [ ] **Step 6: Register + wrap**

In `src-tauri/src/lib.rs`, after `commands::repo_managed_config_view,` add:

```rust
        commands::write_repo_managed_config,
```

Run: `cargo build -p legit-app`
Expected: compiles

In `src/lib/commands.ts`:

```ts
export const writeRepoManagedConfig = (repoId: string, draft: ManagedKeys) =>
  invoke<ProfileStatus>("write_repo_managed_config", { repoId, draft });
```

(Add `ManagedKeys` to the type-import list if not already imported.)

Run: `npx tsc --noEmit`
Expected: no errors

---

### Task 4: Frontend: type mirror, mode helpers, compile patch

**Files:**
- Modify: `src/lib/types.ts:342-346` (`ProfileMatch`)
- Create: `src/panels/Settings/identityMode.ts`
- Test: `src/panels/Settings/identityMode.test.ts`
- Modify: `src/panels/Settings/RepoProfileSection.tsx` (minimal compile patch; the file is DELETED in Task 8)

**Interfaces:**
- Consumes: `ProfileMatch`, `GitProfile`, `ManagedKeys` from `src/lib/types.ts`.
- Produces: `INHERIT_VALUE`, `CUSTOM_VALUE` (dropdown sentinels), `dropdownValueFromMatch(m: ProfileMatch): string`, `profileValues(p: GitProfile): ManagedKeys`. Tasks 6-7 consume all four.

- [ ] **Step 1: Write the failing test**

```ts
// src/panels/Settings/identityMode.test.ts
import { describe, test, expect } from "vitest";
import type { GitProfile } from "../../lib/types";
import {
  INHERIT_VALUE,
  CUSTOM_VALUE,
  dropdownValueFromMatch,
  profileValues,
} from "./identityMode";

describe("dropdownValueFromMatch", () => {
  test("maps the three detection kinds onto dropdown values", () => {
    expect(dropdownValueFromMatch({ kind: "inherit" })).toBe(INHERIT_VALUE);
    expect(dropdownValueFromMatch({ kind: "active", profile_id: "p1" })).toBe("p1");
    expect(dropdownValueFromMatch({ kind: "custom" })).toBe(CUSTOM_VALUE);
  });
});

describe("profileValues", () => {
  test("projects a profile into ManagedKeys shape", () => {
    const p: GitProfile = {
      id: "p1",
      name: "Work",
      userName: "N",
      userEmail: "e@x.com",
      gpgFormat: "ssh",
      signingKey: "/k.pub",
      commitGpgsign: "true",
      allowedSignersFile: null,
      authSshKey: "/k",
      credentialHelper: "manager",
    };
    expect(profileValues(p)).toEqual({
      user_name: "N",
      user_email: "e@x.com",
      gpg_format: "ssh",
      signing_key: "/k.pub",
      commit_gpgsign: "true",
      allowed_signers_file: null,
      auth_ssh_key: "/k",
      credential_helper: "manager",
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `powershell.exe -NoProfile -Command "Set-Location <repo>; npx vitest run src/panels/Settings/identityMode.test.ts"`
Expected: FAIL (cannot resolve `./identityMode`)

- [ ] **Step 3: Update the type mirror and implement the helpers**

In `src/lib/types.ts`, replace the `ProfileMatch` type (lines 342-346):

```ts
export type ProfileMatch =
  | { kind: "inherit" }
  | { kind: "active"; profile_id: string }
  | { kind: "custom" };
```

(`KeyDiff` stays: `previewApplyProfile` still returns it.)

Create `src/panels/Settings/identityMode.ts`:

```ts
// Pure mode helpers for the repo identity section. The mode is DETECTED from
// live local config (see compute_match in src-tauri/commands/profiles.rs);
// these map the detection result onto the dropdown and the summary view.

import type { GitProfile, ManagedKeys, ProfileMatch } from "../../lib/types";

/** Dropdown sentinel: use global config (no local managed keys). */
export const INHERIT_VALUE = "__inherit__";
/** Dropdown sentinel: repo-specific config matching no profile. */
export const CUSTOM_VALUE = "__custom__";

/** The dropdown value a detected match selects: a profile id or a sentinel. */
export function dropdownValueFromMatch(m: ProfileMatch): string {
  switch (m.kind) {
    case "inherit":
      return INHERIT_VALUE;
    case "active":
      return m.profile_id;
    case "custom":
      return CUSTOM_VALUE;
  }
}

/** A profile's defined values in ManagedKeys shape, for the read-only summary. */
export function profileValues(p: GitProfile): ManagedKeys {
  return {
    user_name: p.userName,
    user_email: p.userEmail,
    gpg_format: p.gpgFormat,
    signing_key: p.signingKey,
    commit_gpgsign: p.commitGpgsign,
    allowed_signers_file: p.allowedSignersFile,
    auth_ssh_key: p.authSshKey,
    credential_helper: p.credentialHelper,
  };
}
```

- [ ] **Step 4: Patch `RepoProfileSection.tsx` so the build stays green**

This component is replaced in Task 7 and deleted in Task 8; this is the minimal edit for the shrunk `ProfileMatch` union. Three spots:

The `activeId` line (currently checks `"active" || "drift"`):

```ts
  const activeId = m.kind === "active" ? m.profile_id : null;
```

In `StatusBadge`, delete the whole `else if (m.kind === "drift") {...}` branch and the `{m.kind === "drift" && (...)}` diff-list JSX block below the badge text, and change the `unmanaged` branch to:

```ts
  } else if (m.kind === "custom") {
    color = "var(--warning-fg)";
    text = "Custom (local config matches no profile)";
  }
```

Change the save-as-profile gate from `m.kind === "unmanaged"` to `m.kind === "custom"` (both occurrences: the note text condition inside the apply ConfirmPanel and the save-as block).

- [ ] **Step 5: Run test + type-check to verify they pass**

Run: `powershell.exe -NoProfile -Command "Set-Location <repo>; npx vitest run src/panels/Settings/identityMode.test.ts"`
Expected: PASS (2 tests)

Run: `npx tsc --noEmit`
Expected: no errors

---

### Task 5: Frontend: `EffectiveValuesSummary`

**Files:**
- Create: `src/panels/Settings/EffectiveValuesSummary.tsx`

**Interfaces:**
- Consumes: `ManagedKeys` type; `useSummonStore` from `src/store/summon.ts`.
- Produces: `EffectiveValuesSummary({ values }: { values: ManagedKeys })`. Task 7 consumes it.

- [ ] **Step 1: Implement the component**

```tsx
// src/panels/Settings/EffectiveValuesSummary.tsx
import { useState } from "react";
import type { ManagedKeys } from "../../lib/types";
import { useSummonStore } from "../../store/summon";

const ROWS: { label: string; pick: (v: ManagedKeys) => string | null }[] = [
  { label: "user.name", pick: (v) => v.user_name },
  { label: "user.email", pick: (v) => v.user_email },
  { label: "commit.gpgsign", pick: (v) => v.commit_gpgsign },
  { label: "gpg.format", pick: (v) => v.gpg_format },
  { label: "user.signingkey", pick: (v) => v.signing_key },
  { label: "gpg.ssh.allowedSignersFile", pick: (v) => v.allowed_signers_file },
  { label: "core.sshCommand (auth key)", pick: (v) => v.auth_ssh_key },
  { label: "credential.helper", pick: (v) => v.credential_helper },
];

/**
 * Collapsed, expandable read-only view of the 8 managed keys, shown by the
 * Global and Profile modes of the repo identity section. Editing happens at
 * the source (Global Settings) - never here - which is what makes a selected
 * profile and the repo's config unable to drift apart inside LeGit.
 */
export function EffectiveValuesSummary({ values }: { values: ManagedKeys }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div style={{ marginTop: 8 }}>
      <button onClick={() => setExpanded((e) => !e)} aria-expanded={expanded}>
        {expanded ? "Hide effective values" : "Show effective values"}
      </button>
      {expanded && (
        <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 2 }}>
          {ROWS.map((r) => (
            <div key={r.label} style={{ fontFamily: "monospace", fontSize: "var(--fz-sm)" }}>
              <code>{r.label}</code>:{" "}
              <code>{r.pick(values) ?? "unset"}</code>
            </div>
          ))}
          <div style={{ marginTop: 6 }}>
            <button onClick={() => useSummonStore.getState().summon("global-settings")}>
              Edit in Global Settings
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors (component is not yet rendered anywhere; that happens in Task 7)

---

### Task 6: Frontend: `CustomConfigEditor`

**Files:**
- Create: `src/panels/Settings/CustomConfigEditor.tsx`
- Modify: `src/panels/Settings/GlobalProfilesSection.tsx` (export `profileNameSlug`)

**Interfaces:**
- Consumes: `writeRepoManagedConfig` (Task 3); `ManagedKeys`, `ProfileStatus` types; `Field`, `WithBrowse`, `profileNameSlug` from `GlobalProfilesSection.tsx`; `RadioGroup`, `GPGSIGN_OPTIONS`, `FORMAT_OPTIONS` from `SigningSettings.tsx`; `CredentialHelperField`; `GenerateSshKeyForm`, `SshKeyActions` from `SshKeyTools.tsx`; `usePanelDirty` from `PanelApiContext`.
- Produces: `CustomConfigEditor({ repoId, repoName, local, inherited, onSaved })` where `onSaved: (s: ProfileStatus) => void`. Task 7 consumes it.

- [ ] **Step 1: Export the slug helper**

In `src/panels/Settings/GlobalProfilesSection.tsx`, change `function profileNameSlug(` to `export function profileNameSlug(`.

- [ ] **Step 2: Implement the editor**

```tsx
// src/panels/Settings/CustomConfigEditor.tsx
// Repo-scope twin of GlobalGitConfigSection: ONE bordered form, one Save with
// an explicit confirm listing every key change, empty field = unset (the key
// falls back to the inherited value shown per field). Covers all 8 profile
// keys, including the auth SSH key (repo scope is where SSH auth belongs).

import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useState } from "react";
import { usePanelDirty } from "../PanelApiContext";
import { WarningIcon } from "../../icons";
import { formatAppError } from "../../lib/types";
import type { ManagedKeys, ProfileStatus } from "../../lib/types";
import { writeRepoManagedConfig } from "../../lib/commands";
import { Button } from "../shared/buttons";
import { FieldNote } from "./primitives";
import { CredentialHelperField } from "./CredentialHelperField";
import { GenerateSshKeyForm, SshKeyActions } from "./SshKeyTools";
import { Field, WithBrowse, profileNameSlug } from "./GlobalProfilesSection";
import { RadioGroup, GPGSIGN_OPTIONS, FORMAT_OPTIONS } from "./SigningSettings";

interface ChangeItem { key: string; before: string | null; after: string | null }

export function CustomConfigEditor({
  repoId,
  repoName,
  local,
  inherited,
  onSaved,
}: {
  repoId: string;
  repoName: string;
  local: ManagedKeys;
  inherited: ManagedKeys;
  onSaved: (s: ProfileStatus) => void;
}) {
  const [name, setName] = useState(local.user_name ?? "");
  const [email, setEmail] = useState(local.user_email ?? "");
  const [gpgsign, setGpgsign] = useState<string | null>(local.commit_gpgsign);
  const [format, setFormat] = useState<string | null>(local.gpg_format);
  const [signingKey, setSigningKey] = useState(local.signing_key ?? "");
  const [allowedSigners, setAllowedSigners] = useState(local.allowed_signers_file ?? "");
  const [authKey, setAuthKey] = useState(local.auth_ssh_key ?? "");
  const [helper, setHelper] = useState(local.credential_helper ?? "");
  const [showGenerateKey, setShowGenerateKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmPending, setConfirmPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const norm = (v: string) => (v.trim() === "" ? null : v.trim());

  const draft: ManagedKeys = {
    user_name: norm(name),
    user_email: norm(email),
    gpg_format: format,
    signing_key: norm(signingKey),
    commit_gpgsign: gpgsign,
    allowed_signers_file: norm(allowedSigners),
    auth_ssh_key: norm(authKey),
    credential_helper: norm(helper),
  };

  // Change list computed client-side, exactly like GlobalGitConfigSection;
  // the backend re-diffs against live local config on write.
  const changes: ChangeItem[] = [];
  const push = (key: string, before: string | null, after: string | null) => {
    if (before !== after) changes.push({ key, before, after });
  };
  push("user.name", local.user_name, draft.user_name);
  push("user.email", local.user_email, draft.user_email);
  push("commit.gpgsign", local.commit_gpgsign, draft.commit_gpgsign);
  push("gpg.format", local.gpg_format, draft.gpg_format);
  push("user.signingkey", local.signing_key, draft.signing_key);
  push("gpg.ssh.allowedSignersFile", local.allowed_signers_file, draft.allowed_signers_file);
  push("core.sshCommand (auth key)", local.auth_ssh_key, draft.auth_ssh_key);
  push("credential.helper", local.credential_helper, draft.credential_helper);

  const dirty = changes.length > 0;
  usePanelDirty(dirty);

  const isSsh = (format ?? inherited.gpg_format) === "ssh";

  const inheritPlaceholder = (v: string | null, fallback: string) =>
    v ? `inherits: ${v}` : fallback;

  const handleConfirm = async () => {
    setConfirmPending(false);
    setSaving(true);
    setError(null);
    try {
      const s = await writeRepoManagedConfig(repoId, draft);
      onSaved(s);
    } catch (e) {
      setError(formatAppError(e));
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    setName(local.user_name ?? "");
    setEmail(local.user_email ?? "");
    setGpgsign(local.commit_gpgsign);
    setFormat(local.gpg_format);
    setSigningKey(local.signing_key ?? "");
    setAllowedSigners(local.allowed_signers_file ?? "");
    setAuthKey(local.auth_ssh_key ?? "");
    setHelper(local.credential_helper ?? "");
  };

  const browseInto = async (set: (v: string) => void) => {
    const selected = await openDialog({ multiple: false });
    if (typeof selected === "string") set(selected);
  };

  return (
    <div
      style={{
        marginTop: 10,
        padding: "10px 12px",
        border: "1px solid var(--panel-border)",
        borderRadius: 4,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <Field label="user.name">
        <input
          value={name}
          placeholder={inheritPlaceholder(inherited.user_name, "Your Name")}
          onChange={(e) => setName(e.target.value)}
          disabled={saving}
        />
      </Field>
      <Field label="user.email">
        <input
          value={email}
          placeholder={inheritPlaceholder(inherited.user_email, "you@example.com")}
          onChange={(e) => setEmail(e.target.value)}
          disabled={saving}
        />
      </Field>
      <Field label="commit.gpgsign">
        <RadioGroup
          name="repo-custom-gpgsign"
          value={gpgsign}
          options={GPGSIGN_OPTIONS}
          onChange={setGpgsign}
          disabled={saving}
        />
      </Field>
      <Field label="gpg.format">
        <RadioGroup
          name="repo-custom-format"
          value={format}
          options={FORMAT_OPTIONS}
          onChange={setFormat}
          disabled={saving}
        />
      </Field>
      <Field label="user.signingkey">
        <WithBrowse
          value={signingKey}
          onChange={setSigningKey}
          onBrowse={() => browseInto(setSigningKey)}
          placeholder={isSsh ? "Path to SSH key (or literal public key)" : "GPG key id"}
        />
      </Field>
      {isSsh && (
        <Field label="gpg.ssh.allowedSignersFile">
          <WithBrowse
            value={allowedSigners}
            onChange={setAllowedSigners}
            onBrowse={() => browseInto(setAllowedSigners)}
            placeholder="Path to allowed signers file"
          />
        </Field>
      )}
      <Field label="Auth SSH key (core.sshCommand)">
        <WithBrowse
          value={authKey}
          onChange={setAuthKey}
          onBrowse={() => browseInto(setAuthKey)}
          placeholder="Path to SSH private key (for push/pull)"
        />
        {norm(authKey) && !showGenerateKey && <SshKeyActions privateKeyPath={authKey.trim()} />}
        {showGenerateKey ? (
          <GenerateSshKeyForm
            nameSlug={profileNameSlug(repoName)}
            defaultComment={norm(email) ?? ""}
            onGenerated={(path) => {
              setAuthKey(path);
              setShowGenerateKey(false);
            }}
            onCancel={() => setShowGenerateKey(false)}
          />
        ) : (
          <div>
            <button onClick={() => setShowGenerateKey(true)} disabled={saving}>
              Generate new key…
            </button>
          </div>
        )}
      </Field>
      <Field label="credential.helper (HTTPS)">
        <CredentialHelperField value={helper} onChange={setHelper} disabled={saving} />
        <FieldNote>
          Set here, this overrides any inherited (global/system) helper for this repo.
        </FieldNote>
      </Field>

      {confirmPending && (
        <div style={{ padding: "10px 12px", background: "var(--button-hover-bg)", border: "1px solid var(--panel-border)", borderRadius: 4 }}>
          <div style={{ fontWeight: 600, marginBottom: 6, display: "flex", alignItems: "center", gap: 6 }}>
            <WarningIcon /> Save these changes to this repo's .git/config?
          </div>
          <div style={{ marginBottom: 8, fontSize: "var(--fz-md)" }}>
            {changes.map((c) => (
              <div key={c.key} style={{ fontFamily: "monospace" }}>
                <code>{c.key}</code>: <code>{c.before ?? "unset"}</code> → <code>{c.after ?? "unset"}</code>
              </div>
            ))}
          </div>
          <div style={{ fontSize: "var(--fz-md)", color: "var(--subtle-fg)", marginBottom: 10 }}>
            These writes affect only this repository. Unset keys keep inheriting
            your global config.
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <Button variant="primary" onClick={handleConfirm} disabled={saving}>Save</Button>
            <button onClick={() => setConfirmPending(false)} disabled={saving}>Cancel</button>
          </div>
        </div>
      )}

      {!confirmPending && (
        <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
          <Button variant="primary" disabled={!dirty || saving} onClick={() => setConfirmPending(true)}>
            Save
          </Button>
          <button disabled={!dirty || saving} onClick={handleCancel}>
            Cancel
          </button>
        </div>
      )}

      {error && <pre className="legit-error">{error}</pre>}
    </div>
  );
}
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors. If `CredentialHelperField` has no `disabled` prop, drop that prop here rather than changing the shared field.

---

### Task 7: Frontend: `RepoIdentitySection`

**Files:**
- Create: `src/panels/Settings/RepoIdentitySection.tsx`

**Interfaces:**
- Consumes: everything produced by Tasks 2-6, plus `detectActiveProfileForRepo`, `previewApplyProfile`, `applyProfileToRepo`, `clearRepoProfile`, `createProfileFromRepo`, `repoResolvedIdentity` (existing wrappers) and `useGitProfiles`/`invalidateGitProfiles` (cleanup plan).
- Produces: `RepoIdentitySection({ repoId, repoName })`. Task 8 renders it in `RepoSettingsPanel`.

- [ ] **Step 1: Implement the section**

```tsx
// src/panels/Settings/RepoIdentitySection.tsx
// The ONE repo-scope section for identity/signing/credentials, with three
// mutually exclusive, DETECTION-DRIVEN modes (spec:
// docs/superpowers/specs/2026-07-21-repo-identity-modes-design.md):
//   Global (inherit) - no local managed keys; collapsed read-only summary.
//   Profile          - local config exactly matches a profile; summary.
//   Custom           - local config matches no profile; combined editor.
// There is no drift state: config that matches no profile IS custom.
// Selecting Custom is pure UI (editor opens prefilled, nothing written);
// detection flips once a save diverges from every profile.

import { useCallback, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { usePanelFocusEffect } from "../PanelApiContext";
import { WarningIcon } from "../../icons";
import { formatAppError } from "../../lib/types";
import type { KeyDiff, ManagedConfigView, ProfileStatus, ResolvedIdentity } from "../../lib/types";
import {
  detectActiveProfileForRepo,
  previewApplyProfile,
  applyProfileToRepo,
  clearRepoProfile,
  createProfileFromRepo,
  repoResolvedIdentity,
  repoManagedConfigView,
} from "../../lib/commands";
import { useGitProfiles, invalidateGitProfiles } from "../../lib/useGitProfiles";
import { Button } from "../shared/buttons";
import { Section, FieldNote } from "./primitives";
import { EffectiveValuesSummary } from "./EffectiveValuesSummary";
import { CustomConfigEditor } from "./CustomConfigEditor";
import { INHERIT_VALUE, CUSTOM_VALUE, dropdownValueFromMatch, profileValues } from "./identityMode";

const TITLE = "Identity, signing & credentials (this repo)";

export function RepoIdentitySection({ repoId, repoName }: { repoId: string; repoName: string }) {
  const queryClient = useQueryClient();
  const profilesQuery = useGitProfiles();
  const profiles = profilesQuery.data ?? [];

  const [status, setStatus] = useState<ProfileStatus | null>(null);
  const [view, setView] = useState<ManagedConfigView | null>(null);
  const [resolvedIdentity, setResolvedIdentity] = useState<ResolvedIdentity | null>(null);
  const [pending, setPending] = useState<{ profileId: string; diffs: KeyDiff[] } | null>(null);
  const [clearPending, setClearPending] = useState(false);
  const [customPicked, setCustomPicked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [savingNew, setSavingNew] = useState(false);

  const load = useCallback(() => {
    setPending(null);
    setClearPending(false);
    Promise.all([
      detectActiveProfileForRepo(repoId),
      repoResolvedIdentity(repoId),
      repoManagedConfigView(repoId),
    ])
      .then(([s, r, v]) => { setStatus(s); setResolvedIdentity(r); setView(v); })
      .catch((e) => setError(formatAppError(e)));
  }, [repoId]);

  useEffect(() => { setCustomPicked(false); }, [repoId]);

  // Reload when the shared profile list actually changes (create/delete in
  // any panel): the detected mode depends on the profile set. Depend on
  // `profilesQuery.data` (structurally shared), never on a `?? []` fallback.
  useEffect(() => { load(); }, [load, profilesQuery.data]);

  const { refetch: refetchProfiles } = profilesQuery;
  usePanelFocusEffect(useCallback(() => {
    void refetchProfiles();
    load();
  }, [refetchProfiles, load]));

  /** Refresh status + config view after a mutation, without a full reload. */
  const applyResult = useCallback((s: ProfileStatus) => {
    setStatus(s);
    repoManagedConfigView(repoId).then(setView).catch((e) => setError(formatAppError(e)));
  }, [repoId]);

  if (!status || !view) {
    return <Section title={TITLE} scope="git"><span className="legit-subtle">Loading…</span></Section>;
  }

  const m = status.match;
  const showCustom = (m.kind === "custom" || customPicked) && !pending && !clearPending;
  const dropdown = pending
    ? pending.profileId
    : clearPending
      ? INHERIT_VALUE
      : customPicked
        ? CUSTOM_VALUE
        : dropdownValueFromMatch(m);
  const profileName = (id: string) => profiles.find((p) => p.id === id)?.name ?? "(deleted profile)";
  const activeProfile = m.kind === "active" ? (profiles.find((p) => p.id === m.profile_id) ?? null) : null;

  const handleSelect = async (value: string) => {
    setError(null);
    if (value === CUSTOM_VALUE) {
      // Pure UI: open the editor prefilled; nothing is written or stored.
      setPending(null);
      setClearPending(false);
      setCustomPicked(true);
      return;
    }
    setCustomPicked(false);
    if (value === INHERIT_VALUE) {
      setPending(null);
      setClearPending(m.kind !== "inherit"); // re-selecting the current mode is a no-op
      return;
    }
    try {
      setBusy(true);
      const diffs = await previewApplyProfile(repoId, value);
      setClearPending(false);
      setPending({ profileId: value, diffs });
    } catch (e) {
      setError(formatAppError(e));
    } finally {
      setBusy(false);
    }
  };

  const confirmApply = async () => {
    if (!pending) return;
    setBusy(true);
    setError(null);
    try {
      const s = await applyProfileToRepo(repoId, pending.profileId);
      applyResult(s);
      setPending(null);
    } catch (e) {
      setError(formatAppError(e));
    } finally {
      setBusy(false);
    }
  };

  const confirmClear = async () => {
    setBusy(true);
    setError(null);
    try {
      const s = await clearRepoProfile(repoId);
      applyResult(s);
      setClearPending(false);
    } catch (e) {
      setError(formatAppError(e));
    } finally {
      setBusy(false);
    }
  };

  const saveAsProfile = async () => {
    if (newName.trim() === "") return;
    setSavingNew(true);
    setError(null);
    try {
      await createProfileFromRepo(repoId, newName.trim());
      setNewName("");
      setCustomPicked(false);
      // List invalidation refetches the shared query; the effect above then
      // re-detects (now Active on the new profile).
      invalidateGitProfiles(queryClient);
    } catch (e) {
      setError(formatAppError(e));
    } finally {
      setSavingNew(false);
    }
  };

  return (
    <Section title={TITLE} scope="git">
      <FieldNote>writes to: .git/config (this repo only)</FieldNote>

      <div style={{ marginTop: 8 }}>
        <StatusBadge match={m} profileName={profileName} />
        {m.kind === "inherit" && <InheritedIdentityNote identity={resolvedIdentity} />}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10 }}>
        <span className="legit-subtle" style={{ fontSize: "var(--fz-md)" }}>Source:</span>
        {/* data-testid is a contract with e2e/specs/profiles.spec.ts */}
        <select data-testid="repo-profile-select" value={dropdown} disabled={busy} onChange={(e) => handleSelect(e.target.value)}>
          <option value={INHERIT_VALUE}>Use global config</option>
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>{p.name || "(unnamed)"}</option>
          ))}
          <option value={CUSTOM_VALUE}>Custom (this repo)</option>
        </select>
      </div>

      {pending && (
        <ConfirmPanel
          title={`Apply profile "${profileName(pending.profileId)}" to this repo's .git/config?`}
          diffs={pending.diffs}
          note={
            m.kind === "custom"
              ? "This repo has its own local config; applying will overwrite it."
              : "These writes affect only this repo's local config."
          }
          confirmLabel="Apply"
          busy={busy}
          onConfirm={confirmApply}
          onCancel={() => setPending(null)}
        />
      )}

      {clearPending && (
        <ConfirmPanel
          title="Use the global config for this repo?"
          diffs={[]}
          note="Unsets all identity/signing/auth keys at local scope; the repo falls back to your global git config."
          confirmLabel="Clear local config"
          busy={busy}
          onConfirm={confirmClear}
          onCancel={() => setClearPending(false)}
        />
      )}

      {!showCustom && !pending && !clearPending && m.kind === "active" && activeProfile && (
        <EffectiveValuesSummary values={profileValues(activeProfile)} />
      )}
      {!showCustom && !pending && !clearPending && m.kind === "inherit" && (
        <EffectiveValuesSummary values={view.inherited} />
      )}

      {showCustom && (
        <>
          <CustomConfigEditor
            key={repoId}
            repoId={repoId}
            repoName={repoName}
            local={view.local}
            inherited={view.inherited}
            onSaved={(s) => { applyResult(s); setCustomPicked(false); }}
          />
          <div style={{ marginTop: 10, padding: "10px 12px", background: "var(--button-hover-bg)", borderRadius: 4 }}>
            <div style={{ fontSize: "var(--fz-md)", marginBottom: 6 }}>
              Save this repo's config as a reusable profile?
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <input
                style={{ flex: 1 }}
                value={newName}
                placeholder="New profile name"
                onChange={(e) => setNewName(e.target.value)}
              />
              <Button variant="primary" disabled={savingNew || newName.trim() === ""} onClick={saveAsProfile}>
                Save as profile
              </Button>
            </div>
          </div>
        </>
      )}

      {error && <pre className="legit-error" style={{ marginTop: 6 }}>{error}</pre>}
    </Section>
  );
}

/** What "Use global config" actually resolves to, or a commit-will-fail warning. */
function InheritedIdentityNote({ identity }: { identity: ResolvedIdentity | null }) {
  if (!identity) return null;
  const resolved = [identity.user_name, identity.user_email].filter(Boolean).join(" · ");
  return (
    <div className="legit-subtle" style={{ marginTop: 4, fontSize: "var(--fz-sm)" }}>
      {resolved
        ? `Inheriting identity: ${resolved}.`
        : "No identity is set at any scope: commits will fail. Set the global identity in Global Settings, or configure this repo below."}
    </div>
  );
}

function StatusBadge({
  match,
  profileName,
}: {
  match: ProfileStatus["match"];
  profileName: (id: string) => string;
}) {
  let color = "var(--subtle-fg)";
  let text = "Inherit (global config)";
  if (match.kind === "active") {
    color = "var(--success-fg)";
    text = `Active: ${profileName(match.profile_id)}`;
  } else if (match.kind === "custom") {
    text = "Custom (this repo)";
  }
  return <span style={{ color, fontWeight: 600 }}>{text}</span>;
}

function ConfirmPanel({
  title,
  diffs,
  note,
  confirmLabel,
  busy,
  onConfirm,
  onCancel,
}: {
  title: string;
  diffs: KeyDiff[];
  note: string;
  confirmLabel: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div style={{ marginTop: 10, padding: "10px 12px", background: "var(--button-hover-bg)", border: "1px solid var(--panel-border)", borderRadius: 4 }}>
      <div style={{ fontWeight: 600, marginBottom: 6, display: "flex", alignItems: "center", gap: 6 }}>
        <WarningIcon /> {title}
      </div>
      {diffs.length > 0 && (
        <div style={{ marginBottom: 8, fontSize: "var(--fz-md)" }}>
          {diffs.map((d) => (
            <div key={d.key} style={{ fontFamily: "monospace" }}>
              <code>{d.key}</code>: <code>{d.local ?? "unset"}</code> → <code>{d.profile ?? "unset"}</code>
            </div>
          ))}
        </div>
      )}
      <div style={{ fontSize: "var(--fz-md)", color: "var(--subtle-fg)", marginBottom: 10 }}>{note}</div>
      <div style={{ display: "flex", gap: 6 }}>
        <Button variant="primary" onClick={onConfirm} disabled={busy}>{confirmLabel}</Button>
        <button onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors (section not yet rendered; Task 8 wires it)

---

### Task 8: Wiring: panel swap, dead-code removal, Global Settings reorder

**Files:**
- Modify: `src/panels/Settings/RepoSettingsPanel.tsx:10-11,162-164`
- Delete: `src/panels/Settings/RepoProfileSection.tsx`
- Modify: `src/panels/Settings/SigningSettings.tsx` (delete the `SigningSettings` component; keep exported primitives)
- Modify: `src/lib/commands.ts:310-322` (remove `repoSigningConfig`, `repoWriteSigning`)
- Modify: `src/panels/Settings/GlobalSettingsPanel.tsx:166-167` (section swap)
- Modify: `src/panels/Settings/GlobalProfilesSection.tsx` (delete-confirm wording)

**Interfaces:**
- Consumes: `RepoIdentitySection` (Task 7).
- Produces: the final panel composition. `SigningSettings.tsx` keeps exporting `ConfigRow`, `ResolvedBadge`, `RadioGroup`, `GPGSIGN_OPTIONS`, `FORMAT_OPTIONS` (used by `GlobalGitConfigSection` and `CustomConfigEditor`).

- [ ] **Step 1: Swap the repo panel sections**

In `src/panels/Settings/RepoSettingsPanel.tsx`:

Replace the two imports (lines 10-11):

```tsx
import { RepoIdentitySection } from "./RepoIdentitySection";
```

(The `SigningSettings` and `RepoProfileSection` imports are removed.)

Replace lines 162-164 (`<RepoProfileSection .../>`, `<LineEndingsRepoSection .../>`, `<SigningSettings scope="repo" .../>`), keeping line endings:

```tsx
          <RepoIdentitySection repoId={activeRepo.id} repoName={activeRepo.name} />
          <LineEndingsRepoSection repoId={activeRepo.id} />
```

(`activeRepo` comes from `useActiveRepo()` and has `name` on `RepoSummary`.)

- [ ] **Step 2: Delete the replaced component**

```bash
rm <repo>/src/panels/Settings/RepoProfileSection.tsx
```

- [ ] **Step 3: Strip `SigningSettings.tsx` to its shared primitives**

The Global Settings panel uses `GlobalGitConfigSection` (not `SigningSettings`), so the component is now dead. In `src/panels/Settings/SigningSettings.tsx`:

- Delete the `SigningSettings` component function, the `Scope` type, and the `getChanges` helper it uses (if `getChanges` is used only by the component).
- Delete the now-unused imports (`repoSigningConfig`, `globalSigningConfig`, `repoWriteSigning`, `globalWriteSigning`, `usePanelFocusEffect`, `usePanelDirty`, `openDialog`, `Section`, `FieldNote`, `Button`, `WarningIcon`, `formatAppError`, `ConfigScope`, `SigningView` - keep exactly those still referenced by the surviving exports).
- KEEP the exported `ConfigRow`, `ResolvedBadge`, `RadioGroup`, `GPGSIGN_OPTIONS`, `FORMAT_OPTIONS` (and any types they need). Update the file's header comment to: `// Shared signing-form primitives (rows, badges, radio groups) used by the global git-config form and the repo custom editor. The standalone signing sections were folded into those combined forms.`

In `src/lib/commands.ts`, delete the `repoSigningConfig` and `repoWriteSigning` wrappers (backend commands stay registered; only the unused frontend wrappers go).

- [ ] **Step 4: Global Settings reorder + wording**

In `src/panels/Settings/GlobalSettingsPanel.tsx`, swap lines 166-167 so Connected accounts sits between the Git executable section and the combined form:

```tsx
          <ConnectedAccountsSection />
          <GlobalGitConfigSection />
```

In `src/panels/Settings/GlobalProfilesSection.tsx`, in the delete-confirmation strip (added by the profile-flow-cleanup plan), change the in-use warning wording from `Repos keep their git config and become Unmanaged.` to `Repos keep their git config and show as Custom.`

- [ ] **Step 5: Type-check + full frontend tests**

Run: `npx tsc --noEmit`
Expected: no errors

Run: `powershell.exe -NoProfile -Command "Set-Location <repo>; npx vitest run"`
Expected: all PASS (includes theme contract + no-literal-colors suites)

---

### Task 9: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Rust**

Run: `cargo test -p legit-app && cargo test -p legit-core && cargo build -p legit-app`
Expected: all PASS, build clean

- [ ] **Step 2: Frontend**

Run: `npx tsc --noEmit`
Expected: no errors

Run: `powershell.exe -NoProfile -Command "Set-Location <repo>; npx vitest run"`
Expected: all PASS

- [ ] **Step 3: Manual smoke (user runs the app from PowerShell)**

Using the test repo `<test-repo>` (inspect its state first; do not reset it):

1. Repo Settings shows ONE "Identity, signing & credentials (this repo)" section; the standalone repo signing section is gone.
2. Source dropdown: Use global config / each profile / Custom (this repo). The detected mode is selected.
3. Global mode: "Show effective values" expands to the inherited values; "Edit in Global Settings" summons the Global Settings panel.
4. Apply a profile (preview + confirm); badge shows Active; summary shows the profile's values read-only.
5. Edit `.git/config` in a terminal (e.g. `git config user.email x@y.z`): section flips to Custom, editor open and prefilled, no drift text anywhere.
6. Re-select the profile: preview + confirm re-applies it.
7. Pick Custom while a profile is Active: editor opens prefilled, nothing written; change one key, Save (confirm lists exactly that key); detection flips to Custom.
8. Custom mode: "Save as profile" creates a profile and the section flips to Active on it; the new profile appears in Global Settings immediately.
9. "Use global config": confirm clears the local keys; badge shows Inherit with the resolved identity note.
10. Global Settings: Connected accounts now sits between "Git executable (default for all repos)" and "Identity, signing & credentials (global)".
11. Delete an in-use profile from Global Settings: confirm warns "show as Custom", and the repo section flips to Custom without refocusing.
