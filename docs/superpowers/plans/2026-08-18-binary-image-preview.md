# Binary Image Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (inline). NO subagent-driven-development, NO git commits (user rules). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Image previews (PNG/JPEG/GIF/WebP/BMP/ICO) replacing the binary placeholders in the Diff panel (old/new panes) and File View, including locally-present LFS objects.

**Architecture:** legit-core gains a byte-exact `GitBackend::blob_bytes` over the existing `cat-file --batch` seam; a new `repo_file_preview` command in src-tauri classifies bytes (magic sniff, LFS pointer resolution against `.git/lfs/objects`, 20 MB cap) and ships base64 over IPC; the frontend renders `data:` URLs in a shared `ImagePane` (checkerboard backdrop via 2 new theme tokens), composed by `ImageDiffView` in the Diff panel and directly in File View.

**Tech Stack:** Rust (tokio, base64 0.22), Tauri 2 IPC, React + TanStack Query, vitest.

**Spec:** `docs/superpowers/specs/2026-08-18-binary-image-preview-design.md`

## Global Constraints

- NO git commits or pushes: leave everything in the working tree.
- NO em-dashes in any produced text or code comments; use hyphens or colons.
- All colors via theme tokens (`var(--token)`); new tokens in the contractual 4 places + both bundled themes.
- All dimensions scale with `--ui-font-size` (em / `--fz-*`); fixed px only for hairlines.
- cargo/tsc from WSL; vitest via `powershell.exe -NoProfile -Command "Set-Location C:\NOT_WORK\LeGit; npx vitest run <path>"`.
- New commands: register in `src-tauri/src/lib.rs` `collect_commands!`, hand-written wrapper in `src/lib/commands.ts`, hand-mirrored type in `src/lib/types.ts`.
- `MAX_PREVIEW_BYTES = 20 * 1024 * 1024` (20 MB per side).

---

### Task 1: `GitBackend::blob_bytes` in legit-core

**Files:**
- Modify: `crates/legit-core/src/types.rs` (add `BlobBytes`)
- Modify: `crates/legit-core/src/backend.rs` (trait method)
- Modify: `crates/legit-core/src/cli_impl/mod.rs` (impl + `is_binary_bytes` export)
- Modify: `crates/legit-core/src/lib.rs` (re-export)
- Modify: `crates/legit-core/src/cli_impl/flow_tests.rs` (FakeExecutor stdin assertion + flow test)
- Modify: `crates/legit-core/tests/git_flows.rs` (real-git case)

**Interfaces:**
- Consumes: `GitExecutor::run_with_stdin_bytes` (executor.rs:64), `parse_cat_file_batch` (cli_impl/mod.rs:3363).
- Produces: `async fn blob_bytes(&self, spec: &str, cap: u64) -> Result<BlobBytes, GitError>` on `GitBackend`; `pub enum BlobBytes { Bytes(Vec<u8>), TooLarge { size: u64 }, Missing }` in `legit_core::types`; `pub fn is_binary_bytes(bytes: &[u8]) -> bool` re-exported from `legit_core`.

- [ ] **Step 1: Write the failing flow test.** First extend `FakeExecutor` in `flow_tests.rs`: add `stdin: Option<String>` to `Step` (set `stdin: None` in the existing `expect` / `expect_env` builders), add

```rust
/// Expect an invocation fed the given stdin (asserted exactly).
fn expect_stdin(&self, args: &[&str], stdin: &str, output: RunOutput) -> &Self {
    self.script.lock().unwrap().push_back(Step {
        args: args.iter().map(|s| s.to_string()).collect(),
        env: None,
        stdin: Some(stdin.to_string()),
        output,
    });
    self
}
```

extend `next(...)` with an `actual_stdin: Option<&str>` parameter asserting `assert_eq!(actual_stdin.map(str::to_string), step.stdin, "git invoked with unexpected stdin")` **only when `step.stdin` is Some** (existing steps pass stdin through `run_with_stdin` today, e.g. check-attr; they keep asserting nothing), and change the `run_with_stdin` impl to `Ok(self.next(args, None, Some(stdin_data)))` (all other trait impls pass `None`). `run_with_stdin_bytes` needs no fake impl: the trait default delegates to `run_with_stdin`. Then append the test:

```rust
// ---------------------------------------------------------------------------
// blob_bytes - byte framing, cap, and missing classification
// ---------------------------------------------------------------------------

#[tokio::test]
async fn blob_bytes_parses_found_capped_and_missing() {
    // Found, within cap: exact bytes back.
    let script = FakeExecutor::default();
    script.expect_stdin(
        &["cat-file", "--batch"],
        "HEAD:img.png\n",
        ok("abc123 blob 4\nPNG!\n"),
    );
    let (b, exec) = backend(script);
    assert_eq!(b.blob_bytes("HEAD:img.png", 100).await.unwrap(), BlobBytes::Bytes(b"PNG!".to_vec()));
    exec.assert_done();

    // Found, over cap: size reported, bytes withheld.
    let script = FakeExecutor::default();
    script.expect_stdin(&["cat-file", "--batch"], "HEAD:img.png\n", ok("abc123 blob 4\nPNG!\n"));
    let (b, exec) = backend(script);
    assert_eq!(b.blob_bytes("HEAD:img.png", 3).await.unwrap(), BlobBytes::TooLarge { size: 4 });
    exec.assert_done();

    // Unresolvable spec: cat-file exits 0 and reports "missing" on stdout.
    let script = FakeExecutor::default();
    script.expect_stdin(&["cat-file", "--batch"], "HEAD:gone.png\n", ok("HEAD:gone.png missing\n"));
    let (b, exec) = backend(script);
    assert_eq!(b.blob_bytes("HEAD:gone.png", 100).await.unwrap(), BlobBytes::Missing);
    exec.assert_done();
}
```

