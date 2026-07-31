// Pure selection-to-lines mapping for the diff context menu: which changed
// lines does a text selection cover, expressed as line indices within the
// clicked hunk (the unit `apply_lines` stages/unstages/discards). Kept free of
// CodeMirror so the rules are unit-testable; the editor glue only converts
// selection ranges to covered row indices.

/** The row shape shared by the inline (`DiffRow`) and split (`SplitRow`)
 *  models - everything the selection mapping needs. */
export interface SelectableRow {
  hunkIndex: number;
  lineIndex: number;
  kind: string;
}

/**
 * Changed lines (`Added`/`Removed`) of the CLICKED row's hunk among the rows
 * covered by the selection, deduped and sorted - the payload for "Stage N
 * lines". `null` when the clicked row has no hunk (header band, trailing
 * expander) or the selection covers no changed line of that hunk; selected
 * lines of OTHER hunks are ignored by design (single-hunk rule, see the
 * 2026-07-31 multi-line-selection spec).
 */
export function selectedHunkLines(
  rows: readonly SelectableRow[],
  coveredRowIndices: readonly number[],
  clickedRowIndex: number,
): number[] | null {
  const clicked = rows[clickedRowIndex];
  if (!clicked || clicked.hunkIndex < 0) return null;
  const lines = new Set<number>();
  for (const i of coveredRowIndices) {
    const row = rows[i];
    if (!row || row.hunkIndex !== clicked.hunkIndex || row.lineIndex < 0) continue;
    if (row.kind === "Added" || row.kind === "Removed") lines.add(row.lineIndex);
  }
  if (lines.size === 0) return null;
  return [...lines].sort((a, b) => a - b);
}

export type LineAction = "stage" | "unstage" | "discard";

const ACTION_VERB: Record<LineAction, string> = {
  stage: "Stage",
  unstage: "Unstage",
  discard: "Discard",
};

/** Menu label for a line action: "Stage line" or "Stage N lines". */
export function lineActionLabel(action: LineAction, n: number): string {
  return n === 1 ? `${ACTION_VERB[action]} line` : `${ACTION_VERB[action]} ${n} lines`;
}
