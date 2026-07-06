// Small indicator of a file's line-ending style, shown in the Diff, File View,
// and Blame panels. Detection is backend-side (repo_line_ending_kind) because
// the blame/diff parsers strip newlines, so the frontend lacks the raw bytes.
//
// For a single-file view pass just `rev` (null = working tree). For a diff pass
// `oldRev` too: when the two sides differ (e.g. a CRLF→LF conversion) the badge
// shows "CRLF→LF".

import { useQuery } from "@tanstack/react-query";
import { repoLineEndingKind } from "../../lib/commands";
import type { LineEndingKind } from "../../lib/types";

/** Display label, or null for styles that shouldn't show a badge. */
function labelFor(kind: LineEndingKind | undefined): string | null {
  switch (kind) {
    case "lf":
      return "LF";
    case "crlf":
      return "CRLF";
    case "cr":
      return "CR";
    case "mixed":
      return "Mixed";
    default:
      // "none" (no line breaks) / "binary" / not-yet-loaded → no badge.
      return null;
  }
}

export function LineEndingBadge({
  repoId,
  path,
  rev,
  oldRev,
}: {
  repoId: string;
  path: string;
  /** null = working tree, ":" = index, else a rev spec. */
  rev?: string | null;
  /** The diff's other side; omit for single-file views. */
  oldRev?: string | null;
}) {
  const newRev = rev ?? null;
  const { data: newKind } = useQuery<LineEndingKind>({
    queryKey: [repoId, newRev === null ? "status" : "log", "line-ending", path, newRev],
    queryFn: () => repoLineEndingKind(repoId, path, newRev),
    staleTime: 10_000,
  });

  const hasOld = oldRev !== undefined;
  const oldSide = oldRev ?? null;
  const { data: oldKind } = useQuery<LineEndingKind>({
    queryKey: [repoId, oldSide === null ? "status" : "log", "line-ending-old", path, oldSide],
    queryFn: () => repoLineEndingKind(repoId, path, oldSide),
    enabled: hasOld,
    staleTime: 10_000,
  });

  const newLabel = labelFor(newKind);
  if (!newLabel) return null;

  const oldLabel = hasOld ? labelFor(oldKind) : null;
  const showArrow = !!oldLabel && oldLabel !== newLabel;
  const text = showArrow ? `${oldLabel}→${newLabel}` : newLabel;
  const attention = newKind === "mixed" || showArrow;

  return (
    <span
      title={`Line endings: ${showArrow ? `${oldLabel} → ${newLabel}` : newLabel}`}
      style={{
        flexShrink: 0,
        fontSize: "var(--fz-xs)",
        fontFamily: "monospace",
        letterSpacing: "0.02em",
        padding: "0 6px",
        borderRadius: 999,
        lineHeight: 1.7,
        whiteSpace: "nowrap",
        color: attention ? "var(--status-modified)" : "var(--subtle-fg)",
        border: `1px solid ${attention ? "var(--status-modified)" : "var(--panel-border)"}`,
      }}
    >
      {text}
    </span>
  );
}
