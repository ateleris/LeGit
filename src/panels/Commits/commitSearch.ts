// Pure helpers behind the Commits panel's search features: the type-to-jump
// quick search over loaded rows, and the merge for "Any"-kind filter results
// (message + author are separate git invocations - git ANDs --grep and
// --author, so OR needs two walks merged client-side).

import type { Commit } from "../../lib/types";

/** The row fields quick search matches on (GitExtensions parity: commit
 * message subject, branch labels, tag names - not the author). */
type QuickSearchRow = Pick<Commit, "message" | "decorations">;

/**
 * Find the next loaded row matching `query` (case-insensitive substring of
 * the subject line or any ref decoration name), scanning circularly from
 * `startIndex` in `direction`. Returns the row index, or null when nothing
 * matches. `startIndex` is included in the scan - callers pass the current
 * row to keep a refined query anchored, or current±1 to step.
 */
export function quickSearchMatch(
  rows: readonly QuickSearchRow[],
  query: string,
  startIndex: number,
  direction: 1 | -1,
): number | null {
  const needle = query.trim().toLowerCase();
  if (!needle || rows.length === 0) return null;
  const n = rows.length;
  // Normalize the anchor into [0, n) so callers can pass cur±1 unclamped.
  const start = ((startIndex % n) + n) % n;
  for (let step = 0; step < n; step++) {
    const idx = (((start + step * direction) % n) + n) % n;
    const row = rows[idx];
    if (row.message.split("\n")[0].toLowerCase().includes(needle)) return idx;
    for (const dec of row.decorations ?? []) {
      if ("value" in dec && dec.value.toLowerCase().includes(needle)) return idx;
    }
  }
  return null;
}

/**
 * Merge two capped search-result lists (message hits + author hits) into one:
 * de-duplicated by id, newest first (commit timestamp, id as the
 * deterministic tie-break).
 */
export function mergeSearchResults(a: readonly Commit[], b: readonly Commit[]): Commit[] {
  const byId = new Map<string, Commit>();
  for (const c of a) byId.set(c.id, c);
  for (const c of b) if (!byId.has(c.id)) byId.set(c.id, c);
  return [...byId.values()].sort(
    (x, y) => y.timestamp - x.timestamp || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0),
  );
}
