import type { FileStatus } from "./types";

/** Above this many countable entries, line counts are computed only when the
 * user asks: counting reads every changed file's content. */
export const STATUS_COUNTS_AUTO_MAX = 200;

const COUNTLESS_STATES = new Set<FileStatus["state"]>([
  "Untracked",
  "Ignored",
  "Conflicted",
  "SubmoduleChanged",
  "SubmoduleDirty",
]);

/** Entries git can report line counts for (mirrors the backend's
 * `wants_counts`). */
export function countableEntries(status: readonly FileStatus[]): number {
  let n = 0;
  for (const s of status) if (!COUNTLESS_STATES.has(s.state)) n++;
  return n;
}

export type StatusCountsMode = "none" | "auto" | "on_demand";

/** Whether line counts load by themselves, need a request, or do not apply. */
export function statusCountsMode(countable: number): StatusCountsMode {
  if (countable === 0) return "none";
  return countable <= STATUS_COUNTS_AUTO_MAX ? "auto" : "on_demand";
}

const key = (s: FileStatus) => `${s.staged ? "s" : "u"}\0${s.path}`;

/** Fill line counts and binary flags from a counted status into the fast
 * one. The fast list stays the truth for WHICH entries exist: counts for an
 * entry that is gone are dropped, an entry the counted list has not seen yet
 * keeps none. */
export function mergeStatusCounts(
  status: readonly FileStatus[],
  counted: readonly FileStatus[] | undefined,
): FileStatus[] {
  if (!counted || counted.length === 0) return status as FileStatus[];
  const byKey = new Map(counted.map((c) => [key(c), c]));
  return status.map((s) => {
    const c = byKey.get(key(s));
    return c ? { ...s, additions: c.additions, deletions: c.deletions, binary: c.binary } : s;
  });
}
