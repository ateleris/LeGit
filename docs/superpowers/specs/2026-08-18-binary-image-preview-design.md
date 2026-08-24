# Rich image previews in the Diff viewer and File View

Date: 2026-08-18
Status: approved (design), pending implementation
Related: BACKLOG "Diff viewer: rich preview for displayable binary files";
`2026-08-17-lfs-pointer-placeholder-design.md` (the pointer notice this
extends); `design/2026-08-17-lfs-session-handoff.md` (records that the
dropped LFS fetch/smudge display value folds into this item).

## Scope (decided)

- v1 previews **raster images** (PNG, JPEG, GIF, WebP, BMP, ICO), detected
  by **magic bytes only** - no extension guessing.
- Surfaces: the **Diff panel** (old/new panes) and the **File View panel**
  (single pane). Blame is untouched.
- **LFS tie-in included**: a side that is an LFS pointer is resolved to the
  local LFS object store; a locally-present image previews, a missing one
  keeps pointer information. Never fetches from the network.
- Per-side size cap: **20 MB** (`MAX_PREVIEW_BYTES`). Above it the side
  reports its size instead of content.
- Transport: **base64 over IPC** (decided over asset-protocol/custom-scheme
  streaming: committed blobs are not files on disk, a split transport would
  need dynamic webview scoping plus mtime cache-busting, and the worst case
  of ~27 MB transient string is acceptable on desktop). If streaming is
  ever needed, only the `Image` payload changes shape (base64 -> URL); the
  enum survives.
- Explicitly out (follow-ups, add on demand): audio (MP3/WAV/OGG playable
  panes), SVG (it is text - it already gets a readable text diff/view and
  never hits the binary placeholders), zoom / 1:1 toggle, swipe /
  onion-skin comparison, any per-hunk actions (stage/discard stay
  file-level in the file lists, per the existing backlog decision).

## Backend

### legit-core: `GitBackend::blob_bytes`

`blob_bytes(spec: &str, cap: u64) -> Result<BlobBytes, GitError>` where
`spec` is any `<rev>:<path>` / `:<path>` rev spec and

```rust
pub enum BlobBytes {
    Bytes(Vec<u8>),        // blob exists, size <= cap
    TooLarge { size: u64 },// blob exists, size > cap (bytes not returned)
    Missing,               // spec does not resolve (bad rev, deleted path)
}
```

Implementation: `git cat-file --batch` through the existing byte-safe seam
(`run_with_stdin_bytes` + `parse_cat_file_batch`) - the only byte-exact
channel in the runner (plain `RunOutput.stdout` is lossy-decoded and must
never carry image bytes). The batch header gives the size before the blob
is consumed, so `TooLarge` is decided from the header; the process still
streams the blob (cat-file cannot stop mid-entry), it is just never
base64-encoded or shipped.