- [ ] **Step 2: Run to verify it fails.** `cargo test -p legit-core blob_bytes` - expect compile failure (`BlobBytes` / `blob_bytes` undefined).

- [ ] **Step 3: Implement.** In `types.rs` (near `FileAtRevision`):

```rust
/// Byte-exact blob content for a rev spec, capped. Internal to the backend
/// API (never crosses IPC): previews re-encode it before shipping.
#[derive(Debug, Clone, PartialEq)]
pub enum BlobBytes {
    /// Blob exists and is within the cap.
    Bytes(Vec<u8>),
    /// Blob exists but exceeds the cap; bytes withheld.
    TooLarge { size: u64 },
    /// The spec does not resolve (bad rev, absent path, root commit's `^`).
    Missing,
}
```

In `backend.rs` (near `file_at_revision`):

```rust
/// Byte-exact content of the blob at `spec` (any `<rev>:<path>` /
/// `:<path>` rev spec), for binary previews. Uses `cat-file --batch` raw
/// stdout - the plain runner output is lossy-decoded and must never carry
/// image bytes. An unresolvable spec is `Missing`, not an error.
async fn blob_bytes(&self, spec: &str, cap: u64) -> Result<BlobBytes, GitError>;
```

In `cli_impl/mod.rs` (impl block, near `file_at_revision`):

```rust
async fn blob_bytes(&self, spec: &str, cap: u64) -> Result<BlobBytes, GitError> {
    let runner = self.runner().await;
    let stdin = format!("{spec}\n");
    let out = runner.run_with_stdin_bytes(&["cat-file", "--batch"], &stdin).await?;
    if !out.success {
        return Err(GitError::CommandFailed {
            exit_code: out.exit_code.unwrap_or(-1),
            stderr: out.stderr.trim().to_string(),
        });
    }
    let entries = parse_cat_file_batch(&out.stdout)
        .ok_or_else(|| GitError::Internal("malformed cat-file --batch output".to_string()))?;
    match entries.into_iter().next().flatten() {
        None => Ok(BlobBytes::Missing),
        Some(bytes) if bytes.len() as u64 > cap => Ok(BlobBytes::TooLarge { size: bytes.len() as u64 }),
        Some(bytes) => Ok(BlobBytes::Bytes(bytes)),
    }
}
```

