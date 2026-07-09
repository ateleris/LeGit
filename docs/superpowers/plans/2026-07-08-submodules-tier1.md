# Submodules Tier 1 (State Model + Display) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Do NOT use subagent-driven-development (user rule). Do NOT commit at any point (user rule): leave all changes in the working tree for the user to review.

**Goal:** Make submodules first-class read-only citizens: real `submodules()` enumeration with a full state model, `SubmoduleChanged` status entries from porcelain v2 `S` flags, proper submodule pointer diffs (old -> new SHA + commit list), gitlink classification in commit details, and a Submodules section in the Refs panel. (Spec: `docs/superpowers/specs/2026-07-08-submodules-architecture-design.md`, sub-project 2.)

**Architecture:** New pure parsers in `parsers/submodules.rs` feed a `GitCliBackend::submodules()` orchestration (ls-files gitlinks + `.gitmodules`/local config + one superproject porcelain-v2 status for dirt flags + per-populated-submodule rev-parse probes). The status parser learns to emit `SubmoduleChanged` from the `S<c><m><u>` field; the diff parser learns to detect `Subproject commit` gitlink diffs (with `diff.submodule=short` pinned per invocation); `commit_files` migrates from `--name-status` to `--raw` so modes (`160000`) classify gitlinks. Two new IPC commands (`repo_submodules`, `repo_submodule_log`) feed a read-only `SubmodulesSection` pane and a `SubmoduleDiffView`.

**Tech Stack:** Rust (crates/legit-core, src-tauri), React + TypeScript + react-query (src/), FakeExecutor flow tests, real-git harness.

## Global Constraints

- **No commits, no pushes.** All changes stay in the working tree for user review.
- Never run `git submodule status` or `git submodule--helper` in bulk enumeration (perf trap / removed internals - spec "Enumeration").
- Pin `-c diff.submodule=short` on every parsed `git diff` invocation (user `diff.submodule=log` config breaks the parser otherwise).
- Key submodules by **name** (durable), display by **path**.
- New UI colors only via existing theme tokens (`--status-*`, `--subtle-fg`, `--ref-*`, `--panel-border`); no literal colors, no new tokens needed in this sub-project.
- All UI dimensions from `--fz-*` / em (no fixed px except 1px hairlines).
- Real-git submodule fixtures must pass `-c protocol.file.allow=always` **on the invoking command** (CVE-2022-39253 hardening).
- Verification from WSL: `cargo test -p legit-core` and `npx tsc --noEmit`. vitest and the app itself run only from PowerShell - the plan's final step lists what the user must run there.
- No em-dashes in comments or docs; use hyphens or colons.
- `src/lib/bindings.ts` is regenerated when the app runs (debug) - do NOT hand-edit it; hand-mirror types in `src/lib/types.ts` and wrappers in `src/lib/commands.ts`.

---

### Task 1: Domain types (Rust + TS mirrors)

**Files:**
- Modify: `crates/legit-core/src/types.rs:291-296` (SubmoduleChange), `crates/legit-core/src/types.rs:766-775` (SubmoduleInfo; add SubmoduleState + SubmoduleLog nearby)
- Modify: `src/lib/types.ts:418-422` (SubmoduleChange mirror; add SubmoduleInfo/SubmoduleState/SubmoduleLog mirrors)
- Modify: `crates/legit-core/src/cli_impl/parsers/diff.rs` + any other construction site if `cargo check` flags one (SubmoduleChange gains a field)

**Interfaces:**
- Produces (Rust, all `derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)`):
  - `SubmoduleChange { path: PathBuf, old_sha: Option<CommitId>, new_sha: Option<CommitId>, dirty: bool }`
  - `SubmoduleState { initialized, populated, pointer_moved, dirty_tracked, dirty_untracked, conflicted, orphan_gitlink, config_drift : bool }`
  - `SubmoduleInfo { name: String, path: PathBuf, url: Option<String>, gitmodules_url: Option<String>, branch: Option<String>, recorded_sha: Option<CommitId>, checked_out_sha: Option<CommitId>, head_branch: Option<String>, state: SubmoduleState }`
  - `SubmoduleLogEntry { id: CommitId, subject: String }`
  - `SubmoduleLog` enum (serde `tag = "kind", rename_all = "snake_case"`): `Commits { commits: Vec<SubmoduleLogEntry> }` | `TargetMissing`
- Consumed by every later task.

- [x] **Step 1: Replace the Rust types**

In `types.rs`, replace the `SubmoduleChange` struct (lines 291-296) with:

```rust
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct SubmoduleChange {
    pub path: PathBuf,
    pub old_sha: Option<CommitId>,
    pub new_sha: Option<CommitId>,
    /// The submodule worktree has uncommitted content on top of `new_sha`
    /// (git's `-dirty` suffix on the `Subproject commit` line).
    pub dirty: bool,
}
```

Replace the `SubmoduleInfo` struct (lines 766-775) with:

```rust
/// Orthogonal state flags of one submodule. A struct, not an enum: states
/// combine freely (detached AND dirty AND pointer-moved). The UI derives a
/// single display badge by precedence (spec 2026-07-08, "Data model").
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, Default)]
pub struct SubmoduleState {
    /// Registered in `.git/config` (`submodule.<name>.url` present).
    pub initialized: bool,
    /// The worktree is checked out (a git repo exists at the path).
    pub populated: bool,
    /// Checked-out HEAD differs from the SHA recorded in the superproject.
    pub pointer_moved: bool,
    /// Modified tracked files inside the submodule worktree.
    pub dirty_tracked: bool,
    /// Untracked files inside the submodule worktree.
    pub dirty_untracked: bool,
    /// The gitlink is unmerged in the superproject.
    pub conflicted: bool,
    /// A gitlink with no `.gitmodules` entry.
    pub orphan_gitlink: bool,
    /// `.gitmodules` URL and effective (`.git/config`) URL disagree.
    pub config_drift: bool,
}

/// Submodule entry as recorded in the superproject. Keyed by `name` (durable
/// across `git mv`: config sections and `.git/modules/<name>` use it);
/// displayed by `path`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct SubmoduleInfo {
    pub name: String,
    pub path: PathBuf,
    /// Effective URL (`.git/config`); `None` when uninitialized.
    pub url: Option<String>,
    /// URL declared in `.gitmodules` (for drift detection).
    pub gitmodules_url: Option<String>,
    /// `.gitmodules` `branch` field (used by `update --remote`, tier 3).
    pub branch: Option<String>,
    /// The gitlink SHA in the superproject index; `None` for a declared-but-
    /// never-added entry.
    pub recorded_sha: Option<CommitId>,
    /// HEAD of the checked-out submodule; `None` when unpopulated.
    pub checked_out_sha: Option<CommitId>,
    /// The submodule's checked-out branch; `None` = detached HEAD (or
    /// unpopulated).
    pub head_branch: Option<String>,
    pub state: SubmoduleState,
}

/// One commit in a submodule pointer range (`repo_submodule_log`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct SubmoduleLogEntry {
    pub id: CommitId,
    pub subject: String,
}

/// Commits between two submodule pointers, or the reason they can't be shown.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SubmoduleLog {
    Commits { commits: Vec<SubmoduleLogEntry> },
    /// The target SHA is not present in the submodule's object store - the
    /// pointer references an unfetched commit.
    TargetMissing,
}
```

- [x] **Step 2: Check compilation and fix construction sites**

Run: `cargo check -p legit-core 2>&1 | tail -20`
Expected: currently clean (nothing constructs `SubmoduleChange` yet; the `submodules()` stub returns `Err`). If a constructor site errors, add `dirty: false` there.

- [x] **Step 3: Mirror in TypeScript**

In `src/lib/types.ts`, replace the `SubmoduleChange` interface (lines 418-422) with:

```ts
export interface SubmoduleChange {
  path: string;
  old_sha: string | null;
  new_sha: string | null;
  /** Submodule worktree has uncommitted content (git's `-dirty` suffix). */
  dirty: boolean;
}

/** Orthogonal submodule state flags (mirrors SubmoduleState in types.rs). */
export interface SubmoduleState {
  initialized: boolean;
  populated: boolean;
  pointer_moved: boolean;
  dirty_tracked: boolean;
  dirty_untracked: boolean;
  conflicted: boolean;
  orphan_gitlink: boolean;
  config_drift: boolean;
}

/** Submodule entry (mirrors SubmoduleInfo in types.rs). */
export interface SubmoduleInfo {
  name: string;
  path: string;
  url: string | null;
  gitmodules_url: string | null;
  branch: string | null;
  recorded_sha: string | null;
  checked_out_sha: string | null;
  head_branch: string | null;
  state: SubmoduleState;
}

export interface SubmoduleLogEntry {
  id: string;
  subject: string;
}

export type SubmoduleLog =
  | { kind: "commits"; commits: SubmoduleLogEntry[] }
  | { kind: "target_missing" };
```

- [x] **Step 4: Verify TypeScript compiles**

Run: `npx tsc --noEmit 2>&1 | head -5`
Expected: clean (the `dirty` field is additive; nothing reads it yet).

---

### Task 2: Pure submodule parsers (`parsers/submodules.rs`)

**Files:**
- Create: `crates/legit-core/src/cli_impl/parsers/submodules.rs`
- Modify: `crates/legit-core/src/cli_impl/parsers/mod.rs` (add `pub mod submodules;`)

