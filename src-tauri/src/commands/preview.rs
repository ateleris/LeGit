//! Binary image previews (spec: 2026-08-18-binary-image-preview-design.md):
//! byte-exact blob fetch, magic-byte format sniff, local LFS object
//! resolution, base64 over IPC. Read-only: never writes, never fetches.

use crate::commands::working::resolve_repo_relative;
use crate::error::AppError;
use crate::state::AppState;
use base64::Engine as _;
use legit_core::cli_impl::parsers::lfs::{lfs_object_path, parse_lfs_pointer, LfsPointer};
use legit_core::types::BlobBytes;

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
    /// Extension-triggered (SVG is text - no magic bytes to sniff); the
    /// webview renders it via an `<img>` data URL, where scripts never run.
    Svg,
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






fn classify_bytes(bytes: Vec<u8>, svg_hint: bool) -> FilePreview {
    let size = bytes.len() as u64;
    // Magic bytes first: a binary image renamed .svg is still that image.
    let format = detect_image_format(&bytes)
        .or_else(|| (svg_hint && looks_like_svg(&bytes)).then_some(ImageFormat::Svg));
    match format {
        Some(format) => FilePreview::Image {
            format,
            size,
            base64: base64::engine::general_purpose::STANDARD.encode(&bytes),
        },
        None => FilePreview::NotPreviewable { size },
    }
}

/// Whether the content plausibly IS svg markup: an `<svg` tag in the head of
/// the file (past any XML prolog, BOM, or comments). A named-but-not-svg
/// file must fall through to the text diff, not a broken image pane.
fn looks_like_svg(bytes: &[u8]) -> bool {
    let head = String::from_utf8_lossy(&bytes[..bytes.len().min(4096)]).to_lowercase();
    head.contains("<svg")
}

/// Extension check (case-insensitive). SVG is text, so unlike the binary
/// formats it is triggered by the path, never sniffed on its own.
fn is_svg_path(path: &str) -> bool {
    path.rsplit('.').next().is_some_and(|ext| ext.eq_ignore_ascii_case("svg"))
        && path.len() > 4
}

/// Preview the pointer's object from the repo host's LFS storage; never
/// fetches.
async fn resolve_lfs(
    fs: &dyn legit_core::RepoFs,
    git_dir: &legit_core::HostPath,
    pointer: LfsPointer,
    svg_hint: bool,
) -> FilePreview {
    let obj = lfs_object_path(git_dir, &pointer.oid);
    match fs.stat(&obj).await {
        Ok(Some(st)) if st.len > MAX_PREVIEW_BYTES => FilePreview::TooLarge { size: st.len },
        Ok(Some(_)) => match fs.read(&obj, Some(MAX_PREVIEW_BYTES)).await {
            Ok(bytes) => classify_bytes(bytes, svg_hint),
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
            let abs = resolve_repo_relative(fs.as_ref(), &session.root, &path).await?;
            let hp = abs.clone();
            match fs.stat(&hp).await {
                Ok(None) | Err(_) => return Ok(FilePreview::Absent),
                Ok(Some(st)) if st.len > MAX_PREVIEW_BYTES => {
                    return Ok(FilePreview::TooLarge { size: st.len })
                }
                Ok(Some(_)) => fs
                    .read(&hp, Some(MAX_PREVIEW_BYTES))
                    .await
                    .map_err(|e| AppError::Io(format!("read {}: {e}", abs)))?,
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
        return Ok(match session.backend.absolute_git_dir().await {
            Ok(git_dir) => resolve_lfs(fs.as_ref(), &git_dir, pointer, is_svg_path(&path)).await,
            Err(_) => FilePreview::LfsMissing { oid: pointer.oid, size: pointer.size },
        });
    }
    Ok(classify_bytes(bytes, is_svg_path(&path)))
}

#[cfg(test)]
mod tests {
    use super::*;

    const POINTER: &str = "version https://git-lfs.github.com/spec/v1\noid sha256:4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393\nsize 12345\n";

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




    #[test]
    fn classifies_bytes_image_vs_not() {
        match classify_bytes(b"\x89PNG\r\n\x1a\nDATA".to_vec(), false) {
            FilePreview::Image { format: ImageFormat::Png, size: 12, base64 } => {
                assert!(!base64.is_empty())
            }
            other => panic!("expected Image, got {other:?}"),
        }
        match classify_bytes(vec![0x00, 0x01, 0x02], false) {
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
        let git_dir_hp = legit_core::HostPath::from_path(git_dir);
        // Missing object: pointer info surfaces.
        match resolve_lfs(&legit_core::LocalFs, &git_dir_hp, parse_lfs_pointer(POINTER.as_bytes()).unwrap(), false)
            .await
        {
            FilePreview::LfsMissing { oid, size } => {
                assert_eq!(oid, p.oid);
                assert_eq!(size, 12345);
            }
            other => panic!("expected LfsMissing, got {other:?}"),
        }
        // Present object: classified like any bytes.
        let obj = lfs_object_path(&git_dir_hp, &p.oid).as_local();
        std::fs::create_dir_all(obj.parent().unwrap()).unwrap();
        std::fs::write(&obj, b"\x89PNG\r\n\x1a\nDATA").unwrap();
        match resolve_lfs(&legit_core::LocalFs, &git_dir_hp, p, false).await {
            FilePreview::Image { format: ImageFormat::Png, .. } => {}
            other => panic!("expected Image, got {other:?}"),
        }
    }
}

#[cfg(test)]
mod svg_tests {
    use super::*;

    #[test]
    fn svg_hint_with_svg_content_previews_as_svg_image() {
        let body = b"<?xml version=\"1.0\"?>\n<!-- logo -->\n<svg xmlns=\"http://www.w3.org/2000/svg\"/>".to_vec();
        match classify_bytes(body, true) {
            FilePreview::Image { format: ImageFormat::Svg, .. } => {}
            other => panic!("expected an Svg image preview, got {other:?}"),
        }
    }

    #[test]
    fn svg_hint_with_non_svg_content_stays_not_previewable() {
        // A file merely NAMED .svg must not render as one.
        match classify_bytes(b"just text".to_vec(), true) {
            FilePreview::NotPreviewable { .. } => {}
            other => panic!("expected NotPreviewable, got {other:?}"),
        }
    }

    #[test]
    fn svg_content_without_the_hint_stays_not_previewable() {
        // Extension-triggered only: sniffing markup content is not enough
        // to call something an image (mirrors detect_image_format's
        // deliberate no-extension-guessing, inverted).
        match classify_bytes(b"<svg xmlns=\"x\"/>".to_vec(), false) {
            FilePreview::NotPreviewable { .. } => {}
            other => panic!("expected NotPreviewable, got {other:?}"),
        }
    }

    #[test]
    fn svg_hint_never_overrides_a_binary_sniff() {
        // A png renamed to .svg previews as the png it is.
        match classify_bytes(b"\x89PNG\r\n\x1a\nDATA".to_vec(), true) {
            FilePreview::Image { format: ImageFormat::Png, .. } => {}
            other => panic!("expected a Png image preview, got {other:?}"),
        }
    }

    #[test]
    fn is_svg_path_matches_the_extension_case_insensitively() {
        assert!(is_svg_path("icons/logo.svg"));
        assert!(is_svg_path("LOGO.SVG"));
        assert!(!is_svg_path("logo.svg.bak"));
        assert!(!is_svg_path("svg"));
    }
}
