# Git Profiles in a Separate File - Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Do NOT commit at any point: leave all changes uncommitted for review (house rule; it overrides any skill default).

**Goal:** Persist git profiles in their own portable `<app-data>/git-profiles.json` so dotfile managers (chezmoi) can sync just that file between machines.

**Architecture:** `GitProfilesDoc` stays a field on `GlobalSettings` in memory; only the disk layout changes. A new `profiles_store` module owns the file (path, envelope-validated load, portable serialize, merge-by-id migration); `persist_global_settings` strips the key from `global-settings.json` and writes the profiles file only when the doc changed since the last load/write; `lib.rs` setup loads/migrates before `AppState::new` and surfaces load problems via a new `take_startup_notices` command.

**Tech Stack:** Rust (src-tauri, crate `legit-app`), serde_json, existing `persist::write_atomic{,_sync}`, tauri-specta bindings, React frontend (one effect).

**Spec:** `design/2026-11-05-git-profiles-separate-file.md` (read it first; it fixes semantics this plan references).

## Global Constraints

- Never commit or push; leave everything uncommitted.
- No em-dashes or center dots in any output, including comments and docs.
- Comments only for non-derivable constraints; no historical/what-changed notes.
- A broken (unparseable, unreadable, wrong-envelope) `git-profiles.json` must never be overwritten except by an explicit profile mutation (spec anti-goal).
- `#[serde(skip_serializing)]` on `git_profiles_doc` is forbidden: `sync/model.rs::import_synced_settings` round-trips `GlobalSettings` through `serde_json::Value` and would lose the key.
- Output-only Rust types must not gain field-level `#[serde(default)]` (specta rule); no type changes are expected here.
- Regenerate committed bindings after adding the command: `LEGIT_UPDATE_BINDINGS=1 cargo test -p legit-app bindings` (run via PowerShell interop like all test commands if needed; cargo works from WSL).
- Full gates: `cargo test -p legit-app`, `npx tsc --noEmit`, vitest suite (via `powershell.exe -NoProfile -Command "cd C:\NOT_WORK\LeGit; npx vitest run"`).

## Review Focus

Each line's pinning test is added to the owning task:

1. Corrupt file, then the user edits a profile: the file IS rewritten (explicit supersede). Task 3.
2. Zero-byte file is Broken, not Missing - otherwise the migration write clobbers it. Task 1.
3. Unreadable file (I/O error, e.g. a directory at that path) is Broken, not Missing - same clobber risk. Task 1.
4. Merge never duplicates an id: embedded ids already in the file are not appended, and the file's entries stay byte-identical in order and content. Task 2.
5. A file with unknown extra top-level JSON fields still loads (future minor additions must not brick older versions). Task 1.

---

### Task 1: `profiles_store` - path, envelope-validated load, portable serialize

**Files:**
- Create: `src-tauri/src/profiles_store.rs` (+ `mod profiles_store;` in `src-tauri/src/lib.rs`)
- Modify: `src-tauri/src/sync/model.rs` (make `local_home` and nothing else `pub(crate)`)
- Test: same file, `#[cfg(test)] mod tests`

**Interfaces:**
- Consumes: `GitProfilesDoc`, `GitProfile` from `crate::state`; `portable_profiles_doc`, `localized_profiles_doc`, `local_home` from `crate::sync::model`; `AppError`.
- Produces:
  - `pub fn git_profiles_path(global_settings_path: &Path) -> PathBuf` - `global_settings_path.with_file_name("git-profiles.json")`.
  - `pub enum ProfilesLoad { Missing, Loaded(GitProfilesDoc), Broken(String) }` (Loaded is already localized; Broken carries the human-readable reason).
  - `pub fn load_profiles_file(path: &Path, home: &str) -> ProfilesLoad`.
  - `pub fn portable_profiles_json(doc: &GitProfilesDoc, home: &str) -> Result<String, AppError>` - pretty JSON of the portabilized doc.

