# Status Porcelain v2 Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Do NOT use subagent-driven-development (user rule). Do NOT commit at any point (user rule): leave all changes in the working tree for the user to review.

**Goal:** Migrate `git status` parsing from `--porcelain=v1` to `--porcelain=v2` with byte-for-byte identical `Vec<FileStatus>` output, as the foundation for submodule state detection (spec: `docs/superpowers/specs/2026-07-08-submodules-architecture-design.md`, sub-project 1).

**Architecture:** Only the parser layer changes. `STATUS_ARGS` and `parse_status` in `crates/legit-core/src/cli_impl/parsers/status.rs` move to the v2 record format (`1`/`2`/`u`/`?`/`!` records). The `S<c><m><u>` submodule field and mode fields are skipped positionally for now (surfaced in sub-project 2). Everything downstream (`status_entries`, numstat enrichment, `wants_counts`, `apply_numstat`, IPC types, frontend) is untouched.

**Tech Stack:** Rust (crates/legit-core), `FakeExecutor` flow tests, real-git integration harness (`tests/git_flows.rs`).

## Global Constraints

- **No commits, no pushes.** All changes stay unstaged for user review (overrides the usual per-task commit steps).
- **Zero behavior change:** `parse_status` must return the same `Vec<FileStatus>` (same entries, same order, same states, same `staged` flags) for equivalent repository states as the v1 parser.
- `NUMSTAT_STAGED_ARGS` / `NUMSTAT_UNSTAGED_ARGS` and `apply_numstat` / `wants_counts` are unchanged.
- `-z` NUL framing and `--untracked-files=all` are kept (per-file untracked entries, verbatim paths).
- Verification runs from WSL: `cargo test -p legit-core` (vitest/npm are PowerShell-only and not needed - no frontend files change).
- No em-dashes in comments or docs; use hyphens or colons.

## Porcelain v2 format reference (git 2.11+, stable)

With `-z`, records are NUL-terminated; a rename/copy record's original path
is a separate NUL-terminated field following the record (same consumption
pattern as v1):

```
1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>                      ordinary
2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>\0<orig>   rename/copy
u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>            unmerged
? <path>                                                          untracked
! <path>                                                          ignored
```

- `<XY>`: same letters as v1, but `.` (not space) means "unmodified on this side".
- `<sub>`: `N...` for a plain file, `S<c><m><u>` for a submodule (`c` = commit/pointer changed, `m` = tracked modifications, `u` = untracked files). Parsed positionally, not surfaced yet.
- Header records (`# ...`) appear only with `--branch`/`--show-stash`, which we never pass; the parser skips unknown tags defensively.
- v1's `AA`/`DD`/`*U` conflict forms all arrive as `u` records in v2.

---

### Task 1: Rewrite the status parser for porcelain v2

**Files:**
- Modify: `crates/legit-core/src/cli_impl/parsers/status.rs` (module doc, `STATUS_ARGS`, `parse_status`, new record helpers, test module; `wants_counts` / `apply_numstat` / `map_code` and the numstat constants stay as-is)

**Interfaces:**
- Consumes: `FileStatus::new(path: &str, state: FileState, staged: bool)`, `FileState`, `NumStat` (all unchanged).
- Produces: `pub const STATUS_ARGS: [&str; 4]` with `--porcelain=v2`; `pub fn parse_status(output: &str) -> Vec<FileStatus>` with identical semantics to today. Task 2's flow-test fixtures depend on exactly these args and on the v2 record format above.

- [x] **Step 1: Rewrite the test module for v2 fixtures (failing tests)**

Replace the `tests` module in `status.rs` with the version below. It ports every existing case to v2 records via helpers, and adds cases v1 could not express: `.`-column handling, submodule `S` records folding to `Modified` (parity - reclassification is sub-project 2), typechange, the `u AA`/`u DD` forms, and unknown-tag skipping. The numstat tests keep their exact assertions, only the status fixtures change.