**Interfaces:**
- Consumes: `SubmoduleInfo`, `SubmoduleState`, `CommitId` from Task 1.
- Produces (used by Task 3's orchestration):
  - `pub const LS_FILES_STAGE_ARGS: [&str; 3] = ["ls-files", "--stage", "-z"]`
  - `pub const GITMODULES_CONFIG_ARGS: [&str; 6]` / `pub const LOCAL_SUBMODULE_CONFIG_ARGS: [&str; 4]`
  - `pub fn parse_gitlinks(ls_files: &str) -> Vec<(PathBuf, CommitId)>`
  - `pub struct SubmoduleConfigEntry { path, url, branch: Option<String>, active: Option<bool> }` + `pub fn parse_submodule_config(cfg: &str) -> HashMap<String, SubmoduleConfigEntry>` (name-keyed; works for both `.gitmodules` and local config output)
  - `pub struct SubmoduleDirt { dirty_tracked, dirty_untracked, conflicted: bool }` + `pub fn parse_status_submodule_flags(status: &str) -> HashMap<PathBuf, SubmoduleDirt>`
  - `pub struct SubmoduleProbe { checked_out_sha: CommitId, head_branch: Option<String> }`
  - `pub fn assemble_submodules(gitlinks, gitmodules, local, dirt, probes) -> Vec<SubmoduleInfo>`

Check `CommitId`'s constructor in `types.rs` before starting (it is used as `CommitId::new(...)`/`.as_str()` in `git_flows.rs`; adjust the call form if the actual API differs).

- [x] **Step 1: Write the failing tests**

Create `crates/legit-core/src/cli_impl/parsers/submodules.rs` containing ONLY the test module for now (add `pub mod submodules;` to `parsers/mod.rs`):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::CommitId;
    use std::path::PathBuf;

    fn z(records: &[&str]) -> String {
        let mut s = records.join("\0");
        s.push('\0');
        s
    }

    const SHA_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const SHA_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    // -- parse_gitlinks ------------------------------------------------------

    #[test]
    fn gitlinks_keeps_only_mode_160000() {
        let out = z(&[
            &format!("100644 {SHA_A} 0\tsrc/main.rs"),
            &format!("160000 {SHA_B} 0\tvendor/lib"),
        ]);
        assert_eq!(
            parse_gitlinks(&out),
            vec![(PathBuf::from("vendor/lib"), CommitId::new(SHA_B))]
        );
    }

    #[test]
    fn gitlinks_handles_paths_with_spaces_and_empty_input() {
        let out = z(&[&format!("160000 {SHA_A} 0\tdir with space/sub")]);
        assert_eq!(parse_gitlinks(&out)[0].0, PathBuf::from("dir with space/sub"));
        assert_eq!(parse_gitlinks(""), vec![]);
    }

    // -- parse_submodule_config ---------------------------------------------

    #[test]
    fn config_groups_fields_by_name() {
        // `git config -z` records are `<key>\n<value>` NUL-terminated.
        let out = z(&[
            "submodule.lib.path\nvendor/lib",
            "submodule.lib.url\nhttps://example.invalid/lib.git",
            "submodule.lib.branch\nmain",
        ]);
        let cfg = parse_submodule_config(&out);
        let lib = &cfg["lib"];
        assert_eq!(lib.path.as_deref(), Some("vendor/lib"));
        assert_eq!(lib.url.as_deref(), Some("https://example.invalid/lib.git"));
        assert_eq!(lib.branch.as_deref(), Some("main"));
        assert_eq!(lib.active, None);
    }

    #[test]
    fn config_handles_dotted_names_and_active() {
        // Submodule names may contain dots: the field is the LAST segment.
        let out = z(&[
            "submodule.a.b.path\nsub",
            "submodule.a.b.active\ntrue",
        ]);
        let cfg = parse_submodule_config(&out);
        let e = &cfg["a.b"];
        assert_eq!(e.path.as_deref(), Some("sub"));
        assert_eq!(e.active, Some(true));
    }

    // -- parse_status_submodule_flags ----------------------------------------

    #[test]
    fn status_flags_read_the_s_field() {
        let out = z(&[
            "1 .M S.M. 160000 160000 160000 aaaaaaa bbbbbbb vendor/dirty",
            "1 .M S..U 160000 160000 160000 aaaaaaa bbbbbbb vendor/untracked",
            "1 .M SCMU 160000 160000 160000 aaaaaaa bbbbbbb vendor/all",
            "1 .M N... 100644 100644 100644 aaaaaaa bbbbbbb plain.txt",
        ]);
        let flags = parse_status_submodule_flags(&out);
        assert_eq!(flags.len(), 3);
        let d = &flags[&PathBuf::from("vendor/dirty")];
        assert!(d.dirty_tracked && !d.dirty_untracked && !d.conflicted);
        let u = &flags[&PathBuf::from("vendor/untracked")];
        assert!(!u.dirty_tracked && u.dirty_untracked);
        let a = &flags[&PathBuf::from("vendor/all")];
        assert!(a.dirty_tracked && a.dirty_untracked);
    }

    #[test]
    fn status_flags_mark_unmerged_gitlinks_conflicted() {
        let out = z(&[
            "u UU S... 160000 160000 160000 160000 a1 a2 a3 vendor/lib",
        ]);
        let flags = parse_status_submodule_flags(&out);
        assert!(flags[&PathBuf::from("vendor/lib")].conflicted);
    }

    // -- assemble_submodules ---------------------------------------------------

    fn one_gitlink() -> Vec<(PathBuf, CommitId)> {
        vec![(PathBuf::from("vendor/lib"), CommitId::new(SHA_A))]
    }

    fn gm_entry(path: &str, url: &str) -> HashMap<String, SubmoduleConfigEntry> {
        let mut m = HashMap::new();
        m.insert(
            "lib".to_string(),
            SubmoduleConfigEntry {
                path: Some(path.to_string()),
                url: Some(url.to_string()),
                branch: None,
                active: None,
            },
        );
        m
    }

    #[test]
    fn assembles_a_clean_initialized_submodule() {
        let mut probes = HashMap::new();
        probes.insert(
            PathBuf::from("vendor/lib"),
            SubmoduleProbe { checked_out_sha: CommitId::new(SHA_A), head_branch: Some("main".into()) },
        );
        let subs = assemble_submodules(
            &one_gitlink(),
            &gm_entry("vendor/lib", "https://example.invalid/lib.git"),
            &gm_entry("vendor/lib", "https://example.invalid/lib.git"),
            &HashMap::new(),
            &probes,
        );
        assert_eq!(subs.len(), 1);
        let s = &subs[0];
        assert_eq!(s.name, "lib");
        assert_eq!(s.path, PathBuf::from("vendor/lib"));
        assert_eq!(s.recorded_sha, Some(CommitId::new(SHA_A)));
        assert_eq!(s.checked_out_sha, Some(CommitId::new(SHA_A)));
        assert_eq!(s.head_branch.as_deref(), Some("main"));
        assert!(s.state.initialized && s.state.populated);
        assert!(!s.state.pointer_moved && !s.state.orphan_gitlink && !s.state.config_drift);
    }

    #[test]
    fn detects_pointer_moved_and_detached() {
        let mut probes = HashMap::new();
        probes.insert(
            PathBuf::from("vendor/lib"),
            SubmoduleProbe { checked_out_sha: CommitId::new(SHA_B), head_branch: None },
        );
        let s = &assemble_submodules(
            &one_gitlink(),
            &gm_entry("vendor/lib", "u"),
            &gm_entry("vendor/lib", "u"),
            &HashMap::new(),
            &probes,
        )[0];
        assert!(s.state.pointer_moved);
        assert_eq!(s.head_branch, None);
    }

    #[test]
    fn uninitialized_when_absent_from_local_config_and_unpopulated_without_probe() {
        let s = &assemble_submodules(
            &one_gitlink(),
            &gm_entry("vendor/lib", "u"),
            &HashMap::new(), // not registered locally
            &HashMap::new(),
            &HashMap::new(), // probe failed -> unpopulated
        )[0];
        assert!(!s.state.initialized && !s.state.populated);
        assert_eq!(s.checked_out_sha, None);
        assert!(!s.state.pointer_moved, "no worktree - nothing to compare");
    }

    #[test]
    fn orphan_gitlink_without_gitmodules_entry_uses_path_as_name() {
        let s = &assemble_submodules(
            &one_gitlink(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
        )[0];
        assert!(s.state.orphan_gitlink);
        assert_eq!(s.name, "vendor/lib");
        assert_eq!(s.gitmodules_url, None);
    }

    #[test]
    fn config_drift_when_urls_disagree() {
        let s = &assemble_submodules(
            &one_gitlink(),
            &gm_entry("vendor/lib", "https://new.invalid/lib.git"),
            &gm_entry("vendor/lib", "https://old.invalid/lib.git"),
            &HashMap::new(),
            &HashMap::new(),
        )[0];
        assert!(s.state.config_drift);
        assert_eq!(s.url.as_deref(), Some("https://old.invalid/lib.git"));
        assert_eq!(s.gitmodules_url.as_deref(), Some("https://new.invalid/lib.git"));
    }

    #[test]
    fn declared_but_never_added_entry_is_included_without_recorded_sha() {
        let s = &assemble_submodules(
            &[],
            &gm_entry("vendor/lib", "u"),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
        )[0];
        assert_eq!(s.recorded_sha, None);
        assert!(!s.state.populated && !s.state.initialized);
    }

    #[test]
    fn dirt_flags_are_merged_and_output_is_path_sorted() {
        let mut dirt = HashMap::new();
        dirt.insert(
            PathBuf::from("vendor/lib"),
            SubmoduleDirt { dirty_tracked: true, dirty_untracked: false, conflicted: false },
        );
        let mut gitlinks = one_gitlink();
        gitlinks.push((PathBuf::from("aaa/first"), CommitId::new(SHA_B)));
        let subs = assemble_submodules(&gitlinks, &HashMap::new(), &HashMap::new(), &dirt, &HashMap::new());
        assert_eq!(subs[0].path, PathBuf::from("aaa/first"));
        assert!(subs[1].state.dirty_tracked);
    }
}
```

- [x] **Step 2: Run to verify failure**

Run: `cargo test -p legit-core --lib parsers::submodules 2>&1 | tail -5`
Expected: COMPILE ERROR (functions/types not defined).

- [x] **Step 3: Implement the parsers**

Add above the test module:

```rust
//! Pure parsers + assembly for submodule enumeration, backing `submodules()`.
//!
//! Enumeration deliberately avoids `git submodule status` (spawns `git
//! describe` per submodule - the SourceTree perf trap) and the removed
//! internal `git submodule--helper`. Sources instead (spec 2026-07-08,
//! sub-project 2): index gitlinks (`ls-files --stage`, mode 160000),
//! `.gitmodules` + local config (`git config -z --get-regexp`), the one
//! superproject porcelain-v2 status (`S<c><m><u>` dirt flags), and one
//! `rev-parse` probe per populated submodule.

use crate::types::{CommitId, SubmoduleInfo, SubmoduleState};
use std::collections::HashMap;
use std::path::PathBuf;

/// Index listing; gitlinks are the mode-160000 entries.
pub const LS_FILES_STAGE_ARGS: [&str; 3] = ["ls-files", "--stage", "-z"];

/// All `submodule.*` keys from `.gitmodules` (declared submodules). Exits
/// non-zero when the file is missing or has no matches - treat as empty.
pub const GITMODULES_CONFIG_ARGS: [&str; 6] =
    ["config", "-f", ".gitmodules", "-z", "--get-regexp", "^submodule\\."];

/// All `submodule.*` keys from the effective config (registration state:
/// `submodule.<name>.url` present = initialized). Exits non-zero on no
/// matches - treat as empty.
pub const LOCAL_SUBMODULE_CONFIG_ARGS: [&str; 4] =
    ["config", "-z", "--get-regexp", "^submodule\\."];

/// Fields of one `submodule.<name>.*` config section (either file).
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct SubmoduleConfigEntry {
    pub path: Option<String>,
    pub url: Option<String>,
    pub branch: Option<String>,
    pub active: Option<bool>,
}

/// Worktree dirt of one submodule, read from the superproject's porcelain-v2
/// status `S<c><m><u>` field (`m` = tracked modifications, `u` = untracked)
/// and `u` (unmerged) records.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct SubmoduleDirt {
    pub dirty_tracked: bool,
    pub dirty_untracked: bool,
    pub conflicted: bool,
}

/// Result of probing a populated submodule (`git -C <path> rev-parse ...`).
/// Absence from the probe map means the probe failed = unpopulated.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubmoduleProbe {
    pub checked_out_sha: CommitId,
    /// `None` = detached HEAD.
    pub head_branch: Option<String>,
}

/// Parse `ls-files --stage -z` and keep the gitlinks:
/// `<mode> <sha> <stage>\t<path>` records, mode `160000`.
pub fn parse_gitlinks(ls_files: &str) -> Vec<(PathBuf, CommitId)> {
    let mut out = Vec::new();
    for record in ls_files.split('\0') {
        let Some((meta, path)) = record.split_once('\t') else { continue };
        let mut fields = meta.split(' ');
        if fields.next() != Some("160000") {
            continue;
        }
        let Some(sha) = fields.next() else { continue };
        out.push((PathBuf::from(path), CommitId::new(sha)));
    }
    out
}

