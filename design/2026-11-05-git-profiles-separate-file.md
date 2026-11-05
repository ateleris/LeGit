# Git profiles in a separate file

Issue: https://github.com/ateleris/LeGit/issues/50 (release blocker).

## Intent

Git profiles currently live embedded in `global-settings.json`
(`GlobalSettings::git_profiles_doc`). Users who manage their dotfiles with
a tool like chezmoi cannot share just the profiles between machines:
managing the whole settings file would clobber machine-local state on
every apply. Profiles move to their own file so that file alone can be put
under dotfile management.

## Goals

- Profiles persist in `<app-data>/git-profiles.json`, nothing else in it.
- The identical file is valid on every machine: SSH key paths inside are
  stored in portable `~/.ssh/<file>` form and localized on load.
- An externally replaced file (chezmoi apply) is picked up at the next
  LeGit startup.
- Existing installations migrate automatically and losslessly.

## Non-goals (this slice)

- Live reload while LeGit runs (watch the file): deferred. Startup-only
  read is the decided v1 scope; if demand shows up, a watcher can be added
  later without changing the file format.
- Syncing per-repo profile ASSIGNMENTS through the file: assignments stay
  in repo settings. The file carries the profile definitions only.
- Any UI change. The profiles section, commands, and IPC types are
  untouched.

## Anti-goals

- A chezmoi-applied file that fails to parse must never be silently
  replaced with an empty profile list. Losing the user's (possibly
  mis-templated) file content is worse than running without profiles.
- `global-settings.json` must not keep a second, stale copy of the
  profiles after migration: two sources of truth would confuse exactly
  the dotfile-management use case this feature serves.

## Design

### Runtime shape: unchanged

`GitProfilesDoc` stays a field on `GlobalSettings` in memory, so the ~20
read/write sites (`commands/profiles.rs`, `commands/repo.rs`,
`sync/engine.rs`, `sync/model.rs`) and the IPC surface stay as they are.
Only the on-disk layout changes.

### On-disk layout

- `<app-data>/git-profiles.json` holds the `GitProfilesDoc` envelope
  exactly as it serializes today (`format: "legit-git-profiles"`,
  `format_version: 1`, `profiles: [...]`) with key paths in portable
  form. The envelope is already versioned; no format change.
- `global-settings.json` no longer contains the profiles key (wire
  spelling `gitProfiles`, a serde rename of `git_profiles_doc`):
  `AppState::persist_global_settings` serializes to a `serde_json::Value`
  and strips that key before `write_atomic`. The theme-rename block in
  `lib.rs`'s setup writes `global-settings.json` directly as well; it
  applies the same strip (one shared helper for "serialize global
  settings for disk"). The field keeps plain serde
  derives, so old files (and the migration read below) still parse, and
  the sync engine's value-level merge (`import_synced_settings`, which
  round-trips `GlobalSettings` through `serde_json::Value` and relies on
  `merged.contains_key`) keeps working unmodified. Do NOT use
  `#[serde(skip_serializing)]`: it would silently drop the profiles key
  from that sync merge.

### Portable paths

Reuse `portable_profiles_doc` / `localized_profiles_doc`
(`sync/model.rs`): portabilize with the local home on every write of the
file, localize on load. `local_home()` becomes reachable for this (it is
private today). Only paths directly inside `~/.ssh` are rewritten; custom
locations pass through literally, same trade-off the settings sync
already made.

### Load (startup, `lib.rs` setup after `load_global_settings_sync`)

1. `git-profiles.json` exists and parses: localize it and MERGE BY ID
   with any embedded `git_profiles_doc` still present in
   `global-settings.json`: the file's profiles win per id, embedded
   profiles whose id the file lacks are appended, and when the merge
   added anything the file is rewritten so the recovered profiles
   propagate. This collision is the normal upgrade path on every machine
   except the first (chezmoi applies the file before the machine's LeGit
   is upgraded), and discarding the machine-local profiles would lose
   data and dangle their repo-settings assignments. Once the embedded
   field is gone (first settings persist after upgrade), this reduces to
   "the file wins".