```rust
#[cfg(test)]
mod tests {
    use super::super::commit_files::parse_numstat;
    use super::*;

    /// Join porcelain records into a single `-z` stream (trailing NUL included).
    fn stream(records: &[&str]) -> String {
        let mut s = records.join("\0");
        s.push('\0');
        s
    }

    /// Build a v2 ordinary (`1`) record. Only `<XY>` and `<path>` matter to
    /// the parser; the sub/mode/hash fields are positional filler it skips.
    fn ord(xy: &str, path: &str) -> String {
        format!("1 {xy} N... 100644 100644 100644 aaaaaaa bbbbbbb {path}")
    }

    /// Ordinary record for a submodule entry: `S<c><m><u>` sub field and
    /// gitlink (160000) modes.
    fn ord_sub(xy: &str, sub: &str, path: &str) -> String {
        format!("1 {xy} {sub} 160000 160000 160000 aaaaaaa bbbbbbb {path}")
    }

    /// Build a v2 rename/copy (`2`) record. The original path travels as the
    /// next NUL field, so callers pass it as a separate `stream` element.
    fn ren(xy: &str, score: &str, path: &str) -> String {
        format!("2 {xy} N... 100644 100644 100644 aaaaaaa bbbbbbb {score} {path}")
    }

    /// Build a v2 unmerged (`u`) record.
    fn unm(xy: &str, path: &str) -> String {
        format!("u {xy} N... 100644 100644 100644 100644 a1 a2 a3 {path}")
    }

    /// Shorthand for the expected parser output (counts always empty there).
    fn fs(path: &str, state: FileState, staged: bool) -> FileStatus {
        FileStatus::new(path, state, staged)
    }

    #[test]
    fn parses_working_tree_modification() {
        let out = stream(&[&ord(".M", "src/main.rs")]);
        assert_eq!(
            parse_status(&out),
            vec![fs("src/main.rs", FileState::Modified, false)]
        );
    }

    #[test]
    fn parses_staged_addition() {
        let out = stream(&[&ord("A.", "new.txt")]);
        assert_eq!(parse_status(&out), vec![fs("new.txt", FileState::Added, true)]);
    }

    #[test]
    fn splits_staged_and_restaged_modification() {
        // Staged modification then further modified in the working tree.
        let out = stream(&[&ord("MM", "file.rs")]);
        assert_eq!(
            parse_status(&out),
            vec![
                fs("file.rs", FileState::Modified, true),
                fs("file.rs", FileState::Modified, false),
            ]
        );
    }

    #[test]
    fn parses_untracked() {
        let out = stream(&["? scratch.tmp"]);
        assert_eq!(
            parse_status(&out),
            vec![fs("scratch.tmp", FileState::Untracked, false)]
        );
    }

    #[test]
    fn parses_ignored() {
        let out = stream(&["! target/debug"]);
        assert_eq!(
            parse_status(&out),
            vec![fs("target/debug", FileState::Ignored, false)]
        );
    }

    #[test]
    fn parses_rename_and_consumes_original_path() {
        // `2 ... new.rs\0old.rs\0` - the original path is a separate field.
        let out = stream(&[&ren("R.", "R100", "new.rs"), "old.rs"]);
        assert_eq!(parse_status(&out), vec![fs("new.rs", FileState::Renamed, true)]);
    }

    #[test]
    fn parses_worktree_rename() {
        let out = stream(&[&ren(".R", "R100", "new.rs"), "old.rs"]);
        assert_eq!(parse_status(&out), vec![fs("new.rs", FileState::Renamed, false)]);
    }

    #[test]
    fn parses_conflict() {
        let out = stream(&[&unm("UU", "merged.rs")]);
        assert_eq!(
            parse_status(&out),
            vec![fs("merged.rs", FileState::Conflicted, false)]
        );
    }

    #[test]
    fn parses_both_sides_conflict_forms() {
        // v1 special-cased `AA`/`DD`; v2 delivers them as `u` records too.
        let out = stream(&[&unm("AA", "both-added.rs"), &unm("DD", "both-deleted.rs")]);
        assert_eq!(
            parse_status(&out),
            vec![
                fs("both-added.rs", FileState::Conflicted, false),
                fs("both-deleted.rs", FileState::Conflicted, false),
            ]
        );
    }

    #[test]
    fn parses_path_with_spaces() {
        let out = stream(&[&ord(".M", "dir with spaces/a b.txt")]);
        assert_eq!(
            parse_status(&out),
            vec![fs("dir with spaces/a b.txt", FileState::Modified, false)]
        );
    }

    #[test]
    fn typechange_folds_to_modified() {
        let out = stream(&[&ord(".T", "link.rs")]);
        assert_eq!(parse_status(&out), vec![fs("link.rs", FileState::Modified, false)]);
    }

    #[test]
    fn submodule_records_fold_to_modified_for_now() {
        // Parity with v1: submodule entries stay `Modified` until sub-project
        // 2 surfaces the `S<c><m><u>` flags as `SubmoduleChanged`.
        let out = stream(&[
            &ord_sub("M.", "SC..", "vendor/staged-bump"),
            &ord_sub(".M", "S.M.", "vendor/dirty-inside"),
            &ord_sub(".M", "S..U", "vendor/untracked-inside"),
        ]);
        assert_eq!(
            parse_status(&out),
            vec![
                fs("vendor/staged-bump", FileState::Modified, true),
                fs("vendor/dirty-inside", FileState::Modified, false),
                fs("vendor/untracked-inside", FileState::Modified, false),
            ]
        );
    }

    #[test]
    fn skips_unknown_record_tags() {
        // `#` headers only appear with --branch/--show-stash (never passed);
        // anything unrecognized must be skipped, not crash or mis-parse.
        let out = stream(&["# branch.oid deadbeef", &ord(".M", "a.txt")]);
        assert_eq!(parse_status(&out), vec![fs("a.txt", FileState::Modified, false)]);
    }

    #[test]
    fn empty_input_yields_no_changes() {
        assert_eq!(parse_status(""), vec![]);
        assert_eq!(parse_status("\0"), vec![]);
    }

    #[test]
    fn parses_multiple_records() {
        let out = stream(&[&ord("A.", "added.rs"), &ord(".D", "removed.rs"), "? untracked.rs"]);
        let parsed = parse_status(&out);
        assert_eq!(parsed.len(), 3);
        assert_eq!(parsed[0].state, FileState::Added);
        assert!(parsed[0].staged);
        assert_eq!(parsed[1].state, FileState::Deleted);
        assert!(!parsed[1].staged);
        assert_eq!(parsed[2].state, FileState::Untracked);
    }

    // -- apply_numstat -------------------------------------------------------

    #[test]
    fn merges_staged_and_unstaged_counts_separately() {
        // Same path staged and re-modified: each side gets its own diff's counts.
        let mut statuses = parse_status(&stream(&[&ord("MM", "file.rs")]));
        let staged = parse_numstat(&stream(&["3\t1\tfile.rs"]));
        let unstaged = parse_numstat(&stream(&["2\t0\tfile.rs"]));
        apply_numstat(&mut statuses, &staged, &unstaged);

        assert!(statuses[0].staged);
        assert_eq!((statuses[0].additions, statuses[0].deletions), (Some(3), Some(1)));
        assert!(!statuses[1].staged);
        assert_eq!((statuses[1].additions, statuses[1].deletions), (Some(2), Some(0)));
    }

    #[test]
    fn untracked_and_conflicted_keep_no_counts() {
        let mut statuses = parse_status(&stream(&["? new.txt", &unm("UU", "merged.rs")]));
        // Even if a numstat stream mentioned the paths, they must stay None.
        let counts = parse_numstat(&stream(&["9\t9\tnew.txt", "9\t9\tmerged.rs"]));
        apply_numstat(&mut statuses, &counts, &counts);

        for st in &statuses {
            assert_eq!(st.additions, None);
            assert_eq!(st.deletions, None);
            assert!(!st.binary);
        }
    }

    #[test]
    fn marks_binary_without_counts() {
        let mut statuses = parse_status(&stream(&[&ord(".M", "pic.bin")]));
        let unstaged = parse_numstat(&stream(&["-\t-\tpic.bin"]));
        apply_numstat(&mut statuses, &HashMap::new(), &unstaged);

        assert!(statuses[0].binary);
        assert_eq!(statuses[0].additions, None);
        assert_eq!(statuses[0].deletions, None);
    }

    #[test]
    fn staged_rename_counts_key_by_destination_path() {
        // Porcelain reports the new path; `diff --numstat -M -z` keys the
        // rename record by the destination too, so they line up.
        let mut statuses = parse_status(&stream(&[&ren("R.", "R100", "new.rs"), "old.rs"]));
        let staged = parse_numstat(&stream(&["4\t2\t", "old.rs", "new.rs"]));
        apply_numstat(&mut statuses, &staged, &HashMap::new());

        assert_eq!((statuses[0].additions, statuses[0].deletions), (Some(4), Some(2)));
    }

    #[test]
    fn missing_numstat_entry_keeps_none() {
        let mut statuses = parse_status(&stream(&[&ord(".M", "file.rs")]));
        apply_numstat(&mut statuses, &HashMap::new(), &HashMap::new());
        assert_eq!(statuses[0].additions, None);
        assert_eq!(statuses[0].deletions, None);
    }
}
```

- [x] **Step 2: Run the parser tests to verify they fail**

Run: `cargo test -p legit-core --lib parsers::status -- --nocapture 2>&1 | tail -30`
Expected: FAIL - the old v1 parser mis-parses every v2 fixture (e.g. `parses_working_tree_modification` gets an entry for path `M N... 100644 ...` or nothing).

- [x] **Step 3: Rewrite `STATUS_ARGS` and `parse_status` for v2**

Replace the module doc, `STATUS_ARGS`, and `parse_status` (everything above `wants_counts`) with:

```rust
//! Parser for `git status --porcelain=v2 -z` output backing `status()`.
//!
//! The format flags live here next to the parser so the contract is visible in
//! one place (DESIGN-v0.3.md §4.5). `--porcelain=v2` gives one tagged record
//! per change (`1` ordinary, `2` rename/copy, `u` unmerged, `?` untracked,
//! `!` ignored); `-z` makes records NUL-separated and disables path quoting,
//! so paths with spaces/unicode pass through verbatim. v2 (git 2.11+, stable)
//! is required because only its `S<c><m><u>` sub-field distinguishes a moved
//! submodule pointer from a dirty submodule worktree - porcelain v1 reports
//! both as ` M` (spec: 2026-07-08 submodules architecture, sub-project 1).
//! The sub-field and mode fields are skipped positionally for now and get
//! surfaced in sub-project 2.
//!
//! Line counts are not part of porcelain status: they come from two extra
//! `git diff --numstat -z` runs (index and working tree) whose parsed maps are
//! merged into the entries by `apply_numstat`.