/// Parse `git config -z --get-regexp '^submodule\.'` output
/// (`<key>\n<value>` NUL-terminated records) into name-keyed entries.
/// Submodule names may contain dots: the field is the LAST `.` segment.
pub fn parse_submodule_config(cfg: &str) -> HashMap<String, SubmoduleConfigEntry> {
    let mut map: HashMap<String, SubmoduleConfigEntry> = HashMap::new();
    for record in cfg.split('\0') {
        let Some((key, value)) = record.split_once('\n') else { continue };
        let Some(rest) = key.strip_prefix("submodule.") else { continue };
        let Some((name, field)) = rest.rsplit_once('.') else { continue };
        let entry = map.entry(name.to_string()).or_default();
        match field {
            "path" => entry.path = Some(value.to_string()),
            "url" => entry.url = Some(value.to_string()),
            "branch" => entry.branch = Some(value.to_string()),
            "active" => entry.active = Some(value == "true"),
            _ => {}
        }
    }
    map
}

/// Extract per-submodule dirt flags from `git status --porcelain=v2 -z`
/// output: `1`/`2` records whose `<sub>` field starts with `S` carry
/// `S<c><m><u>`; `u` records with an `S` sub field are conflicted gitlinks.
pub fn parse_status_submodule_flags(status: &str) -> HashMap<PathBuf, SubmoduleDirt> {
    let mut map = HashMap::new();
    let mut tokens = status.split('\0');
    while let Some(record) = tokens.next() {
        let Some(&tag) = record.as_bytes().first() else { continue };
        match tag {
            b'1' => {
                let mut fields = record.splitn(9, ' ');
                let (Some(_xy), Some(sub)) = (fields.nth(1), fields.next()) else { continue };
                let Some(path) = fields.nth(5) else { continue };
                if let Some(dirt) = dirt_from_sub(sub) {
                    map.insert(PathBuf::from(path), dirt);
                }
            }
            b'2' => {
                tokens.next(); // original path field
                let mut fields = record.splitn(10, ' ');
                let (Some(_xy), Some(sub)) = (fields.nth(1), fields.next()) else { continue };
                let Some(path) = fields.nth(6) else { continue };
                if let Some(dirt) = dirt_from_sub(sub) {
                    map.insert(PathBuf::from(path), dirt);
                }
            }
            b'u' => {
                let mut fields = record.splitn(11, ' ');
                let (Some(_xy), Some(sub)) = (fields.nth(1), fields.next()) else { continue };
                let Some(path) = fields.nth(7) else { continue };
                if sub.starts_with('S') {
                    map.insert(
                        PathBuf::from(path),
                        SubmoduleDirt { conflicted: true, ..Default::default() },
                    );
                }
            }
            _ => {}
        }
    }
    map
}

fn dirt_from_sub(sub: &str) -> Option<SubmoduleDirt> {
    if !sub.starts_with('S') {
        return None;
    }
    let b = sub.as_bytes();
    Some(SubmoduleDirt {
        dirty_tracked: b.get(2) == Some(&b'M'),
        dirty_untracked: b.get(3) == Some(&b'U'),
        conflicted: false,
    })
}

/// Join all enumeration sources into the final list, path-sorted.
///
/// - gitlink + `.gitmodules` entry: normal submodule (name from config).
/// - gitlink without entry: orphan (name = path for display).
/// - `.gitmodules` entry without gitlink: declared but never added.
/// - `initialized` = the local config has a `url` for the name.
/// - `pointer_moved` compares SHAs directly (covers staged-only moves the
///   status `c` flag misses); requires a probe (populated).
pub fn assemble_submodules(
    gitlinks: &[(PathBuf, CommitId)],
    gitmodules: &HashMap<String, SubmoduleConfigEntry>,
    local: &HashMap<String, SubmoduleConfigEntry>,
    dirt: &HashMap<PathBuf, SubmoduleDirt>,
    probes: &HashMap<PathBuf, SubmoduleProbe>,
) -> Vec<SubmoduleInfo> {
    let mut out = Vec::new();
    let mut declared_paths: HashMap<&str, &String> = HashMap::new(); // path -> name
    for (name, entry) in gitmodules {
        if let Some(p) = &entry.path {
            declared_paths.insert(p.as_str(), name);
        }
    }

    for (path, recorded) in gitlinks {
        let path_str = path.to_string_lossy();
        let name = declared_paths
            .get(path_str.as_ref())
            .map(|n| (*n).clone())
            .unwrap_or_else(|| path_str.into_owned());
        let gm = gitmodules.get(&name);
        let lc = local.get(&name);
        let probe = probes.get(path);
        let d = dirt.get(path).copied().unwrap_or_default();
        let url = lc.and_then(|e| e.url.clone());
        let gitmodules_url = gm.and_then(|e| e.url.clone());
        out.push(SubmoduleInfo {
            state: SubmoduleState {
                initialized: url.is_some(),
                populated: probe.is_some(),
                pointer_moved: probe.is_some_and(|p| &p.checked_out_sha != recorded),
                dirty_tracked: d.dirty_tracked,
                dirty_untracked: d.dirty_untracked,
                conflicted: d.conflicted,
                orphan_gitlink: gm.is_none(),
                config_drift: matches!((&url, &gitmodules_url), (Some(a), Some(b)) if a != b),
            },
            name,
            path: path.clone(),
            url,
            gitmodules_url,
            branch: gm.and_then(|e| e.branch.clone()),
            recorded_sha: Some(recorded.clone()),
            checked_out_sha: probe.map(|p| p.checked_out_sha.clone()),
            head_branch: probe.and_then(|p| p.head_branch.clone()),
        });
    }

    // Declared in .gitmodules but no gitlink in the index (never `git add`ed).
    let linked: Vec<&PathBuf> = gitlinks.iter().map(|(p, _)| p).collect();
    for (name, entry) in gitmodules {
        let Some(p) = &entry.path else { continue };
        let pb = PathBuf::from(p);
        if linked.contains(&&pb) {
            continue;
        }
        let url = local.get(name).and_then(|e| e.url.clone());
        out.push(SubmoduleInfo {
            state: SubmoduleState {
                initialized: url.is_some(),
                ..Default::default()
            },
            name: name.clone(),
            path: pb,
            url,
            gitmodules_url: entry.url.clone(),
            branch: entry.branch.clone(),
            recorded_sha: None,
            checked_out_sha: None,
            head_branch: None,
        });
    }

    out.sort_by(|a, b| a.path.cmp(&b.path));
    out
}
```

- [x] **Step 4: Run to verify pass**

Run: `cargo test -p legit-core --lib parsers::submodules`
Expected: PASS, 11 tests.

---

### Task 3: `submodules()` orchestration + real-git fixture

**Files:**
- Modify: `crates/legit-core/src/cli_impl/mod.rs:1262-1264` (replace the `NotYet` stub; add `use` of the new parser items via the existing `parsers::` path)
- Modify: `crates/legit-core/src/backend.rs:160` (doc comment on the trait method)
- Modify: `crates/legit-core/src/cli_impl/flow_tests.rs` (new tests at the end)
- Modify: `crates/legit-core/tests/git_flows.rs` (fixture helper + test)

**Interfaces:**
- Consumes: Task 2's constants/parsers, `SubmoduleInfo` from Task 1.
- Produces: a working `GitBackend::submodules()`; the `repo_with_submodule()` real-git fixture reused by Tasks 4-7's integration tests.

- [x] **Step 1: Write the failing flow test**

Append to `flow_tests.rs`:

```rust
// ---------------------------------------------------------------------------
// submodules - enumeration orchestration
// ---------------------------------------------------------------------------

#[tokio::test]
async fn submodules_enumerates_without_git_submodule_status() {
    let sha_a = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let fake = FakeExecutor::default();
    fake.expect(
        &["ls-files", "--stage", "-z"],
        ok(&format!("100644 {sha_a} 0\tREADME.md\0160000 {sha_a} 0\tlib\0")),
    );
    fake.expect(
        &["config", "-f", ".gitmodules", "-z", "--get-regexp", "^submodule\\."],
        ok("submodule.lib.path\nlib\0submodule.lib.url\nhttps://x.invalid/lib.git\0"),
    );
    fake.expect(
        &["config", "-z", "--get-regexp", "^submodule\\."],
        ok("submodule.lib.url\nhttps://x.invalid/lib.git\0submodule.lib.active\ntrue\0"),
    );
    fake.expect(
        &["status", "--porcelain=v2", "-z", "--untracked-files=all"],
        ok("1 .M S.M. 160000 160000 160000 aaaaaaa aaaaaaa lib\0"),
    );
    fake.expect(&["-C", "lib", "rev-parse", "HEAD"], ok(&format!("{sha_a}\n")));
    fake.expect(&["-C", "lib", "rev-parse", "--abbrev-ref", "HEAD"], ok("HEAD\n"));
    let (b, exec) = backend(fake);

    let subs = b.submodules().await.unwrap();
    assert_eq!(subs.len(), 1);
    let s = &subs[0];
    assert_eq!(s.name, "lib");
    assert!(s.state.initialized && s.state.populated && s.state.dirty_tracked);
    assert!(!s.state.pointer_moved);
    assert_eq!(s.head_branch, None, "abbrev-ref HEAD means detached");
    // assert_done proves no `git submodule status` / describe ever ran.
    exec.assert_done();
}

#[tokio::test]
async fn submodules_survives_missing_gitmodules_and_failed_probe() {
    let sha_a = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let fake = FakeExecutor::default();
    fake.expect(
        &["ls-files", "--stage", "-z"],
        ok(&format!("160000 {sha_a} 0\tlib\0")),
    );
    // No .gitmodules: git config exits 1 - must degrade to empty, not error.
    fake.expect(
        &["config", "-f", ".gitmodules", "-z", "--get-regexp", "^submodule\\."],
        fail(1, ""),
    );
    fake.expect(&["config", "-z", "--get-regexp", "^submodule\\."], fail(1, ""));
    fake.expect(
        &["status", "--porcelain=v2", "-z", "--untracked-files=all"],
        ok(""),
    );
    // Unpopulated: the probe fails ("not a git repository").
    fake.expect(
        &["-C", "lib", "rev-parse", "HEAD"],
        fail(128, "fatal: not a git repository"),
    );
    let (b, exec) = backend(fake);

    let subs = b.submodules().await.unwrap();
    assert_eq!(subs.len(), 1);
    assert!(subs[0].state.orphan_gitlink);
    assert!(!subs[0].state.populated);
    exec.assert_done();
}
```

- [x] **Step 2: Run to verify failure**

Run: `cargo test -p legit-core --lib submodules_enumerates 2>&1 | tail -5`
Expected: FAIL - the stub returns `Err(GitError::NotYet)`.

- [x] **Step 3: Implement the orchestration**

Replace the stub in `cli_impl/mod.rs` (lines 1262-1264):

```rust
    async fn submodules(&self) -> Result<Vec<SubmoduleInfo>, GitError> {
        use parsers::submodules as sub;
        let runner = self.runner().await;

        let ls = runner
            .run(&sub::LS_FILES_STAGE_ARGS)
            .await
            .map_err(|e| GitError::Internal(e.to_string()))?;
        if !ls.success {
            return Err(GitError::CommandFailed {
                exit_code: ls.exit_code.unwrap_or(-1),
                stderr: ls.stderr,
            });
        }
        let gitlinks = sub::parse_gitlinks(&ls.stdout);

        // Both config reads exit non-zero for "no matches / no file" - that
        // is a normal repo without submodules, never an error.
        let gitmodules = match runner.run(&sub::GITMODULES_CONFIG_ARGS).await {
            Ok(o) if o.success => sub::parse_submodule_config(&o.stdout),
            _ => Default::default(),
        };
        let local = match runner.run(&sub::LOCAL_SUBMODULE_CONFIG_ARGS).await {
            Ok(o) if o.success => sub::parse_submodule_config(&o.stdout),
            _ => Default::default(),
        };

        // Dirt flags ride along the one superproject status call - never a
        // per-submodule status walk (spec: perf discipline).
        let dirt = match runner.run(&parsers::status::STATUS_ARGS).await {
            Ok(o) if o.success => sub::parse_status_submodule_flags(&o.stdout),
            _ => Default::default(),
        };

        // One probe per gitlink: HEAD sha (failure = unpopulated), then the
        // branch only for populated ones.
        let mut probes = std::collections::HashMap::new();
        for (path, _) in &gitlinks {
            let p = path.to_string_lossy().into_owned();
            let head = match runner.run(&["-C", &p, "rev-parse", "HEAD"]).await {
                Ok(o) if o.success => o.stdout.trim().to_string(),
                _ => continue,
            };
            let head_branch = match runner
                .run(&["-C", &p, "rev-parse", "--abbrev-ref", "HEAD"])
                .await
            {
                Ok(o) if o.success => {
                    let b = o.stdout.trim();
                    // `abbrev-ref HEAD` prints literally `HEAD` when detached.
                    if b == "HEAD" { None } else { Some(b.to_string()) }
                }
                _ => None,
            };
            probes.insert(
                path.clone(),
                sub::SubmoduleProbe { checked_out_sha: CommitId::new(head), head_branch },
            );
        }

        Ok(sub::assemble_submodules(&gitlinks, &gitmodules, &local, &dirt, &probes))
    }
