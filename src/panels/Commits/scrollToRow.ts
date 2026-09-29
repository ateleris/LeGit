// Scroll policy for programmatic jumps to a commit row (externally-driven
// selection, create-branch flows): center the target row in the viewport,
// but only when it actually needs scrolling into view.

/** The virtualizer's currently visible row range (tanstack `Virtualizer.range`). */
export interface VisibleRange {
  startIndex: number;
  endIndex: number;
}

/**
 * True when jumping to `index` should scroll (centered), false when the row is
 * already safely visible and the list must not move under the user. The first
 * and last visible rows count as "needs scrolling": they may be clipped by the
 * viewport edge, and centering a barely-visible target is the point here.
 * A `null` range means the virtualizer hasn't measured yet - scroll.
 */
export function shouldCenterScroll(index: number, range: VisibleRange | null): boolean {
  if (!range) return true;
  return index <= range.startIndex || index >= range.endIndex;
}

/** Commits a seek loads before asking the user whether to keep going; each
 * confirmation raises the limit by another step. */
export const JUMP_SEEK_STEP = 50_000;

/**
 * Next step for a jump whose target commit may be beyond the loaded window:
 * scroll when the row is loaded; otherwise keep extending the walk while the
 * backend still returns full pages - pausing to ask at every `limit` commits
 * loaded, so a deep target can't silently pull an unbounded history into
 * memory; once the log is exhausted, give up - the commit is not reachable
 * in the walked refs at all (e.g. it sits on a remote branch hidden from the
 * walk), so more loading can never find it.
 */
export function pendingJumpAction(
  found: boolean,
  hasMore: boolean,
  loadedCount: number,
  limit: number,
): "scroll" | "extend" | "askToContinue" | "giveUp" {
  if (found) return "scroll";
  if (!hasMore) return "giveUp";
  return loadedCount >= limit ? "askToContinue" : "extend";
}

/**
 * Window growth while seeking a not-yet-loaded commit: double the total
 * window (`totalToFetch = PAGE_SIZE * (1 + extraPages)`) instead of adding
 * one page like infinite scroll does. Growth fetches only the missing tail,
 * so doubling costs O(n) total work in O(log n) requests for a commit n
 * deep - one-page steps would take O(n / page) requests to reach it.
 */
export function growJumpWindow(extraPages: number): number {
  return extraPages * 2 + 1;
}