use super::commit_files::NumStat;
use crate::types::{FileState, FileStatus};
use std::collections::HashMap;

/// Arguments for the status command, in order. `-z` is required for the NUL
/// framing this parser assumes. `--untracked-files=all` lists each untracked
/// file individually; without it git collapses an entirely-untracked directory
/// into a single `dir/` entry, which the UI can't stage/diff per file.
pub const STATUS_ARGS: [&str; 4] =
    ["status", "--porcelain=v2", "-z", "--untracked-files=all"];
```

(`NUMSTAT_UNSTAGED_ARGS` / `NUMSTAT_STAGED_ARGS` keep their existing doc comments and values.)

```rust
/// Parse the stdout of `git status --porcelain=v2 -z`.
///
/// Record tags: `1` ordinary change, `2` rename/copy (the original path is
/// the next NUL field - consumed and ignored, we report the new path only),
/// `u` unmerged, `?` untracked, `!` ignored. In `<XY>`, `X` is the index
/// (staged) column and `Y` the working-tree column, `.` meaning unmodified -
/// a path both staged and re-modified produces two entries, exactly like the
/// old v1 parser. `#` headers appear only with `--branch`/`--show-stash`
/// (never passed); unknown tags are skipped.
pub fn parse_status(output: &str) -> Vec<FileStatus> {
    let mut result = Vec::new();
    let mut tokens = output.split('\0');

    while let Some(record) = tokens.next() {
        // The trailing `-z` separator produces a final empty token.
        let Some(&tag) = record.as_bytes().first() else {
            continue;
        };
        match tag {
            // `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>`
            b'1' => {
                let mut fields = record.splitn(9, ' ');
                if let (Some(xy), Some(path)) = (fields.nth(1), fields.nth(6)) {
                    push_columns(xy, path, &mut result);
                }
            }
            // `2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>` +
            // the original path as the next NUL field - consume it.
            b'2' => {
                tokens.next();
                let mut fields = record.splitn(10, ' ');
                if let (Some(xy), Some(path)) = (fields.nth(1), fields.nth(7)) {
                    push_columns(xy, path, &mut result);
                }
            }
            // `u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>` -
            // reported once, not split into staged/unstaged (v1's `AA`/`DD`/
            // `*U` forms all arrive as `u` records here).
            b'u' => {
                if let Some(path) = record.splitn(11, ' ').nth(10) {
                    result.push(FileStatus::new(path, FileState::Conflicted, false));
                }
            }
            // Untracked / ignored: single entry, never staged.
            b'?' => {
                if let Some(path) = record.strip_prefix("? ") {
                    result.push(FileStatus::new(path, FileState::Untracked, false));
                }
            }
            b'!' => {
                if let Some(path) = record.strip_prefix("! ") {
                    result.push(FileStatus::new(path, FileState::Ignored, false));
                }
            }
            _ => {}
        }
    }

    result
}