Also in `cli_impl/mod.rs`, refactor the sniff for reuse (the backlog's dedup):

```rust
/// Byte-level form of the sniff, for callers that hold raw bytes.
pub fn is_binary_bytes(bytes: &[u8]) -> bool {
    bytes.iter().take(BINARY_SNIFF_WINDOW).any(|&b| b == 0)
}

fn is_binary_content(content: &str) -> bool {
    is_binary_bytes(content.as_bytes())
}
```

and add `is_binary_bytes` to the `pub use cli_impl::{...}` list in `lib.rs`.

- [ ] **Step 4: Flow test passes.** `cargo test -p legit-core blob_bytes` - PASS; also `cargo test -p legit-core` (no regressions from the FakeExecutor change).

- [ ] **Step 5: Real-git case.** Append to `crates/legit-core/tests/git_flows.rs` (uses the existing `TestRepo`):

```rust
/// Pins the blob_bytes contract against the real binary: byte-exact content
/// through the batch framing (NULs + invalid UTF-8 survive), "missing" for
/// an absent path AND for a root commit's `^` (both exit 0), cap reporting.
#[tokio::test]
async fn blob_bytes_is_byte_exact_and_classifies_missing() {
    let repo = TestRepo::init().await;
    let bytes: Vec<u8> = vec![0x89, b'P', b'N', b'G', 0x00, 0xFF, 0xFE, 0x0A, 0x00];
    std::fs::write(repo.path.join("img.png"), &bytes).expect("write binary");
    repo.commit_all("img").await;

    match repo.backend.blob_bytes("HEAD:img.png", 1024).await.unwrap() {
        BlobBytes::Bytes(b) => assert_eq!(b, bytes, "bytes must round-trip exactly"),
        other => panic!("expected Bytes, got {other:?}"),
    }
    assert_eq!(repo.backend.blob_bytes("HEAD:absent.png", 1024).await.unwrap(), BlobBytes::Missing);
    // Root commit has no parent: the diff preview's old side (`<sha>^`)
    // resolves to Missing, which renders as "added".
    assert_eq!(repo.backend.blob_bytes("HEAD^:img.png", 1024).await.unwrap(), BlobBytes::Missing);
    assert_eq!(
        repo.backend.blob_bytes("HEAD:img.png", 4).await.unwrap(),
        BlobBytes::TooLarge { size: bytes.len() as u64 }
    );
}
```

Add `BlobBytes` to the `legit_core::types` import list at the top of the file.

- [ ] **Step 6: Run it.** `cargo test -p legit-core --test git_flows blob_bytes` - PASS. No commit.

### Task 2: `repo_file_preview` command

**Files:**
- Create: `src-tauri/src/commands/preview.rs`
- Modify: `src-tauri/Cargo.toml` (add `base64 = "0.22"` to `[dependencies]`)
- Modify: `src-tauri/src/commands/mod.rs` (add `pub mod preview;`)
- Modify: `src-tauri/src/lib.rs` (register `repo_file_preview` in `collect_commands!`)
- Modify: `src-tauri/src/commands/files.rs` (dedup sniff)

**Interfaces:**
- Consumes: `GitBackend::blob_bytes` (Task 1), `resolve_repo_relative` (`crate::commands::working`), `session.path` / `session.backend` / `session.runner` on `RepoSession`, `legit_core::is_binary_bytes`.
- Produces: command `repo_file_preview(repo_id, rev: Option<String>, path: String) -> Result<FilePreview, AppError>`; serde/IPC shape `{ kind: "image", format, size, base64 } | { kind: "too_large", size } | { kind: "not_previewable", size } | { kind: "absent" } | { kind: "lfs_missing", oid, size }` with `format` one of `"png" | "jpeg" | "gif" | "webp" | "bmp" | "ico"`.

- [ ] **Step 1: Write the failing unit tests.** Create `preview.rs` with only a `#[cfg(test)] mod tests` first:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn detects_image_formats_by_magic() {
        assert_eq!(detect_image_format(b"\x89PNG\r\n\x1a\n....."), Some(ImageFormat::Png));
        assert_eq!(detect_image_format(&[0xFF, 0xD8, 0xFF, 0xE0, 0x00]), Some(ImageFormat::Jpeg));
        assert_eq!(detect_image_format(b"GIF87a..."), Some(ImageFormat::Gif));
        assert_eq!(detect_image_format(b"GIF89a..."), Some(ImageFormat::Gif));
        assert_eq!(detect_image_format(b"RIFF\x10\x00\x00\x00WEBPVP8 "), Some(ImageFormat::Webp));
        assert_eq!(detect_image_format(b"BM\x36\x00"), Some(ImageFormat::Bmp));
        assert_eq!(detect_image_format(&[0x00, 0x00, 0x01, 0x00, 0x01, 0x00]), Some(ImageFormat::Ico));
        // Truncated magic, empty input, RIFF-but-not-WEBP (WAV) are not images.
        assert_eq!(detect_image_format(b"\x89PN"), None);
        assert_eq!(detect_image_format(b""), None);
        assert_eq!(detect_image_format(b"RIFF\x10\x00\x00\x00WAVEfmt "), None);
        assert_eq!(detect_image_format(b"plain text"), None);
    }

    const POINTER: &str = "version https://git-lfs.github.com/spec/v1\noid sha256:4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393\nsize 12345\n";

    #[test]
    fn parses_lfs_pointers_strictly() {
        let p = parse_lfs_pointer(POINTER.as_bytes()).expect("pointer");
        assert_eq!(p.oid, "4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393");
        assert_eq!(p.size, 12345);
        // Extension key-value lines are tolerated.
        let ext = format!("{POINTER}x-custom value\n");
        assert!(parse_lfs_pointer(ext.as_bytes()).is_some());
        // Rejected: no version line, non key-value line, missing oid/size,
        // binary bytes, oversized pointer.
        assert!(parse_lfs_pointer(b"oid sha256:abcd\nsize 1\n").is_none());
        let junk = format!("{POINTER}not a pointer at all!\n");
        assert!(parse_lfs_pointer(junk.as_bytes()).is_none());
        assert!(parse_lfs_pointer(b"version https://git-lfs.github.com/spec/v1\nsize 1\n").is_none());
        assert!(parse_lfs_pointer(&[0x89, 0x50, 0x00, 0x47]).is_none());
        let huge = format!("version https://git-lfs.github.com/spec/v1\n{}", "k v\n".repeat(300));
        assert!(parse_lfs_pointer(huge.as_bytes()).is_none());
    }

    #[test]
    fn lfs_object_path_layout() {
        let oid = "4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393";
        assert_eq!(
            lfs_object_path(Path::new("/repo/.git"), oid),
            Path::new("/repo/.git/lfs/objects/4d/7a").join(oid)
        );
    }

    #[test]
    fn classifies_bytes_image_vs_not() {
        match classify_bytes(b"\x89PNG\r\n\x1a\nDATA".to_vec()) {
            FilePreview::Image { format: ImageFormat::Png, size: 12, base64 } => {
                assert!(!base64.is_empty())
            }
            other => panic!("expected Image, got {other:?}"),
        }
        match classify_bytes(vec![0x00, 0x01, 0x02]) {
            FilePreview::NotPreviewable { size: 3 } => {}
            other => panic!("expected NotPreviewable, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn resolves_lfs_from_fabricated_object_store() {
        // The LFS object store is plain files: fabricate the layout, no
        // git-lfs binary involved.
        let dir = tempfile::tempdir().expect("tempdir");
        let git_dir = dir.path();
        let p = parse_lfs_pointer(POINTER.as_bytes()).unwrap();
        // Missing object: pointer info surfaces.
        match resolve_lfs(git_dir, parse_lfs_pointer(POINTER.as_bytes()).unwrap()).await {
            FilePreview::LfsMissing { oid, size } => {
                assert_eq!(oid, p.oid);
                assert_eq!(size, 12345);
            }
            other => panic!("expected LfsMissing, got {other:?}"),
        }
        // Present object: classified like any bytes.
        let obj = lfs_object_path(git_dir, &p.oid);
        std::fs::create_dir_all(obj.parent().unwrap()).unwrap();
        std::fs::write(&obj, b"\x89PNG\r\n\x1a\nDATA").unwrap();
        match resolve_lfs(git_dir, p).await {
            FilePreview::Image { format: ImageFormat::Png, .. } => {}
            other => panic!("expected Image, got {other:?}"),
        }
    }
}
```

- [ ] **Step 2: Run to verify failure.** `cargo test -p legit-app preview` - compile failure.

- [ ] **Step 3: Implement `preview.rs`.** Add `base64 = "0.22"` to `src-tauri/Cargo.toml` `[dependencies]` first, then:

```rust
//! Binary image previews (spec: 2026-08-18-binary-image-preview-design.md):
//! byte-exact blob fetch, magic-byte format sniff, local LFS object
//! resolution, base64 over IPC. Read-only: never writes, never fetches.

use crate::commands::working::resolve_repo_relative;
use crate::error::AppError;
use crate::state::AppState;
use base64::Engine as _;
use legit_core::types::BlobBytes;
use std::path::{Path, PathBuf};

/// Per-side preview cap (spec: 20 MB). Protects the IPC channel and the
/// query cache, not server memory: cat-file cannot stop mid-blob anyway.
const MAX_PREVIEW_BYTES: u64 = 20 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum ImageFormat { Png, Jpeg, Gif, Webp, Bmp, Ico }

/// What a preview request resolved to. `Absent` covers unresolvable specs
/// (deleted side, root commit's `^`), so the UI renders added/removed.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FilePreview {
    Image { format: ImageFormat, size: u64, base64: String },
    TooLarge { size: u64 },
    NotPreviewable { size: u64 },
    Absent,
    LfsMissing { oid: String, size: u64 },
}

/// Magic-byte sniff; deliberately no extension guessing.
fn detect_image_format(bytes: &[u8]) -> Option<ImageFormat> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") { return Some(ImageFormat::Png); }
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) { return Some(ImageFormat::Jpeg); }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") { return Some(ImageFormat::Gif); }
    if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        return Some(ImageFormat::Webp);
    }
    if bytes.starts_with(b"BM") { return Some(ImageFormat::Bmp); }
    if bytes.starts_with(&[0x00, 0x00, 0x01, 0x00]) { return Some(ImageFormat::Ico); }
    None
}

