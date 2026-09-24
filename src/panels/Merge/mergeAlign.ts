// Pure cross-pane alignment math for the merge view: every pane pads each
// conflict block to the tallest version of that block, so fold bars, context
// and blocks sit level across the panes. Common stretches are identical text
// everywhere, so blocks are the only drift source.

/** One tracked result block, reduced to what alignment needs: its rendered
 * line count and, once composed, how many lines came from each side. */
export interface AlignBlock {
  len: number;
  origin: { ours: number; theirs: number } | null;
}

export interface Alignment {
  /** Line offset of the ours-derived segment inside each result slot. */
  offOurs: number[];
  /** Line offset of the theirs-derived segment inside each result slot. */
  offTheirs: number[];
  /** Each conflict slot's height: the tallest of the result block and each
   * side pane's block placed at its offset. */
  slotLens: number[];
}

/**
 * Segment offsets and slot heights. Unresolved blocks give exact offsets from
 * the marker layout (ours after `<<<<<<<`; theirs after `=======`, which in a
 * diff3 file also sits below the `|||||||` base section); a composed block's
 * offsets come from its origin counts.
 */
export function computeAlignment(
  blocks: readonly AlignBlock[],
  baseLens: readonly number[],
  regionLens: { ours: readonly number[]; theirs: readonly number[] },
): Alignment {
  const offOurs = blocks.map((b) => (b.origin === null ? 1 : 0));
  const offTheirs = blocks.map((b, i) => {
    if (b.origin !== null) return b.origin.ours;
    const baseSeg = baseLens[i] > 0 ? 1 + baseLens[i] : 0;
    return 1 + (regionLens.ours[i] ?? 0) + baseSeg + 1;
  });
  const slotLens = blocks.map((b, i) =>
    Math.max(
      b.len,
      (offOurs[i] ?? 0) + (regionLens.ours[i] ?? 0),
      (offTheirs[i] ?? 0) + (regionLens.theirs[i] ?? 0),
    ),
  );
  return { offOurs, offTheirs, slotLens };
}

/** The spacer paddings placing a pane's block inside its slot: `top` puts the
 * block at its segment offset, `bottom` fills the slot so the trailing
 * context aligns again. */
export function spacerPads(
  slotLen: number,
  ownLen: number,
  offset: number,
): { top: number; bottom: number } {
  return { top: offset, bottom: slotLen - offset - ownLen };
}
