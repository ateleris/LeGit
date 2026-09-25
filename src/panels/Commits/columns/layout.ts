// Grid layout derivation for the Commits columns: which columns render, each
// one's grid track, and the shared row/header width floor. Pure, so the
// sizing rules are testable without the panel.

import {
  COLUMN_GAP,
  columnGridTrack,
  columnsMinWidth,
  type ColumnId,
} from "./types";
import type { ColumnState } from "./types";

export interface ColumnLayout {
  /** Order-filtered visible columns (the graph hides under an author filter). */
  visibleColumns: ColumnId[];
  /** Grid track per column id. */
  colWidth: (id: ColumnId) => string;
  /** The full grid-template-columns value. */
  gridColumns: string;
  /** Shared width floor for the header grid and the row container: a bare
   * `width: 100%` resolves to the scroller's VIEWPORT width, so with a
   * horizontal scrollbar the selection background ended mid-row. */
  minRowWidth: number;
  graphColWidth: number;
}

export function computeColumnLayout(args: {
  colState: ColumnState;
  /** The graph column hides under an author filter - lanes/edges between an
   * arbitrary subset of commits would be meaningless. */
  authorFilterActive: boolean;
  maxVisibleLane: number;
  laneSpacing: number;
  uiFontSize: number;
  maxWidths: Partial<Record<ColumnId, number>>;
}): ColumnLayout {
  const { colState, authorFilterActive, maxVisibleLane, laneSpacing, uiFontSize, maxWidths } = args;

  // The Graph column's width tracks the maximum visible lane; Subject is
  // always the elastic filler. All others use the persisted px width
  // (or DEFAULT_WIDTHS if not yet set).
  const graphColWidth = (maxVisibleLane + 2) * laneSpacing;
  const visibleColumns = colState.order.filter(
    (id) => !colState.hidden.includes(id) && !(authorFilterActive && id === "graph"),
  );

  // Signed column: fixed one-icon width, derived from the UI font size so it
  // scales with the rest of the chrome (icons render at 1em of the text size).
  const signedColWidth = Math.round(uiFontSize * 1.3);

  // Subject never collapses below ~10 characters (see columnGridTrack).
  const subjectMinWidth = Math.round(uiFontSize * 10);

  const trackOpts = {
    graphColWidth,
    signedColWidth,
    subjectMinWidth,
    widths: colState.widths,
    maxWidths,
  };
  const colWidth = (id: ColumnId): string => columnGridTrack(id, trackOpts);

  return {
    visibleColumns,
    colWidth,
    gridColumns: visibleColumns.map(colWidth).join(" "),
    // 24 = the rows'/header's horizontal padding (border-box).
    minRowWidth: columnsMinWidth(visibleColumns, trackOpts, COLUMN_GAP, 24),
    graphColWidth,
  };
}

/** The column order after dragging `draggedId` next to `targetId`; null for
 * a no-op (same column, or an id missing from the order). */
export function reorderColumns(
  order: readonly ColumnId[],
  draggedId: ColumnId,
  targetId: ColumnId,
  side: "left" | "right",
): ColumnId[] | null {
  if (draggedId === targetId) return null;
  const newOrder = [...order];
  const fromIdx = newOrder.indexOf(draggedId);
  if (fromIdx === -1) return null;
  newOrder.splice(fromIdx, 1);
  const toIdx = newOrder.indexOf(targetId);
  if (toIdx === -1) return null;
  const insertAt = toIdx + (side === "right" ? 1 : 0);
  newOrder.splice(insertAt, 0, draggedId);
  return newOrder;
}