pub(crate) struct LfsPointer { oid: String, size: u64 }

// Mirror of the strict frontend grammar in src/lib/lfsPointer.ts: version
// line first, `oid sha256:<64 lowercase hex>` and `size <n>` among
// key-value lines, whole pointer under 1024 bytes. Strictness matters: a
// false positive would divert a real file into the LFS lookup.
const VERSION_PREFIX: &str = "version https://git-lfs.github.com/spec/";
const MAX_POINTER_BYTES: usize = 1024;

fn is_key_value(line: &str) -> bool {
    match line.split_once(' ') {
        Some((key, value)) => {
            !key.is_empty()
                && key.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
                && value.chars().next().is_some_and(|c| !c.is_whitespace())
        }
        None => false,
    }
}

fn parse_lfs_pointer(bytes: &[u8]) -> Option<LfsPointer> {
    if bytes.is_empty() || bytes.len() >= MAX_POINTER_BYTES { return None; }
    let text = std::str::from_utf8(bytes).ok()?;
    let mut lines = text.strip_suffix('\n').unwrap_or(text).lines();
    if !lines.next()?.starts_with(VERSION_PREFIX) { return None; }
    let (mut oid, mut size) = (None, None);
    for line in lines {
        if let Some(hex) = line.strip_prefix("oid sha256:") {
            if hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
                oid = Some(hex.to_string());
                continue;
            }
        }
        if let Some(n) = line.strip_prefix("size ") {
            if let Ok(v) = n.parse::<u64>() {
                size = Some(v);
                continue;
            }
        }
        // Unknown keys (pointer extensions) are fine; a non key-value line
        // means this is not a pointer at all.
        if !is_key_value(line) { return None; }
    }
    Some(LfsPointer { oid: oid?, size: size? })
}

/// `<git-dir>/lfs/objects/<oid[0..2]>/<oid[2..4]>/<oid>` (the LFS store is
/// plain files; oid is validated 64-hex by the parser).
fn lfs_object_path(git_dir: &Path, oid: &str) -> PathBuf {
    git_dir.join("lfs").join("objects").join(&oid[..2]).join(&oid[2..4]).join(oid)
}

fn classify_bytes(bytes: Vec<u8>) -> FilePreview {
    let size = bytes.len() as u64;
    match detect_image_format(&bytes) {
        Some(format) => FilePreview::Image {
            format,
            size,
            base64: base64::engine::general_purpose::STANDARD.encode(&bytes),
        },
        None => FilePreview::NotPreviewable { size },
    }
}

/// Preview the pointer's object from local LFS storage; never fetches.
async fn resolve_lfs(git_dir: &Path, pointer: LfsPointer) -> FilePreview {
    let obj = lfs_object_path(git_dir, &pointer.oid);
    match tokio::fs::metadata(&obj).await {
        Ok(md) if md.len() > MAX_PREVIEW_BYTES => FilePreview::TooLarge { size: md.len() },
        Ok(_) => match tokio::fs::read(&obj).await {
            Ok(bytes) => classify_bytes(bytes),
            Err(_) => FilePreview::LfsMissing { oid: pointer.oid, size: pointer.size },
        },
        Err(_) => FilePreview::LfsMissing { oid: pointer.oid, size: pointer.size },
    }
}