- [ ] **Step 1: Write the failing tests** (tempdir-based; build docs with one profile whose `auth_ssh_key` is `<home>/.ssh/id_ed25519`):

```rust
#[test] fn missing_file_is_missing()                 // no file -> ProfilesLoad::Missing
#[test] fn valid_file_loads_localized()              // write portable_profiles_json output, load -> Loaded with "<home>/.ssh/id_ed25519" restored
#[test] fn garbage_is_broken_and_untouched()         // write "not json", load -> Broken(_), file bytes unchanged afterwards
#[test] fn empty_file_is_broken()                    // write "", load -> Broken(_), not Missing
#[test] fn unreadable_path_is_broken()               // create a DIRECTORY named git-profiles.json -> Broken(_), not Missing
#[test] fn wrong_format_is_broken()                  // format: "something-else" -> Broken(_)
#[test] fn newer_version_is_broken()                 // format_version: 2 -> Broken(_) (forward-compat refusal)
#[test] fn unknown_extra_fields_still_load()         // valid envelope + extra top-level key -> Loaded
#[test] fn path_is_settings_sibling()                // git_profiles_path("/x/global-settings.json") == "/x/git-profiles.json"
```

- [ ] **Step 2: Run to verify they fail**

Run: `cargo test -p legit-app profiles_store`
Expected: FAIL to compile (module missing).

- [ ] **Step 3: Implement the module.** Load reads the file itself (NOT `persist::load_json_or_default`, which moves corrupt files aside): `std::fs::read_to_string` where `ErrorKind::NotFound` is Missing and any other error is Broken; parse to `GitProfilesDoc`; then refuse `format != "legit-git-profiles"` or `format_version > 1` as Broken; localize with `localized_profiles_doc(doc, home)`.

- [ ] **Step 4: Run to verify they pass**

Run: `cargo test -p legit-app profiles_store`
Expected: PASS.

### Task 2: merge-by-id and `load_and_migrate_profiles`

**Files:**
- Modify: `src-tauri/src/profiles_store.rs`
- Test: same file

**Interfaces:**
- Consumes: Task 1's functions; `GlobalSettings`; `persist::write_atomic_sync`.
- Produces:
  - `pub fn merge_profiles_by_id(file: &GitProfilesDoc, embedded: &GitProfilesDoc) -> (GitProfilesDoc, bool)` - file's profiles first and unchanged, then each embedded profile whose id the file lacks, in embedded order; bool = anything appended.
  - `pub struct MigrateOutcome { pub notices: Vec<String>, pub file_broken: bool }`
  - `pub fn load_and_migrate_profiles(settings: &mut GlobalSettings, path: &Path, home: &str) -> MigrateOutcome` - applies the spec's load rules to `settings.git_profiles_doc`, writes the file (portable, `write_atomic_sync`) when the rules demand, returns user-facing notices (empty when all is well) and whether the file is broken.

- [ ] **Step 1: Write the failing tests**

```rust
#[test] fn merge_file_wins_per_id_and_appends_unknown()   // same id in both -> file's version kept; embedded-only id appended after file's entries; returns true
#[test] fn merge_identical_adds_nothing()                 // embedded subset of file -> (file.clone(), false)
#[test] fn load_missing_with_embedded_writes_migration()  // no file + settings doc has 1 profile -> file created, parses as portable doc, settings doc unchanged, no notices
#[test] fn load_missing_without_profiles_writes_nothing() // no file + empty doc -> still no file, no notices
#[test] fn load_file_wins_and_merges()                    // file has profile A; embedded has A' (same id, edited) + B -> settings doc = [A, B], file rewritten containing B, no notices
#[test] fn load_file_only_does_not_rewrite()              // file has A, embedded empty -> settings doc = [A], file mtime/bytes unchanged
#[test] fn load_broken_keeps_embedded_and_flags()         // garbage file + embedded profile -> settings doc KEEPS the embedded profile (local profiles keep working), file_broken == true, exactly 1 notice naming the path, file bytes unchanged
#[test] fn load_ok_is_not_flagged_broken()                // valid file -> file_broken == false, no notices
```

