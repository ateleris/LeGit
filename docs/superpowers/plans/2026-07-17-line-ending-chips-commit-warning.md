# Line-Ending Chips in Working Changes + Commit Warning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Do NOT use subagent-driven-development (user rule).

**Goal:** Show attention-only line-ending chips on Working Changes rows and warn before committing staged line-ending changes, both policy-aware (no false alarms on autocrlf repos), fed by one batch backend command.

**Architecture:** A new pure "check-in kind" classifier in legit-core models git's clean-filter normalization. A new Tauri command `repo_line_ending_status` assembles a per-changed-file summary with a fixed subprocess budget (status, config, check-attr, one raw-bytes cat-file --batch). The frontend reads it through one shared React Query map that drives the new FileTree row chips, the existing Diff/Merge working-vs-index badges (now policy-aware), and the commit warning. Two settings (global default + repo override) gate the features.

**Tech Stack:** Rust (tokio, serde, specta), Tauri 2.x commands, React + TypeScript, TanStack Query, vitest, cargo test.

**Spec:** `docs/superpowers/specs/2026-07-17-line-ending-chips-commit-warning-design.md`

## Global Constraints

- **NEVER commit or push. Leave all changes staged/unstaged for the user to review.** This overrides every "commit" step convention in any skill.
- No em-dashes in any output, comments, or docs. Use hyphens or colons.
- Every colour must be a theme token (`var(--token)`); this plan reuses existing tokens only (`--status-modified`, `--subtle-fg`, `--panel-border`, `--warning-fg`, `--button-hover-bg`, `--fz-*`). No new tokens.
- All UI dimensions scale with `--ui-font-size` (use `em`, `var(--fz-*)`; the chip styles already comply).
- New Tauri commands: register in `src-tauri/src/lib.rs` `collect_commands!`, hand-write the wrapper in `src/lib/commands.ts`, hand-mirror types in `src/lib/types.ts`.
- Verification split (project memory): `cargo test` and `npx tsc --noEmit` run from WSL; `vitest` and the app itself only run from PowerShell. Write vitest files, run them only if a PowerShell path is available; otherwise ask the user to run `npm test` from PowerShell.
- The test repo `../LeGit-Test` must not be reset/aborted/cleaned without asking.
- 2 MB size cap for all line-ending reads (`MAX_LINE_ENDING_BYTES`), binary detection via NUL in the leading window (existing helpers).

---

### Task 1: Pure check-in classification in legit-core

Models what `git add` stores: the policy-aware side of the whole feature.

**Files:**
- Modify: `crates/legit-core/src/cli_impl/mod.rs` (next to `classify_line_endings`, ~line 2721)
- Modify: `crates/legit-core/src/lib.rs` (export new items alongside `classify_line_endings`, line 17)
- Test: unit tests in the existing `#[cfg(test)]` module of `crates/legit-core/src/cli_impl/mod.rs` (~line 3440, next to the `classify_line_endings_*` tests)

**Interfaces:**
- Consumes: `LineEndingKind` (types.rs), `BINARY_SNIFF_WINDOW` (existing const in cli_impl/mod.rs).
- Produces (used by Tasks 2-4):
  - `pub enum EolTextAttr { Set, Unset, Auto, Unspecified }`
  - `pub enum AutocrlfSetting { True, Input, False }`
  - `pub fn parse_autocrlf(stdout: &str) -> AutocrlfSetting`
  - `pub fn checkin_normalizes(text: EolTextAttr, eol_attr_set: bool, autocrlf: AutocrlfSetting, content_kind: LineEndingKind, index_kind: Option<LineEndingKind>) -> bool`
  - `pub fn classify_line_endings_normalized(text: &str) -> LineEndingKind`

- [ ] **Step 1: Write the failing tests**

Add to the `#[cfg(test)]` module in `cli_impl/mod.rs`:

```rust
#[test]
fn parse_autocrlf_values() {
    assert_eq!(parse_autocrlf("true\n"), AutocrlfSetting::True);
    assert_eq!(parse_autocrlf("input"), AutocrlfSetting::Input);
    assert_eq!(parse_autocrlf("false\n"), AutocrlfSetting::False);
    assert_eq!(parse_autocrlf(""), AutocrlfSetting::False);
    assert_eq!(parse_autocrlf("TRUE"), AutocrlfSetting::True);
}

#[test]
fn checkin_normalizes_matrix() {
    use AutocrlfSetting as A;
    use EolTextAttr as T;
    use LineEndingKind as K;
    // Explicit text attr: always normalizes, even when the index has CRLF.
    assert!(checkin_normalizes(T::Set, false, A::False, K::Crlf, Some(K::Crlf)));
    // -text / binary attr: never.
    assert!(!checkin_normalizes(T::Unset, false, A::True, K::Crlf, None));
    // Binary content: never, regardless of attrs.
    assert!(!checkin_normalizes(T::Set, false, A::True, K::Binary, None));
    // text=auto: yes, unless the indexed blob already contains CRLF.
    assert!(checkin_normalizes(T::Auto, false, A::False, K::Crlf, Some(K::Lf)));
    assert!(checkin_normalizes(T::Auto, false, A::False, K::Crlf, None));
    assert!(!checkin_normalizes(T::Auto, false, A::False, K::Crlf, Some(K::Crlf)));
    assert!(!checkin_normalizes(T::Auto, false, A::False, K::Crlf, Some(K::Mixed)));
    // No attr: core.autocrlf decides, with the same index-CRLF exemption.
    assert!(checkin_normalizes(T::Unspecified, false, A::True, K::Crlf, Some(K::Lf)));
    assert!(checkin_normalizes(T::Unspecified, false, A::Input, K::Crlf, None));
    assert!(!checkin_normalizes(T::Unspecified, false, A::False, K::Crlf, None));
    assert!(!checkin_normalizes(T::Unspecified, false, A::True, K::Crlf, Some(K::Crlf)));
    // An eol= attribute alone implies text: always normalizes.
    assert!(checkin_normalizes(T::Unspecified, true, A::False, K::Crlf, Some(K::Crlf)));
}

#[test]
fn classify_normalized_treats_crlf_as_lf() {
    use LineEndingKind as K;
    assert_eq!(classify_line_endings_normalized("a\r\nb\r\n"), K::Lf);
    assert_eq!(classify_line_endings_normalized("a\r\nb\n"), K::Lf);
    assert_eq!(classify_line_endings_normalized("a\nb\n"), K::Lf);
    // Lone CR is never converted by git.
    assert_eq!(classify_line_endings_normalized("a\rb\r"), K::Cr);
    assert_eq!(classify_line_endings_normalized("a\r\nb\r"), K::Mixed);
    assert_eq!(classify_line_endings_normalized("no newline"), K::None);
    assert_eq!(classify_line_endings_normalized("bin\0ary\r\n"), K::Binary);
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p legit-core parse_autocrlf_values checkin_normalizes_matrix classify_normalized 2>&1 | tail -20`
Expected: compile FAILURE ("cannot find function `parse_autocrlf`" etc.)

- [ ] **Step 3: Implement**

Add to `cli_impl/mod.rs` directly after `classify_line_endings`:

```rust
/// The `text` attribute's effective value for a path (`git check-attr`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EolTextAttr {
    /// `text` - normalization always on.
    Set,
    /// `-text` / `binary` - normalization off.
    Unset,
    /// `text=auto` - normalize when the content looks like text.
    Auto,
    /// No `text` attribute - `core.autocrlf` decides.
    Unspecified,
}

/// Resolved `core.autocrlf`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AutocrlfSetting {
    True,
    Input,
    False,
}

/// Parse `git config --get core.autocrlf` output. Anything unrecognized
/// (including unset - git exits 1 with empty stdout) is False, git's default.
pub fn parse_autocrlf(stdout: &str) -> AutocrlfSetting {
    match stdout.trim().to_ascii_lowercase().as_str() {
        "true" => AutocrlfSetting::True,
        "input" => AutocrlfSetting::Input,
        _ => AutocrlfSetting::False,
    }
}

/// Whether `git add` would normalize CRLF to LF for this path (the clean
/// filter), per gitattributes(5). `content_kind` is the working file's raw
/// classification (binary content is never converted). `index_kind` is the
/// blob currently in the index, if any: in the AUTO modes (`text=auto`, or
/// no attr + autocrlf true/input) git leaves files whose indexed blob
/// already contains CRLF untouched ("files that contain CRLF in the
/// repository will not be touched"); an explicit `text` or `eol` attribute
/// normalizes unconditionally. These rules are assumptions about git's
/// convert.c and are validated against the real binary in git_flows.rs.
pub fn checkin_normalizes(
    text: EolTextAttr,
    eol_attr_set: bool,
    autocrlf: AutocrlfSetting,
    content_kind: LineEndingKind,
    index_kind: Option<LineEndingKind>,
) -> bool {
    if content_kind == LineEndingKind::Binary {
        return false;
    }
    let index_has_crlf = matches!(
        index_kind,
        Some(LineEndingKind::Crlf) | Some(LineEndingKind::Mixed)
    );
    match text {
        EolTextAttr::Unset => false,
        EolTextAttr::Set => true,
        EolTextAttr::Auto => !index_has_crlf,
        EolTextAttr::Unspecified => {
            if eol_attr_set {
                // An `eol=` attribute alone implies `text`.
                true
            } else {
                matches!(autocrlf, AutocrlfSetting::True | AutocrlfSetting::Input)
                    && !index_has_crlf
            }
        }
    }
}

/// `classify_line_endings` as `git add` would see the content after CRLF->LF
/// normalization: CRLF counts as LF; bare LF and lone CR are unchanged. The
/// check-in kind of a working file is this when `checkin_normalizes` says
/// yes, the raw classification otherwise.
pub fn classify_line_endings_normalized(text: &str) -> LineEndingKind {
    let bytes = text.as_bytes();
    if bytes.iter().take(BINARY_SNIFF_WINDOW).any(|&b| b == 0) {
        return LineEndingKind::Binary;
    }
    let (mut lf, mut cr) = (false, false);
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'\r' if i + 1 < bytes.len() && bytes[i + 1] == b'\n' => {
                lf = true;
                i += 2;
            }
            b'\r' => {
                cr = true;
                i += 1;
            }
            b'\n' => {
                lf = true;
                i += 1;
            }
            _ => i += 1,
        }
    }
    match (lf, cr) {
        (false, false) => LineEndingKind::None,
        (true, false) => LineEndingKind::Lf,
        (false, true) => LineEndingKind::Cr,
        (true, true) => LineEndingKind::Mixed,
    }
}
```