/// Preview of a file's content at a rev (`None` = working tree): an image
/// payload, or why there is none. Read-only; a failed side is a content
/// state, never a toast.
#[tauri::command]
#[specta::specta]
pub async fn repo_file_preview(
    state: tauri::State<'_, AppState>,
    repo_id: String,
    rev: Option<String>,
    path: String,
) -> Result<FilePreview, AppError> {
    let session = state.get_session(&repo_id).await?;
    let bytes: Vec<u8> = match &rev {
        None => {
            let abs = resolve_repo_relative(&session.path, &path)?;
            match tokio::fs::metadata(&abs).await {
                Err(_) => return Ok(FilePreview::Absent),
                Ok(md) if md.len() > MAX_PREVIEW_BYTES => {
                    return Ok(FilePreview::TooLarge { size: md.len() })
                }
                Ok(_) => tokio::fs::read(&abs)
                    .await
                    .map_err(|e| AppError::Io(format!("read {}: {e}", abs.display())))?,
            }
        }
        Some(r) => {
            // ":" (the index) prefixes the path directly; every other rev
            // takes the standard `<rev>:<path>` form (":0" composes to the
            // stage-0 spec ":0:<path>").
            let spec = if r == ":" { format!(":{path}") } else { format!("{r}:{path}") };
            match session.backend.blob_bytes(&spec, MAX_PREVIEW_BYTES).await.map_err(AppError::Git)? {
                BlobBytes::Bytes(b) => b,
                BlobBytes::TooLarge { size } => return Ok(FilePreview::TooLarge { size }),
                BlobBytes::Missing => return Ok(FilePreview::Absent),
            }
        }
    };
    if let Some(pointer) = parse_lfs_pointer(&bytes) {
        // Worktrees/submodules relocate `.git`: resolve the real git dir.
        let runner = session.runner.read().await.clone();
        // `?` converts: From<RunnerError> for AppError (error.rs:56).
        let out = runner.run(&["rev-parse", "--git-dir"]).await?;
        if out.success {
            let git_dir = session.path.join(out.stdout.trim());
            return Ok(resolve_lfs(&git_dir, pointer).await);
        }
        return Ok(FilePreview::LfsMissing { oid: pointer.oid, size: pointer.size });
    }
    Ok(classify_bytes(bytes))
}
```

Add `pub mod preview;` to `commands/mod.rs` and `commands::preview::repo_file_preview` to `collect_commands!` in `lib.rs` next to the `repo_lfs_*` entries.

- [ ] **Step 4: Dedup the sniff in `files.rs`.** Delete the local `BINARY_SNIFF_WINDOW` const and switch `classify_worktree_bytes` to `legit_core::is_binary_bytes(bytes)` (import it; keep the function and its doc comment otherwise unchanged, updating the window reference in the comment to name legit-core).

- [ ] **Step 5: Tests pass.** `cargo test -p legit-app preview` then `cargo test -p legit-app` and `cargo check --workspace` - all PASS. No commit.

### Task 3: Frontend plumbing (types, wrapper, rev tables, hook, decision helpers)

**Files:**
- Modify: `src/lib/types.ts` (FilePreview mirror)
- Modify: `src/lib/commands.ts` (wrapper)
- Create: `src/lib/diffSides.ts` + `src/lib/diffSides.test.ts`
- Create: `src/lib/useFilePreview.ts`
- Create: `src/lib/previewSurface.ts` + `src/lib/previewSurface.test.ts`
- Modify: `src/panels/Diff/DiffPanel.tsx` (delete local `lineEndingSides`, import `diffSides`)

**Interfaces:**
- Consumes: `repo_file_preview` (Task 2), `DiffSource` (types.ts), `formatByteSize` (lib/formatBytes).
- Produces: `FilePreview` / `ImageFormat` TS types; `repoFilePreview(repoId, rev: string | null, path)`; `diffSides(source): { rev: string | null; oldRev: string | null }`; `useFilePreview(repoId, rev, path, enabled)` returning `UseQueryResult<FilePreview>`; `hasImageSide(o, n)`, `sideNotice(p)`, `binarySizes(o, n)`.

- [ ] **Step 1: Types + wrapper.** In `types.ts` (near `LfsPatternsView`):

```ts
export type ImageFormat = "png" | "jpeg" | "gif" | "webp" | "bmp" | "ico";

/** Preview of a file's content at a rev (mirror of legit-app's FilePreview):
 * an image payload, or why there is none. */
export type FilePreview =
  | { kind: "image"; format: ImageFormat; size: number; base64: string }
  | { kind: "too_large"; size: number }
  | { kind: "not_previewable"; size: number }
  | { kind: "absent" }
  | { kind: "lfs_missing"; oid: string; size: number };
```

In `commands.ts` (import `FilePreview`, add near `repoLfsFiles`):

```ts
/** Image preview of a file at a rev (null = working tree); read-only. */
export const repoFilePreview = (repoId: string, rev: string | null, path: string) =>
  invoke<FilePreview>("repo_file_preview", { repoId, rev, path });
```

- [ ] **Step 2: Extract the rev-side table (failing test first).** `src/lib/diffSides.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { diffSides } from "./diffSides";