- [ ] **Step 2: Run to verify they fail**

Run: `cargo test -p legit-app profiles_store`
Expected: FAIL (functions missing).

- [ ] **Step 3: Implement.** `load_and_migrate_profiles` maps `ProfilesLoad`: Missing -> migration write if `!profiles.is_empty()`; Loaded -> merge, assign merged doc, rewrite only when the merge appended; Broken(reason) -> leave `settings.git_profiles_doc` untouched, set `file_broken`, push a notice naming `path` and `reason` and saying the file was left untouched and the previously known profiles stay active until it is fixed or a profile is edited. A failed write also pushes a notice (`tracing::warn!` too).

- [ ] **Step 4: Run to verify they pass**

Run: `cargo test -p legit-app profiles_store`
Expected: PASS.

### Task 3: persist seam - strip the key, dirty-compare file write

**Files:**
- Modify: `src-tauri/src/state.rs` (AppState fields + `persist_global_settings`), `src-tauri/src/profiles_store.rs` (one helper), `src-tauri/src/lib.rs` (theme-rename write only)
- Test: `src-tauri/src/state.rs` tests module (reuse the existing `state(dir)` helper pattern)

**Interfaces:**
- Consumes: Task 1/2 functions.
- Produces:
  - `pub fn global_settings_disk_json(settings: &GlobalSettings, profiles_file_broken: bool) -> Result<String, AppError>` in `profiles_store.rs`: pretty JSON of the settings with the `gitProfilesDoc` key removed; with `profiles_file_broken` true the key is kept (the embedded copy must survive until the broken file is superseded). Copy the key's exact wire spelling from a serialization of `GlobalSettings::default()` in a test, do not guess casing.
  - `AppState` gains: `git_profiles_path: PathBuf` (from `git_profiles_path(&global_settings_path)` in `new`), `git_profiles_baseline: std::sync::Mutex<GitProfilesDoc>` (initialized in `new` to `global_settings.git_profiles_doc.clone()`), `git_profiles_file_broken: std::sync::Mutex<bool>` (false; set by Task 4 from `MigrateOutcome`), `startup_notices: std::sync::Mutex<Vec<String>>` (empty; consumed in Task 4).
  - `persist_global_settings` behavior later tasks rely on: writes `global-settings.json` WITHOUT the profiles key, EXCEPT while `git_profiles_file_broken` is set - then the full struct is written so the embedded copy survives until the broken file is superseded; writes `git-profiles.json` (portable, `write_atomic`) and updates the baseline ONLY when the current doc differs from the baseline, and that write clears `git_profiles_file_broken`.

- [ ] **Step 1: Write the failing tests** in `state.rs`:

```rust
#[tokio::test] async fn global_settings_json_has_no_profiles_key()  // add a profile to state's settings, persist, read global-settings.json -> no "gitProfilesDoc" key (assert the exact key string also appears when serializing the struct directly, so the strip targets the real spelling)
#[tokio::test] async fn unchanged_doc_never_touches_profiles_file() // persist twice with a non-profile change between -> git-profiles.json does not exist
#[tokio::test] async fn changed_doc_writes_portable_file()          // mutate settings.git_profiles_doc (key path under local home's .ssh), persist -> file exists, contains "~/.ssh/..." portable form; persist again unchanged -> file bytes identical
#[tokio::test] async fn profile_edit_supersedes_broken_file()       // pre-create garbage git-profiles.json, baseline empty; mutate doc; persist -> file now parses as the new doc (Review Focus 1)
#[tokio::test] async fn broken_state_keeps_embedded_key_until_superseded() // set git_profiles_file_broken; persist with non-profile change -> global-settings.json KEEPS "gitProfilesDoc"; then mutate doc + persist -> file written, flag cleared, key stripped
```