In `crates/legit-core/src/lib.rs`, extend the existing re-export list (line 17) with:
`checkin_normalizes, classify_line_endings_normalized, parse_autocrlf, AutocrlfSetting, EolTextAttr`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p legit-core parse_autocrlf_values checkin_normalizes_matrix classify_normalized`
Expected: 3 tests PASS.

Do NOT commit (user rule).

---

### Task 2: Raw-bytes runner variant + batch parsers

`cat-file --batch` frames output by byte counts; `RunOutput.stdout` is lossy UTF-8 (U+FFFD shifts lengths - see the existing comment at `cli_impl/mod.rs:1383`), so the runner needs a raw-stdout variant.

**Files:**
- Modify: `crates/legit-core/src/runner.rs` (new struct + method after `run_with_stdin`, ~line 402)
- Modify: `crates/legit-core/src/cli_impl/mod.rs` (two pure parsers next to Task 1's code)
- Modify: `crates/legit-core/src/lib.rs` (re-export `parse_cat_file_batch, parse_check_attr_z`; `RunOutputBytes` exports from runner like `RunOutput`)
- Test: unit tests in `cli_impl/mod.rs` test module

**Interfaces:**
- Consumes: `EolTextAttr` (Task 1), runner internals (`build_command`, `read_to_string`, `log_invocation`).
- Produces (used by Task 4):
  - `pub struct RunOutputBytes { pub stdout: Vec<u8>, pub stderr: String, pub exit_code: Option<i32>, pub success: bool, pub duration_ms: u64 }`
  - `GitRunner::run_with_stdin_bytes(&self, args: &[&str], stdin_data: &str) -> Result<RunOutputBytes, RunnerError>`
  - `pub fn parse_cat_file_batch(out: &[u8]) -> Option<Vec<Option<Vec<u8>>>>` (one entry per requested object, request order; `None` entry = missing/unresolvable; outer `None` = framing violation)
  - `pub fn parse_check_attr_z(stdout: &str) -> HashMap<String, (EolTextAttr, bool)>` (path -> (text attr, eol attr set))

- [ ] **Step 1: Write the failing parser tests**

```rust
#[test]
fn parse_cat_file_batch_found_missing_and_binary() {
    // Two found objects (one containing NUL bytes and a newline) + one missing.
    let mut out: Vec<u8> = Vec::new();
    out.extend_from_slice(b"1111111111111111111111111111111111111111 blob 4\nab\ncd");
    out.push(b'\n');
    out.extend_from_slice(b":gone.txt missing\n");
    out.extend_from_slice(b"2222222222222222222222222222222222222222 blob 3\na\0b");
    out.push(b'\n');
    let parsed = parse_cat_file_batch(&out).expect("framing ok");
    assert_eq!(parsed.len(), 3);
    assert_eq!(parsed[0].as_deref(), Some(b"ab\ncd".as_slice()));
    assert_eq!(parsed[1], None);
    assert_eq!(parsed[2].as_deref(), Some(b"a\0b".as_slice()));
}

#[test]
fn parse_cat_file_batch_rejects_truncated_output() {
    let out = b"1111111111111111111111111111111111111111 blob 99\nshort\n";
    assert_eq!(parse_cat_file_batch(out), None);
}

#[test]
fn parse_check_attr_z_shapes() {
    use EolTextAttr as T;
    // path NUL attr NUL value NUL triples, one per (path, attr).
    let stdout = "a.txt\0text\0set\0a.txt\0eol\0unspecified\0\
                  b.bin\0text\0unset\0b.bin\0eol\0unspecified\0\
                  c.txt\0text\0auto\0c.txt\0eol\0lf\0\
                  d.txt\0text\0unspecified\0d.txt\0eol\0unspecified\0";
    let map = parse_check_attr_z(stdout);
    assert_eq!(map["a.txt"], (T::Set, false));
    assert_eq!(map["b.bin"], (T::Unset, false));
    assert_eq!(map["c.txt"], (T::Auto, true));
    assert_eq!(map["d.txt"], (T::Unspecified, false));
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p legit-core parse_cat_file parse_check_attr 2>&1 | tail -5`
Expected: compile FAILURE (functions not found).

- [ ] **Step 3: Implement the parsers**

In `cli_impl/mod.rs` (needs `use std::collections::HashMap;` if not already imported in scope):

```rust
/// Parse `git cat-file --batch` output into one entry per requested object,
/// in request order: `Some(bytes)` for a found object, `None` for one git
/// could not resolve ("<input> missing" and similar). Byte-exact: the
/// framing declares byte counts, which is why this parses RAW stdout
/// (`run_with_stdin_bytes`) - the runner's lossy UTF-8 String would shift
/// them. Returns `None` on a framing violation (fail closed).
pub fn parse_cat_file_batch(out: &[u8]) -> Option<Vec<Option<Vec<u8>>>> {
    let mut entries = Vec::new();
    let mut i = 0usize;
    while i < out.len() {
        let nl = out[i..].iter().position(|&b| b == b'\n')? + i;
        let header = std::str::from_utf8(&out[i..nl]).ok()?;
        i = nl + 1;
        // A found object's header is "<oid> <type> <size>"; anything whose
        // last token isn't a number ("<input> missing", "... ambiguous") is
        // an unresolvable request.
        let Some(size) = header.rsplit(' ').next().and_then(|t| t.parse::<usize>().ok())
        else {
            entries.push(None);
            continue;
        };
        if i + size > out.len() {
            return None;
        }
        entries.push(Some(out[i..i + size].to_vec()));
        i += size;
        // LF terminator after the contents.
        if out.get(i) == Some(&b'\n') {
            i += 1;
        }
    }
    Some(entries)
}

/// Parse `git check-attr -z --stdin text eol` output (path NUL attr NUL
/// value NUL triples) into per-path line-ending attributes: the `text`
/// attribute plus whether an `eol=` attribute applies. Output shape is
/// validated against the real binary in git_flows.rs.
pub fn parse_check_attr_z(stdout: &str) -> HashMap<String, (EolTextAttr, bool)> {
    let mut map: HashMap<String, (EolTextAttr, bool)> = HashMap::new();
    let mut it = stdout.split('\0');
    while let (Some(path), Some(attr), Some(value)) = (it.next(), it.next(), it.next()) {
        if path.is_empty() {
            break;
        }
        let entry = map
            .entry(path.to_string())
            .or_insert((EolTextAttr::Unspecified, false));
        match attr {
            "text" => {
                entry.0 = match value {
                    "set" => EolTextAttr::Set,
                    "unset" => EolTextAttr::Unset,
                    "auto" => EolTextAttr::Auto,
                    _ => EolTextAttr::Unspecified,
                };
            }
            "eol" => entry.1 = value != "unspecified" && value != "unset",
            _ => {}
        }
    }
    map
}
```

- [ ] **Step 4: Implement `run_with_stdin_bytes`**

In `runner.rs`, add after `RunOutput` (~line 63):

```rust
/// Like `RunOutput`, but with raw stdout bytes - for commands whose output
/// is byte-size framed (`cat-file --batch`), where the lossy UTF-8
/// conversion of `RunOutput.stdout` would corrupt the declared byte counts.
#[derive(Debug, Clone)]
pub struct RunOutputBytes {
    pub stdout: Vec<u8>,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub success: bool,
    pub duration_ms: u64,
}
```

Add the method after `run_with_stdin`, mirroring its body exactly (readers spawned before the stdin write, stdin dropped for EOF, `log_invocation` at the end) with two differences: stdout is collected via `read_to_end` into a `Vec<u8>`, and the result is a `RunOutputBytes`:

```rust
    /// `run_with_stdin` with RAW stdout bytes (see `RunOutputBytes`). Used by
    /// `cat-file --batch`, whose output frames blob contents by byte count.
    pub async fn run_with_stdin_bytes(
        &self,
        args: &[&str],
        stdin_data: &str,
    ) -> Result<RunOutputBytes, RunnerError> {
        use tokio::io::AsyncWriteExt;

        let started = Instant::now();
        let mut cmd = self.build_command(args);
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = cmd.spawn().map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                RunnerError::GitNotFound(self.git_path.clone())
            } else {
                RunnerError::Spawn(e)
            }
        })?;

        let mut stdin = child.stdin.take().expect("stdin piped");
        let stdout = child.stdout.take().expect("stdout piped");
        let stderr = child.stderr.take().expect("stderr piped");

        let stdout_task = tokio::spawn(async move {
            use tokio::io::AsyncReadExt;
            let mut buf = Vec::new();
            let mut reader = stdout;
            let _ = reader.read_to_end(&mut buf).await;
            buf
        });
        let stderr_task = tokio::spawn(read_to_string(stderr));

        stdin.write_all(stdin_data.as_bytes()).await.map_err(RunnerError::Io)?;
        drop(stdin);

        let status = child.wait().await.map_err(RunnerError::Io)?;
        let stdout = stdout_task.await.unwrap_or_default();
        let stderr = stderr_task.await.unwrap_or_default();

        log_invocation(self.cwd.as_deref(), args, started, status.code(), status.success(), &stderr);

        Ok(RunOutputBytes {
            stdout,
            stderr,
            exit_code: status.code(),
            success: status.success(),
            duration_ms: started.elapsed().as_millis() as u64,
        })
    }
