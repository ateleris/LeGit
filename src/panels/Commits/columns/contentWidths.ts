// Content-derived width caps for the Commits panel's text columns.
//
// The Author / Date / SHA columns must never grow past what their content
// needs (plus padding): a wide panel gives the surplus to the elastic
// Subject column instead. The cap is derived from the widest RENDERED value
// among the loaded rows (and the column's header label, which must not
// ellipsize either), measured at the actual row/header fonts so everything
// stays scaled to the global UI font size - no fixed px.
//
// `contentWidthCap` is the pure decision logic (unit-tested with a fake
// measurer); `computeContentMaxWidths` is the thin DOM layer that feeds it
// canvas `measureText` measurers for the concrete fonts.

import { MIN_COLUMN_WIDTH } from "./types";
import type { ColumnId } from "./types";

/** Measures one string's rendered width in px for a fixed font. */
export type TextMeasure = (text: string) => number;

/**
 * One column's cap: the widest cell text or the header label, plus padding,
 * floored at MIN_COLUMN_WIDTH so the cap never undercuts the resize minimum.
 */
export function contentWidthCap(
  cellTexts: Iterable<string>,
  headerLabel: string,
  measureCell: TextMeasure,
  measureHeader: TextMeasure,
  padding: number,
): number {
  let widest = measureHeader(headerLabel);
  for (const t of cellTexts) widest = Math.max(widest, measureCell(t));
  return Math.max(MIN_COLUMN_WIDTH, Math.ceil(widest + padding));
}

/** The SHA cell always renders 8 monospace hex chars - one sample suffices. */
export const SHA_SAMPLE = "8".repeat(8);

interface ContentMaxWidthInputs {
  /** Rendered Author cell texts (dedup is the caller's choice; cheap either way). */
  authorTexts: Iterable<string>;
  /** Rendered Date cell texts under the current date-format settings. */
  dateTexts: Iterable<string>;
  /** The concrete UI font size in px (rows render at exactly this size). */
  uiFontSize: number;
  /** Header labels for the capped columns (COLUMN_LABELS). */
  headerLabels: Pick<Record<ColumnId, string>, "author" | "date" | "sha">;
}

/** Canvas-based measurer for a CSS font shorthand (shared 2D context). */
function canvasMeasurer(font: string): TextMeasure {
  const ctx = measureContext();
  if (!ctx) return () => 0;
  return (text) => {
    ctx.font = font;
    return ctx.measureText(text).width;
  };
}

let sharedContext: CanvasRenderingContext2D | null | undefined;
function measureContext(): CanvasRenderingContext2D | null {
  if (sharedContext === undefined) {
    sharedContext = document.createElement("canvas").getContext("2d");
  }
  return sharedContext;
}

/**
 * Compute the `maxWidths` ctx for `columnGridTrack` / `columnsMinWidth`:
 * caps for Author, Date, and SHA. Refs (chips), Graph, Signed, and Subject
 * are not content-capped.
 */
export function computeContentMaxWidths(
  inputs: ContentMaxWidthInputs,
): Partial<Record<ColumnId, number>> {
  const { uiFontSize } = inputs;
  const family = getComputedStyle(document.body).fontFamily || "sans-serif";
  const measureCell = canvasMeasurer(`${uiFontSize}px ${family}`);
  // The SHA cell renders in the generic monospace family (see CommitsPanel).
  const measureSha = canvasMeasurer(`${uiFontSize}px monospace`);
  // Header: --fz-sm (= uiFontSize - 1, global.css), weight 600, uppercase,
  // 0.04em letter-spacing. measureText ignores letter-spacing, so add it
  // per character; uppercase before measuring.
  const headerSize = uiFontSize - 1;
  const measureHeaderFont = canvasMeasurer(`600 ${headerSize}px ${family}`);
  const measureHeader: TextMeasure = (text) =>
    measureHeaderFont(text.toUpperCase()) + text.length * 0.04 * headerSize;
  // "Content plus padding": room for the cell/edge breathing space and the
  // header's resize handle, scaled with the font like everything else.
  const padding = Math.round(uiFontSize * 0.75);

  return {
    author: contentWidthCap(inputs.authorTexts, inputs.headerLabels.author, measureCell, measureHeader, padding),
    date: contentWidthCap(inputs.dateTexts, inputs.headerLabels.date, measureCell, measureHeader, padding),
    sha: contentWidthCap([SHA_SAMPLE], inputs.headerLabels.sha, measureSha, measureHeader, padding),
  };
}
