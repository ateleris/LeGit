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
      return `too large to preview (${formatByteSize(p.size)}, cap 20 MiB)`;
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