describe("diffSides", () => {
  it("maps each diff source to its old/new rev specs", () => {
    expect(diffSides({ kind: "working_unstaged" })).toEqual({ rev: null, oldRev: ":" });
    expect(diffSides({ kind: "working_staged" })).toEqual({ rev: ":", oldRev: "HEAD" });
    expect(diffSides({ kind: "commit", commit_id: "abc" })).toEqual({ rev: "abc", oldRev: "abc^" });
    expect(diffSides({ kind: "commit_range", from: "a", to: "b" })).toEqual({ rev: "b", oldRev: "a" });
  });
});
```

Run (PowerShell interop) - fails. Then create `src/lib/diffSides.ts` by MOVING `lineEndingSides` from `DiffPanel.tsx:75-86` verbatim (renamed `diffSides`, same doc comment, `import type { DiffSource } from "./types"`), delete the local copy in `DiffPanel.tsx`, and update its call sites there to the import. Run the test - PASS.

- [ ] **Step 3: Hook.** `src/lib/useFilePreview.ts`:

```ts
import { useQuery } from "@tanstack/react-query";
import { repoFilePreview } from "./commands";
import type { FilePreview } from "./types";

/** Preview query for one side. Mutable specs (worktree, index) live under
 * the "status" domain so the watcher refreshes them; committed revs are
 * immutable and live under "log". */
export function useFilePreview(
  repoId: string | undefined,
  rev: string | null,
  path: string | undefined,
  enabled: boolean,
) {
  const mutable = rev === null || rev === ":" || rev === ":0";
  return useQuery<FilePreview>({
    queryKey: [repoId, mutable ? "status" : "log", "preview", rev ?? "worktree", path],
    queryFn: () => repoFilePreview(repoId!, rev, path!),
    enabled: enabled && !!repoId && !!path,
    staleTime: mutable ? 5_000 : 60_000,
  });
}
```

- [ ] **Step 4: Decision helpers (failing test first).** `src/lib/previewSurface.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { binarySizes, hasImageSide, sideNotice } from "./previewSurface";
import type { FilePreview } from "./types";

const img: FilePreview = { kind: "image", format: "png", size: 10, base64: "aa" };
const big: FilePreview = { kind: "too_large", size: 30 * 1024 * 1024 };
const bin: FilePreview = { kind: "not_previewable", size: 2048 };
const lfs: FilePreview = { kind: "lfs_missing", oid: "a".repeat(64), size: 4096 };

describe("previewSurface", () => {
  it("shows the image surface when at least one side is an image", () => {
    expect(hasImageSide(img, undefined)).toBe(true);
    expect(hasImageSide(bin, img)).toBe(true);
    expect(hasImageSide(bin, big)).toBe(false);
    expect(hasImageSide(undefined, undefined)).toBe(false);
  });

  it("describes non-image sides", () => {
    expect(sideNotice(undefined)).toBe("(no file)");
    expect(sideNotice({ kind: "absent" })).toBe("(no file)");
    expect(sideNotice(big)).toContain("cap 20 MB");
    expect(sideNotice(bin)).toContain("binary");
    expect(sideNotice(lfs)).toContain("git lfs pull");
    expect(sideNotice(lfs)).toContain("aaaaaaaaaaaa");
  });

  it("summarizes sizes for the enriched fallback", () => {
    expect(binarySizes(bin, big)).toBe("2.0 KB → 30.0 MB");
    expect(binarySizes({ kind: "absent" }, bin)).toBe("added, 2.0 KB");
    expect(binarySizes(bin, { kind: "absent" })).toBe("2.0 KB, removed");
    expect(binarySizes(undefined, undefined)).toBeNull();
  });
});
```

Adjust the exact size strings to `formatByteSize`'s real output (read `src/lib/formatBytes.ts` first and mirror its formatting in the assertions). Run - fails. Then `src/lib/previewSurface.ts`:

```ts
import { formatByteSize } from "./formatBytes";
import type { FilePreview } from "./types";

/** The image surface renders when at least one side decoded as an image. */
export function hasImageSide(oldP?: FilePreview, newP?: FilePreview): boolean {
  return oldP?.kind === "image" || newP?.kind === "image";
}

/** Caption for a non-image side shown next to an image side. */
export function sideNotice(p: FilePreview | undefined): string {
  switch (p?.kind) {
    case undefined:
    case "absent":
      return "(no file)";
    case "too_large":
      return `too large to preview (${formatByteSize(p.size)}, cap 20 MB)`;
    case "not_previewable":
      return `binary, ${formatByteSize(p.size)}`;
    case "lfs_missing":
      return `LFS object not present locally (oid ${p.oid.slice(0, 12)}, ${formatByteSize(p.size)}): run git lfs pull in the Console`;
    case "image":
      return "";
  }
}