```

NOTE: copy the tail of the real `run_with_stdin` when writing this; if its final section differs from the above (extra logging, cancellation hooks), mirror the real code, not this snippet.

Re-export from `lib.rs`: add `parse_cat_file_batch, parse_check_attr_z` to the cli_impl re-export list and `RunOutputBytes` next to wherever `RunOutput` is re-exported (check `lib.rs`; `runner::RunOutput` is already public via `pub use`).

- [ ] **Step 5: Run tests + full core build**

Run: `cargo test -p legit-core parse_cat_file parse_check_attr && cargo build -p legit-core`
Expected: 3 tests PASS, clean build.

Do NOT commit (user rule).

---

### Task 3: Real-git validation of the encoded assumptions

Per the project rule: assumptions about git behaviour live in `tests/git_flows.rs`, not in comments. The auto-stash bug happened because this step was skipped. **If any assertion here fails, fix the Task 1/2 logic to match real git, not the test.**

**Files:**
- Modify: `crates/legit-core/tests/git_flows.rs` (new tests at the end; uses the existing `TestRepo` helper which pins `core.autocrlf=false`)

**Interfaces:**
- Consumes: `TestRepo::{init, git, write}`, `GitRunner::{run_with_stdin, run_with_stdin_bytes}`, Task 1 + Task 2 functions (import them in the existing `use legit_core::{...}` block: `checkin_normalizes, classify_line_endings, classify_line_endings_normalized, parse_autocrlf, parse_cat_file_batch, parse_check_attr_z, AutocrlfSetting, EolTextAttr, LineEndingKind`).
- Produces: confidence; nothing consumed downstream.

- [ ] **Step 1: Write the tests**

```rust
/// `cat-file --batch` resolves `:path` (index) and `HEAD:path` specs and
/// reports unresolvable ones - the framing our batch parser encodes.
#[tokio::test]
async fn cat_file_batch_resolves_index_and_head_specs() {
    let repo = TestRepo::init().await;
    repo.write("a.txt", "one\ntwo\n");
    repo.git(&["add", "a.txt"]).await;
    repo.git(&["commit", "-m", "init"]).await;
    repo.write("a.txt", "one\r\ntwo\r\n");
    repo.git(&["add", "a.txt"]).await;

    let runner = GitRunner::for_repo("git", &repo.path);
    let out = runner
        .run_with_stdin_bytes(&["cat-file", "--batch"], ":a.txt\nHEAD:a.txt\n:gone.txt\n")
        .await
        .expect("spawn");
    let parsed = parse_cat_file_batch(&out.stdout).expect("framing");
    assert_eq!(parsed.len(), 3);
    assert_eq!(parsed[0].as_deref(), Some(b"one\r\ntwo\r\n".as_slice()));
    assert_eq!(parsed[1].as_deref(), Some(b"one\ntwo\n".as_slice()));
    assert_eq!(parsed[2], None);
}

/// `check-attr -z --stdin text eol` emits path NUL attr NUL value NUL
/// triples with the values our parser encodes.
#[tokio::test]
async fn check_attr_z_output_shape() {
    let repo = TestRepo::init().await;
    repo.write(
        ".gitattributes",
        "set.txt text\nbin.dat -text\nauto.txt text=auto\nforced.txt eol=lf\n",
    );
    let runner = GitRunner::for_repo("git", &repo.path);
    let out = runner
        .run_with_stdin(
            &["check-attr", "-z", "--stdin", "text", "eol"],
            "set.txt\0bin.dat\0auto.txt\0forced.txt\0plain.txt\0",
        )
        .await
        .expect("spawn");
    assert!(out.success, "{}", out.stderr);
    let map = parse_check_attr_z(&out.stdout);
    assert_eq!(map["set.txt"], (EolTextAttr::Set, false));
    assert_eq!(map["bin.dat"], (EolTextAttr::Unset, false));
    assert_eq!(map["auto.txt"], (EolTextAttr::Auto, false));
    assert_eq!(map["forced.txt"], (EolTextAttr::Unspecified, true));
    assert_eq!(map["plain.txt"], (EolTextAttr::Unspecified, false));
}

/// The check-in normalization rules encoded in `checkin_normalizes` match
/// what `git add` actually stages, per scenario. For each: configure, write,
/// add, then compare the staged blob's classification with our prediction.
#[tokio::test]
async fn checkin_kind_matches_real_git() {
    // (autocrlf, content, expected staged kind for a FIRST add - no index blob)
    let cases: &[(&str, &str, LineEndingKind)] = &[
        ("false", "a\r\nb\r\n", LineEndingKind::Crlf), // no policy: raw CRLF staged
        ("true", "a\r\nb\r\n", LineEndingKind::Lf),    // autocrlf=true normalizes
        ("input", "a\r\nb\r\n", LineEndingKind::Lf),   // input too
        ("true", "a\rb\r", LineEndingKind::Cr),        // lone CR never converted
        ("true", "a\nb\n", LineEndingKind::Lf),        // LF stays LF
    ];
    for (i, (autocrlf, content, expected)) in cases.iter().enumerate() {
        let repo = TestRepo::init().await;
        repo.git(&["config", "core.autocrlf", autocrlf]).await;
        let name = format!("f{i}.txt");
        repo.write(&name, content);
        repo.git(&["add", &name]).await;
        let staged = repo.git(&["show", &format!(":{name}")]).await;
        assert_eq!(
            classify_line_endings(&staged),
            *expected,
            "case {i}: autocrlf={autocrlf} content={content:?}"
        );
        // And our prediction agrees.
        let raw = classify_line_endings(content);
        let normalizes = checkin_normalizes(
            EolTextAttr::Unspecified,
            false,
            parse_autocrlf(autocrlf),
            raw,
            None,
        );
        let predicted = if normalizes {
            classify_line_endings_normalized(content)
        } else {
            raw
        };
        assert_eq!(predicted, *expected, "prediction diverges in case {i}");
    }
}

/// The auto-mode exemption: a file already committed with CRLF is NOT
/// renormalized by autocrlf=true on a later add - while an explicit `text`
/// attribute DOES renormalize it. Both encoded in `checkin_normalizes`.
#[tokio::test]
async fn committed_crlf_not_renormalized_under_auto() {
    let repo = TestRepo::init().await;
    repo.write("f.txt", "a\r\nb\r\n");
    repo.git(&["add", "f.txt"]).await;
    repo.git(&["commit", "-m", "crlf blob"]).await;

    // Auto mode: modify, re-add - the staged blob keeps CRLF.
    repo.git(&["config", "core.autocrlf", "true"]).await;
    repo.write("f.txt", "a\r\nb\r\nc\r\n");
    repo.git(&["add", "f.txt"]).await;
    let staged = repo.git(&["show", ":f.txt"]).await;
    assert_eq!(classify_line_endings(&staged), LineEndingKind::Crlf);
    assert!(!checkin_normalizes(
        EolTextAttr::Unspecified,
        false,
        AutocrlfSetting::True,
        LineEndingKind::Crlf,
        Some(LineEndingKind::Crlf),
    ));

    // Explicit text attr: the same add DOES normalize.
    repo.write(".gitattributes", "f.txt text\n");
    repo.write("f.txt", "a\r\nb\r\nc\r\nd\r\n");
    repo.git(&["add", "f.txt"]).await;
    let staged = repo.git(&["show", ":f.txt"]).await;
    assert_eq!(classify_line_endings(&staged), LineEndingKind::Lf);
    assert!(checkin_normalizes(
        EolTextAttr::Set,
        false,
        AutocrlfSetting::True,
        LineEndingKind::Crlf,
        Some(LineEndingKind::Crlf),
    ));
}
```

- [ ] **Step 2: Run the new tests**

Run: `cargo test -p legit-core --test git_flows cat_file_batch check_attr_z checkin_kind committed_crlf`
Expected: 4 tests PASS. If a real-git assertion fails, adjust `checkin_normalizes` / the parsers until real git agrees, then re-run Task 1/2 unit tests too.

Do NOT commit (user rule).

---

### Task 4: `repo_line_ending_status` command

**Files:**
- Modify: `crates/legit-core/src/types.rs` (two new IPC types after `LineEndingKind`, ~line 240)
- Modify: `crates/legit-core/src/cli_impl/mod.rs` (pure `derive_line_ending_entry` + tests)
- Modify: `crates/legit-core/src/lib.rs` (re-export `derive_line_ending_entry`; types are under `types::`)
- Modify: `src-tauri/src/commands/line_endings.rs` (the command + a `read_capped_bytes` helper)
- Modify: `src-tauri/src/lib.rs` (register `commands::repo_line_ending_status` next to line 68)

**Interfaces:**
- Consumes: Tasks 1-2 functions, `session.backend.status()` (`Vec<FileStatus>`), `GitRunner::{run, run_with_stdin, run_with_stdin_bytes}`, `MAX_LINE_ENDING_BYTES`, `resolve_repo_relative`.
- Produces (used by Tasks 6-9, exact serde shape):
  - `LineEndingTransition { from: LineEndingKind, to: LineEndingKind }`
  - `LineEndingStatusEntry { path: String, unstaged: Option<LineEndingTransition>, staged: Option<LineEndingTransition>, mixed: bool, working_raw: Option<LineEndingKind> }`
  - Tauri command `repo_line_ending_status(repo_id: String) -> Vec<LineEndingStatusEntry>` (an entry for EVERY classifiable changed file, noteworthy or not - the Diff header needs `working_raw` for passive labels; the list filters client-side)

- [ ] **Step 1: Add the IPC types**

In `types.rs` after `LineEndingKind`:

```rust
/// A line-ending change between two sides of a changed file (old -> new).
/// Backs the Working Changes chips and the commit warning.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct LineEndingTransition {
    pub from: LineEndingKind,
    pub to: LineEndingKind,
}

