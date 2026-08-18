// Column types and defaults for the Commits panel.
//
// The column system is frontend-owned: the backend stores the serialized
// preferences as opaque JSON (`column_preferences` in GlobalSettings).
// See DESIGN-v0.4.md §C.5 for default order and §I.1 for the versioned
// persistence schema.

export type ColumnId = "refs" | "graph" | "signed" | "subject" | "date" | "author" | "sha";

/** Runtime, in-memory column state held by `useColumnState`. */
export interface ColumnState {
  /** Visible columns in display order (left-to-right). */
  order: ColumnId[];
  /** Hidden columns — surfaced in the "Show columns" submenu. */
  hidden: ColumnId[];
  /** Pixel widths per column. Graph is omitted (dynamic from lane count). */
  widths: Partial<Record<ColumnId, number>>;
}

/** On-disk shape persisted via `save_column_preferences`. §I.1 */
export interface ColumnPreferences {
  format: "legit-commits-columns";
  formatVersion: 1;
  order: ColumnId[];
  hidden: ColumnId[];
  widths: Partial<Record<ColumnId, number>>;
}

/** Default column order — SHA is hidden by default (§C.5). */
export const DEFAULT_ORDER: ColumnId[] = [
  "refs",
  "graph",
  "signed",
  "subject",
  "date",
  "author",
  "sha",
];
export const DEFAULT_HIDDEN: ColumnId[] = ["sha"];
export const DEFAULT_WIDTHS: Partial<Record<ColumnId, number>> = {
  refs: 150,
  subject: 300,
  date: 100,
  author: 130,
  sha: 80,
};

/** Grid track for one column. Subject is the elastic filler WITH A FLOOR:
 *  a bare "1fr" collapses to zero width when the panel is narrower than the
 *  fixed columns' sum (the 1280x800 E2E window hit this - subjects were
 *  invisible and unclickable), while `minmax` keeps it readable and lets the
 *  grid overflow-scroll instead. Pinned by useColumnState.test.ts. */
interface ColumnWidthCtx {
  graphColWidth: number;
  signedColWidth: number;
  subjectMinWidth: number;
  widths: Partial<Record<ColumnId, number>>;
}

/** One column's minimum px width (subject: its minmax floor). */
function columnMinPx(id: ColumnId, ctx: ColumnWidthCtx): number {
  if (id === "graph") return ctx.graphColWidth;
  if (id === "signed") return ctx.signedColWidth;
  if (id === "subject") return ctx.subjectMinWidth;
  return ctx.widths[id] ?? DEFAULT_WIDTHS[id] ?? 100;
}

export function columnGridTrack(id: ColumnId, ctx: ColumnWidthCtx): string {
  if (id === "subject") return `minmax(${ctx.subjectMinWidth}px, 1fr)`;
  return `${columnMinPx(id, ctx)}px`;
}

/**
 * The visible columns' total minimum width in px (tracks + gaps +
 * horizontal padding, border-box). The header grid AND the row container
 * both take this as `minWidth` so they always span the full horizontally
 * scrollable line - a bare `width: 100%` resolves to the scroller's
 * VIEWPORT width, which ended the selection background (and the header)
 * mid-row whenever the panel had a horizontal scrollbar.
 */
export function columnsMinWidth(
  ids: readonly ColumnId[],
  ctx: ColumnWidthCtx,
  gap: number,
  horizontalPadding: number,
): number {
  const tracks = ids.reduce((sum, id) => sum + columnMinPx(id, ctx), 0);
  return Math.ceil(tracks + gap * Math.max(0, ids.length - 1) + horizontalPadding);
}

/** All known column ids — used for validation when reading persisted prefs. */
export const ALL_COLUMN_IDS: readonly ColumnId[] = [
  "refs",
  "graph",
  "signed",
  "subject",
  "date",
  "author",
  "sha",
];

/**
 * Columns that are *not* user-resizable.
 * - Graph: width is dynamic, driven by the number of visible lanes.
 * - Signed: fixed one-icon width, derived from the UI font size.
 * - Subject: always the elastic "1fr" filler — a resize handle would have no
 *   effect (the grid ignores a px width for it).
 */
export const NON_RESIZABLE: ColumnId[] = ["graph", "signed", "subject"];

/**
 * Columns that cannot be hidden.
 * - Subject: hiding it would leave the panel content-free.
 */
export const NON_HIDEABLE: ColumnId[] = ["subject"];

/** Minimum pixel width when resizing. */
export const MIN_COLUMN_WIDTH = 40;

/**
 * Horizontal gap between grid columns (header and rows share it). The header
 * resize handles position themselves relative to this: a left-edge handle
 * must reach across the gap to sit on the previous column's separator line.
 */
export const COLUMN_GAP = 8;
