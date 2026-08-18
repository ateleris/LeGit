import type { LfsPointerInfo } from "../../lib/lfsPointer";
import { formatByteSize } from "../../lib/formatBytes";

const short = (oid: string) => oid.slice(0, 12);

/**
 * Placeholder for Git LFS pointer content, mirroring the binary-file
 * placeholders: committed-blob views (File View at a revision, Blame,
 * Diff at a revision) never smudge, and an unsmudged working-tree stub has
 * the same shape - either way the pointer, not the payload, is what the
 * view received. Shows the REAL content size (the pointer's `size` key).
 *
 * Single-blob form: pass `info`. Diff form: pass `oldInfo`/`newInfo`
 * (null side = file added/removed).
 */
export function LfsPointerNotice({
  info,
  oldInfo,
  newInfo,
}: {
  info?: LfsPointerInfo | null;
  oldInfo?: LfsPointerInfo | null;
  newInfo?: LfsPointerInfo | null;
}) {
  const style: React.CSSProperties = { display: "block", padding: 8, fontSize: "var(--fz-md)" };
  if (info) {
    return (
      <span className="legit-subtle" style={style}>
        Git LFS file, {formatByteSize(info.size)}. The content is stored in Git LFS
        (oid {short(info.oid)}); this view shows only its pointer.
      </span>
    );
  }
  const from = oldInfo
    ? `${formatByteSize(oldInfo.size)} (oid ${short(oldInfo.oid)})`
    : "added";
  const to = newInfo
    ? `${formatByteSize(newInfo.size)} (oid ${short(newInfo.oid)})`
    : "removed";
  return (
    <span className="legit-subtle" style={style}>
      Git LFS file changed: {from} → {to}. The content is stored in Git LFS; no text
      diff to show.
    </span>
  );
}