- [ ] **Step 2: Run to verify they fail**

Run: `cargo test -p legit-app state::tests`
Expected: FAIL (fields/helper missing, key still present).

- [ ] **Step 3: Implement.** In `persist_global_settings`: clear `git_profiles_file_broken` FIRST when the doc differs from the baseline (the profile edit supersedes the broken file), then write `global-settings.json` via `global_settings_disk_json(&settings, *broken)`, then write the profiles file and update the baseline when the doc differed. In `lib.rs`'s theme-rename block replace its `serde_json::to_string_pretty(&global_settings)` with `global_settings_disk_json(&global_settings, outcome.file_broken)` (the migrate outcome from Task 4 exists at that point; until Task 4 lands, pass `false`).

- [ ] **Step 4: Run the crate suite**

Run: `cargo test -p legit-app`
Expected: PASS (existing sync-engine tests prove the in-memory sync merge still sees the key).

### Task 4: startup wiring + `take_startup_notices` command

**Files:**
- Modify: `src-tauri/src/lib.rs` (setup), `src-tauri/src/commands/persistence.rs` (new command), `src-tauri/src/lib.rs` `collect_commands!` registration
- Generated: `src/lib/bindings.ts` (regenerate, commit stays for the user)

**Interfaces:**
- Consumes: Task 2's `load_and_migrate_profiles`, Task 3's `startup_notices` field.
- Produces: `#[tauri::command] #[specta::specta] pub async fn take_startup_notices(state: tauri::State<'_, AppState>) -> Result<Vec<String>, AppError>` - drains and returns `startup_notices` (empty on second call). Frontend name: `api.takeStartupNotices()`.

- [ ] **Step 1: Wire setup.** In `lib.rs` setup, directly after `load_global_settings_sync` and before the theme-rename block: `let outcome = profiles_store::load_and_migrate_profiles(&mut global_settings, &profiles_store::git_profiles_path(&global_settings_path), &crate::sync::model::local_home());` Pass `outcome.file_broken` to the theme-rename block's `global_settings_disk_json` call. After `AppState::new`, set `state.git_profiles_file_broken` and push `outcome.notices` into `state.startup_notices` before `app.manage(state)`.

- [ ] **Step 2: Add the command** (drain with `std::mem::take`), register it in `collect_commands!`.

- [ ] **Step 3: Regenerate bindings**

Run: `LEGIT_UPDATE_BINDINGS=1 cargo test -p legit-app bindings`
Expected: PASS, `src/lib/bindings.ts` updated with `takeStartupNotices`.

- [ ] **Step 4: Run the crate suite**

Run: `cargo test -p legit-app`
Expected: PASS (bindings staleness test included).

### Task 5: frontend notice surfacing + bookkeeping

**Files:**
- Modify: `src/panels/AppLayout.tsx`, `CHANGELOG.md`, `BACKLOG.md`, `design/2026-11-05-git-profiles-separate-file.md` (only if implementation diverged)

**Interfaces:**
- Consumes: `api.takeStartupNotices()` (Task 4), `notify` from `src/store/notifications`.

- [ ] **Step 1: Add a mount effect** in `AppLayout` (alongside the existing mount effects): call `api.takeStartupNotices()`, `notify.error(n)` for each returned string, swallow call failures silently (a notice fetch must never break startup). No vitest seam exists for this wiring; the behavior is pinned backend-side (Task 2 notices, Task 4 drain).

- [ ] **Step 2: CHANGELOG** - under `## [Unreleased]` / Changed: one bullet that git profiles now live in their own portable `git-profiles.json` next to the app settings (dotfile-manager friendly; migrates automatically).

- [ ] **Step 3: BACKLOG** - remove the issue #50 release-blocker entry (back to "(none currently)").

- [ ] **Step 4: Full verification**

Run: `cargo test -p legit-app`, `npx tsc --noEmit`, full vitest via PowerShell.
Expected: all green. Report any unrelated failure by name.
