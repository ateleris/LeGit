# LFS pointer placeholder in content views

Date: 2026-08-17
Status: approved (design), pending implementation
Related: `2026-08-17-lfs-detection-warning-design.md` (detection/warning half),
BACKLOG release blocker #4 (this implements option (a); option (b)
smudge-on-demand stays open).

## Problem

Content views that read committed blobs bypass LFS smudging, so an
LFS-tracked file renders as its ~3-line pointer text: File View at a
revision (`git show rev:path`), Blame (`git blame --porcelain`), and Diff at
a revision (pointer lines appear as ordinary +/- hunks; git's own
"Binary files differ" marker never fires for pointers). An unsmudged
working-tree stub (broken git-lfs setup) has the same shape on disk.

## Approach (decided): frontend-only detection

The pointer text already crosses IPC as ordinary content, and it carries the
real payload size and oid. Interpreting well-formed content for display is a
view concern (like syntax highlighting), so detection lives in one pure
TypeScript module; no Rust, IPC, or type changes. Backend classification
(new `FileAtRevision`/`DiffEntry` variants, a breaking blame type change)
was rejected: three vertical slices of churn for zero functional gain, and
option (b) will need oid/size frontend-side anyway.

## Components

### `src/lib/lfsPointer.ts` (pure, unit-tested)

- `interface LfsPointerInfo { oid: string; size: number }`
- `parseLfsPointer(text: string): LfsPointerInfo | null`
  Accepts exactly the LFS pointer shape: total length < 1024; first line
  starts with `version https://git-lfs.github.com/spec/`; an
  `oid sha256:<64 lowercase hex>` line; a `size <digits>` line; remaining
  lines must look like `key value` pairs; trailing newline tolerated.
  Anything else returns null.
- `lfsPointerDiffSides(hunks: DiffHunk[]): { oldInfo: LfsPointerInfo | null; newInfo: LfsPointerInfo | null } | null`
  Rebuilds the old side (Context + Removed lines) and new side (Context +
  Added lines) across all hunks; a pointer file is at most a few lines, so
  U3 hunks always contain both complete sides. Returns non-null only when
  every non-empty side parses as a pointer and at least one side is
  non-empty. An LFS-to-text (or text-to-LFS) conversion therefore keeps the
  normal text diff, which is genuinely informative there.

### `src/panels/shared/LfsPointerNotice.tsx`

Same visual language as the existing binary placeholders (`legit-subtle`
text in the panel body, no new theme tokens). Two forms:
- single blob: "Git LFS file, <size>. Content is stored in Git LFS
  (oid <short>)."
- diff: old and new size/oid, or "added" / "removed" when a side is absent.
The wording must stay valid for a committed blob AND an unsmudged
working-tree stub.

`formatByteSize` moves from `FileViewPanel.tsx` (local, lines 29-40) to
`src/lib/formatBytes.ts` and is imported by both call sites.

### Wiring (three thin call sites, display-only)

- `FileViewPanel.tsx`: when content arrived as `Text` and
  `parseLfsPointer(content)` matches, render the notice instead of
  `FileContentView`. Applies in both revision and working-tree modes (a
  stub on disk gets explained too, pairing with the missing-git-lfs
  banner).
- `DiffPanel.tsx`: in the `Text` branch (non-empty hunks), if
  `lfsPointerDiffSides(text.hunks)` matches, render the notice instead of
  `DiffEditor`. Uniform across all diff sources.
- `BlamePanel.tsx`: when the joined hunk lines parse as a pointer, render
  the notice instead of the blame list.

## Error handling

Detection is total (returns null on any mismatch); a null simply falls
through to today's rendering. No failure modes are added.

## Testing

- `src/lib/lfsPointer.test.ts` (vitest): real pointer fixture (from the
  LeGit-Test-LFS repo), trailing-newline variant, negatives (near-miss
  first line, bad oid, missing size, >1024 chars, ordinary text), and
  diff-side cases: pointer-to-pointer change, add (old side empty), delete
  (new side empty), LFS-to-text conversion (must return null), text-only
  diff (null), empty hunks (null).
- Panel wiring is display-only; no component tests (no such seam exists in
  the project).

## Out of scope

Option (b) smudge-on-demand (the notice deliberately has no fetch button);
LFS icons in at-revision listings; any backend change.
