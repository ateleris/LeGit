import { useMemo, useState } from "react";
import type { FilePreview, ImageFormat } from "../../lib/types";
import { formatByteSize } from "../../lib/formatBytes";
import { svgPaintedNothing } from "./svgPaintCheck";
import { decodeBase64Utf8, svgLacksIntrinsicSize, svgUsesInheritedColor } from "./svgPreviewMarkup";

/** data: URL for an image preview payload (CSP is null; data URLs render). */
export function previewDataUrl(format: ImageFormat, base64: string): string {
  const mime =
    format === "ico" ? "image/x-icon" : format === "svg" ? "image/svg+xml" : `image/${format}`;
  return `data:${mime};base64,${base64}`;
}

/** What the pane must know about an SVG payload: whether it has to be sized
 * explicitly, and whether its `currentColor` paint shows as black for lack of
 * a colour to inherit. An undecodable payload reports neither. */
export function svgPreviewFacts(base64: string): {
  lacksIntrinsicSize: boolean;
  usesInheritedColor: boolean;
} {
  try {
    const markup = decodeBase64Utf8(base64);
    return {
      lacksIntrinsicSize: svgLacksIntrinsicSize(markup),
      usesInheritedColor: svgUsesInheritedColor(markup),
    };
  } catch {
    return { lacksIntrinsicSize: false, usesInheritedColor: false };
  }
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
  const svg = useMemo(
    () => (preview.format === "svg" ? svgPreviewFacts(preview.base64) : null),
    [preview.format, preview.base64],
  );
  const sizeFallback = svg?.lacksIntrinsicSize ?? false;
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
            setPaintedNothing(preview.format === "svg" && svgPaintedNothing(e.currentTarget));
          }}
          style={{
            maxWidth: "100%",
            maxHeight: "100%",
            objectFit: "contain",
            // An explicit em width, never a percentage: the box around the
            // image is content-sized, and an image with no intrinsic size
            // contributes nothing to it, so a percentage resolves to zero.
            ...(sizeFallback ? { width: "20em", height: "auto" } : null),
            // Stays mounted while hidden: the next preview's load event must
            // still fire here to re-evaluate the notice.
            display: paintedNothing ? "none" : "block",
          }}
        />
      </div>
      <span className="legit-subtle" style={{ fontSize: "var(--fz-sm)" }}>
        {preview.format.toUpperCase()}
        {dims && !sizeFallback && dims.w > 0 && dims.h > 0 ? `, ${dims.w}×${dims.h}` : ""},{" "}
        {formatByteSize(preview.size)}
      </span>
      {svg?.usesInheritedColor && (
        <span className="legit-subtle" style={{ fontSize: "var(--fz-xs)", textAlign: "center" }}>
          currentColor shown as black
        </span>
      )}
    </div>
  );
}