```

(Add `CommitId` to the `use crate::types::{...}` import in `mod.rs` if not already present; check the `CommitId::new` constructor name against `types.rs` and adjust.) In `backend.rs:160`, give the trait method a doc comment:

```rust
    /// Enumerate the repo's submodules with full state (gitlinks + config +
    /// dirt flags + per-submodule HEAD probe). Read-only; one status walk.
    async fn submodules(&self) -> Result<Vec<SubmoduleInfo>, GitError>;
```

- [x] **Step 4: Run flow tests to verify pass**

Run: `cargo test -p legit-core --lib flow_tests::submodules 2>&1 | tail -3`
Expected: PASS (2 tests).

- [x] **Step 5: Add the real-git fixture + integration test**

In `tests/git_flows.rs`, after `conflicting_branches` (~line 100), add the shared fixture; then a test at the end of the status section:

```rust
/// Superproject with one submodule `lib` (its upstream repo returned too).
/// `protocol.file.allow=always` must ride the invoking command: local config
/// does not reach git's internal clone (CVE-2022-39253 hardening).
async fn repo_with_submodule() -> (TestRepo, TestRepo) {
    let lib = TestRepo::init().await;
    lib.write("lib.txt", "v1\n");
    lib.commit_all("lib v1").await;

    let sup = TestRepo::init().await;
    sup.write("README.md", "super\n");
    sup.commit_all("base").await;
    let lib_path = lib.path.to_string_lossy().into_owned();
    sup.git(&["-c", "protocol.file.allow=always", "submodule", "add", &lib_path, "lib"])
        .await;
    sup.git(&["commit", "-m", "add submodule"]).await;
    (sup, lib)
}

#[tokio::test]
async fn submodules_reports_a_real_submodule() {
    let (sup, _lib) = repo_with_submodule().await;

    let subs = sup.backend.submodules().await.unwrap();
    assert_eq!(subs.len(), 1);
    let s = &subs[0];
    assert_eq!(s.name, "lib");
    assert_eq!(s.path, PathBuf::from("lib"));
    assert!(s.state.initialized && s.state.populated);
    assert!(!s.state.pointer_moved && !s.state.orphan_gitlink);
    assert_eq!(s.recorded_sha, s.checked_out_sha);
    assert!(s.gitmodules_url.is_some());

    // Move the submodule's HEAD: pointer_moved must flip.
    let sub_path = sup.path.join("lib").to_string_lossy().into_owned();
    sup.git(&["-C", &sub_path, "commit", "--allow-empty", "-m", "bump"]).await;
    let subs = sup.backend.submodules().await.unwrap();
    assert!(subs[0].state.pointer_moved);

    // Untracked file inside: dirty_untracked must flip.
    sup.write("lib/junk.txt", "x\n");
    let subs = sup.backend.submodules().await.unwrap();
    assert!(subs[0].state.dirty_untracked);
}
```

- [x] **Step 6: Run the real-git test**

Run: `cargo test -p legit-core --test git_flows submodules_reports -- --nocapture 2>&1 | tail -5`
Expected: PASS. (If `submodule add` fails on the runner's hardened env, read the stderr - the fixture may need the absolute path form; the `-c protocol.file.allow=always` placement on the invoking command is the critical part.)

---

### Task 4: Status parser emits `SubmoduleChanged`

**Files:**
- Modify: `crates/legit-core/src/cli_impl/parsers/status.rs` (`parse_status` `1`-record arm, new `push_submodule_columns`, `wants_counts`, tests)
- Modify: `crates/legit-core/tests/git_flows.rs` (one real-git test)

**Interfaces:**
- Consumes: v2 record layout (sub-project 1), `FileState::SubmoduleChanged`.
- Produces: status entries later tasks and the UI rely on: staged pointer move -> `SubmoduleChanged` staged; worktree pointer move (`c` flag) -> `SubmoduleChanged` unstaged; dirty-only submodule -> NO worktree entry (it surfaces as a Refs-row badge instead); submodule add/delete stay `Added`/`Deleted`.

- [x] **Step 1: Replace the submodule test and add the new expectations**

In `status.rs` tests, DELETE `submodule_records_fold_to_modified_for_now` and add:

```rust
    #[test]
    fn submodule_pointer_moves_become_submodule_changed() {
        let out = stream(&[
            // Staged pointer move: the sub field describes the worktree side,
            // so a staged-only move reads `M.` with `S...`.
            &ord_sub("M.", "S...", "vendor/staged-bump"),
            // Worktree pointer move: the `c` flag.
            &ord_sub(".M", "SC..", "vendor/moved"),
            // Staged move + worktree moved again on top.
            &ord_sub("MM", "SC..", "vendor/both"),
        ]);
        assert_eq!(
            parse_status(&out),
            vec![
                fs("vendor/staged-bump", FileState::SubmoduleChanged, true),
                fs("vendor/moved", FileState::SubmoduleChanged, false),
                fs("vendor/both", FileState::SubmoduleChanged, true),
                fs("vendor/both", FileState::SubmoduleChanged, false),
            ]
        );
    }

    #[test]
    fn dirty_only_submodules_produce_no_entry() {
        // Dirty contents are not a committable superproject change: they show
        // as a badge on the Refs-panel submodule row, never as a pseudo file
        // modification (spec 2026-07-08, sub-project 2).
        let out = stream(&[
            &ord_sub(".M", "S.M.", "vendor/dirty"),
            &ord_sub(".M", "S..U", "vendor/untracked"),
            &ord_sub(".M", "S.MU", "vendor/both-dirty"),
        ]);
        assert_eq!(parse_status(&out), vec![]);
    }

    #[test]
    fn submodule_add_and_delete_keep_their_states() {
        let out = stream(&[
            &ord_sub("A.", "S...", "vendor/new"),
            &ord_sub("D.", "S...", "vendor/gone-index"),
            &ord_sub(".D", "S...", "vendor/gone-tree"),
        ]);
        assert_eq!(
            parse_status(&out),
            vec![
                fs("vendor/new", FileState::Added, true),
                fs("vendor/gone-index", FileState::Deleted, true),
                fs("vendor/gone-tree", FileState::Deleted, false),
            ]
        );
    }

    #[test]
    fn submodule_changed_wants_no_counts() {
        assert!(!wants_counts(&fs("vendor/lib", FileState::SubmoduleChanged, true)));
    }
```

- [x] **Step 2: Run to verify failure**

Run: `cargo test -p legit-core --lib parsers::status 2>&1 | tail -8`
Expected: FAIL - the four new tests (submodule records currently fold to `Modified`).

- [x] **Step 3: Implement**

In `parse_status`, change the `b'1'` arm to route submodule records:

```rust
            // `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>`
            b'1' => {
                let mut fields = record.splitn(9, ' ');
                let (Some(xy), Some(sub)) = (fields.nth(1), fields.next()) else {
                    continue;
                };
                let Some(path) = fields.nth(5) else { continue };
                if sub.starts_with('S') {
                    push_submodule_columns(xy, sub, path, &mut result);
                } else {
                    push_columns(xy, path, &mut result);
                }
            }
