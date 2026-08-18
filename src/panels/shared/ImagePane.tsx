import { useState } from "react";
import type { FilePreview, ImageFormat } from "../../lib/types";
import { formatByteSize } from "../../lib/formatBytes";

/** data: URL for an image preview payload (CSP is null; data URLs render). */
export function previewDataUrl(format: ImageFormat, base64: string): string {
  const mime = format === "ico" ? "image/x-icon" : `image/${format}`;
  return `data:${mime};base64,${base64}`;
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
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        alignItems: "center",
        minWidth: 0,
        minHeight: 0,
        flex: 1,
        padding: 8,
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
        <img
          src={previewDataUrl(preview.format, preview.base64)}
          onLoad={(e) =>
            setDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })
          }
          style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain", display: "block" }}
        />
      </div>
      <span className="legit-subtle" style={{ fontSize: "var(--fz-sm)" }}>
        {preview.format.toUpperCase()}
        {dims ? `, ${dims.w}×${dims.h}` : ""}, {formatByteSize(preview.size)}
      </span>
    </div>
  );
}
