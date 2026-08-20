//! Pure parsers + assembly for submodule enumeration, backing `submodules()`.
//!
//! Enumeration deliberately avoids `git submodule status` (spawns `git
//! describe` per submodule - the SourceTree perf trap) and the removed
//! internal `git submodule--helper`. Sources instead (spec 2026-07-08,
//! sub-project 2): index gitlinks (`ls-files --stage`, mode 160000),
//! `.gitmodules` + local config (`git config -z --get-regexp`), the one
//! superproject porcelain-v2 status (`S<c><m><u>` dirt flags), and one
//! `rev-parse` probe per populated submodule.

use crate::types::{CommitId, GitmodulesFinding, SubmoduleInfo, SubmoduleLogEntry, SubmoduleState};
use std::collections::{HashMap, HashSet};
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

/// `git log` format for submodule pointer ranges: `<sha>\0<subject>\0` pairs.
pub const SUBMODULE_LOG_FORMAT: &str = "--format=%H%x00%s%x00";

/// Staged diff, raw form: gates the `.gitmodules` consistency check to
/// commits that actually touch submodule config (the root `.gitmodules`, or
/// any gitlink add/remove/mode flip).
pub const STAGED_RAW_DIFF_ARGS: [&str; 5] =
    ["diff", "--cached", "--raw", "-z", "--no-renames"];

/// All `submodule.*` keys from the STAGED `.gitmodules` blob - what the next
/// commit will record, deliberately not the worktree file. Exits non-zero
/// when nothing is staged at that path or there are no matches - treat as
/// empty.
pub const STAGED_GITMODULES_CONFIG_ARGS: [&str; 6] =
    ["config", "--blob", ":.gitmodules", "-z", "--get-regexp", "^submodule\\."];

/// Whether the staged diff (`STAGED_RAW_DIFF_ARGS` output) touches submodule
/// config at all: the root `.gitmodules`, or any entry whose old or new mode
/// is a gitlink (160000). `--raw -z --no-renames` alternates meta records
/// (`:oldmode newmode oldsha newsha status`) and path records.
pub fn staged_touches_submodule_config(raw_z: &str) -> bool {
    let mut records = raw_z.split('\0');
    while let Some(meta) = records.next() {
        let Some(meta) = meta.strip_prefix(':') else { continue };
        let mut fields = meta.split(' ');
        let old_mode = fields.next().unwrap_or("");
        let new_mode = fields.next().unwrap_or("");
        let Some(path) = records.next() else { break };
        if old_mode == "160000" || new_mode == "160000" || path == ".gitmodules" {
            return true;
        }
    }
    false
}

/// Compare the staged `.gitmodules` sections against the staged gitlinks and
/// report every mismatch, deterministically ordered (dangling entries by
/// name, then orphaned gitlinks by path) so the warning list is stable
/// across runs.
pub fn check_gitmodules_consistency(
    entries: &HashMap<String, SubmoduleConfigEntry>,
    gitlinks: &[(PathBuf, CommitId)],
) -> Vec<GitmodulesFinding> {
    let link_set: HashSet<&PathBuf> = gitlinks.iter().map(|(p, _)| p).collect();
    let mut dangling: Vec<GitmodulesFinding> = entries
        .iter()
        .filter(|(_, e)| {
            e.path
                .as_ref()
                .map(|p| !link_set.contains(&PathBuf::from(p)))
                .unwrap_or(true)
        })
        .map(|(name, e)| GitmodulesFinding::EntryWithoutGitlink {
            name: name.clone(),
            path: e.path.clone().unwrap_or_default(),
        })
        .collect();
    dangling.sort_by(|a, b| match (a, b) {
        (
            GitmodulesFinding::EntryWithoutGitlink { name: an, .. },
            GitmodulesFinding::EntryWithoutGitlink { name: bn, .. },
        ) => an.cmp(bn),
        _ => std::cmp::Ordering::Equal,
    });

    let covered: HashSet<PathBuf> = entries
        .values()
        .filter_map(|e| e.path.as_ref().map(PathBuf::from))
        .collect();
    let mut orphans: Vec<&PathBuf> = gitlinks
        .iter()
        .map(|(p, _)| p)
        .filter(|p| !covered.contains(*p))
        .collect();
    orphans.sort();

    dangling.extend(orphans.into_iter().map(|p| GitmodulesFinding::GitlinkWithoutEntry {
        path: p.to_string_lossy().into_owned(),
    }));
    dangling
}

/// Cap the range walk: the diff view shows "what's between the pointers",
/// not a full history browser.
pub const SUBMODULE_LOG_MAX: &str = "--max-count=100";

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

