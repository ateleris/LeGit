import { useState } from "react";
import type { FilePreview, ImageFormat } from "../../lib/types";
import { formatByteSize } from "../../lib/formatBytes";
import { svgPaintedNothing } from "./svgPaintCheck";

/** data: URL for an image preview payload (CSP is null; data URLs render). */
export function previewDataUrl(format: ImageFormat, base64: string): string {
  const mime =
    format === "ico" ? "image/x-icon" : format === "svg" ? "image/svg+xml" : `image/${format}`;
  return `data:${mime};base64,${base64}`;
}

/** An SVG without width/height attributes loads with no intrinsic size
 * (engines report 0), so an unstyled `<img>` collapses to nothing; such
 * images get explicit box-filling dimensions instead. SVG-only: a raster
 * image reporting 0 is broken, and stretching it would hide that. */
export function needsSvgSizeFallback(
  format: ImageFormat,
  naturalWidth: number,
  naturalHeight: number,
): boolean {
  return format === "svg" && (naturalWidth === 0 || naturalHeight === 0);
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
  const [paintedNothing, setPaintedNothing] = useState(false);
  const [sizeFallback, setSizeFallback] = useState(false);
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "0.333em",
        alignItems: "center",
        minWidth: 0,
        minHeight: 0,
        flex: 1,
        padding: "0.667em",
      }}
    >
      {label && (
        <span className="legit-subtle" style={{ fontSize: "var(--fz-sm)" }}>
          {label}
        </span>
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
        {paintedNothing && (
          <span
            className="legit-subtle"
            style={{ fontSize: "var(--fz-sm)", padding: "0.667em", textAlign: "center" }}
          >
            This SVG draws via scripts or external files, which the image preview cannot load.
          </span>
        )}
        <img
          src={previewDataUrl(preview.format, preview.base64)}
          onLoad={(e) => {
            const { naturalWidth, naturalHeight } = e.currentTarget;
            setDims({ w: naturalWidth, h: naturalHeight });
            setSizeFallback(needsSvgSizeFallback(preview.format, naturalWidth, naturalHeight));
            setPaintedNothing(preview.format === "svg" && svgPaintedNothing(e.currentTarget));
          }}
          style={{
            maxWidth: "100%",
            maxHeight: "100%",
            objectFit: "contain",
            ...(sizeFallback ? { width: "100%", height: "100%" } : null),
            // Stays mounted while hidden: the next preview's load event must
            // still fire here to re-evaluate the notice.
            display: paintedNothing ? "none" : "block",
          }}
        />
      </div>
      <span className="legit-subtle" style={{ fontSize: "var(--fz-sm)" }}>
        {preview.format.toUpperCase()}
        {dims && dims.w > 0 && dims.h > 0 ? `, ${dims.w}×${dims.h}` : ""},{" "}
        {formatByteSize(preview.size)}
      </span>
    </div>
  );
}