/// Line-ending summary for one changed file (`repo_line_ending_status`).
/// `unstaged` compares the index against what `git add` would store
/// (check-in normalization applied - policy-aware, so autocrlf conversions
/// are not flagged); `staged` compares HEAD against the index: exactly what
/// a commit records, immune to autocrlf by construction.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct LineEndingStatusEntry {
    pub path: String,
    pub unstaged: Option<LineEndingTransition>,
    pub staged: Option<LineEndingTransition>,
    /// The working file has mixed CRLF+LF endings.
    pub mixed: bool,
    /// Raw on-disk kind of the working file - the chip label never lies
    /// about disk state. `None` when there is no readable working side.
    pub working_raw: Option<LineEndingKind>,
}
```

- [ ] **Step 2: Write the failing derivation tests**

In the `cli_impl/mod.rs` test module:

```rust
#[test]
fn derive_line_ending_entry_transitions() {
    use AutocrlfSetting as A;
    use EolTextAttr as T;
    use LineEndingKind as K;
    let d = |working: Option<&[u8]>, index: Option<&[u8]>, head: Option<&[u8]>, a: A| {
        derive_line_ending_entry("f.txt", working, index, head, T::Unspecified, false, a)
    };
    // Plain flip, no policy: index LF, working CRLF -> unstaged LF->CRLF.
    let e = d(Some(b"a\r\nb\r\n"), Some(b"a\nb\n"), Some(b"a\nb\n"), A::False);
    assert_eq!(e.unstaged, Some(LineEndingTransition { from: K::Lf, to: K::Crlf }));
    assert_eq!(e.staged, None);
    assert_eq!(e.working_raw, Some(K::Crlf));
    assert!(!e.mixed);
    // Same bytes under autocrlf=true: the CRLF is policy, no transition.
    let e = d(Some(b"a\r\nb\r\n"), Some(b"a\nb\n"), Some(b"a\nb\n"), A::True);
    assert_eq!(e.unstaged, None);
    assert_eq!(e.working_raw, Some(K::Crlf)); // label still shows disk truth
    // Staged flip: HEAD LF vs index CRLF -> staged LF->CRLF.
    let e = d(Some(b"a\r\n"), Some(b"a\r\n"), Some(b"a\n"), A::False);
    assert_eq!(e.staged, Some(LineEndingTransition { from: K::Lf, to: K::Crlf }));
    // Newly mixed staged counts as a transition.
    let e = d(None, Some(b"a\r\nb\n"), Some(b"a\nb\n"), A::False);
    assert_eq!(e.staged, Some(LineEndingTransition { from: K::Lf, to: K::Mixed }));
    // Mixed working file flags `mixed`.
    let e = d(Some(b"a\r\nb\n"), Some(b"a\r\nb\n"), None, A::False);
    assert!(e.mixed);
    // Untracked (no index/HEAD): no transitions, raw label only.
    let e = d(Some(b"a\r\n"), None, None, A::False);
    assert_eq!(e.unstaged, None);
    assert_eq!(e.staged, None);
    assert_eq!(e.working_raw, Some(K::Crlf));
    // A side with no line breaks never forms a transition.
    let e = d(Some(b"one line"), Some(b"a\n"), None, A::False);
    assert_eq!(e.unstaged, None);
}
```

Run: `cargo test -p legit-core derive_line_ending 2>&1 | tail -5` - expected compile FAILURE.

- [ ] **Step 3: Implement the pure derivation**

In `cli_impl/mod.rs`:

```rust
/// Kinds that can appear in a transition chip: an actual line-ending style.
fn transitionable(kind: LineEndingKind) -> bool {
    matches!(
        kind,
        LineEndingKind::Lf | LineEndingKind::Crlf | LineEndingKind::Cr | LineEndingKind::Mixed
    )
}

fn transition_between(
    from: Option<LineEndingKind>,
    to: Option<LineEndingKind>,
) -> Option<LineEndingTransition> {
    let (from, to) = (from?, to?);
    (transitionable(from) && transitionable(to) && from != to)
        .then_some(LineEndingTransition { from, to })
}

/// Assemble one changed file's line-ending summary from its (optional)
/// sides. Pure: the `repo_line_ending_status` command only does IO around
/// this. `working`/`index`/`head` are the raw bytes of each side, `None`
/// when that side is missing, unreadable, oversized, or binary-skipped.
pub fn derive_line_ending_entry(
    path: &str,
    working: Option<&[u8]>,
    index: Option<&[u8]>,
    head: Option<&[u8]>,
    text_attr: EolTextAttr,
    eol_attr_set: bool,
    autocrlf: AutocrlfSetting,
) -> LineEndingStatusEntry {
    let classify = |b: &[u8]| classify_line_endings(&String::from_utf8_lossy(b));
    let index_kind = index.map(classify);
    let head_kind = head.map(classify);
    let working_raw = working.map(classify);

    // What `git add` would store for the working file (the policy-aware side).
    let checkin = working.map(|b| {
        let text = String::from_utf8_lossy(b);
        let raw = classify_line_endings(&text);
        if checkin_normalizes(text_attr, eol_attr_set, autocrlf, raw, index_kind) {
            classify_line_endings_normalized(&text)
        } else {
            raw
        }
    });

    LineEndingStatusEntry {
        path: path.to_string(),
        unstaged: transition_between(index_kind, checkin),
        staged: transition_between(head_kind, index_kind),
        mixed: working.and_then(mixed_endings_in_bytes).unwrap_or(false),
        working_raw,
    }
}
```

Add `LineEndingTransition, LineEndingStatusEntry` to the `use crate::types::{...}` in `cli_impl/mod.rs`, re-export `derive_line_ending_entry` from `lib.rs`.

Run: `cargo test -p legit-core derive_line_ending` - expected PASS.

- [ ] **Step 4: Implement the command**

In `src-tauri/src/commands/line_endings.rs` (extend the existing `use legit_core::{...}` with `derive_line_ending_entry, parse_autocrlf, parse_cat_file_batch, parse_check_attr_z, AutocrlfSetting, EolTextAttr`; add `use legit_core::types::{FileState, LineEndingStatusEntry};` and `use std::collections::{HashMap, HashSet};`):

```rust
/// Line-ending summary for every changed file - drives the Working Changes
/// chips, the Diff/Merge working-vs-index badges, and the commit warning.
/// Fixed subprocess budget regardless of file count: status (via the
/// backend), one `config --get`, one `check-attr --stdin`, one
/// `cat-file --batch`; working files are read from disk. Every classifiable
/// changed file gets an entry (the Diff header wants `working_raw` even
/// when nothing is noteworthy); consumers filter for attention client-side.
#[tauri::command]
#[specta::specta]
pub async fn repo_line_ending_status(
    state: tauri::State<'_, AppState>,
    repo_id: String,
) -> Result<Vec<LineEndingStatusEntry>, AppError> {
    let session = state.get_session(&repo_id).await?;
    let runner = session.runner.read().await.clone();

    let statuses = session.backend.status().await.map_err(AppError::Git)?;
    // One record per path (a partially-staged file appears twice in status);
    // submodules and ignored files have no blob content of their own.
    let mut paths: Vec<String> = Vec::new();
    let mut untracked: HashSet<String> = HashSet::new();
    let mut seen: HashSet<String> = HashSet::new();
    for s in &statuses {
        if matches!(
            s.state,
            FileState::SubmoduleChanged | FileState::SubmoduleDirty | FileState::Ignored
        ) {
            continue;
        }
        let path = s.path.to_string_lossy().into_owned();
        if s.state == FileState::Untracked {
            untracked.insert(path.clone());
        }
        if seen.insert(path.clone()) {
            paths.push(path);
        }
    }
    if paths.is_empty() {
        return Ok(vec![]);
    }

    // Resolved core.autocrlf (exit 1 + empty stdout when unset = False).
    let autocrlf: AutocrlfSetting = match runner.run(&["config", "--get", "core.autocrlf"]).await {
        Ok(o) => parse_autocrlf(&o.stdout),
        Err(_) => AutocrlfSetting::False,
    };

    // text/eol attributes for all changed paths in one call.
    let attr_stdin: String = paths.iter().map(|p| format!("{p}\0")).collect();
    let attrs: HashMap<String, (EolTextAttr, bool)> = match runner
        .run_with_stdin(&["check-attr", "-z", "--stdin", "text", "eol"], &attr_stdin)
        .await
    {
        Ok(o) if o.success => parse_check_attr_z(&o.stdout),
        _ => HashMap::new(),
    };

    // Index and HEAD blobs for every tracked changed path, one subprocess.
    // Request order mirrors `paths` so the results zip back positionally.
    let tracked: Vec<&String> = paths.iter().filter(|p| !untracked.contains(*p)).collect();
    let mut blobs: HashMap<&str, (Option<Vec<u8>>, Option<Vec<u8>>)> = HashMap::new();
    if !tracked.is_empty() {
        let stdin: String = tracked
            .iter()
            .map(|p| format!(":{p}\nHEAD:{p}\n"))
            .collect();
        if let Ok(out) = runner.run_with_stdin_bytes(&["cat-file", "--batch"], &stdin).await {
            if let Some(parsed) = parse_cat_file_batch(&out.stdout) {
                if parsed.len() == tracked.len() * 2 {
                    let mut it = parsed.into_iter();
                    for p in &tracked {
                        let index = it.next().flatten().filter(|b| b.len() <= MAX_LINE_ENDING_BYTES);
                        let head = it.next().flatten().filter(|b| b.len() <= MAX_LINE_ENDING_BYTES);
                        blobs.insert(p.as_str(), (index, head));
                    }
                }
            }
        }
    }

    let mut entries: Vec<LineEndingStatusEntry> = Vec::with_capacity(paths.len());
    for path in &paths {
        let working = match resolve_repo_relative(&session.path, path) {
            Ok(abs) => read_capped_bytes(&abs).await,
            Err(_) => None,
        };
        let (index, head) = blobs.get(path.as_str()).cloned().unwrap_or((None, None));
        let (text_attr, eol_set) = attrs
            .get(path)
            .copied()
            .unwrap_or((EolTextAttr::Unspecified, false));
        entries.push(derive_line_ending_entry(
            path,
            working.as_deref(),
            index.as_deref(),
            head.as_deref(),
            text_attr,
            eol_set,
            autocrlf,
        ));
    }
    Ok(entries)
}

/// Read a working-tree file's raw bytes for line-ending classification;
/// `None` if missing, unreadable, or over the size cap (byte-level sibling
/// of `read_capped_text`).
async fn read_capped_bytes(abs: &Path) -> Option<Vec<u8>> {
    let meta = tokio::fs::metadata(abs).await.ok()?;
    if meta.len() > MAX_LINE_ENDING_BYTES as u64 {
        return None;
    }
    tokio::fs::read(abs).await.ok()
}
```

Register in `src-tauri/src/lib.rs` `collect_commands!`, after `commands::repo_revert_line_endings` (line 69):

```rust
        commands::repo_line_ending_status,
