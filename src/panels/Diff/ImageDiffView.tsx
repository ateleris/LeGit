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
      <span className="legit-subtle" style={{ fontSize: "var(--fz-sm)" }}>
        {label}
      </span>
      <span className="legit-subtle" style={{ fontSize: "var(--fz-md)" }}>
        {sideNotice(preview)}
      </span>
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