/** Size summary for the no-preview fallback text; null when nothing is known. */
export function binarySizes(oldP?: FilePreview, newP?: FilePreview): string | null {
  const size = (p?: FilePreview) => (p && "size" in p ? formatByteSize(p.size) : null);
  const o = size(oldP);
  const n = size(newP);
  if (o && n) return `${o} → ${n}`;
  if (n) return `added, ${n}`;
  if (o) return `${o}, removed`;
  return null;
}
```

- [ ] **Step 5: Verify.** `npx tsc --noEmit` clean (WSL); both new vitest files PASS via PowerShell interop. No commit.

### Task 4: Tokens + `ImagePane` + `ImageDiffView`

**Files:**
- Modify: `src/theme/tokens.ts`, `src/theme/defaults.ts`, `src/styles/theme.css`, `themes/Dark.legit-theme.json`, `themes/Light.legit-theme.json`
- Create: `src/panels/shared/ImagePane.tsx`
- Create: `src/panels/Diff/ImageDiffView.tsx`

**Interfaces:**
- Consumes: `FilePreview`, `useFilePreview`, `diffSides`, `hasImageSide`, `sideNotice` (Task 3), `formatByteSize`.
- Produces: `ImagePane({ preview, label? })` where `preview.kind === "image"`; `ImageDiffView({ repoId, source, path, oldPath, fallback })` with `fallback: (oldP?: FilePreview, newP?: FilePreview) => React.ReactNode`; CSS vars `--preview-checker-a` / `--preview-checker-b`.

- [ ] **Step 1: Tokens in the contractual 4 places + both themes.** `tokens.ts` (Panel group, after `pane.header.fg`):

```ts
{ name: "preview.checker.a", group: "Panel", documentation: "Image-preview checkerboard backdrop, first tile shade (makes transparency visible)." },
{ name: "preview.checker.b", group: "Panel", documentation: "Image-preview checkerboard backdrop, second tile shade." },
```

`defaults.ts` tokens map: `"preview.checker.a": "panel-bg", "preview.checker.b": "panel-border",`. `styles/theme.css` `:root`: `--preview-checker-a: var(--palette-panel-bg); --preview-checker-b: var(--palette-panel-border);`. Both `themes/*.legit-theme.json` `tokens` sections: same two mappings as defaults.ts. Verify with the contract suite (vitest `src/theme` via PowerShell) - PASS.

- [ ] **Step 2: `ImagePane`.** `src/panels/shared/ImagePane.tsx`:

```tsx
import { useState } from "react";
import type { FilePreview, ImageFormat } from "../../lib/types";
import { formatByteSize } from "../../lib/formatBytes";

/** data: URL for an image preview payload (CSP is null; data URLs render). */
export function previewDataUrl(format: ImageFormat, base64: string): string {
  const mime = format === "ico" ? "image/x-icon" : `image/${format}`;
  return `data:${mime};base64,${base64}`;
}

/** One image preview: checkerboard backdrop (transparency stays visible),
 * fit-to-pane image, caption with format / natural dimensions / byte size. */
export function ImagePane({
  preview,
  label,
}: {
  preview: Extract<FilePreview, { kind: "image" }>;
  label?: string;
}) {
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        alignItems: "center",
        minWidth: 0,
        minHeight: 0,
        flex: 1,
        padding: 8,
      }}
    >
      {label && (
        <span className="legit-subtle" style={{ fontSize: "var(--fz-sm)" }}>{label}</span>
      )}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          maxWidth: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          border: "1px solid var(--panel-border)",
          background:
            "repeating-conic-gradient(var(--preview-checker-a) 0% 25%, var(--preview-checker-b) 0% 50%) 0 0 / 1.4em 1.4em",
        }}
      >
        <img
          src={previewDataUrl(preview.format, preview.base64)}
          onLoad={(e) =>
            setDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })
          }
          style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain", display: "block" }}
        />
      </div>
      <span className="legit-subtle" style={{ fontSize: "var(--fz-sm)" }}>
        {preview.format.toUpperCase()}
        {dims ? `, ${dims.w}×${dims.h}` : ""}, {formatByteSize(preview.size)}
      </span>
    </div>
  );
}
```

- [ ] **Step 3: `ImageDiffView`.** `src/panels/Diff/ImageDiffView.tsx`:

```tsx
import type { DiffSource, FilePreview } from "../../lib/types";
import { diffSides } from "../../lib/diffSides";
import { useFilePreview } from "../../lib/useFilePreview";
import { hasImageSide, sideNotice } from "../../lib/previewSurface";
import { ImagePane } from "../shared/ImagePane";

/** One diff side: the image, or a subtle caption for a non-image state. */
function PreviewSide({ label, preview }: { label: string; preview?: FilePreview }) {
  if (preview?.kind === "image") return <ImagePane label={label} preview={preview} />;
  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        gap: 4,
        alignItems: "center",
        justifyContent: "center",
        padding: 8,
      }}
    >
      <span className="legit-subtle" style={{ fontSize: "var(--fz-sm)" }}>{label}</span>
      <span className="legit-subtle" style={{ fontSize: "var(--fz-md)" }}>{sideNotice(preview)}</span>
    </div>
  );
}

/**
 * Old/new image panes for a binary or LFS-pointer diff. Read-only (stage /
 * discard stay file-level in the file lists) and identical in inline and
 * split mode. When NEITHER side decodes as an image the caller's fallback
 * renders instead (enriched placeholder / LfsPointerNotice).
 */
