// Pure fold arithmetic for the merge view's collapsed common stretches: a
// fold's base line range shrinks as gap reveals eat into it (down from the
// top edge, up from the bottom), collapses entirely below a minimum
// remainder, and its bar describes the visible chunk BELOW it, exactly like
// a diff hunk header. All line values are 0-based unless a name says 1-based.

export interface FoldBase {
  from: number;
  to: number;
}

export interface GapReveal {
  down: number;
  up: number;
}

/** The fold's current (reveal-adjusted) range, or null when it has shrunk
 * below `minRemainder` and no placeholder is rendered any more. */
export function foldRange(
  base: FoldBase,
  reveal: GapReveal,
  minRemainder: number,
): FoldBase | null {
  const from = base.from + reveal.down;
  const to = base.to - reveal.up;
  return to - from + 1 >= minRemainder ? { from, to } : null;
}

/** The visible chunk below fold `slot` (1-based start line + count), ending
 * at the next still-active fold or the file end. Null once the fold itself
 * has collapsed (its bar is gone with it). */
export function chunkBelowFold(
  slot: number,
  bases: readonly FoldBase[],
  reveals: readonly (GapReveal | undefined)[],
  totalLines: number,
  minRemainder: number,
): { start: number; count: number } | null {
  const revealOf = (k: number) => reveals[k] ?? { down: 0, up: 0 };
  const own = foldRange(bases[slot], revealOf(slot), minRemainder);
  if (!own) return null;
  const start0 = own.to + 1;
  let end0 = totalLines - 1;
  for (let j = slot + 1; j < bases.length; j++) {
    const next = foldRange(bases[j], revealOf(j), minRemainder);
    if (next) {
      end0 = next.from - 1;
      break;
    }
  }
  return { start: start0 + 1, count: Math.max(0, end0 - start0 + 1) };
}

/** The fold bar's text: the chunk below it in this pane's own numbering
 * (both pairs identical - a fold hides common text, not a change), or ""
 * when nothing follows (a fold reaching the file end). */
export function foldBarLabel(chunk: { start: number; count: number } | null): string {
  return chunk && chunk.count > 0
    ? `@@ -${chunk.start},${chunk.count} +${chunk.start},${chunk.count} @@`
    : "";
}

/** Sensible reveal directions for a fold: the one at the file start can only
 * be revealed upward, the one reaching the file end only downward (same rule
 * as the diff's first/last hunk headers). */
export function slotDirection(base: FoldBase, totalLines: number): "both" | "up" | "down" {
  if (base.from === 0) return "up";
  if (base.to === totalLines - 1) return "down";
  return "both";
}