```

Add below `push_columns`:

```rust
/// Emit entries for a submodule record (`S<c><m><u>` sub field). The staged
/// column stages the gitlink pointer, so staged `M`/`T` becomes
/// `SubmoduleChanged` (add/delete read better as `Added`/`Deleted`). The
/// worktree `M` covers both pointer moves and dirty contents; only a real
/// pointer move (`c` flag) yields an entry - dirty-only submodules surface
/// as a Refs-panel badge, not a pseudo file change.
fn push_submodule_columns(xy: &str, sub: &str, path: &str, out: &mut Vec<FileStatus>) {
    let mut chars = xy.chars();
    let (Some(x), Some(y)) = (chars.next(), chars.next()) else {
        return;
    };
    let pointer_moved = sub.as_bytes().get(1) == Some(&b'C');
    if x != '.' {
        let state = match x {
            'A' => FileState::Added,
            'D' => FileState::Deleted,
            _ => FileState::SubmoduleChanged,
        };
        out.push(FileStatus::new(path, state, true));
    }
    match y {
        '.' => {}
        'D' => out.push(FileStatus::new(path, FileState::Deleted, false)),
        _ if pointer_moved => {
            out.push(FileStatus::new(path, FileState::SubmoduleChanged, false));
        }
        _ => {} // dirty-only
    }
}
```

Extend `wants_counts` (gitlinks have no meaningful line counts):

```rust
pub fn wants_counts(status: &FileStatus) -> bool {
    !matches!(
        status.state,
        FileState::Untracked
            | FileState::Ignored
            | FileState::Conflicted
            | FileState::SubmoduleChanged
    )
}
```

- [x] **Step 4: Run to verify pass**

Run: `cargo test -p legit-core --lib parsers::status`
Expected: PASS (23 tests).

- [x] **Step 5: Real-git status test**

Append to the status section of `tests/git_flows.rs` (uses Task 3's fixture):

```rust
#[tokio::test]
async fn status_classifies_submodule_pointer_moves_and_hides_dirt() {
    let (sup, _lib) = repo_with_submodule().await;
    let sub_path = sup.path.join("lib").to_string_lossy().into_owned();

    // Dirty-only (untracked file inside): no status entry for the submodule.
    sup.write("lib/junk.txt", "x\n");
    let status = sup.backend.status().await.unwrap();
    assert!(
        !status.iter().any(|s| s.path == PathBuf::from("lib")),
        "dirty-only submodule must not appear in status: {status:?}"
    );

    // Worktree pointer move: unstaged SubmoduleChanged.
    sup.git(&["-C", &sub_path, "commit", "--allow-empty", "-m", "bump"]).await;
    let status = sup.backend.status().await.unwrap();
    let entry = status
        .iter()
        .find(|s| s.path == PathBuf::from("lib"))
        .expect("pointer move must appear");
    assert_eq!(entry.state, FileState::SubmoduleChanged);
    assert!(!entry.staged);
    assert_eq!((entry.additions, entry.deletions), (None, None));

    // Staged pointer move: staged SubmoduleChanged.
    sup.git(&["add", "lib"]).await;
    let status = sup.backend.status().await.unwrap();
    let entry = status
        .iter()
        .find(|s| s.path == PathBuf::from("lib"))
        .expect("staged move must appear");
    assert_eq!(entry.state, FileState::SubmoduleChanged);
    assert!(entry.staged);
}
```

- [x] **Step 6: Run it**

Run: `cargo test -p legit-core --test git_flows status_classifies_submodule -- --nocapture 2>&1 | tail -5`
Expected: PASS. This encodes the `S<c><m><u>` semantics against the real binary (spec: testing).

---

### Task 5: Submodule diffs (`DiffEntry::Submodule` + pinned format)

**Files:**
- Modify: `crates/legit-core/src/cli_impl/mod.rs:128-133` (`run_diff_text` arg list)
- Modify: `crates/legit-core/src/cli_impl/parsers/diff.rs` (`parse_file_diff` + new `submodule_change`, tests)
- Modify: `crates/legit-core/src/cli_impl/flow_tests.rs` (any FakeExecutor expectation scripting a `diff` argv gains the two leading args)
- Modify: `crates/legit-core/tests/git_flows.rs` (one real-git test)

**Interfaces:**
- Consumes: `SubmoduleChange` (with `dirty`) from Task 1.
- Produces: `parse_file_diff` returns `DiffEntry::Submodule(SubmoduleChange)` for gitlink diffs; every parsed diff runs under `-c diff.submodule=short`.

- [x] **Step 1: Write the failing parser tests**

Append to `diff.rs` tests (check the existing test module name/helpers first and match them):

```rust
    #[test]
    fn parses_submodule_pointer_diff() {
        let raw = "diff --git a/vendor/lib b/vendor/lib\n\
                   index aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa..bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb 160000\n\
                   --- a/vendor/lib\n\
                   +++ b/vendor/lib\n\
                   @@ -1 +1 @@\n\
                   -Subproject commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n\
                   +Subproject commit bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n";
        let entry = parse_file_diff(raw);
        let DiffEntry::Submodule(sub) = entry else { panic!("expected Submodule: {entry:?}") };
        assert_eq!(sub.path, PathBuf::from("vendor/lib"));
        assert_eq!(sub.old_sha.as_ref().map(|s| s.as_str()), Some("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
        assert_eq!(sub.new_sha.as_ref().map(|s| s.as_str()), Some("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"));
        assert!(!sub.dirty);
    }

    #[test]
    fn parses_dirty_submodule_diff_without_index_line() {
        // Dirty-only gitlink diffs carry a `-dirty` suffix and NO index line.
        let raw = "diff --git a/vendor/lib b/vendor/lib\n\
                   --- a/vendor/lib\n\
                   +++ b/vendor/lib\n\
                   @@ -1 +1 @@\n\
                   -Subproject commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n\
                   +Subproject commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-dirty\n";
        let DiffEntry::Submodule(sub) = parse_file_diff(raw) else { panic!() };
        assert!(sub.dirty);
        assert_eq!(sub.old_sha, sub.new_sha);
    }

    #[test]
    fn parses_new_submodule_diff() {
        let raw = "diff --git a/vendor/lib b/vendor/lib\n\
                   new file mode 160000\n\
                   index 0000000000000000000000000000000000000000..bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n\
                   --- /dev/null\n\
                   +++ b/vendor/lib\n\
                   @@ -0,0 +1 @@\n\
                   +Subproject commit bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n";
        let DiffEntry::Submodule(sub) = parse_file_diff(raw) else { panic!() };
        assert_eq!(sub.old_sha, None);
        assert!(sub.new_sha.is_some());
    }

    #[test]
    fn text_mentioning_subproject_lines_is_not_a_submodule_diff() {
        // A text diff where only SOME changed lines look like Subproject
        // lines must stay a text diff.
        let raw = "diff --git a/notes.md b/notes.md\n\
                   index aaaaaaa..bbbbbbb 100644\n\
                   --- a/notes.md\n\
                   +++ b/notes.md\n\
                   @@ -1,2 +1,2 @@\n\
                   -Subproject commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n\
                   +some other line\n";
        assert!(matches!(parse_file_diff(raw), DiffEntry::Text(_)));
    }
```

- [x] **Step 2: Run to verify failure**

Run: `cargo test -p legit-core --lib parsers::diff 2>&1 | tail -8`
Expected: FAIL - the new tests get `DiffEntry::Text`.

- [x] **Step 3: Implement detection**

In `diff.rs`: import `SubmoduleChange` and `CommitId` (`use crate::types::{..., SubmoduleChange}; use crate::types::CommitId;` - merge into the existing `use`). At the END of `parse_file_diff`, before `DiffEntry::Text(...)`:

```rust
    if let Some(sub) = submodule_change(stdout) {
        return DiffEntry::Submodule(sub);
    }

    DiffEntry::Text(TextDiff { old_path, new_path, hunks })
```

Add:

```rust
/// Detect a gitlink diff: EVERY changed (`+`/`-`) line is a
/// `Subproject commit <sha>[-dirty]` line (with `diff.submodule=short`
/// pinned, that is the only shape gitlink diffs take; a dirty-only diff has
/// no `index ... 160000` line, so the mode header cannot be required).
fn submodule_change(stdout: &str) -> Option<SubmoduleChange> {
    let mut old_sha = None;
    let mut new_sha = None;
    let mut dirty = false;
    let mut changed = 0usize;
    let mut subproject = 0usize;
    for line in stdout.lines() {
        if line.starts_with("---") || line.starts_with("+++") {
            continue;
        }
        match line.as_bytes().first() {
            Some(b'-') => {
                changed += 1;
                if let Some(sha) = line.strip_prefix("-Subproject commit ") {
                    subproject += 1;
                    old_sha = Some(CommitId::new(sha.trim_end_matches("-dirty").trim()));
                }
            }
            Some(b'+') => {
                changed += 1;
                if let Some(sha) = line.strip_prefix("+Subproject commit ") {
                    subproject += 1;
                    dirty = sha.trim_end().ends_with("-dirty");
                    new_sha = Some(CommitId::new(sha.trim_end_matches("-dirty").trim()));
                }
            }
            _ => {}
        }
    }
    if changed == 0 || changed != subproject {
        return None;
    }
    let (old_p, new_p) = git_header_paths(stdout);
    Some(SubmoduleChange {
        path: new_p.or(old_p)?,
        old_sha,
        new_sha,
        dirty,
    })
}
```

(`CommitId::new(sha)` - confirm the constructor; `sha` here is `&str`.) Note `trim_end_matches("-dirty").trim()`: order matters, strip the suffix then whitespace.

Wait - `strip_prefix` already leaves no leading content, and lines from `.lines()` have no trailing `\n`. Keep exactly the code above.

- [x] **Step 4: Pin the diff format in `run_diff_text`**

In `cli_impl/mod.rs:128-133`, change the arg vector:

```rust
        // Common flags: no color/ANSI, no external diff drivers — we need git's
        // own deterministic unified output for the parser. `diff.submodule` is
        // pinned to `short`: a user's `log`/`diff` config changes gitlink diff
        // output and breaks parsing (the magit#4538 class of bug).
        let mut args: Vec<String> = vec![
            "-c".into(),
            "diff.submodule=short".into(),
            "diff".into(),
            "--no-color".into(),
            "--no-ext-diff".into(),
            unified,
        ];
```

- [x] **Step 5: Run parser tests, then the whole lib suite; update diff argv fixtures**

Run: `cargo test -p legit-core --lib 2>&1 | tail -10`
Expected: parser tests PASS; any `flow_tests` expectation that scripts a `git diff` argv now fails on the two new leading args. For each failing expectation, prepend the two args, e.g.:

```rust
// before:
fake.expect(&["diff", "--no-color", "--no-ext-diff", "-U3", "--", "a.txt"], ok(...));
// after:
fake.expect(&["-c", "diff.submodule=short", "diff", "--no-color", "--no-ext-diff", "-U3", "--", "a.txt"], ok(...));
```

(Only argv arrays starting with `"diff", "--no-color", "--no-ext-diff"` are affected - the numstat `["diff", "--numstat", ...]` calls go through `status()`, not `run_diff_text`, and stay unchanged.) Re-run until green.

- [x] **Step 6: Real-git diff test**

Append to `tests/git_flows.rs` (uses Task 3's fixture; check that `DiffEntry` and `DiffSource` are in the `use legit_core::{...}` list - add if missing):

```rust
#[tokio::test]
async fn file_diff_returns_a_submodule_entry_for_a_pointer_move() {
    let (sup, _lib) = repo_with_submodule().await;
    let sub_path = sup.path.join("lib").to_string_lossy().into_owned();
    let old = sup.git(&["-C", &sub_path, "rev-parse", "HEAD"]).await.trim().to_string();
    sup.git(&["-C", &sub_path, "commit", "--allow-empty", "-m", "bump"]).await;
    let new = sup.git(&["-C", &sub_path, "rev-parse", "HEAD"]).await.trim().to_string();

    let entry = sup
        .backend
        .file_diff(DiffSource::WorkingUnstaged, Path::new("lib"), None, 3)
        .await
        .unwrap();
    let DiffEntry::Submodule(sub) = entry else { panic!("expected Submodule: {entry:?}") };
    assert_eq!(sub.old_sha.as_ref().map(|s| s.as_str().to_string()), Some(old));
    assert_eq!(sub.new_sha.as_ref().map(|s| s.as_str().to_string()), Some(new));
    assert!(!sub.dirty);
}
```

(Match `file_diff`'s exact signature from `backend.rs` - check parameter order/types and adjust the call; add `use std::path::Path;` if missing.)

- [x] **Step 7: Run it**

Run: `cargo test -p legit-core --test git_flows file_diff_returns_a_submodule -- --nocapture 2>&1 | tail -5`
Expected: PASS.

---

### Task 6: Commit details classify gitlinks (`--raw` migration)

**Files:**
- Modify: `crates/legit-core/src/cli_impl/parsers/commit_files.rs` (parser + tests)
- Modify: `crates/legit-core/src/cli_impl/mod.rs:788,798` (`--name-status` -> `--raw`)
- Modify: `crates/legit-core/tests/git_flows.rs` (one real-git test)

**Interfaces:**
- Consumes: `FileState::SubmoduleChanged`.
- Produces: `parse_commit_files(raw: &str, numstat: &str)` where the first stream is now `diff-tree --raw -z` output (`:<oldmode> <newmode> <oldsha> <newsha> <status>\0<path>\0`, rename `...R100\0<old>\0<new>\0`). A gitlink (`160000` mode) `M`/`T` becomes `SubmoduleChanged`.

- [x] **Step 1: Rewrite the tests for raw fixtures**

In `commit_files.rs` tests, add a raw-record helper and port every fixture (keep all assertions; only the first stream's shape changes). Replace the test module contents above the numstat-only tests:

```rust
    /// Build a raw diff-tree metadata token (`-z`: path(s) follow as separate
    /// NUL fields, passed by the caller through `z(...)`).
    fn raw(old_mode: &str, new_mode: &str, status: &str) -> String {
        format!(":{old_mode} {new_mode} aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb {status}")
    }

    #[test]
    fn parses_modify_add_delete() {
        let ns = z(&[
            &raw("000000", "100644", "A"), "added.txt",
            &raw("100644", "000000", "D"), "del.txt",
            &raw("100644", "100644", "M"), "keep.txt",
        ]);
        let nm = z(&["1\t0\tadded.txt", "0\t1\tdel.txt", "3\t2\tkeep.txt"]);
        let files = parse_commit_files(&ns, &nm);
        assert_eq!(files.len(), 3);
        assert_eq!(files[0].path, PathBuf::from("added.txt"));
        assert_eq!(files[0].change, FileState::Added);
        assert_eq!((files[0].additions, files[0].deletions), (1, 0));
        assert_eq!(files[1].change, FileState::Deleted);
        assert_eq!(files[2].change, FileState::Modified);
        assert!(!files[2].binary);
    }

    #[test]
    fn parses_rename_with_old_and_new_paths() {
        let ns = z(&[&raw("100644", "100644", "R100"), "orig.txt", "moved.txt"]);
        let nm = z(&["0\t0\t", "orig.txt", "moved.txt"]);
        let files = parse_commit_files(&ns, &nm);
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].change, FileState::Renamed);
        assert_eq!(files[0].path, PathBuf::from("moved.txt"));
        assert_eq!(files[0].old_path, Some(PathBuf::from("orig.txt")));
    }

    #[test]
    fn parses_rename_with_content_change_counts() {
        let ns = z(&[&raw("100644", "100644", "R86"), "a/old.rs", "b/new.rs"]);
        let nm = z(&["4\t2\t", "a/old.rs", "b/new.rs"]);
        let files = parse_commit_files(&ns, &nm);
        assert_eq!(files[0].change, FileState::Renamed);
        assert_eq!((files[0].additions, files[0].deletions), (4, 2));
    }

    #[test]
    fn marks_binary_files() {
        let ns = z(&[&raw("100644", "100644", "M"), "pic.bin"]);
        let nm = z(&["-\t-\tpic.bin"]);
        let files = parse_commit_files(&ns, &nm);
        assert!(files[0].binary);
    }

    #[test]
    fn handles_path_with_spaces() {
        let ns = z(&[&raw("100644", "100644", "M"), "dir with spaces/a b.txt"]);
        let nm = z(&["2\t1\tdir with spaces/a b.txt"]);
        let files = parse_commit_files(&ns, &nm);
        assert_eq!(files[0].path, PathBuf::from("dir with spaces/a b.txt"));
    }

    #[test]
    fn defaults_counts_when_numstat_missing() {
        let files = parse_commit_files(&z(&[&raw("100644", "100644", "M"), "keep.txt"]), "");
        assert_eq!((files[0].additions, files[0].deletions), (0, 0));
    }

    #[test]
    fn empty_input_yields_no_files() {
        assert_eq!(parse_commit_files("", ""), vec![]);
        assert_eq!(parse_commit_files("\0", "\0"), vec![]);
    }

    #[test]
    fn root_commit_all_added() {
        let ns = z(&[
            &raw("000000", "100644", "A"), "keep.txt",
            &raw("000000", "100644", "A"), "src/main.rs",
        ]);
        let nm = z(&["3\t0\tkeep.txt", "10\t0\tsrc/main.rs"]);
        let files = parse_commit_files(&ns, &nm);
        assert!(files.iter().all(|f| f.change == FileState::Added));
    }

    #[test]
    fn gitlink_modification_becomes_submodule_changed() {
        let ns = z(&[&raw("160000", "160000", "M"), "vendor/lib"]);
        let nm = z(&["0\t0\tvendor/lib"]);
        let files = parse_commit_files(&ns, &nm);
        assert_eq!(files[0].change, FileState::SubmoduleChanged);
    }

    #[test]
    fn gitlink_add_and_delete_stay_added_deleted() {
        let ns = z(&[
            &raw("000000", "160000", "A"), "vendor/new",
            &raw("160000", "000000", "D"), "vendor/gone",
        ]);
        let files = parse_commit_files(&ns, "");
        assert_eq!(files[0].change, FileState::Added);
        assert_eq!(files[1].change, FileState::Deleted);
    }