```

- [ ] **Step 5: Build and end-to-end test against real git**

Run: `cargo build -p legit-app 2>&1 | tail -5`
Expected: clean build.

Add one integration test to `git_flows.rs` exercising the derivation over a real repo end-to-end at the parser level (the Tauri command itself is thin IO; its pieces are all covered):

```rust
/// End-to-end: a real repo where one file flips endings unstaged, one is
/// staged with a flip, one is policy-converted (autocrlf) and must NOT be
/// flagged. Exercises the same call sequence the command runs.
#[tokio::test]
async fn line_ending_status_pipeline_against_real_repo() {
    let repo = TestRepo::init().await;
    repo.write("flip.txt", "a\nb\n");
    repo.write("staged.txt", "a\nb\n");
    repo.git(&["add", "."]).await;
    repo.git(&["commit", "-m", "init"]).await;
    repo.write("flip.txt", "a\r\nb\r\n"); // unstaged CRLF flip
    repo.write("staged.txt", "a\r\nb\r\n");
    repo.git(&["add", "staged.txt"]).await; // staged CRLF flip

    let runner = GitRunner::for_repo("git", &repo.path);
    let blobs = runner
        .run_with_stdin_bytes(
            &["cat-file", "--batch"],
            ":flip.txt\nHEAD:flip.txt\n:staged.txt\nHEAD:staged.txt\n",
        )
        .await
        .expect("spawn");
    let parsed = parse_cat_file_batch(&blobs.stdout).expect("framing");

    let flip = derive_line_ending_entry(
        "flip.txt",
        Some(b"a\r\nb\r\n"),
        parsed[0].as_deref(),
        parsed[1].as_deref(),
        EolTextAttr::Unspecified,
        false,
        AutocrlfSetting::False,
    );
    assert_eq!(
        flip.unstaged,
        Some(LineEndingTransition { from: LineEndingKind::Lf, to: LineEndingKind::Crlf })
    );
    assert_eq!(flip.staged, None);

    let staged = derive_line_ending_entry(
        "staged.txt",
        Some(b"a\r\nb\r\n"),
        parsed[2].as_deref(),
        parsed[3].as_deref(),
        EolTextAttr::Unspecified,
        false,
        AutocrlfSetting::False,
    );
    assert_eq!(
        staged.staged,
        Some(LineEndingTransition { from: LineEndingKind::Lf, to: LineEndingKind::Crlf })
    );
    assert_eq!(staged.unstaged, None); // working matches index
}
```

(`LineEndingTransition` needs importing from `legit_core::types` in git_flows.rs; check how sibling types like `FileState` are imported there and follow suit.)

Run: `cargo test -p legit-core --test git_flows line_ending_status_pipeline`
Expected: PASS.

Do NOT commit (user rule).

---

### Task 5: Settings plumbing (backend + frontend)

Two settings mirroring `warn_on_mixed_endings` exactly: global default true, per-repo `Option<bool>` override.

**Files:**
- Modify: `src-tauri/src/state.rs` (GlobalSettings ~line 190, its `Default` impl ~line 302, RepoSettings ~line 369)
- Modify: `src-tauri/src/commands/persistence.rs` (two setters after `set_warn_on_mixed_endings`, line 146)
- Modify: `src-tauri/src/lib.rs` (register both setters next to `commands::set_warn_on_mixed_endings`, line 102)
- Modify: `src/lib/types.ts` (GlobalSettings ~line 31, RepoSettings ~line 78)
- Modify: `src/lib/commands.ts` (two wrappers after `setWarnOnMixedEndings`, line 204)
- Modify: `src/panels/Settings/GlobalSettingsPanel.tsx` (new section next to `MixedEndingDetectionSection`, registered ~line 99)
- Modify: `src/panels/Settings/RepoSettingsPanel.tsx` (new override section next to `MixedEndingRepoSection`, registered ~line 114)

**Interfaces:**
- Produces (used by Tasks 8-9):
  - GlobalSettings fields `line_ending_chips_in_changes: bool`, `warn_on_line_ending_commit: bool` (serde default true)
  - RepoSettings fields `line_ending_chips_in_changes: Option<bool>`, `warn_on_line_ending_commit: Option<bool>`
  - Commands `set_line_ending_chips_in_changes(enabled: bool)`, `set_warn_on_line_ending_commit(warn: bool)`
  - Frontend wrappers `setLineEndingChipsInChanges(enabled)`, `setWarnOnLineEndingCommit(warn)`

- [ ] **Step 1: Backend settings fields**

`state.rs` GlobalSettings (after `warn_on_mixed_endings`, line 190; `default_true` already exists):

```rust
    /// Attention-only line-ending chips on Working Changes rows; per-repo
    /// settings can override.
    #[serde(default = "default_true")]
    pub line_ending_chips_in_changes: bool,
    /// Warn before committing staged line-ending changes; per-repo override.
    #[serde(default = "default_true")]
    pub warn_on_line_ending_commit: bool,
```

`Default for GlobalSettings` (line ~302, after `warn_on_mixed_endings: true`):

```rust
            line_ending_chips_in_changes: true,
            warn_on_line_ending_commit: true,
```

RepoSettings (after `warn_on_mixed_endings`, line 369; struct already has `#[serde(default)]`):

```rust
    /// Per-repo override for the Working Changes line-ending chips
    /// (None = inherit global).
    pub line_ending_chips_in_changes: Option<bool>,
    /// Per-repo override for the commit line-ending warning
    /// (None = inherit global).
    pub warn_on_line_ending_commit: Option<bool>,
```

`persistence.rs`, after `set_warn_on_mixed_endings`:

```rust
#[tauri::command]
#[specta::specta]
pub async fn set_line_ending_chips_in_changes(
    state: tauri::State<'_, AppState>,
    enabled: bool,
) -> Result<(), AppError> {
    state.mutate_global(|s| {
        s.line_ending_chips_in_changes = enabled;
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn set_warn_on_line_ending_commit(
    state: tauri::State<'_, AppState>,
    warn: bool,
) -> Result<(), AppError> {
    state.mutate_global(|s| {
        s.warn_on_line_ending_commit = warn;
    })
    .await
}
```

Register both in `lib.rs` `collect_commands!` after `commands::set_warn_on_mixed_endings`.

Run: `cargo build -p legit-app 2>&1 | tail -3` - expected clean.

- [ ] **Step 2: Frontend types + wrappers**

`src/lib/types.ts` GlobalSettings (after `warn_on_mixed_endings?: boolean;`):

```ts
  /** Attention-only line-ending chips on Working Changes rows (default true). */
  line_ending_chips_in_changes?: boolean;
  /** Warn before committing staged line-ending changes (default true). */
  warn_on_line_ending_commit?: boolean;
```

RepoSettings (after `warn_on_mixed_endings: boolean | null;`):

```ts
  /** Per-repo override for the Working Changes chips (null = inherit). */
  line_ending_chips_in_changes?: boolean | null;
  /** Per-repo override for the commit warning (null = inherit). */
  warn_on_line_ending_commit?: boolean | null;
```

`src/lib/commands.ts` (after `setWarnOnMixedEndings`):

```ts
export const setLineEndingChipsInChanges = (enabled: boolean) =>
  invoke<null>("set_line_ending_chips_in_changes", { enabled });

export const setWarnOnLineEndingCommit = (warn: boolean) =>
  invoke<null>("set_warn_on_line_ending_commit", { warn });
```

- [ ] **Step 3: Global settings UI**

In `GlobalSettingsPanel.tsx`, add a component next to `MixedEndingDetectionSection` (same file, same style) and render it directly after `<MixedEndingDetectionSection />` (line 99). Import the two new command wrappers.

```tsx
function LineEndingChangesSection() {
  const chips = useSettingsStore((s) => s.settings?.line_ending_chips_in_changes ?? true);
  const warn = useSettingsStore((s) => s.settings?.warn_on_line_ending_commit ?? true);
  const [saving, setSaving] = useState(false);

  const toggle = async (key: "chips" | "warn") => {
    setSaving(true);
    try {
      if (key === "chips") {
        await setLineEndingChipsInChanges(!chips);
        useSettingsStore.setState((s) =>
          s.settings ? { settings: { ...s.settings, line_ending_chips_in_changes: !chips } } : {}
        );
      } else {
        await setWarnOnLineEndingCommit(!warn);
        useSettingsStore.setState((s) =>
          s.settings ? { settings: { ...s.settings, warn_on_line_ending_commit: !warn } } : {}
        );
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Section title="Line ending changes">
      <FieldNote>writes to: global settings — default for all repos</FieldNote>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
        <input
          type="checkbox"
          id="global-eol-chips"
          checked={chips}
          onChange={() => toggle("chips")}
          disabled={saving}
        />
        <label htmlFor="global-eol-chips" style={{ fontSize: "var(--fz-lg)", cursor: "pointer" }}>
          Show line-ending change chips on Working Changes files
        </label>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
        <input
          type="checkbox"
          id="global-eol-warn"
          checked={warn}
          onChange={() => toggle("warn")}
          disabled={saving}
        />
        <label htmlFor="global-eol-warn" style={{ fontSize: "var(--fz-lg)", cursor: "pointer" }}>
          Warn when committing files whose line endings change
        </label>
      </div>
    </Section>
  );
}
```

NOTE: the FieldNote copy above contains the section's standard em-dash used elsewhere in this file; match the existing FieldNote copy style exactly as found in the file (do not introduce new punctuation of your own).

- [ ] **Step 4: Repo settings override UI**

In `RepoSettingsPanel.tsx`, add next to `MixedEndingRepoSection` and render after it (line 114). It reuses the exact tri-state pattern, once per setting:

