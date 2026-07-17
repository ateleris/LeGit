// Shared source of truth for "which changed files have noteworthy line
// endings": one batch query per repo (repo_line_ending_status), keyed under
// the status domain so the watcher and invalidateRepoDomains keep it fresh.
// The Working Changes row chips, the Diff/Merge working-vs-index badges,
// and the commit warning all read this map - list and diff can never
// disagree because they share one source.

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { repoLineEndingStatus } from "../../lib/commands";
import type { LineEndingKind, LineEndingStatusEntry } from "../../lib/types";

export function useLineEndingStatusMap(
  repoId: string | undefined,
  enabled: boolean,
): Map<string, LineEndingStatusEntry> {
  const { data } = useQuery<LineEndingStatusEntry[]>({
    queryKey: [repoId, "status", "line-endings"],
    queryFn: () => repoLineEndingStatus(repoId!),
    enabled: !!repoId && enabled,
    staleTime: 5_000,
  });
  return useMemo(() => new Map((data ?? []).map((e) => [e.path, e])), [data]);
}

/** Display label, or null for styles that shouldn't show a chip. */
export function eolLabel(kind: LineEndingKind | null | undefined): string | null {
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
      return null; // none / binary / unknown
  }
}

const CONCRETE = new Set<LineEndingKind>(["lf", "crlf", "cr"]);

export interface RowChipContent {
  text: string;
  title: string;
  /** Concrete kind the revert action would rewrite to; null = passive chip. */
  revertTarget: "lf" | "crlf" | "cr" | null;
}

/**
 * Attention-only chip content for a Working Changes row: null unless the
 * side has a transition, or (unstaged side) the working file is mixed. The
 * revert action exists only for unstaged transitions from a concrete kind -
 * it rewrites the WORKING file, which cannot fix a staged blob.
 */
export function rowChipContent(
  entry: LineEndingStatusEntry,
  side: "unstaged" | "staged",
): RowChipContent | null {
  const t = side === "unstaged" ? entry.unstaged : entry.staged;
  if (t) {
    const from = eolLabel(t.from);
    const to = eolLabel(t.to);
    if (!from || !to) return null;
    const revertable = side === "unstaged" && CONCRETE.has(t.from);
    return {
      text: `${from}→${to}`,
      title: `Line endings: ${from} → ${to}`,
      revertTarget: revertable ? (t.from as "lf" | "crlf" | "cr") : null,
    };
  }
  if (side === "unstaged" && entry.mixed) {
    return { text: "Mixed", title: "Line endings: Mixed", revertTarget: null };
  }
  return null;
}