```

- [x] **Step 2: Run to verify failure**

Run: `cargo test -p legit-core --lib parsers::commit_files 2>&1 | tail -8`
Expected: FAIL - the parser still expects `--name-status` records.

- [x] **Step 3: Migrate the parser**

Update the module doc (first stream is now `--raw -z`: `:<modes/shas> <status>\0<path>\0`) and rewrite `parse_commit_files`'s tokenizer loop:

```rust
pub fn parse_commit_files(raw: &str, numstat: &str) -> Vec<CommitFileChange> {
    let counts = parse_numstat(numstat);

    let mut result = Vec::new();
    let mut tokens = raw.split('\0');

    while let Some(meta) = tokens.next() {
        // `:<oldmode> <newmode> <oldsha> <newsha> <status>` - path(s) follow
        // as separate NUL fields. Skip anything not shaped like a raw record.
        let Some(meta) = meta.strip_prefix(':') else { continue };
        let mut fields = meta.split(' ');
        let old_mode = fields.next().unwrap_or("");
        let new_mode = fields.next().unwrap_or("");
        let status = fields.nth(2).unwrap_or(""); // skip the two shas
        let Some(&kind_byte) = status.as_bytes().first() else { continue };
        let kind = kind_byte as char;

        let (path, old_path) = if kind == 'R' || kind == 'C' {
            let old = match tokens.next() {
                Some(o) => o,
                None => break,
            };
            let new = match tokens.next() {
                Some(n) => n,
                None => break,
            };
            (new.to_string(), Some(PathBuf::from(old)))
        } else {
            let p = match tokens.next() {
                Some(p) => p,
                None => break,
            };
            (p.to_string(), None)
        };

        // A modified gitlink is a submodule pointer bump; adds/deletes of a
        // gitlink read better as plain Added/Deleted (matches status).
        let gitlink = old_mode == "160000" || new_mode == "160000";
        let change = if gitlink && matches!(kind, 'M' | 'T') {
            FileState::SubmoduleChanged
        } else {
            map_kind(kind)
        };

        let stat = counts.get(&path);
        result.push(CommitFileChange {
            change,
            old_path,
            additions: stat.map(|s| s.additions).unwrap_or(0),
            deletions: stat.map(|s| s.deletions).unwrap_or(0),
            binary: stat.map(|s| s.binary).unwrap_or(false),
            path: PathBuf::from(path),
        });
    }

    result
}
```

In `cli_impl/mod.rs`, change both `run_diff(..., "--name-status")` call sites (lines 788 and 798) to `run_diff(..., "--raw")`.

- [x] **Step 4: Run the parser tests and the full lib suite**

Run: `cargo test -p legit-core --lib 2>&1 | tail -5`
Expected: PASS (fix any flow test scripting `diff-tree ... --name-status` argv to `--raw` with raw-shaped stdout, same technique as Task 5 Step 5).

- [x] **Step 5: Real-git commit-files test**

Append to `tests/git_flows.rs`:

```rust
#[tokio::test]
async fn commit_files_classifies_a_submodule_bump() {
    let (sup, _lib) = repo_with_submodule().await;
    let sub_path = sup.path.join("lib").to_string_lossy().into_owned();
    sup.git(&["-C", &sub_path, "commit", "--allow-empty", "-m", "bump"]).await;
    sup.git(&["add", "lib"]).await;
    sup.git(&["commit", "-m", "bump submodule"]).await;

    let head = sup.head().await;
    let files = sup.backend.commit_files(&CommitId::new(head)).await.unwrap();
    let lib = files.iter().find(|f| f.path == PathBuf::from("lib")).expect("lib entry");
    assert_eq!(lib.change, FileState::SubmoduleChanged);
}
```

(Match `commit_files`'s exact signature in `backend.rs` - it may take `&CommitId` or a plain id; check the `CommitId` import in the test file's `use legit_core::{...}` list.)

- [x] **Step 6: Run it, then the full real-git suite**

Run: `cargo test -p legit-core --test git_flows 2>&1 | tail -3`
Expected: PASS - all integration tests, proving the `--raw` output shape assumption against the real binary.

---

### Task 7: `submodule_log` backend method

**Files:**
- Modify: `crates/legit-core/src/backend.rs` (trait method after `submodules()`)
- Modify: `crates/legit-core/src/cli_impl/mod.rs` (implementation)
- Modify: `crates/legit-core/src/cli_impl/parsers/submodules.rs` (format const + parser + tests)
- Modify: `crates/legit-core/tests/git_flows.rs` (one real-git test)

**Interfaces:**
- Consumes: `SubmoduleLog`, `SubmoduleLogEntry` from Task 1.
- Produces: `async fn submodule_log(&self, path: &Path, from: Option<&CommitId>, to: &CommitId) -> Result<SubmoduleLog, GitError>` - used by Task 8's IPC command.

- [x] **Step 1: Failing parser test**

Append to `parsers/submodules.rs` tests:

```rust
    #[test]
    fn parses_submodule_log_pairs() {
        let out = format!("{SHA_A}\0subject one\0{SHA_B}\0subject: with colons\0");
        let entries = parse_submodule_log(&out);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].id, CommitId::new(SHA_A));
        assert_eq!(entries[0].subject, "subject one");
        assert_eq!(entries[1].subject, "subject: with colons");
        assert_eq!(parse_submodule_log(""), vec![]);
    }
```

- [x] **Step 2: Run to verify failure, then implement the parser**

Run: `cargo test -p legit-core --lib parses_submodule_log 2>&1 | tail -3` -> COMPILE ERROR.

Add to `parsers/submodules.rs`:

```rust
use crate::types::SubmoduleLogEntry;

/// `git log` format for submodule pointer ranges: `<sha>\0<subject>\0` pairs.
pub const SUBMODULE_LOG_FORMAT: &str = "--format=%H%x00%s%x00";

/// Cap the range walk: the diff view shows "what's between the pointers",
/// not a full history browser.
pub const SUBMODULE_LOG_MAX: &str = "--max-count=100";

/// Parse the `<sha>\0<subject>\0` stream into entries.
pub fn parse_submodule_log(stdout: &str) -> Vec<SubmoduleLogEntry> {
    let mut out = Vec::new();
    let mut tokens = stdout.split('\0');
    while let Some(sha) = tokens.next() {
        let sha = sha.trim();
        if sha.is_empty() {
            continue;
        }
        let Some(subject) = tokens.next() else { break };
        out.push(SubmoduleLogEntry {
            id: CommitId::new(sha),
            subject: subject.to_string(),
        });
    }
    out
}
```

Run: `cargo test -p legit-core --lib parses_submodule_log` -> PASS.

- [x] **Step 3: Failing flow test for the method**

Append to `flow_tests.rs`:

```rust
#[tokio::test]
async fn submodule_log_lists_range_and_flags_missing_target() {
    let sha_a = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let sha_b = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    let fake = FakeExecutor::default();
    // Target present: existence probe, then the range log.
    fake.expect(&["-C", "lib", "cat-file", "-e", &format!("{sha_b}^{{commit}}")], ok(""));
    fake.expect(
        &["-C", "lib", "log", "--format=%H%x00%s%x00", "--max-count=100", &format!("{sha_a}..{sha_b}")],
        ok(&format!("{sha_b}\0bump\0")),
    );
    // Target missing: the probe fails, no log runs.
    fake.expect(
        &["-C", "lib", "cat-file", "-e", &format!("{sha_b}^{{commit}}")],
        fail(128, "fatal: Not a valid object name"),
    );
    let (b, exec) = backend(fake);

    let log = b
        .submodule_log(Path::new("lib"), Some(&CommitId::new(sha_a)), &CommitId::new(sha_b))
        .await
        .unwrap();
    let SubmoduleLog::Commits { commits } = log else { panic!("{log:?}") };
    assert_eq!(commits.len(), 1);
    assert_eq!(commits[0].subject, "bump");

    let log = b
        .submodule_log(Path::new("lib"), Some(&CommitId::new(sha_a)), &CommitId::new(sha_b))
        .await
        .unwrap();
    assert!(matches!(log, SubmoduleLog::TargetMissing));
    exec.assert_done();
}
```

(Add `SubmoduleLog` and `Path` to the flow-test `use` list as needed.)

- [x] **Step 4: Run to verify failure, then implement**

Run: `cargo test -p legit-core --lib submodule_log_lists 2>&1 | tail -3` -> COMPILE ERROR (no trait method).

In `backend.rs`, after `submodules()`:

```rust
    /// Commits between two submodule pointers (`git -C <path> log from..to`),
    /// or `TargetMissing` when `to` is not in the submodule's object store
    /// (unfetched pointer target). `from = None` lists from the root (new
    /// submodule).
    async fn submodule_log(
        &self,
        path: &Path,
        from: Option<&CommitId>,
        to: &CommitId,
    ) -> Result<SubmoduleLog, GitError>;