```tsx
function LineEndingChangesRepoSection({
  repoId,
  repoSettings,
}: {
  repoId: string;
  repoSettings: import("../../lib/types").RepoSettings | null;
}) {
  const globalChips = useSettingsStore((s) => s.settings?.line_ending_chips_in_changes ?? true);
  const globalWarn = useSettingsStore((s) => s.settings?.warn_on_line_ending_commit ?? true);
  const loadRepoSettings = useRepoStore((s) => s.loadRepoSettings);
  const [saving, setSaving] = useState(false);

  const setOverride = async (
    key: "line_ending_chips_in_changes" | "warn_on_line_ending_commit",
    value: boolean | null,
  ) => {
    if (!repoSettings) return;
    setSaving(true);
    try {
      await updateRepoSettings(repoId, { ...repoSettings, [key]: value });
      await loadRepoSettings(repoId);
    } finally {
      setSaving(false);
    }
  };

  const groups = [
    {
      key: "line_ending_chips_in_changes" as const,
      label: "Line-ending chips on Working Changes files",
      global: globalChips,
      override: repoSettings?.line_ending_chips_in_changes ?? null,
    },
    {
      key: "warn_on_line_ending_commit" as const,
      label: "Warn when committing line-ending changes",
      global: globalWarn,
      override: repoSettings?.warn_on_line_ending_commit ?? null,
    },
  ];

  return (
    <Section title="Line ending changes">
      <FieldNote>writes to: repos/&lt;hash&gt;/settings.json (this repo only)</FieldNote>
      {groups.map((g) => (
        <div key={g.key} style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
          <div style={{ fontSize: "var(--fz-md)" }}>{g.label}</div>
          {(["inherit", "on", "off"] as const).map((opt) => {
            const checked =
              opt === "inherit" ? g.override === null :
              opt === "on" ? g.override === true :
              g.override === false;
            return (
              <label key={opt} style={{ display: "flex", alignItems: "center", gap: 6, cursor: saving ? "default" : "pointer", opacity: saving ? 0.5 : 1 }}>
                <input
                  type="radio"
                  name={`repo-${g.key}-${repoId}`}
                  checked={checked}
                  disabled={saving}
                  onChange={() => setOverride(g.key, opt === "inherit" ? null : opt === "on")}
                />
                <span style={{ fontSize: "var(--fz-lg)" }}>
                  {opt === "inherit"
                    ? `Inherit from global (currently ${g.global ? "on" : "off"})`
                    : opt === "on" ? "On" : "Off"}
                </span>
              </label>
            );
          })}
        </div>
      ))}
    </Section>
  );
}
```

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit 2>&1 | tail -5` (from WSL)
Expected: no errors.

Do NOT commit (user rule).

---

### Task 6: Shared summary query + row-chip content helper

**Files:**
- Create: `src/panels/shared/lineEndingStatus.ts`
- Modify: `src/lib/types.ts` (mirror the two new IPC types near `LineEndingKind`, line 476)
- Modify: `src/lib/commands.ts` (wrapper near `repoLineEndingKind`, line 467)
- Test: `src/panels/shared/lineEndingStatus.test.ts` (vitest)

**Interfaces:**
- Consumes: Task 4's command; `LineEndingKind` type.
- Produces (used by Tasks 7-9):
  - types.ts: `LineEndingTransition { from: LineEndingKind; to: LineEndingKind }`, `LineEndingStatusEntry { path: string; unstaged: LineEndingTransition | null; staged: LineEndingTransition | null; mixed: boolean; working_raw: LineEndingKind | null }`
  - commands.ts: `repoLineEndingStatus(repoId: string): Promise<LineEndingStatusEntry[]>`
  - `useLineEndingStatusMap(repoId: string | undefined, enabled: boolean): Map<string, LineEndingStatusEntry>`
  - `rowChipContent(entry: LineEndingStatusEntry, side: "unstaged" | "staged"): { text: string; title: string; revertTarget: "lf" | "crlf" | "cr" | null } | null` (pure; null = no chip, attention-only)
  - `eolLabel(kind: LineEndingKind): string | null`

- [ ] **Step 1: Types + wrapper**

`src/lib/types.ts`, after `LineEndingKind` (line 476):

```ts
/** A line-ending change between two sides of a changed file (old -> new). */
export interface LineEndingTransition {
  from: LineEndingKind;
  to: LineEndingKind;
}

/** Line-ending summary for one changed file (`repo_line_ending_status`).
 * `unstaged` = index vs what `git add` would store (policy-aware);
 * `staged` = HEAD vs index (exactly what a commit records). */
export interface LineEndingStatusEntry {
  path: string;
  unstaged: LineEndingTransition | null;
  staged: LineEndingTransition | null;
  mixed: boolean;
  working_raw: LineEndingKind | null;
}
```

`src/lib/commands.ts`, after `repoLineEndingKind` (import `LineEndingStatusEntry` in the existing type-import block):

```ts
export const repoLineEndingStatus = (repoId: string) =>
  invoke<LineEndingStatusEntry[]>("repo_line_ending_status", { repoId });
```

- [ ] **Step 2: Write the failing vitest for the pure helper**

`src/panels/shared/lineEndingStatus.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { rowChipContent } from "./lineEndingStatus";
import type { LineEndingStatusEntry } from "../../lib/types";

const entry = (over: Partial<LineEndingStatusEntry>): LineEndingStatusEntry => ({
  path: "f.txt",
  unstaged: null,
  staged: null,
  mixed: false,
  working_raw: "lf",
  ...over,
});

describe("rowChipContent", () => {
  it("is attention-only: nothing for a clean entry", () => {
    expect(rowChipContent(entry({}), "unstaged")).toBeNull();
    expect(rowChipContent(entry({}), "staged")).toBeNull();
  });

  it("shows the transition for its own side only", () => {
    const e = entry({ unstaged: { from: "lf", to: "crlf" } });
    expect(rowChipContent(e, "unstaged")).toEqual({
      text: "LF→CRLF",
      title: "Line endings: LF → CRLF",
      revertTarget: "lf",
    });
    expect(rowChipContent(e, "staged")).toBeNull();
  });

  it("staged transitions never offer a revert (it rewrites the working file)", () => {
    const e = entry({ staged: { from: "crlf", to: "lf" } });
    expect(rowChipContent(e, "staged")).toEqual({
      text: "CRLF→LF",
      title: "Line endings: CRLF → LF",
      revertTarget: null,
    });
  });

  it("mixed working file gets a passive Mixed chip on the unstaged side", () => {
    const e = entry({ mixed: true, working_raw: "mixed" });
    expect(rowChipContent(e, "unstaged")).toEqual({
      text: "Mixed",
      title: "Line endings: Mixed",
      revertTarget: null,
    });
    expect(rowChipContent(e, "staged")).toBeNull();
  });

  it("a transition wins over the mixed flag", () => {
    const e = entry({ mixed: true, unstaged: { from: "crlf", to: "mixed" } });
    expect(rowChipContent(e, "unstaged")?.text).toBe("CRLF→Mixed");
    // `mixed` is not a concrete revert target.
    expect(rowChipContent(e, "unstaged")?.revertTarget).toBe("crlf");
  });
});
```

Run (PowerShell only, per project memory): `npm test -- lineEndingStatus` - expected FAIL (module missing). If no PowerShell access, note it and continue; Task 10 collects the vitest run.

- [ ] **Step 3: Implement**

`src/panels/shared/lineEndingStatus.ts`:

```ts
// Shared source of truth for "which changed files have noteworthy line
// endings": one batch query per repo (repo_line_ending_status), keyed under
// the status domain so the watcher and invalidateRepoDomains keep it fresh.
// The Working Changes row chips, the Diff/Merge working-vs-index badges,
// and the commit warning all read this map - list and diff can never
// disagree because they share one source.

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { repoLineEndingStatus } from "../../lib/commands";
import type { LineEndingKind, LineEndingStatusEntry } from "../../lib/types";

export function useLineEndingStatusMap(
  repoId: string | undefined,
  enabled: boolean,
): Map<string, LineEndingStatusEntry> {
  const { data } = useQuery<LineEndingStatusEntry[]>({
    queryKey: [repoId, "status", "line-endings"],
    queryFn: () => repoLineEndingStatus(repoId!),
    enabled: !!repoId && enabled,
    staleTime: 5_000,
  });
  return useMemo(() => new Map((data ?? []).map((e) => [e.path, e])), [data]);
}

/** Display label, or null for styles that shouldn't show a chip. */
export function eolLabel(kind: LineEndingKind | null | undefined): string | null {
  switch (kind) {
    case "lf": return "LF";
    case "crlf": return "CRLF";
    case "cr": return "CR";
    case "mixed": return "Mixed";
    default: return null; // none / binary / unknown
  }
}

const CONCRETE = new Set<LineEndingKind>(["lf", "crlf", "cr"]);

export interface RowChipContent {
  text: string;
  title: string;
  /** Concrete kind the revert action would rewrite to; null = passive chip. */
  revertTarget: "lf" | "crlf" | "cr" | null;
}

/**
 * Attention-only chip content for a Working Changes row: null unless the
 * side has a transition, or (unstaged side) the working file is mixed. The
 * revert action exists only for unstaged transitions from a concrete kind -
 * it rewrites the WORKING file, which cannot fix a staged blob.
 */
export function rowChipContent(
  entry: LineEndingStatusEntry,
  side: "unstaged" | "staged",
): RowChipContent | null {
  const t = side === "unstaged" ? entry.unstaged : entry.staged;
  if (t) {
    const from = eolLabel(t.from);
    const to = eolLabel(t.to);
    if (!from || !to) return null;
    const revertable = side === "unstaged" && CONCRETE.has(t.from);
    return {
      text: `${from}→${to}`,
      title: `Line endings: ${from} → ${to}`,
      revertTarget: revertable ? (t.from as "lf" | "crlf" | "cr") : null,
    };
  }
  if (side === "unstaged" && entry.mixed) {
    return { text: "Mixed", title: "Line endings: Mixed", revertTarget: null };
  }
  return null;
}
```

- [ ] **Step 4: Typecheck + vitest**

Run: `npx tsc --noEmit 2>&1 | tail -5` - expected clean.
Run (PowerShell when available): `npm test -- lineEndingStatus` - expected 5 tests PASS.

Do NOT commit (user rule).

---

### Task 7: Policy-aware diff/merge chips + shared revert chip

Rewire `useLineEndingChip`'s working-vs-index case onto the summary and extract the clickable revert chip so Task 8 can reuse it.

**Files:**
- Modify: `src/panels/shared/LineEndingBadge.tsx`

**Interfaces:**
- Consumes: `useLineEndingStatusMap`, `eolLabel`, `rowChipContent` (Task 6); existing `repoRevertLineEndings`, menu primitives.
- Produces (used by Task 8):
  - `export function RevertChipButton({ repoId, path, target, text, title, disabled }: { repoId: string; path: string; target: "lf" | "crlf" | "cr"; text: string; title: string; disabled?: boolean })` - the clickable chip with the confirm-gated revert menu; must be inside a `PanelContextMenuProvider`.
  - `LineEndingBadge` / `RevertableLineEndingBadge` keep their existing props and behaviour, except the `rev=null, oldRev=":"` pair is now summary-fed and policy-aware.

- [ ] **Step 1: Extract `RevertChipButton`**

Move the menu/confirm/revert logic out of `RevertableLineEndingBadge` into an exported component (same file). The revert invalidates `["status", "diff"]` as today, which also refreshes the summary (it lives under the status domain):

```tsx
/**
 * The clickable revert chip: opens a menu whose action rewrites the working
 * file's endings to `target` (content edits untouched). Destructive, so it
 * inline-confirms per the global setting. Must be rendered inside a
 * `PanelContextMenuProvider`. Shared by the Diff panel's unstaged badge and
 * the Working Changes row chips so the action cannot drift out of parity.
 */