export function ImageDiffView({
  repoId,
  source,
  path,
  oldPath,
  fallback,
}: {
  repoId: string;
  source: DiffSource;
  path: string;
  oldPath: string | null;
  fallback: (oldP?: FilePreview, newP?: FilePreview) => React.ReactNode;
}) {
  const sides = diffSides(source);
  const oldQ = useFilePreview(repoId, sides.oldRev, oldPath ?? path, true);
  const newQ = useFilePreview(repoId, sides.rev, path, true);
  // Local + fast: no spinner (delayed-busy rule), render when both settle.
  if (oldQ.isPending || newQ.isPending) return null;
  const oldP = oldQ.data;
  const newP = newQ.data;
  if (!hasImageSide(oldP, newP)) return <>{fallback(oldP, newP)}</>;
  const oldShown = !!oldP && oldP.kind !== "absent";
  const newShown = !!newP && newP.kind !== "absent";
  return (
    <div
      className="legit-panel__body"
      style={{ display: "flex", gap: 12, minHeight: 0, overflow: "auto", justifyContent: "center" }}
    >
      {oldShown && <PreviewSide label={newShown ? "Old" : "Old (deleted)"} preview={oldP} />}
      {newShown && <PreviewSide label={oldShown ? "New" : "New (added)"} preview={newP} />}
    </div>
  );
}
```

- [ ] **Step 4: Verify.** `npx tsc --noEmit` clean; theme suites (contract + noLiteralColors) PASS via PowerShell vitest. No commit.

### Task 5: Wire the Diff panel and File View

**Files:**
- Modify: `src/panels/Diff/DiffPanel.tsx` (DiffBody Binary + LFS branches)
- Modify: `src/panels/FileView/FileViewPanel.tsx`

**Interfaces:**
- Consumes: `ImageDiffView`, `ImagePane`, `binarySizes`, `useFilePreview` (Tasks 3-4). Existing: `lfsPointerDiffSides`, `LfsPointerNotice`, `request.oldPath`.

- [ ] **Step 1: DiffBody Binary branch** (`DiffPanel.tsx:635-641`) becomes:

```tsx
if ("Binary" in data) {
  return (
    <ImageDiffView
      repoId={request.repoId}
      source={request.source}
      path={request.path}
      oldPath={request.oldPath ?? null}
      fallback={(o, n) => {
        const sizes = binarySizes(o, n);
        return (
          <div className="legit-panel__body">
            <span className="legit-subtle">
              Binary file{sizes ? ` (${sizes})` : ""}, no preview available.
            </span>
          </div>
        );
      }}
    />
  );
}
```

(The sizes come from the preview responses, fixing the always-`None` `BinaryDiff` sizes without touching the diff parser.)

- [ ] **Step 2: DiffBody LFS branch** (`DiffPanel.tsx:666-673`): keep the `lfsSides` computation and comment, replace the returned JSX:

```tsx
const lfsSides = lfsPointerDiffSides(text.hunks);
if (lfsSides) {
  return (
    <ImageDiffView
      repoId={request.repoId}
      source={request.source}
      path={request.path}
      oldPath={request.oldPath ?? null}
      fallback={() => (
        <div className="legit-panel__body">
          <LfsPointerNotice oldInfo={lfsSides.oldInfo} newInfo={lfsSides.newInfo} />
        </div>
      )}
    />
  );
}
```

Add the imports (`ImageDiffView`, `binarySizes`) at the top of `DiffPanel.tsx`.

- [ ] **Step 3: File View** (`FileViewPanel.tsx`). After the `lfsInfo` line (:124), add one preview query, enabled only for the two placeholder cases:

```tsx
const previewWanted = (data != null && "Binary" in data) || lfsInfo != null;
const { data: preview } = useFilePreview(
  repo?.id,
  worktree ? null : request?.rev ?? null,
  request?.path,
  previewWanted,
);
```

and change the body branches (:163-168):

```tsx
) : data && "Binary" in data ? (
  preview?.kind === "image" ? (
    <ImagePane preview={preview} />
  ) : (
    <span className="legit-subtle" style={{ display: "block", padding: 8, fontSize: "var(--fz-md)" }}>
      Binary file, {formatByteSize(data.Binary.size_bytes)}. No text content to show.
    </span>
  )
) : lfsInfo ? (
  preview?.kind === "image" ? (
    <ImagePane preview={preview} />
  ) : (
    <LfsPointerNotice info={lfsInfo} />
  )
) : (
```

Add the `ImagePane` / `useFilePreview` imports. Note: hooks must run unconditionally, so the query sits above the early `if (!repo || !request)` return only if that return comes later; in the current file the early return is at :128, AFTER the existing hooks: place `useFilePreview` with the other hooks before it (it is enable-gated, so it never fires without a request).

- [ ] **Step 4: Verify.** `npx tsc --noEmit` clean; full vitest via PowerShell PASS. No commit.

### Task 6: Full verification + docs

- [ ] `cargo test -p legit-core && cargo test -p legit-app && cargo check --workspace` all green.
- [ ] `npx tsc --noEmit` clean; full `npx vitest run` via PowerShell green (incl. theme contract + noLiteralColors + the new diffSides/previewSurface tests).
- [ ] BACKLOG.md: replace the "Diff viewer: rich preview for displayable binary files" item body with a SHIPPED note (spec path, what shipped: images in Diff + File View incl. local LFS objects, 20 MB cap) keeping the open remainder: audio panes, SVG, zoom/1:1, swipe/onion-skin - add on demand.
- [ ] Report manual test steps for Simon (app must run interactively):
  1. `C:\NOT_WORK\LeGit-Test`: add a PNG, see it in the unstaged diff as a single "New (added)" pane with checkerboard + caption; stage it (working_staged shows it too); commit and modify it: old/new panes side by side; delete it: "Old (deleted)".
  2. Compare view (commit_range) and a commit diff show read-only panes; a ROOT commit that adds an image shows "added" (old side Missing).
  3. File View: open the PNG at a revision and from the Files panel (worktree); both render the pane; a non-image binary (e.g. .zip) keeps the text placeholder with its size.
  4. `C:\NOT_WORK\LeGit-Test-LFS`: `logo.png` diff/File View renders the image from local LFS storage; move its object out of `.git/lfs/objects` and re-check: pointer notice / "not present locally" caption returns.
  5. A >20 MB image shows the cap message with its real size.
  6. Theme check: switch Light/Dark; checkerboard follows the theme (no literal colors anywhere).
