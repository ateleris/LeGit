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

/** Extension check for the diff panel's SVG image routing (mirrors the
 * backend's `is_svg_path`): SVG is text to git, so it is extension-
 * triggered, never sniffed. */
export function isSvgPath(path: string): boolean {
  const ext = path.split(".").pop() ?? "";
  return path.length > 4 && ext.toLowerCase() === "svg";
}

export type FileViewSurface = "image" | "binary" | "lfs" | "text" | "pending";

/** Which surface File View renders for one file. The image preview is
 * requested for the same content the Diff panel routes to its image panes:
 * binary blobs, LFS pointers and `.svg` paths. An SVG waits for its preview
 * (`pending`) so the source never flashes before the image, and falls back
 * to its source when it does not preview as an image. */
export function fileViewSurface(args: {
  binary: boolean;
  lfsPointer: boolean;
  path: string;
  preview: FilePreview | undefined;
  previewPending: boolean;
}): FileViewSurface {
  const { binary, lfsPointer, preview, previewPending } = args;
  if (!fileViewWantsPreview(args)) return "text";
  if (preview?.kind === "image") return "image";
  if (binary) return "binary";
  if (lfsPointer) return "lfs";
  return previewPending ? "pending" : "text";
}

export function fileViewWantsPreview(args: { binary: boolean; lfsPointer: boolean; path: string }): boolean {
  return args.binary || args.lfsPointer || isSvgPath(args.path);
}
