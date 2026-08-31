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
pub enum ImageFormat {
    Png,
    Jpeg,
    Gif,
    Webp,
    Bmp,
    Ico,
}

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
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some(ImageFormat::Png);
    }
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some(ImageFormat::Jpeg);
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some(ImageFormat::Gif);
    }
    if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        return Some(ImageFormat::Webp);
    }
    if bytes.starts_with(b"BM") {
        return Some(ImageFormat::Bmp);
    }
    if bytes.starts_with(&[0x00, 0x00, 0x01, 0x00]) {
        return Some(ImageFormat::Ico);
    }
    None
}

pub(crate) struct LfsPointer {
    oid: String,
    size: u64,
}

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
    if bytes.is_empty() || bytes.len() >= MAX_POINTER_BYTES {
        return None;
    }
    let text = std::str::from_utf8(bytes).ok()?;
    let mut lines = text.strip_suffix('\n').unwrap_or(text).lines();
    if !lines.next()?.starts_with(VERSION_PREFIX) {
        return None;
    }
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
        if !is_key_value(line) {
            return None;
        }
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

/// Preview the pointer's object from the repo host's LFS storage; never
/// fetches.
async fn resolve_lfs(
    fs: &dyn legit_core::RepoFs,
    git_dir: &Path,
    pointer: LfsPointer,
) -> FilePreview {
    let obj = legit_core::HostPath::from_path(&lfs_object_path(git_dir, &pointer.oid));
    match fs.stat(&obj).await {
        Ok(Some(st)) if st.len > MAX_PREVIEW_BYTES => FilePreview::TooLarge { size: st.len },
        Ok(Some(_)) => match fs.read(&obj, Some(MAX_PREVIEW_BYTES)).await {
            Ok(bytes) => classify_bytes(bytes),
            Err(_) => FilePreview::LfsMissing { oid: pointer.oid, size: pointer.size },
        },
        _ => FilePreview::LfsMissing { oid: pointer.oid, size: pointer.size },
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
    let fs = session.host.fs();
    let bytes: Vec<u8> = match &rev {
        None => {
            let abs = resolve_repo_relative(fs.as_ref(), &session.path, &path).await?;
            let hp = legit_core::HostPath::from_path(&abs);
            match fs.stat(&hp).await {
                Ok(None) | Err(_) => return Ok(FilePreview::Absent),
                Ok(Some(st)) if st.len > MAX_PREVIEW_BYTES => {
                    return Ok(FilePreview::TooLarge { size: st.len })
                }
                Ok(Some(_)) => fs
                    .read(&hp, Some(MAX_PREVIEW_BYTES))
                    .await
                    .map_err(|e| AppError::Io(format!("read {}: {e}", abs.display())))?,
            }
        }
        Some(r) => {
            // ":" (the index) prefixes the path directly; every other rev
            // takes the standard `<rev>:<path>` form (":0" composes to the
            // stage-0 spec ":0:<path>").
            let spec = if r == ":" { format!(":{path}") } else { format!("{r}:{path}") };
            match session
                .backend
                .blob_bytes(&spec, MAX_PREVIEW_BYTES)
                .await
                .map_err(AppError::Git)?
            {
                BlobBytes::Bytes(b) => b,
                BlobBytes::TooLarge { size } => return Ok(FilePreview::TooLarge { size }),
                BlobBytes::Missing => return Ok(FilePreview::Absent),
            }
        }
    };
    if let Some(pointer) = parse_lfs_pointer(&bytes) {
        // Worktrees/submodules relocate `.git`: resolve the real git dir.
        let runner = session.runner.read().await.clone();
        let out = runner.run(&["rev-parse", "--git-dir"]).await?;
        if out.success {
            let git_dir = session.path.join(out.stdout.trim());
            return Ok(resolve_lfs(fs.as_ref(), &git_dir, pointer).await);
        }
        return Ok(FilePreview::LfsMissing { oid: pointer.oid, size: pointer.size });
    }
    Ok(classify_bytes(bytes))
}

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
        // A line that is not `key value` shaped (no space / bad key chars)
        // disqualifies the whole blob. NOTE: "not a pointer!" WOULD pass as
        // key "not" + value - the grammar (like the TS original) tolerates
        // unknown keys, so the rejection needs a structurally invalid line.
        let junk = format!("{POINTER}definitely_not_a_key_value_line\n");
        assert!(parse_lfs_pointer(junk.as_bytes()).is_none());
        let bad_key = format!("{POINTER}b@d key\n");
        assert!(parse_lfs_pointer(bad_key.as_bytes()).is_none());
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
        match resolve_lfs(&legit_core::LocalFs, git_dir, parse_lfs_pointer(POINTER.as_bytes()).unwrap())
            .await
        {
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
        match resolve_lfs(&legit_core::LocalFs, git_dir, p).await {
            FilePreview::Image { format: ImageFormat::Png, .. } => {}
            other => panic!("expected Image, got {other:?}"),
        }
    }
}