Rides along (the backlog's "unified binary-sniff window" cleanup):
`is_binary_content` / `BINARY_SNIFF_WINDOW` become `pub` exports of
legit-core, and the duplicated constant + sniff in
`src-tauri/src/commands/files.rs` (`classify_worktree_bytes`) switch to
them.

### src-tauri: `repo_file_preview` command

New `src-tauri/src/commands/preview.rs`:

```rust
repo_file_preview(repo_id: String, rev: Option<String>, path: String)
    -> Result<FilePreview, AppError>
```

`rev = None` means the working tree; otherwise the rev spec is passed to
`blob_bytes` as `<rev>:<path>`.

```rust
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FilePreview {
    Image { format: ImageFormat, size: u64, base64: String },
    TooLarge { size: u64 },
    NotPreviewable { size: u64 },
    Absent,
    LfsMissing { oid: String, size: u64 },
}
// ImageFormat: Png | Jpeg | Gif | Webp | Bmp | Ico (lowercase over IPC)
```

Flow:

1. **Fetch bytes.** Worktree: `resolve_repo_relative` (path-escape guard),
   size check via metadata, then capped `tokio::fs::read`. Committed /
   index: `blob_bytes`. `Missing` -> `Absent` (this makes a root commit's
   `<sha>^` old side render as "added" - correct, the side does not
   exist).
2. **LFS resolution.** If the bytes parse as an LFS pointer (reuse the
   pointer grammar already encoded in `src/lib/lfsPointer.ts`, ported as a
   small Rust parser next to the command): derive the object path
   `<git-dir>/lfs/objects/<oid[0..2]>/<oid[2..4]>/<oid>` with `<git-dir>`
   from `git rev-parse --git-dir` (worktrees/submodules relocate `.git`).
   Present -> preview those bytes (cap applies to the object size);
   absent -> `LfsMissing { oid, size }` from the pointer fields. The
   worktree side is normally already smudged on disk, so this mainly
   serves committed sides.
3. **Classify.** `detect_image_format(&[u8])` (pure, magic bytes) ->
   `Image` with base64, else `NotPreviewable { size }`. Cap exceeded at
   any stage -> `TooLarge { size }`.

Registered in `lib.rs` `collect_commands!`; wrapper `repoFilePreview` in
`src/lib/commands.ts`, `FilePreview` hand-mirrored in `src/lib/types.ts`.

## Frontend

### Shared plumbing

Hook `useFilePreview(repoId, rev, path, enabled)`. Query keys follow the
File View precedent, split by mutability of the spec:

- mutable (`rev = null` worktree, `":"` / `":0"` index):
  `[repoId, "status", "preview", rev, path]`, staleTime 5s - the watcher's
  status-domain invalidation keeps it fresh;
- immutable revs: `[repoId, "log", "preview", rev, path]`, staleTime 60s.

The per-source old/new rev table currently inlined as `lineEndingSides`
in `DiffPanel.tsx` is extracted to a shared pure helper (one table,
consumed by the line-endings badge and the preview; unit-tested), mapping
`DiffSource` -> `{ oldRev, newRev }` exactly as today
(`working_unstaged`: index -> worktree; `working_staged`: HEAD -> index;
`commit`: `<sha>^` -> sha; `commit_range`: from -> to).

### Diff panel

`DiffBody` routing changes (both inserted before the existing fallbacks,
which all remain as-is):

1. **`"Binary" in data`**: render `ImageDiffView` (new sibling of
   `SubmoduleDiffView` in `src/panels/Diff/`). It fires the two preview
   queries. If at least one side is `Image`, the preview surface renders;
   if neither is, it falls back to the current subtle placeholder text,
   now enriched with the byte sizes returned by the preview calls (fixing
   the always-`None` `BinaryDiff` sizes without touching the diff parser).
2. **LFS pointer case** (Text branch where `lfsPointerDiffSides` is
   non-null): the same two preview queries run; any side yielding `Image`
   renders as a pane, a `LfsMissing` side renders its pointer info
   compactly ("LFS object not present locally - run `git lfs pull` in the
   Console"). If no side yields an image, the existing `LfsPointerNotice`
   renders unchanged.

`ImageDiffView` layout: two labeled panes (Old / New) side by side, each
with a checkerboard backdrop, the image scaled to fit
(`object-fit: contain`, `max-width/height: 100%`), and a caption line:
format, natural dimensions (read from the img element after load), byte
size via `formatByteSize`. Added/deleted renders a single centered pane
labeled "added" / "deleted". Mixed per-side states render in place:
`Absent` = "(no file)", `TooLarge` = "too large to preview (N, cap 20 MB)",
`NotPreviewable` = "binary, N". The surface is read-only and identical in
inline and split mode (the mode toggle does not apply; action parity is
trivially preserved - there are no actions). GIFs animate natively.

The single-pane building block (`ImagePane`: checkerboard + img + caption)
lives in `src/panels/shared/` so File View reuses it.

### File View

When `data` is `Binary`, or the content is an LFS pointer (the existing
`lfsInfo` case): fire one preview query for the same rev/path. `Image`
renders the shared pane; every other outcome keeps today's placeholder /
`LfsPointerNotice` (enriched with nothing - the File View placeholder
already shows the byte size).

### Errors and loading

A failed preview query never blocks or replaces the panel: the surface
falls back to the existing placeholder (house convention: a passive data
query's failure may be a content state; no toasts). No instant spinners -
the previews are local and fast; the panes render when data arrives, per
the delayed-busy rule.

## Theme tokens

Two new tokens for the checkerboard: `preview.checker.a`,
`preview.checker.b` - added in the contractual 4 places
(`src/theme/tokens.ts`, `src/theme/defaults.ts`,
`src/styles/theme.css` `:root`, and both
`themes/Light.legit-theme.json` + `themes/Dark.legit-theme.json`).
Everything else reuses `panel.border` and `subtle-fg`. The contract and
no-literal-colors suites enforce this.

## Testing

- **Rust unit tests** (next to the code): `detect_image_format` (every
  magic, truncated header, empty input), the LFS object-path derivation,
  the Rust pointer parser, cap decisions in the preview assembly.
- **`flow_tests.rs`**: `blob_bytes` command-sequence test - exact
  `cat-file --batch` invocation and stdin framing, plus the `TooLarge` /
  `Missing` classification from scripted batch output.
- **`git_flows.rs`** (real binary): pin `cat-file --batch` output for an
  existing and a missing spec (extends the already-pinned framing
  contract), and the LFS resolution end-to-end against a fabricated
  `.git/lfs/objects/...` layout in a tempdir repo (no git-lfs binary
  required - the store is plain files).
- **Vitest**: the extracted per-source rev-side table; the pure
  "which surface renders" decision helper (preview vs placeholder vs
  pointer notice, per side-state combinations).
- **Full suites**: `cargo test`, `cargo check --workspace`,
  `npx tsc --noEmit`, full vitest via PowerShell interop. Theme suites
  cover the new tokens automatically.

## Manual test notes (for the implementation plan)

`<lfs-test-repo>` already holds a committed LFS image
(`logo.png`) and `<test-repo>` real histories: verify
add/modify/delete image diffs across all four `DiffSource` kinds, the
File View pane at a rev and in the worktree, an LFS image with the object
present vs removed from `.git/lfs/objects`, a >20 MB image (cap message),
and a non-image binary (unchanged placeholder, now with sizes).
