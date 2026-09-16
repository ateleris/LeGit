import type { FileTreeEntry } from "../shared/FileTree/buildTree";
import type { Section } from "./selection";

/**
 * In-flight stage/unstage/discard targets per section. Rapid keyboard
 * staging queues several ops, so the sets ACCUMULATE across ops and shrink
 * per file as git confirms each move (prunePending) or an op fails
 * (removePending). All updates are identity-preserving when nothing changes.
 */
export type PendingSections = Readonly<Record<Section, ReadonlySet<string>>>;

export const NO_PENDING: PendingSections = { unstaged: new Set(), staged: new Set() };

export function mergePending(
  p: PendingSections,
  section: Section,
  paths: readonly string[],
): PendingSections {
  if (paths.every((x) => p[section].has(x))) return p;
  return { ...p, [section]: new Set([...p[section], ...paths]) };
}

/** Keep only pending paths still present in the section's entries. */
export function prunePending(
  p: PendingSections,
  section: Section,
  present: ReadonlySet<string>,
): PendingSections {
  const kept = [...p[section]].filter((x) => present.has(x));
  if (kept.length === p[section].size) return p;
  return { ...p, [section]: new Set(kept) };
}

export function removePending(
  p: PendingSections,
  section: Section,
  paths: readonly string[],
): PendingSections {
  const kept = [...p[section]].filter((x) => !paths.includes(x));
  if (kept.length === p[section].size) return p;
  return { ...p, [section]: new Set(kept) };
}

/**
 * Render in-flight stage/unstage/discard targets dimmed in place: the rows
 * stay where git still reports them, visibly "on their way out", instead of
 * sitting untouched until the status refetch moves them. Identity-preserving
 * when nothing is pending.
 */
export function dimPending(
  entries: FileTreeEntry[],
  pending: ReadonlySet<string>,
): FileTreeEntry[] {
  if (pending.size === 0 || !entries.some((e) => pending.has(e.path))) return entries;
  return entries.map((e) => (pending.has(e.path) ? { ...e, dimmed: true } : e));
}