/// Parse the `<sha>\0<subject>\0` stream of a submodule range log.
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

    // -- staged_touches_submodule_config --------------------------------------

    #[test]
    fn gate_ignores_plain_file_changes() {
        let out = z(&[
            &format!(":100644 100644 {SHA_A} {SHA_B} M"),
            "src/main.rs",
        ]);
        assert!(!staged_touches_submodule_config(&out));
        assert!(!staged_touches_submodule_config(""));
    }

    #[test]
    fn gate_fires_on_gitmodules_change() {
        let out = z(&[
            &format!(":100644 100644 {SHA_A} {SHA_B} M"),
            ".gitmodules",
        ]);
        assert!(staged_touches_submodule_config(&out));
    }

    #[test]
    fn gate_fires_on_gitlink_add_and_delete() {
        let zero = "0000000000000000000000000000000000000000";
        let del = z(&[
            &format!(":160000 000000 {SHA_A} {zero} D"),
            "subs/gone",
        ]);
        assert!(staged_touches_submodule_config(&del));
        let add = z(&[
            &format!(":000000 160000 {zero} {SHA_A} A"),
            "subs/new",
        ]);
        assert!(staged_touches_submodule_config(&add));
    }

    #[test]
    fn gate_does_not_fire_on_a_nested_gitmodules_file() {
        // Only the ROOT .gitmodules declares submodules.
        let out = z(&[
            &format!(":100644 100644 {SHA_A} {SHA_B} M"),
            "vendor/lib/.gitmodules",
        ]);
        assert!(!staged_touches_submodule_config(&out));
    }

    // -- check_gitmodules_consistency ------------------------------------------

    fn entries(pairs: &[(&str, Option<&str>)]) -> HashMap<String, SubmoduleConfigEntry> {
        pairs
            .iter()
            .map(|(name, path)| {
                let mut e = SubmoduleConfigEntry::default();
                e.path = path.map(|p| p.to_string());
                (name.to_string(), e)
            })
            .collect()
    }

    fn links(paths: &[&str]) -> Vec<(PathBuf, CommitId)> {
        paths.iter().map(|p| (PathBuf::from(p), CommitId::new(SHA_A))).collect()
    }

    #[test]
    fn consistent_state_yields_no_findings() {
        let out = check_gitmodules_consistency(
            &entries(&[("lib", Some("vendor/lib"))]),
            &links(&["vendor/lib"]),
        );
        assert_eq!(out, vec![]);
    }

    #[test]
    fn dangling_entry_is_flagged() {
        let out = check_gitmodules_consistency(
            &entries(&[("lib", Some("vendor/lib"))]),
            &links(&[]),
        );
        assert_eq!(
            out,
            vec![GitmodulesFinding::EntryWithoutGitlink {
                name: "lib".into(),
                path: "vendor/lib".into(),
            }]
        );
    }

    #[test]
    fn orphaned_gitlink_is_flagged() {
        let out = check_gitmodules_consistency(&entries(&[]), &links(&["subs/x"]));
        assert_eq!(
            out,
            vec![GitmodulesFinding::GitlinkWithoutEntry { path: "subs/x".into() }]
        );
    }

    #[test]
    fn section_without_path_key_is_a_dangling_entry() {
        let out = check_gitmodules_consistency(&entries(&[("ghost", None)]), &links(&[]));
        assert_eq!(
            out,
            vec![GitmodulesFinding::EntryWithoutGitlink {
                name: "ghost".into(),
                path: String::new(),
            }]
        );
    }

    #[test]
    fn mixed_findings_are_deterministically_ordered() {
        // Entries (by name) before gitlinks (by path), so the warning list
        // is stable across runs regardless of HashMap iteration order.
        let out = check_gitmodulesconsistency_ordered_helper();
        assert_eq!(
            out,
            vec![
                GitmodulesFinding::EntryWithoutGitlink { name: "a".into(), path: "pa".into() },
                GitmodulesFinding::EntryWithoutGitlink { name: "b".into(), path: "pb".into() },
                GitmodulesFinding::GitlinkWithoutEntry { path: "subs/one" .into() },
                GitmodulesFinding::GitlinkWithoutEntry { path: "subs/two".into() },
            ]
        );
    }

    fn check_gitmodulesconsistency_ordered_helper() -> Vec<GitmodulesFinding> {
        check_gitmodules_consistency(
            &entries(&[("b", Some("pb")), ("a", Some("pa"))]),
            &links(&["subs/two", "subs/one"]),
        )
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
    fn parses_submodule_log_pairs() {
        let out = format!("{SHA_A}\0subject one\0{SHA_B}\0subject: with colons\0");
        let entries = parse_submodule_log(&out);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].id, CommitId::new(SHA_A));
        assert_eq!(entries[0].subject, "subject one");
        assert_eq!(entries[1].subject, "subject: with colons");
        assert_eq!(parse_submodule_log(""), vec![]);
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