export function RevertChipButton({
  repoId,
  path,
  target,
  text,
  title,
  disabled,
}: {
  repoId: string;
  path: string;
  target: "lf" | "crlf" | "cr";
  text: string;
  title: string;
  disabled?: boolean;
}) {
  const { openMenu, closeMenu } = usePanelContextMenu();
  const menuConfirm = useMenuConfirm();
  const confirmDestructive = useConfirmDestructive();
  const queryClient = useQueryClient();

  const targetLabel = target.toUpperCase();
  const doRevert = async () => {
    closeMenu();
    try {
      await repoRevertLineEndings(repoId, path, target);
      invalidateRepoDomains(queryClient, repoId, ["status", "diff"]);
    } catch (e) {
      notify.error(formatAppError(e));
    }
  };
  const requestRevert = () => {
    if (!confirmDestructive) {
      void doRevert();
      return;
    }
    menuConfirm(`Rewrite ${path} with ${targetLabel} line endings?`, () => void doRevert());
  };

  const section = (
    <>
      <SectionLabel>{title}</SectionLabel>
      <MenuItem disabled={disabled} onClick={requestRevert}>
        {confirmDestructive
          ? `Revert line endings to ${targetLabel}…`
          : `Revert line endings to ${targetLabel}`}
      </MenuItem>
    </>
  );

  return (
    <button
      type="button"
      title={`${title} — click to revert`}
      onClick={(e) => openMenu(e, section)}
      onContextMenu={(e) => openMenu(e, section)}
      style={{ ...chipStyle(true), background: "transparent", cursor: "pointer" }}
    >
      {text}
    </button>
  );
}
```

Rewrite `RevertableLineEndingBadge` to use it (identical rendered output to today):

```tsx
export function RevertableLineEndingBadge(props: BadgeProps & { disabled?: boolean }) {
  const chip = useLineEndingChip(props);
  if (!chip) return null;
  const revertable = chip.showArrow && isConcrete(chip.oldKind);
  if (!revertable) {
    return (
      <span title={chip.title} style={chipStyle(chip.attention)}>
        {chip.text}
      </span>
    );
  }
  return (
    <RevertChipButton
      repoId={props.repoId}
      path={props.path}
      target={chip.oldKind as "lf" | "crlf" | "cr"}
      text={chip.text}
      title={chip.title}
      disabled={props.disabled}
    />
  );
}
```

(Note: the old inline code used `chip.oldLabel` in the menu copy; `RevertChipButton` derives the label from `target` - same strings for lf/crlf/cr.)

- [ ] **Step 2: Make the working-vs-index pair summary-fed**

Replace `useLineEndingChip` with (keep the return shape so both badge components are untouched beyond Step 1):

```tsx
/** Both sides' kinds plus the derived chip content (null = no chip). */
function useLineEndingChip({ repoId, path, rev, oldRev }: BadgeProps) {
  const newRev = rev ?? null;
  // The working-vs-index pair (Diff unstaged header, Merge panel) reads the
  // batch summary: policy-aware (an autocrlf conversion is not an arrow) and
  // shared with the Working Changes chips, so list and diff always agree.
  // Every other pair compares git blobs, where policy is irrelevant - those
  // keep the per-file queries.
  const workingVsIndex = newRev === null && oldRev === ":";
  const summary = useLineEndingStatusMap(repoId, workingVsIndex);

  const { data: newKind } = useQuery<LineEndingKind>({
    queryKey: [repoId, newRev === null ? "status" : "log", "line-ending", path, newRev],
    queryFn: () => repoLineEndingKind(repoId, path, newRev),
    staleTime: 10_000,
    enabled: !workingVsIndex,
  });

  const hasOld = oldRev !== undefined;
  const oldSide = oldRev ?? null;
  const { data: oldKind } = useQuery<LineEndingKind>({
    queryKey: [repoId, oldSide === null ? "status" : "log", "line-ending-old", path, oldSide],
    queryFn: () => repoLineEndingKind(repoId, path, oldSide),
    enabled: hasOld && !workingVsIndex,
    staleTime: 10_000,
  });

  if (workingVsIndex) {
    const entry = summary.get(path);
    if (!entry) return null;
    const t = entry.unstaged;
    const fromLabel = t ? eolLabel(t.from) : null;
    const toLabel = t ? eolLabel(t.to) : null;
    if (t && fromLabel && toLabel) {
      // A real (policy-aware) transition: the arrow shows what a commit of
      // this file would do to the blob.
      return {
        newKind: entry.working_raw ?? undefined,
        oldKind: t.from,
        oldLabel: fromLabel,
        text: `${fromLabel}→${toLabel}`,
        title: `Line endings: ${fromLabel} → ${toLabel}`,
        attention: true,
        showArrow: true,
      };
    }
    // No transition: a passive label with the raw on-disk kind (the chip
    // never lies about disk state - on an autocrlf repo this shows CRLF
    // with no arrow).
    const rawLabel = eolLabel(entry.working_raw);
    if (!rawLabel) return null;
    return {
      newKind: entry.working_raw ?? undefined,
      oldKind: undefined,
      oldLabel: null,
      text: rawLabel,
      title: `Line endings: ${rawLabel}`,
      attention: entry.working_raw === "mixed",
      showArrow: false,
    };
  }

  const newLabel = labelFor(newKind);
  if (!newLabel) return null;
  const oldLabel = hasOld ? labelFor(oldKind) : null;
  const showArrow = !!oldLabel && oldLabel !== newLabel;
  return {
    newKind,
    oldKind,
    oldLabel,
    text: showArrow ? `${oldLabel}→${newLabel}` : newLabel,
    title: `Line endings: ${showArrow ? `${oldLabel} → ${newLabel}` : newLabel}`,
    attention: newKind === "mixed" || showArrow,
    showArrow,
  };
}
```

Imports to add: `useLineEndingStatusMap, eolLabel` from `./lineEndingStatus`. The local `labelFor` stays for the per-file path (or replace its uses with `eolLabel` and delete it - both accept `undefined`; prefer deleting the duplicate).

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit 2>&1 | tail -5` - expected clean.

Behavioural check happens in Task 10 (needs the running app).

Do NOT commit (user rule).

---

### Task 8: FileTree `renderBadge` + Working Changes row chips

**Files:**
- Modify: `src/panels/shared/FileTree/FileTree.tsx` (new prop + `FileRowView` slot)
- Modify: `src/panels/WorkingChanges/WorkingChangesPanel.tsx` (settings, summary map, `renderBadge` on both sections)
- Modify: `src/panels/shared/LineEndingBadge.tsx` (one small row-badge component)

**Interfaces:**
- Consumes: `rowChipContent`, `useLineEndingStatusMap` (Task 6), `RevertChipButton`, `chipStyle` (Task 7), settings fields (Task 5).
- Produces: `FileTree` prop `renderBadge?: (file: FileTreeEntry) => ReactNode` (always-visible, between filename and +/- counts); `LineEndingRowBadge` component.

- [ ] **Step 1: FileTree prop and slot**

In `FileTree.tsx`:

1. Add to `FileTreeProps` (after `renderActions`, line 46):

```tsx
  /**
   * Optional always-visible badge for a file row, rendered between the
   * filename and the +/- counts (unlike `renderActions`, which is
   * hover-only). Working Changes uses it for line-ending chips.
   */
  renderBadge?: (file: FileTreeEntry) => ReactNode;
```

2. Destructure `renderBadge` in the `FileTree` function signature (next to `renderActions`).

3. Pass it to `FileRowView` (line ~360): `badge={renderBadge ? renderBadge(row.file) : null}`.

4. In `FileRowView`, add `badge` to the props type (`badge?: ReactNode;`) and destructure it; render it directly BEFORE the counts `<span>` and make that span's `marginLeft` conditional:

```tsx
      {badge && (
        // A badge can be interactive (the revert chip): stop the row's
        // mousedown selection the same way the hover actions do.
        <span
          onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
          onClick={(e) => e.stopPropagation()}
          style={{ marginLeft: "auto", flexShrink: 0, display: "flex", alignItems: "center" }}
        >
          {badge}
        </span>
      )}

      <span
        style={{
          marginLeft: badge ? 0 : "auto",
          flexShrink: 0,
          fontFamily: "monospace",
          fontSize: "var(--fz-sm)",
        }}
      >
```

- [ ] **Step 2: Row badge component**

In `LineEndingBadge.tsx` (imports: `rowChipContent`, type `LineEndingStatusEntry`):

```tsx
/**
 * Working Changes row chip, fed from the batch summary entry (no queries -
 * the panel owns the map). Attention-only via `rowChipContent`; unstaged
 * transitions from a concrete kind are clickable (same revert menu as the
 * Diff chip), everything else is passive.
 */
export function LineEndingRowBadge({
  repoId,
  entry,
  side,
  disabled,
}: {
  repoId: string;
  entry: LineEndingStatusEntry;
  side: "unstaged" | "staged";
  disabled?: boolean;
}) {
  const chip = rowChipContent(entry, side);
  if (!chip) return null;
  if (chip.revertTarget) {
    return (
      <RevertChipButton
        repoId={repoId}
        path={entry.path}
        target={chip.revertTarget}
        text={chip.text}
        title={chip.title}
        disabled={disabled}
      />
    );
  }
  return (
    <span title={chip.title} style={chipStyle(true)}>
      {chip.text}
    </span>
  );
}
```

- [ ] **Step 3: Wire into WorkingChangesPanel**

Imports to add: `LineEndingRowBadge` from `../shared/LineEndingBadge`, `useLineEndingStatusMap` from `../shared/lineEndingStatus`.

After the existing settings reads (~line 162, next to `confirmDiscardEnabled`):

```tsx
  // Line-ending features: repo override else global (both default on).
  const chipsGlobal = useSettingsStore((s) => s.settings?.line_ending_chips_in_changes ?? true);
  const warnEolGlobal = useSettingsStore((s) => s.settings?.warn_on_line_ending_commit ?? true);
  const repoEolSettings = useRepoStore((s) => (repo ? s.repoSettings[repo.id] : undefined));
  const chipsEnabled = repoEolSettings?.line_ending_chips_in_changes ?? chipsGlobal;
  const warnEolCommit = repoEolSettings?.warn_on_line_ending_commit ?? warnEolGlobal;
```