```

(Add `SubmoduleLog` to `backend.rs` imports; it already imports from `crate::types`. `Path` likewise.) In `cli_impl/mod.rs`, after `submodules()`:

```rust
    async fn submodule_log(
        &self,
        path: &Path,
        from: Option<&CommitId>,
        to: &CommitId,
    ) -> Result<SubmoduleLog, GitError> {
        use parsers::submodules as sub;
        let runner = self.runner().await;
        let p = path.to_string_lossy().into_owned();

        // Unfetched pointer target is an expected state, not an error.
        let probe = format!("{}^{{commit}}", to.as_str());
        match runner.run(&["-C", &p, "cat-file", "-e", &probe]).await {
            Ok(o) if o.success => {}
            Ok(_) => return Ok(SubmoduleLog::TargetMissing),
            Err(e) => return Err(GitError::Internal(e.to_string())),
        }

        let range = match from {
            Some(f) => format!("{}..{}", f.as_str(), to.as_str()),
            None => to.as_str().to_string(),
        };
        let out = runner
            .run(&["-C", &p, "log", sub::SUBMODULE_LOG_FORMAT, sub::SUBMODULE_LOG_MAX, &range])
            .await
            .map_err(|e| GitError::Internal(e.to_string()))?;
        if !out.success {
            return Err(GitError::CommandFailed {
                exit_code: out.exit_code.unwrap_or(-1),
                stderr: out.stderr,
            });
        }
        Ok(SubmoduleLog::Commits { commits: sub::parse_submodule_log(&out.stdout) })
    }
```

- [x] **Step 5: Run the flow test, then a real-git test**

Run: `cargo test -p legit-core --lib submodule_log_lists` -> PASS.

Append to `tests/git_flows.rs`:

```rust
#[tokio::test]
async fn submodule_log_reports_the_commits_between_pointers() {
    let (sup, _lib) = repo_with_submodule().await;
    let sub_path = sup.path.join("lib").to_string_lossy().into_owned();
    let old = sup.git(&["-C", &sub_path, "rev-parse", "HEAD"]).await.trim().to_string();
    sup.git(&["-C", &sub_path, "commit", "--allow-empty", "-m", "bump one"]).await;
    sup.git(&["-C", &sub_path, "commit", "--allow-empty", "-m", "bump two"]).await;
    let new = sup.git(&["-C", &sub_path, "rev-parse", "HEAD"]).await.trim().to_string();

    let log = sup
        .backend
        .submodule_log(Path::new("lib"), Some(&CommitId::new(old)), &CommitId::new(new))
        .await
        .unwrap();
    let SubmoduleLog::Commits { commits } = log else { panic!("{log:?}") };
    assert_eq!(commits.len(), 2);
    assert_eq!(commits[0].subject, "bump two"); // newest first

    // A fabricated SHA is an unfetched target, not an error.
    let log = sup
        .backend
        .submodule_log(
            Path::new("lib"),
            None,
            &CommitId::new("0123456789012345678901234567890123456789"),
        )
        .await
        .unwrap();
    assert!(matches!(log, SubmoduleLog::TargetMissing));
}
```

Run: `cargo test -p legit-core --test git_flows submodule_log_reports -- --nocapture 2>&1 | tail -3` -> PASS.

---

### Task 8: IPC commands + frontend wrappers

**Files:**
- Create: `src-tauri/src/commands/submodules.rs`
- Modify: `src-tauri/src/commands/mod.rs` (module + re-export, matching neighbors)
- Modify: `src-tauri/src/lib.rs` (`collect_commands![...]`: add both commands)
- Modify: `src/lib/commands.ts` (two wrappers, near `repoTags` at line ~597)

**Interfaces:**
- Consumes: `submodules()` / `submodule_log()` from Tasks 3/7; TS types from Task 1.
- Produces: `repoSubmodules(repoId): Promise<SubmoduleInfo[]>` and `repoSubmoduleLog(repoId, path, from, to): Promise<SubmoduleLog>` for Tasks 9-10.

- [x] **Step 1: Write the Tauri commands**

Create `src-tauri/src/commands/submodules.rs`:

```rust
//! Submodule read commands: enumeration for the Refs-panel section and
//! pointer-range logs for the diff view. Read-only (tier 1); mutations come
//! with the tier-2/3 sub-projects.

use crate::error::AppError;
use crate::state::AppState;
use legit_core::types::{CommitId, SubmoduleInfo, SubmoduleLog};
use std::path::PathBuf;

/// List the repo's submodules with their full state.
#[tauri::command]
#[specta::specta]
pub async fn repo_submodules(
    state: tauri::State<'_, AppState>,
    repo_id: String,
) -> Result<Vec<SubmoduleInfo>, AppError> {
    let session = state.get_session(&repo_id).await?;
    session.backend.submodules().await.map_err(AppError::Git)
}

/// Commits between two submodule pointers (diff-view enrichment).
#[tauri::command]
#[specta::specta]
pub async fn repo_submodule_log(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    path: String,
    from: Option<String>,
    to: String,
) -> Result<SubmoduleLog, AppError> {
    let session = state.get_session(&repo_id).await?;
    let from = from.map(CommitId::new);
    session
        .backend
        .submodule_log(&PathBuf::from(path), from.as_ref(), &CommitId::new(to))
        .await
        .map_err(AppError::Git)
}
```

(Adjust `CommitId::new` to the actual constructor. Register the module in `commands/mod.rs` exactly like `tags`/`working` are; add `commands::repo_submodules,` and `commands::repo_submodule_log,` to `collect_commands![...]` in `src-tauri/src/lib.rs`.)

- [x] **Step 2: Compile the tauri crate**

Run: `cargo check -p legit 2>&1 | tail -5` (use the actual src-tauri crate name from `src-tauri/Cargo.toml` if different)
Expected: clean.

- [x] **Step 3: Frontend wrappers**

In `src/lib/commands.ts` (near `repoTags`, importing the types at the top with the existing type imports):

```ts
export const repoSubmodules = (repoId: string) =>
  invoke<SubmoduleInfo[]>("repo_submodules", { repoId });

export const repoSubmoduleLog = (
  repoId: string,
  path: string,
  from: string | null,
  to: string,
) => invoke<SubmoduleLog>("repo_submodule_log", { repoId, path, from, to });
```

- [x] **Step 4: Verify**

Run: `npx tsc --noEmit 2>&1 | head -5`
Expected: clean.

---

### Task 9: Refs-panel Submodules section

**Files:**
- Create: `src/lib/submodules.ts` (badge derivation, pure) + `src/lib/submodules.test.ts`
- Create: `src/panels/Submodules/SubmodulesSection.tsx`
- Modify: `src/panels/Refs/RefsPanel.tsx:33-47` (DEFAULT_PANES + PANE_COMPONENTS)
- Modify: `src/lib/repoInvalidation.ts` + `src/lib/useRepoChangeListener.ts` (derived `submodules` domain)
- Modify: `src/lib/repoInvalidation.test.ts` (derivation tests)

**Interfaces:**
- Consumes: `repoSubmodules` (Task 8), `SubmoduleInfo`/`SubmoduleState` (Task 1).
- Produces: query key `[repoId, "submodules"]`; `submoduleBadge(info): { label: string; color: string } | null`; `withDerivedDomains(domains: string[]): string[]`.

- [x] **Step 1: Badge derivation (pure) + test**

Create `src/lib/submodules.ts`:

```ts
import type { SubmoduleInfo } from "./types";

/** Display badge for a submodule row, by severity precedence (spec
 * 2026-07-08: conflict > drift > pointer-moved > dirty > detached >
 * uninitialized > clean). Colors are existing theme tokens only. */
export function submoduleBadge(
  info: SubmoduleInfo,
): { label: string; color: string } | null {
  const s = info.state;
  if (s.conflicted) return { label: "conflict", color: "var(--status-conflicted)" };
  if (s.config_drift) return { label: "config drift", color: "var(--status-conflicted)" };
  if (s.orphan_gitlink) return { label: "orphan", color: "var(--status-conflicted)" };
  if (s.pointer_moved) return { label: "pointer moved", color: "var(--status-modified)" };
  if (s.dirty_tracked || s.dirty_untracked)
    return { label: "dirty", color: "var(--status-modified)" };
  if (!s.initialized || !s.populated)
    return { label: "uninitialized", color: "var(--subtle-fg)" };
  if (info.head_branch === null) return { label: "detached", color: "var(--subtle-fg)" };
  return null;
}
```

Create `src/lib/submodules.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { submoduleBadge } from "./submodules";
import type { SubmoduleInfo, SubmoduleState } from "./types";

const state = (over: Partial<SubmoduleState> = {}): SubmoduleState => ({
  initialized: true,
  populated: true,
  pointer_moved: false,
  dirty_tracked: false,
  dirty_untracked: false,
  conflicted: false,
  orphan_gitlink: false,
  config_drift: false,
  ...over,
});

const info = (over: Partial<SubmoduleInfo> = {}): SubmoduleInfo => ({
  name: "lib",
  path: "vendor/lib",
  url: "u",
  gitmodules_url: "u",
  branch: null,
  recorded_sha: "a".repeat(40),
  checked_out_sha: "a".repeat(40),
  head_branch: "main",
  state: state(),
  ...over,
});

describe("submoduleBadge", () => {
  it("returns null for a clean submodule on a branch", () => {
    expect(submoduleBadge(info())).toBeNull();
  });
  it("prefers conflict over everything", () => {
    const i = info({ state: state({ conflicted: true, pointer_moved: true }) });
    expect(submoduleBadge(i)?.label).toBe("conflict");
  });
  it("pointer move beats dirty", () => {
    const i = info({ state: state({ pointer_moved: true, dirty_tracked: true }) });
    expect(submoduleBadge(i)?.label).toBe("pointer moved");
  });
  it("flags detached HEAD", () => {
    expect(submoduleBadge(info({ head_branch: null }))?.label).toBe("detached");
  });
  it("flags uninitialized before detached", () => {
    const i = info({ head_branch: null, state: state({ initialized: false, populated: false }) });
    expect(submoduleBadge(i)?.label).toBe("uninitialized");
  });
});
```

- [x] **Step 2: The section component**

Create `src/panels/Submodules/SubmodulesSection.tsx` (read-only; follows `TagsSection`'s query/loading patterns):

```tsx
import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { useActiveRepo } from "../../store/repos";
import { usePanelFocusEffect } from "../PanelApiContext";
import { repoSubmodules } from "../../lib/commands";
import { submoduleBadge } from "../../lib/submodules";
import type { SubmoduleInfo } from "../../lib/types";
import { PanelLoadingBar } from "../shared/PanelLoadingBar";

