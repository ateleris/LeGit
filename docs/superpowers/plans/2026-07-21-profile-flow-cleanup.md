# Profile Flow Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Do NOT use subagent-driven-development (user rule).

**Goal:** One shared, always-fresh profile list across every consumer, a proper destructive-action confirmation on profile delete, and an in-use warning naming the repos that use the profile being deleted.

**Architecture:** The global profile list moves from four independent `useState` copies into a single React Query cache entry (`["global", "profiles"]`); every profile mutation invalidates that key, so all mounted consumers refetch immediately (no reliance on panel focus). The Repo Settings status re-derives whenever the shared list actually changes (React Query structural sharing makes that a cheap dependency). A new read-only backend command scans the persisted per-repo settings (`repos/<hash>/settings.json` + `path.txt`) to report which repos have a given profile selected.

**Tech Stack:** React 19 + TypeScript + @tanstack/react-query 5 (frontend), Rust + Tauri 2 commands (backend), vitest + cargo test.

## Global Constraints

- Do NOT commit or push at any point. Leave all changes unstaged for the user's review (user rule, overrides the usual commit-per-task steps).
- No em-dashes in any generated text, code comments, or docs. Use hyphens or restructure.
- Every colour must come from a theme token (`var(--token)`); this plan only reuses existing tokens (`--fz-sm`, `--button-hover-bg`, danger button class), no new tokens needed.
- New IPC commands must be added in BOTH places: `collect_commands![]` in `src-tauri/src/lib.rs` AND a hand-written wrapper in `src/lib/commands.ts` (`src/lib/bindings.ts` regenerates only when the app runs; do not edit it by hand).
- Run vitest from WSL via PowerShell interop: `powershell.exe -NoProfile -Command "Set-Location C:\NOT_WORK\LeGit; npx vitest run <file>"`. `cargo test` and `npx tsc --noEmit` run directly in WSL.
- Destructive-action confirmations are gated by the global setting via `useConfirmDestructive()`; never hardcode a confirm step (project convention).

## Decisions (context for reviewers)

- **Query key `["global", "profiles"]`:** repo-scoped keys are `[repoId, domain]` where `repoId` is a UUID (`RepoSession::new`), so the literal `"global"` can never collide with a repo id.
- **In-use warning lives inside the gated confirm.** When "Destructive action confirmation" is off, delete stays immediate with no warning, per the "never hardcode a confirm step" convention.
- **Deleting a profile still does not touch any repo's `.git/config`** (documented behavior of `delete_git_profile`). Repos that used it keep their config and show as Unmanaged / "(deleted profile)". Clearing dangling `git_profile_id` hints in repo settings was considered and rejected: the stored id is explicitly a hint, and the status detection already handles it.
- **Usage lookup scans `repos/<hash>/` on disk, not open sessions.** Repo settings are persisted eagerly on every change, so disk is always current, and the scan also covers repos that are not open right now. `path.txt` (written alongside the first settings write) provides the display name; a dir without `path.txt` has never had settings written and is skipped.

---

### Task 1: Shared profile list hook (`useGitProfiles`)

**Files:**
- Create: `src/lib/useGitProfiles.ts`
- Test: `src/lib/useGitProfiles.test.ts`

**Interfaces:**
- Consumes: `listGitProfiles()` from `src/lib/commands.ts`, `GitProfile` from `src/lib/types.ts`.
- Produces: `GIT_PROFILES_KEY: string[]`, `useGitProfiles(): UseQueryResult<GitProfile[]>`, `invalidateGitProfiles(qc: QueryClient): void`. Tasks 2-4 and 6 import these.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/useGitProfiles.test.ts
// The hook itself is a thin useQuery wrapper; the testable contract is the
// shared key + invalidation helper that all profile mutations call.
import { describe, test, expect } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { GIT_PROFILES_KEY, invalidateGitProfiles } from "./useGitProfiles";