/// Emit the staged (index column) and/or working-tree entry for one record.
/// `.` means "unmodified on this side" in v2, replacing v1's space.
fn push_columns(xy: &str, path: &str, out: &mut Vec<FileStatus>) {
    let mut chars = xy.chars();
    let (Some(x), Some(y)) = (chars.next(), chars.next()) else {
        return;
    };
    if x != '.' {
        out.push(FileStatus::new(path, map_code(x), true));
    }
    if y != '.' {
        out.push(FileStatus::new(path, map_code(y), false));
    }
}
```

`wants_counts`, `apply_numstat`, and `map_code` stay exactly as they are (v2 uses the same state letters; `.` never reaches `map_code`).

- [x] **Step 4: Run the parser tests to verify they pass**

Run: `cargo test -p legit-core --lib parsers::status`
Expected: PASS, all tests green (0 failed).

---

### Task 2: Update the FakeExecutor flow-test fixtures to v2

**Files:**
- Modify: `crates/legit-core/src/cli_impl/flow_tests.rs:1022,1043,1067,1082` (the four `status --porcelain=v1` expectations and their scripted stdout)

**Interfaces:**
- Consumes: the new `STATUS_ARGS` (`--porcelain=v2`) and v2 record format from Task 1. `FakeExecutor` asserts exact argv, so these fixtures fail loudly until updated - that is the point of this task.
- Produces: nothing new; the flow tests return to green with v2-shaped scripted output.

- [x] **Step 1: Run the flow tests to see the four failures**

Run: `cargo test -p legit-core --lib flow_tests 2>&1 | tail -20`
Expected: FAIL - `discard_restores_tracked_and_cleans_untracked`, `status_enriches_entries_with_numstat_counts`, `status_skips_numstat_for_an_all_untracked_tree`, `status_survives_a_failing_numstat` (FakeExecutor argv mismatch: expected `--porcelain=v1`, got `--porcelain=v2`).

- [x] **Step 2: Update the four expectations to v2 argv and v2-shaped stdout**

In `discard_restores_tracked_and_cleans_untracked` (line ~1022):

```rust
    // status: one modified (tracked), one untracked.
    fake.expect(
        &["status", "--porcelain=v2", "-z", "--untracked-files=all"],
        ok("1 .M N... 100644 100644 100644 aaaaaaa bbbbbbb tracked.txt\0? untracked.txt\0"),
    );