/**
 * Submodules section - read-only tier-1 view (spec 2026-07-08): one row per
 * submodule with path, branch or "(detached)", and a state badge. Rendered
 * as a pane inside the combined Refs panel, which supplies the header.
 * Operations (init/update/open-as-tab) arrive with tier 2.
 */
export function SubmodulesSection() {
  const repo = useActiveRepo();
  const { data: subs = [], isFetching, refetch } = useQuery<SubmoduleInfo[]>({
    queryKey: [repo?.id, "submodules"],
    queryFn: () => repoSubmodules(repo!.id),
    enabled: !!repo,
    staleTime: 5_000,
  });
  const reload = useCallback(() => { refetch(); }, [refetch]);
  usePanelFocusEffect(reload);

  if (!repo) {
    return (
      <div className="legit-panel">
        <div className="legit-panel__body">
          <span className="legit-subtle">No repository open.</span>
        </div>
      </div>
    );
  }

  return (
    <div className="legit-panel" style={{ display: "flex", flexDirection: "column" }}>
      <PanelLoadingBar active={isFetching} />
      <div
        className="legit-panel__body"
        style={{ display: "flex", flexDirection: "column", gap: 6 }}
      >
        {subs.length === 0 ? (
          <span className="legit-subtle" style={{ fontSize: "var(--fz-md)" }}>
            No submodules.
          </span>
        ) : (
          subs.map((s) => <SubmoduleRow key={s.name} info={s} />)
        )}
      </div>
    </div>
  );
}

function SubmoduleRow({ info }: { info: SubmoduleInfo }) {
  const badge = submoduleBadge(info);
  const sha = info.checked_out_sha ?? info.recorded_sha;
  return (
    <div
      style={{
        border: "1px solid var(--panel-border)",
        borderRadius: 4,
        padding: "6px 10px",
        display: "flex",
        alignItems: "center",
        gap: 8,
      }}
      title={info.url ?? info.gitmodules_url ?? undefined}
    >
      <span
        style={{
          fontSize: "var(--fz-md)",
          fontFamily: "monospace",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
        title={info.path}
      >
        {info.path}
      </span>
      <span className="legit-subtle" style={{ fontSize: "var(--fz-sm)", flexShrink: 0 }}>
        {info.state.populated ? info.head_branch ?? "(detached)" : ""}
      </span>
      {badge && (
        <span
          style={{
            fontSize: "var(--fz-sm)",
            color: badge.color,
            border: "1px solid currentColor",
            borderRadius: "0.75em",
            padding: "0 0.5em",
            flexShrink: 0,
          }}
        >
          {badge.label}
        </span>
      )}
      {sha && (
        <span
          className="legit-subtle"
          style={{
            fontSize: "var(--fz-sm)",
            fontFamily: "monospace",
            marginLeft: "auto",
            flexShrink: 0,
          }}
          title={sha}
        >
          {sha.slice(0, 8)}
        </span>
      )}
    </div>
  );
}
```

- [x] **Step 3: Register the pane**

In `RefsPanel.tsx`: import `{ SubmodulesSection } from "../Submodules/SubmodulesSection";`, add to `DEFAULT_PANES` after `stashes`:

```ts
  { id: "submodules", title: "Submodules", isExpanded: false },
```

and to `PANE_COMPONENTS`:

```ts
  submodules: () => <SubmodulesSection />,
```

(The existing "append missing default panes" restore logic makes the section appear in previously saved layouts. Note: the spec sketched hiding the pane for repos without gitlinks; paneview panes persist in the layout, so tier 1 ships the pane collapsed-by-default with a "No submodules." empty state instead - flagged as a deliberate deviation.)

- [x] **Step 4: Derived query domain**

In `src/lib/repoInvalidation.ts`, append:

```ts
/** The watcher payloads do not carry a `submodules` domain yet (that lands
 * with the tier-2 watcher work): submodule-relevant changes classify as
 * `status` (index, worktree) or `branches`/`log` (HEAD moves). Derive the
 * domain so the Submodules section refreshes with them. */
export function withDerivedDomains(domains: string[]): string[] {
  if (!domains.includes("status") && !domains.includes("branches")) return domains;
  if (domains.includes("submodules")) return domains;
  return [...domains, "submodules"];
}
```

In `useRepoChangeListener.ts`, import it and change the callback line:

```ts
      invalidateRepoDomains(queryClient, payload.repo_id, withDerivedDomains(payload.domains), {
        coalesce: true,
      });
```

Append to `src/lib/repoInvalidation.test.ts`:

```ts
import { withDerivedDomains } from "./repoInvalidation";

describe("withDerivedDomains", () => {
  it("adds submodules alongside status", () => {
    expect(withDerivedDomains(["status"])).toEqual(["status", "submodules"]);
  });
  it("adds submodules alongside branches", () => {
    expect(withDerivedDomains(["branches", "log"])).toEqual(["branches", "log", "submodules"]);
  });
  it("leaves unrelated domains alone", () => {
    expect(withDerivedDomains(["tags"])).toEqual(["tags"]);
  });
  it("does not duplicate", () => {
    expect(withDerivedDomains(["status", "submodules"])).toEqual(["status", "submodules"]);
  });
});
```

(Match the test file's existing import style - it already imports from `./repoInvalidation`, so merge the import.)

- [x] **Step 5: Verify**

Run: `npx tsc --noEmit 2>&1 | head -5`
Expected: clean. (vitest runs in the final PowerShell pass.)

---

### Task 10: DiffPanel submodule view

**Files:**
- Create: `src/panels/Diff/SubmoduleDiffView.tsx`
- Modify: `src/panels/Diff/DiffPanel.tsx:750-756` (replace the placeholder branch)

**Interfaces:**
- Consumes: `DiffEntry`'s `Submodule` variant (`SubmoduleChange` with `dirty`), `repoSubmoduleLog` (Task 8), `request.repoId` (in scope where the branch renders).

- [x] **Step 1: The view component**

Create `src/panels/Diff/SubmoduleDiffView.tsx`:

```tsx
import { useQuery } from "@tanstack/react-query";
import { repoSubmoduleLog } from "../../lib/commands";
import type { SubmoduleChange, SubmoduleLog } from "../../lib/types";

/**
 * Rich submodule pointer diff (spec 2026-07-08): old -> new SHA, a dirty
 * badge, and the commits between the pointers (lazy `git -C <sub> log`,
 * TortoiseGit-style). An unfetched target renders a distinct state instead
 * of an error.
 */
export function SubmoduleDiffView({
  repoId,
  change,
}: {
  repoId: string;
  change: SubmoduleChange;
}) {
  const { path, old_sha, new_sha, dirty } = change;
  const { data, isError } = useQuery<SubmoduleLog>({
    queryKey: [repoId, "submodule-log", path, old_sha, new_sha],
    queryFn: () => repoSubmoduleLog(repoId, path, old_sha, new_sha!),
    enabled: new_sha !== null,
    staleTime: 60_000,
    retry: false,
  });

  return (
    <div
      className="legit-panel__body"
      style={{ display: "flex", flexDirection: "column", gap: 10 }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: "var(--fz-md)", fontFamily: "monospace" }}>{path}</span>
        <span className="legit-subtle" style={{ fontSize: "var(--fz-sm)" }}>
          submodule
        </span>
        {dirty && (
          <span
            style={{
              fontSize: "var(--fz-sm)",
              color: "var(--status-modified)",
              border: "1px solid currentColor",
              borderRadius: "0.75em",
              padding: "0 0.5em",
            }}
          >
            contains uncommitted changes
          </span>
        )}
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontFamily: "monospace",
          fontSize: "var(--fz-md)",
        }}
      >
        <Sha sha={old_sha} fallback="(none)" />
        <span className="legit-subtle">→</span>
        <Sha sha={new_sha} fallback="(removed)" />
      </div>

      {new_sha === null ? (
        <span className="legit-subtle" style={{ fontSize: "var(--fz-md)" }}>
          Submodule removed.
        </span>
      ) : isError ? (
        <span className="legit-subtle" style={{ fontSize: "var(--fz-md)" }}>
          Could not read the submodule's history.
        </span>
      ) : data?.kind === "target_missing" ? (
        <span className="legit-subtle" style={{ fontSize: "var(--fz-md)" }}>
          The target commit is not present locally - fetch inside the submodule
          to see the commits it brings in.
        </span>
      ) : data?.kind === "commits" ? (
        data.commits.length === 0 ? (
          <span className="legit-subtle" style={{ fontSize: "var(--fz-md)" }}>
            No new commits between the pointers (backwards move or divergence).
          </span>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {data.commits.map((c) => (
              <div
                key={c.id}
                style={{ display: "flex", gap: 8, fontSize: "var(--fz-md)" }}
              >
                <span
                  className="legit-subtle"
                  style={{ fontFamily: "monospace", flexShrink: 0 }}
                  title={c.id}
                >
                  {c.id.slice(0, 8)}
                </span>
                <span
                  style={{
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  title={c.subject}
                >
                  {c.subject}
                </span>
              </div>
            ))}
            {data.commits.length === 100 && (
              <span className="legit-subtle" style={{ fontSize: "var(--fz-sm)" }}>
                First 100 commits shown.
              </span>
            )}
          </div>
        )
      ) : null}
    </div>
  );
}

function Sha({ sha, fallback }: { sha: string | null; fallback: string }) {
  if (sha === null) return <span className="legit-subtle">{fallback}</span>;
  return <span title={sha}>{sha.slice(0, 12)}</span>;
}
```

- [x] **Step 2: Wire the DiffPanel branch**

In `DiffPanel.tsx`, replace lines 750-756:

```tsx
  if ("Submodule" in data) {
    return <SubmoduleDiffView repoId={request.repoId} change={data.Submodule} />;
  }
```

and import `{ SubmoduleDiffView } from "./SubmoduleDiffView";` at the top. (`request` is already in scope in this component - see line 776 using `request.repoId`.)

- [x] **Step 3: Verify**

Run: `npx tsc --noEmit 2>&1 | head -5`
Expected: clean.

---

### Task 11: Full verification

- [x] **Step 1: Backend suite**

Run: `cargo test -p legit-core 2>&1 | grep "test result"`
Expected: all green (lib + git_flows).

- [x] **Step 2: Tauri crate compiles**

Run: `cargo check -p legit 2>&1 | tail -3` (actual crate name from `src-tauri/Cargo.toml`)
Expected: clean.

- [x] **Step 3: Frontend type-check**

Run: `npx tsc --noEmit`
Expected: clean.

- [x] **Step 4: Hand off PowerShell verification to the user**

Ask the user to run from PowerShell (WSL cannot: Linux node binaries):
1. `npm test` - vitest incl. `submodules.test.ts`, `repoInvalidation.test.ts`, and the theme contract/no-literal-colors suites (the new components use only `var(--token)` colors, so these must stay green).
2. `npm run tauri dev` - opens the app; verify in a repo with submodules: the Refs panel shows the Submodules section with state badges; clicking a pointer-moved submodule in Working Changes shows the new submodule diff view with the commit list; a commit that bumps a submodule shows `SubmoduleChanged` in Changed Files. Running the app also regenerates `src/lib/bindings.ts` with the new commands/types.
