import type { DiffHunk } from "./types";

/** A parsed Git LFS pointer: the content's oid and REAL payload size (the
 * `size` key), not the pointer blob's own size. */
export interface LfsPointerInfo {
  oid: string;
  size: number;
}

// The LFS spec mandates: first line is the version URL, `oid sha256:<hex>`
// and `size <n>` lines follow, every line is a `key value` pair, and the
// whole pointer stays under 1024 bytes. Validation is strict so ordinary
// text can never masquerade as a pointer (a false positive would HIDE real
// file content behind the placeholder).
const VERSION_PREFIX = "version https://git-lfs.github.com/spec/";
const OID_RE = /^oid sha256:([0-9a-f]{64})$/;
const SIZE_RE = /^size (\d+)$/;
const KEY_VALUE_RE = /^[a-z0-9._-]+ \S.*$/i;
const MAX_POINTER_BYTES = 1024;

/** Parse `text` as a Git LFS pointer blob; null for anything else. */
export function parseLfsPointer(text: string): LfsPointerInfo | null {
  if (text.length === 0 || text.length >= MAX_POINTER_BYTES) return null;
  const lines = text.replace(/\n$/, "").split("\n");
  if (!lines[0]?.startsWith(VERSION_PREFIX)) return null;
  let oid: string | null = null;
  let size: number | null = null;
  for (const line of lines.slice(1)) {
    const oidMatch = OID_RE.exec(line);
    if (oidMatch) {
      oid = oidMatch[1];
      continue;
    }
    const sizeMatch = SIZE_RE.exec(line);
    if (sizeMatch) {
      size = Number(sizeMatch[1]);
      continue;
    }
    // Unknown keys (pointer extensions) are fine; a non key-value line
    // means this is not a pointer at all.
    if (!KEY_VALUE_RE.test(line)) return null;
  }
  return oid !== null && size !== null ? { oid, size } : null;
}

/** Rebuild both sides of a text diff and classify them as LFS pointers.
 * Non-null only when at least one side exists and every existing side is a
 * pointer - so an LFS-to-text conversion keeps its normal, informative
 * text diff. A pointer file is only a few lines, so the standard context
 * window always contains both complete sides. */
export function lfsPointerDiffSides(
  hunks: DiffHunk[],
): { oldInfo: LfsPointerInfo | null; newInfo: LfsPointerInfo | null } | null {
  const oldLines: string[] = [];
  const newLines: string[] = [];
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.kind !== "Added") oldLines.push(line.content);
      if (line.kind !== "Removed") newLines.push(line.content);
    }
  }
  const oldInfo = oldLines.length ? parseLfsPointer(oldLines.join("\n")) : null;
  const newInfo = newLines.length ? parseLfsPointer(newLines.join("\n")) : null;
  // Every non-empty side must be a pointer, and at least one side must exist.
  if (oldLines.length > 0 && oldInfo === null) return null;
  if (newLines.length > 0 && newInfo === null) return null;
  if (oldInfo === null && newInfo === null) return null;
  return { oldInfo, newInfo };
}