describe("invalidateGitProfiles", () => {
  test("marks the shared profiles query invalidated", () => {
    const qc = new QueryClient();
    qc.setQueryData(GIT_PROFILES_KEY, []);
    expect(qc.getQueryState(GIT_PROFILES_KEY)?.isInvalidated).toBe(false);
    invalidateGitProfiles(qc);
    expect(qc.getQueryState(GIT_PROFILES_KEY)?.isInvalidated).toBe(true);
  });

  test("does not touch unrelated query keys", () => {
    const qc = new QueryClient();
    qc.setQueryData(["some-repo-id", "branches"], []);
    invalidateGitProfiles(qc);
    expect(qc.getQueryState(["some-repo-id", "branches"])?.isInvalidated).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `powershell.exe -NoProfile -Command "Set-Location C:\NOT_WORK\LeGit; npx vitest run src/lib/useGitProfiles.test.ts"`
Expected: FAIL (cannot resolve `./useGitProfiles`)

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/useGitProfiles.ts
import { useQuery, type QueryClient } from "@tanstack/react-query";
import { listGitProfiles } from "./commands";
import type { GitProfile } from "./types";

/**
 * Single shared cache entry for the global profile list. Every consumer
 * (Global Settings, Repo Settings, clone/init forms) reads this query, and
 * every profile mutation calls `invalidateGitProfiles`, so no panel can hold
 * a stale copy. Repo-scoped keys are `[repoId, domain]` with UUID repo ids,
 * so the literal "global" cannot collide.
 */
export const GIT_PROFILES_KEY = ["global", "profiles"];

export function useGitProfiles() {
  return useQuery<GitProfile[]>({
    queryKey: GIT_PROFILES_KEY,
    queryFn: listGitProfiles,
    staleTime: 5_000,
  });
}

/** Call after any mutation that changes the profile set (create/update/delete,
 *  create-from-repo). Refetches the list in every mounted consumer. */
export function invalidateGitProfiles(qc: QueryClient) {
  qc.invalidateQueries({ queryKey: GIT_PROFILES_KEY });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `powershell.exe -NoProfile -Command "Set-Location C:\NOT_WORK\LeGit; npx vitest run src/lib/useGitProfiles.test.ts"`
Expected: PASS (2 tests)

---

### Task 2: GlobalProfilesSection reads the shared query and invalidates on mutation

**Files:**
- Modify: `src/panels/Settings/GlobalProfilesSection.tsx` (lines 1-81: imports, state, `load`, `save`, `remove`)

**Interfaces:**
- Consumes: `useGitProfiles`, `invalidateGitProfiles` from Task 1; `useQueryClient` from @tanstack/react-query.
- Produces: no exports change. Task 6 edits this same component further (delete confirm).

- [ ] **Step 1: Replace the local list state with the shared query**

Replace the imports block additions and the component head. The `useCallback`/`useEffect` imports change and `useQueryClient` is added:

```tsx
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { usePanelFocusEffect } from "../PanelApiContext";
import { formatAppError } from "../../lib/types";
import type { GitProfile } from "../../lib/types";
import {
  createGitProfile,
  updateGitProfile,
  deleteGitProfile,
} from "../../lib/commands";
import { useGitProfiles, invalidateGitProfiles } from "../../lib/useGitProfiles";
import { Button } from "../shared/buttons";
import { Section, FieldNote } from "./primitives";
import { CredentialHelperField } from "./CredentialHelperField";
import { GenerateSshKeyForm, SshKeyActions } from "./SshKeyTools";
```

Replace the state + load block (previously `const [profiles, setProfiles] = useState...` through `usePanelFocusEffect(load);`) with:

```tsx
export function GlobalProfilesSection() {
  const queryClient = useQueryClient();
  const profilesQuery = useGitProfiles();
  const profiles = profilesQuery.data ?? [];
  const [editing, setEditing] = useState<GitProfile | null>(null);
  const [error, setError] = useState<string | null>(null);

  usePanelFocusEffect(useCallback(() => { void profilesQuery.refetch(); }, [profilesQuery.refetch]));
```

Note: `refetch` is referentially stable in React Query 5; destructure it if the lint setup complains about the member dependency:

```tsx
  const { refetch } = profilesQuery;
  usePanelFocusEffect(useCallback(() => { void refetch(); }, [refetch]));
```

- [ ] **Step 2: Mutations invalidate instead of reloading locally**

```tsx
  const save = async (p: GitProfile) => {
    setError(null);
    try {
      if (p.id === "") {
        await createGitProfile(p);
      } else {
        await updateGitProfile(p);
      }
      setEditing(null);
      invalidateGitProfiles(queryClient);
    } catch (e) {
      setError(formatAppError(e));
    }
  };

  const remove = async (id: string) => {
    setError(null);
    try {
      await deleteGitProfile(id);
      invalidateGitProfiles(queryClient);
    } catch (e) {
      setError(formatAppError(e));
    }
  };
```

- [ ] **Step 3: Surface query fetch errors in the existing error slot**

The old `load()` funneled list-fetch errors into `error`. Keep that behavior by rendering both sources. Replace the final error line of the JSX:

```tsx
      {(error ?? (profilesQuery.error ? formatAppError(profilesQuery.error) : null)) && (
        <pre className="legit-error" style={{ marginTop: 6 }}>
          {error ?? formatAppError(profilesQuery.error)}
        </pre>
      )}
```

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors

---

### Task 3: RepoProfileSection reads the shared query; status re-derives when the list changes

**Files:**
- Modify: `src/panels/Settings/RepoProfileSection.tsx` (lines 1-45: imports, state, `load`; line ~104: `saveAsProfile`)

**Interfaces:**
- Consumes: `useGitProfiles`, `invalidateGitProfiles` from Task 1.
- Produces: no export changes. This is the fix for "repo settings shows a deleted/renamed profile until refocused": the status badge and dropdown now refresh the moment the shared list changes anywhere.

- [ ] **Step 1: Swap the profiles fetch for the shared query**

Imports: drop `listGitProfiles` from the `../../lib/commands` import list, add:

```tsx
import { useQueryClient } from "@tanstack/react-query";
import { useGitProfiles, invalidateGitProfiles } from "../../lib/useGitProfiles";
```

Replace the state + load block (from `const [status, setStatus] = ...` through `usePanelFocusEffect(load);`) with:

```tsx
  const queryClient = useQueryClient();
  const profilesQuery = useGitProfiles();
  const profiles = profilesQuery.data ?? [];

  const [status, setStatus] = useState<ProfileStatus | null>(null);
  const [resolvedIdentity, setResolvedIdentity] = useState<ResolvedIdentity | null>(null);
  const [pending, setPending] = useState<{ profileId: string; diffs: KeyDiff[] } | null>(null);
  const [clearPending, setClearPending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [savingNew, setSavingNew] = useState(false);

  const load = useCallback(() => {
    setPending(null);
    setClearPending(false);
    Promise.all([detectActiveProfileForRepo(repoId), repoResolvedIdentity(repoId)])
      .then(([s, r]) => { setStatus(s); setResolvedIdentity(r); })
      .catch((e) => setError(formatAppError(e)));
  }, [repoId]);

  // Re-derive the status whenever the shared profile list actually changes
  // (structural sharing keeps `data` referentially stable otherwise), so a
  // create/delete in Global Settings updates this badge without a refocus.
  // Depend on `profilesQuery.data` (not the `?? []` fallback, which is a new
  // array every render while the query is loading).
  useEffect(() => { load(); }, [load, profilesQuery.data]);

  const { refetch: refetchProfiles } = profilesQuery;
  usePanelFocusEffect(useCallback(() => {
    void refetchProfiles();
    load();
  }, [refetchProfiles, load]));
```

- [ ] **Step 2: `saveAsProfile` invalidates the shared list**

```tsx
  const saveAsProfile = async () => {
    if (newName.trim() === "") return;
    setSavingNew(true);
    setError(null);
    try {
      await createProfileFromRepo(repoId, newName.trim());
      setNewName("");
      // The list invalidation refetches the shared query; the effect above
      // then reloads the status (now Active on the new profile).
      invalidateGitProfiles(queryClient);
    } catch (e) {
      setError(formatAppError(e));
    } finally {
      setSavingNew(false);
    }
  };
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors

---

### Task 4: RepoAddMenu and RepositoriesPanel read the shared query

**Files:**
- Modify: `src/panels/RepoAddMenu.tsx` (lines 2-3, 32, 43-47)
- Modify: `src/panels/Repositories/RepositoriesPanel.tsx` (lines 2-3, 26, 30-34)

**Interfaces:**
- Consumes: `useGitProfiles` from Task 1.
- Produces: no export changes. The clone/init profile dropdowns now update live when profiles change.

- [ ] **Step 1: RepoAddMenu**

Imports: drop `listGitProfiles` (keep `recentRepos`), drop the now-unused `GitProfile` type import if nothing else uses it, and add:

```tsx
import { useGitProfiles } from "../lib/useGitProfiles";
```

Replace `const [profiles, setProfiles] = useState<GitProfile[]>([]);` with:

```tsx
  const { data: profiles = [], refetch: refetchProfiles } = useGitProfiles();
```

Replace the lazy-load effect:

```tsx
  // Load menu data lazily each time the popover opens (recents change as
  // repos are opened; the profile list refreshes through the shared query).
  useEffect(() => {
    if (!open) return;
    recentRepos().then(setRecents).catch(console.warn);
    void refetchProfiles();
  }, [open, openRepoIds, refetchProfiles]);
```

- [ ] **Step 2: RepositoriesPanel**

Imports: drop `listGitProfiles`, drop the unused `GitProfile` type import if nothing else uses it, add:

```tsx
import { useGitProfiles } from "../../lib/useGitProfiles";
```

Replace `const [profiles, setProfiles] = useState<GitProfile[]>([]);` with:

```tsx
  const { data: profiles = [] } = useGitProfiles();
```

Replace the mount effect:

```tsx
  useEffect(() => {
    if (!initialized) refresh();
    recentRepos().then(setRecents).catch(console.warn);
  }, [initialized, refresh]);
```

- [ ] **Step 3: Type-check and full frontend test run**

Run: `npx tsc --noEmit`
Expected: no errors

Run: `powershell.exe -NoProfile -Command "Set-Location C:\NOT_WORK\LeGit; npx vitest run"`
Expected: all suites PASS (this catches the theme/contract suites too)

---

### Task 5: Backend command `repos_using_profile`

**Files:**
- Modify: `src-tauri/src/commands/profiles.rs` (new command + pure helper + tests)
- Modify: `src-tauri/src/lib.rs` (register in `collect_commands![]`, next to `commands::delete_git_profile` at line ~81)
- Modify: `src/lib/commands.ts` (wrapper)

**Interfaces:**
- Consumes: `AppState::repos_data_dir`, `crate::state::load_repo_settings_sync` (both exist).
- Produces: IPC command `repos_using_profile(profile_id: String) -> Vec<String>` (sorted repo folder names); frontend wrapper `reposUsingProfile(profileId: string): Promise<string[]>`. Task 6 consumes the wrapper.

- [ ] **Step 1: Write the failing unit test for the pure helper**

Append inside the existing `mod tests` in `src-tauri/src/commands/profiles.rs`:

```rust
    #[test]
    fn profile_usage_filters_and_names() {
        let entries = vec![
            ("/work/alpha".to_string(), Some("p1".to_string())),
            ("/work/beta".to_string(), Some("p2".to_string())),
            ("/work/gamma".to_string(), None),
            (r"C:\work\delta".to_string(), Some("p1".to_string())),
        ];
        assert_eq!(collect_profile_usage(&entries, "p1"), vec!["alpha", "delta"]);
        assert_eq!(collect_profile_usage(&entries, "p2"), vec!["beta"]);
        assert!(collect_profile_usage(&entries, "p9").is_empty());
    }
```

Note the Windows path case: `path.txt` stores Windows-style paths on Windows. `Path::file_name` does not split on `\` on Linux, so the helper must normalize separators itself (implementation below does).

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p legit-app profile_usage_filters_and_names`
Expected: FAIL to compile (`collect_profile_usage` not found)

- [ ] **Step 3: Implement helper + command**

In `src-tauri/src/commands/profiles.rs`, next to the other per-repo commands (after `delete_git_profile` is a good spot). Ensure `use std::path::Path;` is present in the file's imports (add it if the file only imports `PathBuf` or nothing from `std::path`).

```rust
/// Pure: display names (repo folder name) of the repos whose stored selection
/// references `profile_id`. Entries are `(repo_path, stored_profile_id)`.
/// Paths may be Windows-style regardless of host OS (they come from
/// `path.txt`), so separators are normalized before taking the last segment.
fn collect_profile_usage(entries: &[(String, Option<String>)], profile_id: &str) -> Vec<String> {
    let mut names: Vec<String> = entries
        .iter()
        .filter(|(_, stored)| stored.as_deref() == Some(profile_id))
        .map(|(path, _)| {
            let normalized = path.replace('\\', "/");
            normalized
                .rsplit('/')
                .find(|seg| !seg.is_empty())
                .unwrap_or(&normalized)
                .to_string()
        })
        .collect();
    names.sort();
    names.dedup();
    names
}

/// Read-only: which repos currently select `profile_id`. Scans the persisted
/// per-repo settings under `repos/<hash>/` - repo settings persist eagerly on
/// every change, so disk is current even for open repos, and the scan also
/// covers repos that are not open right now. A dir without `path.txt` has
/// never had settings written and is skipped.
#[tauri::command]
#[specta::specta]
pub async fn repos_using_profile(
    state: tauri::State<'_, AppState>,
    profile_id: String,
) -> Result<Vec<String>, AppError> {
    let mut entries: Vec<(String, Option<String>)> = Vec::new();
    let mut dir = match tokio::fs::read_dir(&state.repos_data_dir).await {
        Ok(d) => d,
        Err(_) => return Ok(vec![]), // no repo data yet
    };
    while let Ok(Some(ent)) = dir.next_entry().await {
        let repo_dir = ent.path();
        let Ok(repo_path) = tokio::fs::read_to_string(repo_dir.join("path.txt")).await else {
            continue;
        };
        let settings = crate::state::load_repo_settings_sync(&repo_dir.join("settings.json"));
        entries.push((repo_path.trim().to_string(), settings.git_profile_id));
    }
    Ok(collect_profile_usage(&entries, &profile_id))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p legit-app profile_usage_filters_and_names`
Expected: PASS

- [ ] **Step 5: Register the command**

In `src-tauri/src/lib.rs`, inside `collect_commands![...]`, directly after `commands::delete_git_profile,` add:

```rust
        commands::repos_using_profile,
```

If `src-tauri/src/commands/mod.rs` re-exports profiles explicitly (not via `pub use profiles::*;`), add `repos_using_profile` to that re-export list too.

Run: `cargo build -p legit-app`
Expected: compiles (this validates the specta registration)

- [ ] **Step 6: Frontend wrapper**

In `src/lib/commands.ts`, next to the other profile wrappers (after `deleteGitProfile`, line ~356):

```ts
export const reposUsingProfile = (profileId: string) =>
  invoke<string[]>("repos_using_profile", { profileId });
```

No `types.ts` change needed (plain `string[]`).

Run: `npx tsc --noEmit`
Expected: no errors

---

### Task 6: Delete confirmation with in-use warning in GlobalProfilesSection

**Files:**
- Modify: `src/panels/Settings/GlobalProfilesSection.tsx` (builds on Task 2's version)

**Interfaces:**
- Consumes: `useConfirmDestructive` from `src/store/settings`, `reposUsingProfile` from Task 5, `Button` danger variant.
- Produces: no export changes. Pattern follows `ConnectedAccountsSection.tsx` (inline row confirm that replaces the row's buttons; the trigger label gains a trailing ellipsis when confirmation is on).

- [ ] **Step 1: Add confirm state and gated delete flow**

Imports to add:

```tsx
import { useConfirmDestructive } from "../../store/settings";
import { reposUsingProfile } from "../../lib/commands";
```

(`reposUsingProfile` joins the existing `../../lib/commands` import list.)

Inside `GlobalProfilesSection`, add state and replace `remove` with the pair below:

```tsx
  const confirmDestructive = useConfirmDestructive();
  const [confirmingDelete, setConfirmingDelete] =
    useState<{ id: string; usedBy: string[] } | null>(null);

  const doDelete = async (id: string) => {
    setError(null);
    try {
      await deleteGitProfile(id);
      setConfirmingDelete(null);
      invalidateGitProfiles(queryClient);
    } catch (e) {
      setError(formatAppError(e));
    }
  };

  const requestDelete = async (id: string) => {
    // Gated by the global destructive-confirmation setting (never hardcoded).
    if (!confirmDestructive) return void doDelete(id);
    let usedBy: string[] = [];
    try {
      usedBy = await reposUsingProfile(id);
    } catch {
      // Usage lookup is best-effort; the confirmation still shows without it.
    }
    setConfirmingDelete({ id, usedBy });
  };
```

- [ ] **Step 2: Row UI: confirm strip replaces the row buttons**

Replace the Edit/Delete buttons inside the `profiles.map((p) => ...)` row:

```tsx
            {confirmingDelete?.id === p.id ? (
              <>
                <span style={{ fontSize: "var(--fz-sm)", textAlign: "right" }}>
                  {confirmingDelete.usedBy.length > 0 ? (
                    <>
                      Used by <b>{confirmingDelete.usedBy.join(", ")}</b>.
                      {" "}Repos keep their git config and become Unmanaged. Delete profile?
                    </>
                  ) : (
                    "Delete profile?"
                  )}
                </span>
                <Button variant="danger" onClick={() => doDelete(p.id)}>Delete</Button>
                <button onClick={() => setConfirmingDelete(null)}>Cancel</button>
              </>
            ) : (
              <>
                <button onClick={() => setEditing(p)} disabled={!!editing}>Edit</button>
                <button onClick={() => requestDelete(p.id)} disabled={!!editing}>
                  {confirmDestructive ? "Delete…" : "Delete"}
                </button>
              </>
            )}
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors

---

### Task 7: E2E regression test: cross-panel freshness + delete confirmation

This is the test that would have caught the original bug. The key design
point: the repo-settings panel is activated ONCE (so it mounts and renders
its dropdown), then left unfocused; every later assertion reads the dropdown
via DOM queries, never by focusing the panel. Under the old focus-only
refresh, the dropdown would never update and the spec fails.

**Files:**
- Create: `e2e/specs/profiles.spec.ts`
- Modify: `src/panels/Settings/GlobalProfilesSection.tsx` (5 data-testids)
- Modify: `src/panels/Settings/RepoProfileSection.tsx` (1 data-testid)

**Interfaces:**
- Consumes: Tasks 2, 3, 5, 6 (shared query invalidation, status reload on
  list change, delete confirmation). The default smoke fixture is used
  (`seedForSpec` needs no change: only `conflict*` specs get a different
  fixture). Destructive confirmation is ON by default in the hermetic
  `E2E_HOME` app data.
- Produces: `data-testid="repo-profile-select"` becomes a stable contract:
  the repo-identity-modes plan's replacement dropdown MUST keep this testid.

- [ ] **Step 1: Add the test ids**

In `src/panels/Settings/GlobalProfilesSection.tsx`:

- The "New profile" Button: `<Button variant="primary" data-testid="profile-new" onClick={() => setEditing(emptyProfile())}>`
- The ProfileEditor name input (the `Field label="Profile name"` input): add `data-testid="profile-name-input"`
- The "Save profile" Button in ProfileEditor: add `data-testid="profile-save"`
- The per-row Delete trigger (from Task 6): add `data-testid="profile-delete"`
- The confirm-strip danger Button (from Task 6): add `data-testid="profile-delete-confirm"`

In `src/panels/Settings/RepoProfileSection.tsx`, the profile `<select>`:
add `data-testid="repo-profile-select"`.

(If the shared `Button` component does not forward unknown props, spread
rest props onto the underlying `<button>` in `src/panels/shared/buttons.tsx`
- check first; it likely already spreads.)

- [ ] **Step 2: Write the spec**

```ts
// e2e/specs/profiles.spec.ts
// Regression test for the cross-panel profile staleness bug: creating or
// deleting a profile in Global Settings must update the Repo Settings
// profile dropdown WITHOUT the repo panel being focused (the old code only
// refreshed on panel focus). Repo Settings is activated once so it mounts,
// then left unfocused; all dropdown assertions read the DOM directly.
// Also covers the delete-confirmation gate (destructive setting default ON).
import { browser, $, expect } from "@wdio/globals";
import { waitForTextContent } from "../helpers.ts";

const PROFILE_NAME = "E2E Profile";

/** Click a dockview tab by its title text (works for both docks). */
async function clickDockTab(title: string): Promise<void> {
  const tab = $(`//div[contains(@class, "dv-tab")][contains(., "${title}")]`);
  await tab.waitForDisplayed({ timeout: 15_000 });
  await tab.click();
}

/** Option labels of the repo profile dropdown, read atomically (no focus). */
function repoDropdownOptions(): Promise<string[]> {
  return browser.execute(() =>
    Array.from(
      document.querySelectorAll('[data-testid="repo-profile-select"] option'),
    ).map((o) => o.textContent ?? ""),
  );
}

describe("profiles: cross-panel freshness + delete confirmation", () => {
  it("opens the repo and both settings panels", async () => {
    await $('[data-testid="repo-tab"]').waitForDisplayed({ timeout: 30_000 });
    await waitForTextContent('[data-testid="repo-tab"]', "smoke", "repo tab missing");
    // Activate Repo Settings FIRST so it renders its dropdown, then leave
    // it unfocused for the rest of the test.
    await clickDockTab("Repo Settings");
    await $('[data-testid="repo-profile-select"]').waitForDisplayed({ timeout: 15_000 });
    await clickDockTab("Global Settings");
    await $('[data-testid="profile-new"]').waitForDisplayed({ timeout: 15_000 });
  });

  it("creating a profile updates the unfocused repo dropdown", async () => {
    await $('[data-testid="profile-new"]').click();
    await $('[data-testid="profile-name-input"]').setValue(PROFILE_NAME);
    await $('[data-testid="profile-save"]').click();
    await browser.waitUntil(
      async () => (await repoDropdownOptions()).includes(PROFILE_NAME),
      { timeout: 15_000, timeoutMsg: "new profile did not reach the repo dropdown without focus" },
    );
  });

  it("delete asks for confirmation first", async () => {
    await $('[data-testid="profile-delete"]').click();
    await $('[data-testid="profile-delete-confirm"]').waitForDisplayed({ timeout: 10_000 });
    // Not deleted yet: the repo dropdown still lists it.
    expect(await repoDropdownOptions()).toContain(PROFILE_NAME);
  });

  it("confirming the delete removes it from the unfocused repo dropdown", async () => {
    await $('[data-testid="profile-delete-confirm"]').click();
    await browser.waitUntil(
      async () => !(await repoDropdownOptions()).includes(PROFILE_NAME),
      { timeout: 15_000, timeoutMsg: "deleted profile still in the repo dropdown without focus" },
    );
  });
});
```

- [ ] **Step 3: Verify the spec compiles and (if the harness is available) run it**

Run: `cd /mnt/c/NOT_WORK/LeGit/e2e && npx tsc --noEmit`
Expected: no errors

The suite needs a Linux debug binary + tauri-driver + WebKitWebDriver
(normally CI). If available locally, run:
`cd /mnt/c/NOT_WORK/LeGit/e2e && npm test`
Expected: profiles.spec.ts PASS. If the harness is not available locally,
state that explicitly and leave the spec to CI - do not claim it ran.

---

### Task 8: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Rust tests**

Run: `cargo test -p legit-app && cargo test -p legit-core`
Expected: all PASS

- [ ] **Step 2: Frontend type-check + full vitest suite**

Run: `npx tsc --noEmit`
Expected: no errors

Run: `powershell.exe -NoProfile -Command "Set-Location C:\NOT_WORK\LeGit; npx vitest run"`
Expected: all PASS (includes the theme contract and no-literal-colors suites)

- [ ] **Step 3: Manual smoke test (user runs the app from PowerShell)**

Checklist for the interactive check, with Global Settings and Repo Settings open side by side:

1. Create a profile in Global Settings: it appears in Repo Settings' "Use profile" dropdown without refocusing the panel.
2. Apply that profile to the test repo (`C:\NOT_WORK\LeGit-Test`), then delete it in Global Settings with "Destructive action confirmation" ON: the inline confirm appears, names `LeGit-Test` as a user, and after Delete the Repo Settings badge flips to Unmanaged without refocusing.
3. Toggle "Destructive action confirmation" OFF: the Delete button loses its ellipsis and deletes immediately with no confirm.
4. In Repo Settings, "Save as profile" on an unmanaged repo: the new profile appears in Global Settings' list without refocusing.
5. Open the "+" add-repo menu: the clone form's profile dropdown lists the current profiles.