2. File missing: keep whatever the embedded `git_profiles_doc` field
   yielded (migration source, or the empty default on a fresh install).
   If that doc has profiles, write `git-profiles.json` immediately so the
   migrated file exists for the user to point chezmoi at.
3. File exists but fails to parse: log + remember the failure ("broken"
   state), KEEP the embedded doc in memory (on an already-migrated
   machine that is the empty default; on a first-upgrade machine the
   local profiles keep working), and surface a startup warning toast
   naming the file (reuse the existing frontend error-forwarding/notify
   path; exact surface is the builder's choice). While broken, the
   key-strip below is suspended so `global-settings.json` keeps its
   embedded copy - otherwise fixing the file later could no longer
   recover the machine-local profiles. The broken state clears when a
   profile edit writes the file. See write rules below for why the file
   is not clobbered. Three cases take this same path:
   - JSON parse failure.
   - A read I/O error. It must NOT be treated as "file missing", or the
     migration write in rule 2 would overwrite a file that merely could
     not be read.
   - An unexpected envelope: `format` != "legit-git-profiles" or
     `format_version` > 1. Serde would happily deserialize a future
     version's file (unknown fields ignored), and the next profile edit
     would rewrite it as v1, destroying newer content distributed via
     chezmoi from a newer LeGit. Refusing it like a parse failure is the
     forward-compat rule.
   The file therefore needs its own loader: `persist::load_json_or_default`
   is unsuitable here because it moves a corrupt file aside, which is
   exactly the clobbering the anti-goal forbids.

The embedded field disappears from `global-settings.json` at the next
settings persist (any settings change), completing the migration without
a separate write at startup.

### Write rules

`persist_global_settings` keeps a last-written copy of the doc (in
`AppState`) and writes `git-profiles.json` (atomically, portable form)
only when the current doc differs from it. Consequences, all intended:

- Unrelated settings changes (font size, theme) never touch the file:
  no mtime noise for dotfile tooling, and after a failed parse the file
  stays untouched.
- After a failed parse, the baseline is the in-memory doc at startup (the
  kept embedded copy); the file is only rewritten once the user actually
  edits a profile, which is an explicit decision to supersede the broken
  content, and that write also clears the broken state (the strip
  resumes).
- Profile mutations (create/edit/delete, sync import with
  `sync_git_profiles` on) flow through the existing
  `persist_global_settings` call sites unchanged.

### Settings sync interaction

No behavior change. The sync engine reads and writes
`global_settings.git_profiles_doc` in memory; export already
portabilizes, import already localizes. The only difference is where the
doc lands on disk afterwards (the new file, via the write rule above).

## Constraints

- Old `global-settings.json` files (with the embedded field) and old
  `settings files without it must both keep parsing (`#[serde(default)]`
  stays on nothing new; the field already defaults).
- A downgrade to an older LeGit after migration loses sight of the
  profiles (old versions read only the embedded field). Accepted; noted
  here so support knows.
- Tests pin: load-order precedence (file wins over embedded), migration
  write, parse-failure non-clobbering, portable round-trip through the
  file, and that `global-settings.json` no longer contains the key after
  a persist.
- CHANGELOG bullet (user-visible: profiles file location changed, chezmoi
  use unlocked). Consider a line in the issue when closing it naming the
  file path per OS.

## Left to the builder

- Exact representation of the "last-written doc" baseline and where the
  parse-failure flag lives in `AppState`.
- The precise startup-warning surface for a corrupt file.
- Whether the fresh-install empty doc writes the file on first profile
  creation only (follows from the dirty-compare rule) - fine either way.
- Test seams: Rust unit tests around a `load_git_profiles` /
  `persist` pair vs integration through `AppState`; follow existing
  state.rs test patterns.