After the status query (~line 260):

```tsx
  // Batch line-ending summary - drives the row chips and the commit
  // warning. Disabled entirely when both features are off.
  const eolMap = useLineEndingStatusMap(repo?.id, chipsEnabled || warnEolCommit);
```

On the UNSTAGED `<FileTree>` (after `renderActions`, ~line 886):

```tsx
              renderBadge={
                chipsEnabled
                  ? (f) => {
                      const entry = eolMap.get(f.path);
                      return entry ? (
                        <LineEndingRowBadge repoId={repo.id} entry={entry} side="unstaged" disabled={busy} />
                      ) : null;
                    }
                  : undefined
              }
```

On the STAGED `<FileTree>` (after `renderActions`, ~line 1016): same block with `side="staged"`.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit 2>&1 | tail -5` - expected clean.

Do NOT commit (user rule).

---

### Task 9: Commit warning

**Files:**
- Create: `src/panels/WorkingChanges/lineEndingWarning.ts`
- Test: `src/panels/WorkingChanges/lineEndingWarning.test.ts` (vitest, mirrors `sectionOrder.test.ts` style)
- Modify: `src/panels/WorkingChanges/WorkingChangesPanel.tsx` (gate + inline confirm box)

**Interfaces:**
- Consumes: `LineEndingStatusEntry` map (Task 8's `eolMap`), `warnEolCommit` (Task 8), `eolLabel` (Task 6).
- Produces:
  - `StagedEolChange { path: string; from: string; to: string }` (labels, not kinds)
  - `stagedEolChanges(entries: Iterable<LineEndingStatusEntry>, stagedPaths: ReadonlySet<string>): StagedEolChange[]`
  - `formatEolChanges(changes: StagedEolChange[], max?: number): string`

- [ ] **Step 1: Write the failing vitest**

`src/panels/WorkingChanges/lineEndingWarning.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { formatEolChanges, stagedEolChanges } from "./lineEndingWarning";
import type { LineEndingStatusEntry } from "../../lib/types";

const entry = (path: string, over: Partial<LineEndingStatusEntry>): LineEndingStatusEntry => ({
  path,
  unstaged: null,
  staged: null,
  mixed: false,
  working_raw: "lf",
  ...over,
});

describe("stagedEolChanges", () => {
  it("collects staged transitions for staged paths only", () => {
    const entries = [
      entry("a.ts", { staged: { from: "crlf", to: "lf" } }),
      entry("b.ts", { staged: { from: "lf", to: "crlf" } }),
      entry("c.ts", { unstaged: { from: "lf", to: "crlf" } }), // unstaged only: not committed
    ];
    const out = stagedEolChanges(entries, new Set(["a.ts", "c.ts"]));
    expect(out).toEqual([{ path: "a.ts", from: "CRLF", to: "LF" }]);
  });
});

describe("formatEolChanges", () => {
  const c = (p: string) => ({ path: p, from: "CRLF", to: "LF" });
  it("lists every file under the cap", () => {
    expect(formatEolChanges([c("a"), c("b")])).toBe("a CRLF→LF, b CRLF→LF");
  });
  it("caps at 5 with a +N more tail", () => {
    const changes = ["a", "b", "c", "d", "e", "f", "g"].map(c);
    expect(formatEolChanges(changes)).toBe(
      "a CRLF→LF, b CRLF→LF, c CRLF→LF, d CRLF→LF, e CRLF→LF (+2 more)",
    );
  });
});
```

Run (PowerShell when available): `npm test -- lineEndingWarning` - expected FAIL (module missing).

- [ ] **Step 2: Implement the pure builder**

`src/panels/WorkingChanges/lineEndingWarning.ts`:

```ts
// Pure builder for the commit-time line-ending warning: which STAGED files
// change their line endings relative to HEAD (index vs HEAD - exactly what
// the commit records, so autocrlf can't produce false positives), and the
// human summary line. Unit-tested next door.

import type { LineEndingStatusEntry } from "../../lib/types";
import { eolLabel } from "../shared/lineEndingStatus";

export interface StagedEolChange {
  path: string;
  from: string;
  to: string;
}

/** Staged line-ending transitions among the files the commit would record. */
export function stagedEolChanges(
  entries: Iterable<LineEndingStatusEntry>,
  stagedPaths: ReadonlySet<string>,
): StagedEolChange[] {
  const out: StagedEolChange[] = [];
  for (const e of entries) {
    if (!e.staged || !stagedPaths.has(e.path)) continue;
    const from = eolLabel(e.staged.from);
    const to = eolLabel(e.staged.to);
    if (from && to) out.push({ path: e.path, from, to });
  }
  return out;
}

/** "a.ts CRLF→LF, b.ts LF→CRLF (+3 more)", capped at `max` files. */
export function formatEolChanges(changes: StagedEolChange[], max = 5): string {
  const shown = changes.slice(0, max).map((c) => `${c.path} ${c.from}→${c.to}`);
  const more = changes.length - shown.length;
  return shown.join(", ") + (more > 0 ? ` (+${more} more)` : "");
}
```

Run: `npm test -- lineEndingWarning` (PowerShell) - expected PASS. `npx tsc --noEmit` from WSL regardless.

- [ ] **Step 3: Wire the gate into the panel**

In `WorkingChangesPanel.tsx`:

1. Imports: `stagedEolChanges, formatEolChanges` from `./lineEndingWarning`.

2. State, next to the other confirm flags (line ~237):

```tsx
  const [confirmEolCommit, setConfirmEolCommit] = useState(false);
```

3. Derivation, after the `staged`/`unstaged` memos (~line 311):

```tsx
  // Staged line-ending changes the next commit would record - the commit
  // warning's data (index vs HEAD, so repo policy can't false-positive).
  const stagedPathSet = useMemo(() => new Set(staged.map((f) => f.path)), [staged]);
  const eolChanges = useMemo(
    () => stagedEolChanges(eolMap.values(), stagedPathSet),
    [eolMap, stagedPathSet],
  );
```

4. Replace `requestCommit` (line 579) and chain the existing confirms through a shared `proceedCommit`, so the warning still fires after a detached-HEAD or amend-pushed confirm (order per spec: detached, amend-pushed, then line endings):

```tsx
  // Final gate before the actual commit: the line-ending warning (per its
  // setting). Runs LAST so it also covers commits approved through the
  // detached-HEAD / amend-pushed confirms.
  const proceedCommit = () => {
    if (warnEolCommit && eolChanges.length > 0) {
      setConfirmEolCommit(true);
      return;
    }
    commit();
  };
  const requestCommit = () => {
    if (detached) {
      setConfirmDetachedCommit(true);
      return;
    }
    if (amendingPushed) {
      setConfirmAmendPushed(true);
      return;
    }
    proceedCommit();
  };
```

In the detached-HEAD confirm's "Commit anyway" button (line ~1085) and the amend-pushed confirm's "Amend anyway" button (line ~1116), replace `commit();` with `proceedCommit();`.

5. Reset effect, next to the other two (line ~602):

```tsx
  // Drop a pending line-ending confirmation once it no longer applies
  // (files unstaged, endings reverted, or the setting turned off).
  useEffect(() => {
    if (!warnEolCommit || eolChanges.length === 0) setConfirmEolCommit(false);
  }, [warnEolCommit, eolChanges.length]);
```

6. The confirm box: extend the composer's ternary chain (line 1068 `confirmDetachedCommit ? ... : confirmAmendPushed ? ... :`) with a third branch before the default buttons row:

```tsx
          ) : confirmEolCommit ? (
            <div
              style={{
                padding: "8px 10px",
                border: "1px solid var(--panel-border)",
                borderRadius: 4,
                background: "var(--button-hover-bg)",
              }}
            >
              <div style={{ marginBottom: 8, fontSize: "var(--fz-md)" }}>
                {eolChanges.length === 1 ? (
                  <>1 file changes <strong>line endings</strong>: </>
                ) : (
                  <>{eolChanges.length} files change <strong>line endings</strong>: </>
                )}
                <code>{formatEolChanges(eolChanges)}</code>. Commit anyway?
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <Button
                  variant="primary"
                  disabled={busy}
                  onClick={() => {
                    setConfirmEolCommit(false);
                    commit();
                  }}
                >
                  Commit anyway
                </Button>
                <button disabled={busy} onClick={() => setConfirmEolCommit(false)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit 2>&1 | tail -5` - expected clean.

Do NOT commit (user rule).

---

### Task 10: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Full Rust suite from WSL**

Run: `cargo test -p legit-core 2>&1 | tail -10` and `cargo build --workspace 2>&1 | tail -3`
Expected: all tests pass (unit + flow_tests + git_flows), clean workspace build.

- [ ] **Step 2: Frontend checks from WSL**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: vitest + manual smoke (PowerShell / user)**

vitest cannot run from WSL (project memory: Linux binaries break the run). Ask the user to run from PowerShell:

- `npm test` - expect the two new suites (`lineEndingStatus`, `lineEndingWarning`) plus the theme contract and no-literal-colors suites green (no new tokens were added, so those must be untouched).
- `npm run tauri dev` and smoke against `<test-repo>` (ask before mutating its state; set up scratch files rather than resetting anything):
  1. Change a file's endings LF->CRLF (e.g. in an editor): the Unstaged row shows an `LF→CRLF` chip; clicking it offers "Revert line endings to LF" (confirm per the destructive setting); reverting clears the chip and the row's diff.
  2. Stage a flipped file: the Staged row shows a passive chip; Commit shows the inline "files change line endings" warning; Cancel keeps the draft; Commit anyway commits.
  3. Open the flipped file's diff: the header chip agrees with the row chip (same arrow), and on a repo with `core.autocrlf=true` a modified file shows a plain `CRLF` chip with NO arrow and no revert offer.
  4. Toggle both new settings in Global Settings and the repo overrides in Repo Settings: chips disappear / warning stops firing accordingly.

- [ ] **Step 4: Report**

Summarize results honestly (per verification-before-completion: evidence before claims). Leave ALL changes uncommitted for the user's review.