```

In `status_enriches_entries_with_numstat_counts` (line ~1043):

```rust
    fake.expect(
        &["status", "--porcelain=v2", "-z", "--untracked-files=all"],
        ok("1 MM N... 100644 100644 100644 aaaaaaa bbbbbbb file.rs\0? new.txt\0"),
    );
```

In `status_skips_numstat_for_an_all_untracked_tree` (line ~1067):

```rust
    fake.expect(
        &["status", "--porcelain=v2", "-z", "--untracked-files=all"],
        ok("? a.txt\0? b.txt\0"),
    );
```

In `status_survives_a_failing_numstat` (line ~1082):

```rust
    fake.expect(
        &["status", "--porcelain=v2", "-z", "--untracked-files=all"],
        ok("1 A. N... 000000 100644 100644 0000000 bbbbbbb new.txt\0"),
    );
```

(The mode/hash tokens are positional filler the parser skips; `000000`/`0000000` on the added file mirror real git output for a path absent from HEAD.)

- [x] **Step 3: Run the flow tests to verify they pass**

Run: `cargo test -p legit-core --lib flow_tests`
Expected: PASS (all flow tests green, including the four updated ones - their assertions on entry counts, states, and numstat behavior are unchanged).

---

### Task 3: Real-git parity validation and a conflict-status harness test

**Files:**
- Modify: `crates/legit-core/tests/git_flows.rs` (add one test after `status_reports_counts_for_a_staged_rename`, ~line 1320)

**Interfaces:**
- Consumes: `TestRepo::init()`, `conflicting_branches(&repo)`, `repo.backend.status()`, `repo.backend.merge(..)`, `FileState::Conflicted` (all existing).
- Produces: a real-binary test pinning the "conflicts arrive as `u` records and map to a single unstaged `Conflicted` entry" assumption. The existing status tests (`status_reports_line_counts_per_side`, `status_counts_work_before_the_first_commit`, `status_reports_counts_for_a_staged_rename`) already exercise ordinary/untracked/binary/rename records against real git and act as the parity harness for the new args.

- [x] **Step 1: Add the conflict-status test**

The existing real-git status tests cover ordinary, untracked, binary, and rename records, but none asserts the status view of a conflict - which is exactly the record shape that changed most between v1 (`UU`/`AA`/`DD` letter forms) and v2 (`u` records). Encode it:

```rust
#[tokio::test]
async fn status_reports_a_conflict_as_a_single_unstaged_entry() {
    // Conflicts arrive as porcelain v2 `u` records; the parser must fold each
    // into exactly one Conflicted entry (never split staged/unstaged, never
    // duplicated), matching the old v1 behavior for `UU` forms.
    let repo = TestRepo::init().await;
    conflicting_branches(&repo).await;
    let outcome = repo.backend.merge("feature", MergeOptions::default()).await.unwrap();
    assert!(matches!(outcome, MergeOutcome::Conflicts { .. }), "{outcome:?}");

    let status = repo.backend.status().await.unwrap();
    let conflicted: Vec<_> = status
        .iter()
        .filter(|s| s.path == PathBuf::from("a.txt"))
        .collect();
    assert_eq!(conflicted.len(), 1, "one entry for the conflicted path: {status:?}");
    assert_eq!(conflicted[0].state, FileState::Conflicted);
    assert!(!conflicted[0].staged);
    assert_eq!((conflicted[0].additions, conflicted[0].deletions), (None, None));
}
```

- [x] **Step 2: Run the new test against the real binary**

Run: `cargo test -p legit-core --test git_flows status_reports_a_conflict -- --nocapture`
Expected: PASS.

- [x] **Step 3: Run the entire legit-core suite as the final parity gate**

Run: `cargo test -p legit-core`
Expected: PASS - parser unit tests, all flow tests, and every real-git integration test green. The real-git status tests passing against `--porcelain=v2` is the end-to-end parity evidence.

- [x] **Step 4: Confirm nothing outside the parser layer changed**

Run: `git diff --stat`
Expected: exactly three files - `parsers/status.rs`, `flow_tests.rs`, `tests/git_flows.rs`. No `types.rs`, no `mod.rs`, no frontend files (byte-for-byte parity means downstream consumers are untouched). Leave everything uncommitted for user review.
