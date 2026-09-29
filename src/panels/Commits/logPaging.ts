// Incremental log paging: the Commits panel grows its window by fetching
// only the next page (`repoLog` with an offset) and appending, instead of
// refetching the whole window. Real commits paginate cleanly, but the
// backend injects ALL stashes into every requested window (positioned by
// committer date, with stashes older than the window appended at its end),
// so the seam between pages needs merging - pure and unit-tested here.

import type { Commit } from "../../lib/types";

export function isStashNode(c: Commit): boolean {
  return (c.decorations ?? []).some((d) => d.type === "stash");
}

/** Real commits in the window - injected stash nodes don't count toward the
 * fetched page size (`--max-count` caps only real commits). */
export function countRealCommits(commits: readonly Commit[]): number {
  return commits.reduce((n, c) => n + (isStashNode(c) ? 0 : 1), 0);
}

/**
 * Append the next log page to the loaded window, reconciling the stash
 * injection at the seam so the result matches what one full-window fetch
 * would return:
 * - the window's trailing stash run is displaced (older than everything
 *   loaded); the page re-injects those stashes at their true position, so
 *   trim them and let the page's copies win,
 * - stashes already placed INSIDE the window arrive again at the page's
 *   head (they are newer than the whole page); drop those copies,
 * - duplicate real commits (refs moved between fetches) are dropped too.
 * A page without real commits appends nothing - and must not trim: at the
 * end of history a trailing stash is correctly placed.
 */
export function appendLogPage(acc: Commit[], page: Commit[]): Commit[] {
  if (countRealCommits(page) === 0) return acc;
  let cut = acc.length;
  while (cut > 0 && isStashNode(acc[cut - 1])) cut--;
  const kept = acc.slice(0, cut);
  const seen = new Set(kept.map((c) => c.id));
  return kept.concat(page.filter((c) => !seen.has(c.id)));
}
