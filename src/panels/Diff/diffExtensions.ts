// The Diff view's CodeMirror extensions: decorations, gutters, widgets, the
// editable-pane extras, async syntax highlighting, and the shared helpers the
// ACTION PARITY invariant hangs on (see mountDiff.ts, which applies these to
// both the inline and the split view).

import { EditorState, type Range, StateEffect, StateField } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  GutterMarker,
  WidgetType,
  gutter,
  keymap,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import type { TextDiff } from "../../lib/types";
import type { DiffRow, Segment, SplitRow } from "./diffModel";
import type { RowState } from "./editableState";
import { selectedHunkLines } from "./selectionModel";
import { expanderPair, headerBand } from "../codemirror/hunkExpanders";
import { NumberMarker } from "../codemirror/gutters";
import { plusMinusIcon } from "../codemirror/gutters";
import {
  MAX_SYNTAX_CHARS,
  computeSyntaxSegments,
  type ContextSide,
  type SyntaxRow,
} from "./syntaxModel";
import { loadParserForPath } from "../codemirror/syntaxLanguages";

export type HunkAction = "stage" | "unstage" | "discard";
export type DiffViewMode = "inline" | "split";
/** Per-line action offered for a working-tree diff (null = read-only commit). */
export type LineActionOp = "stage" | "unstage" | null;

/** Apply an action to changed lines of one hunk (indices into the hunk's
 *  diff lines). The hover gutter sends a single line; the context menu may
 *  send a whole selection. */
export type LineActionHandler = (
  hunkIndex: number,
  lineIndices: number[],
  action: HunkAction,
) => void;

/** Right-click on a hunk. `lineIndex` is the clicked changed line (else
 *  null); `selectedLines` is the changed lines of THAT hunk covered by a
 *  text selection the click landed in (else null) - see `selectedHunkLines`. */
export type ContextMenuHandler = (
  hunkIndex: number,
  lineIndex: number | null,
  event: MouseEvent,
  selectedLines: number[] | null,
) => void;

const ACTION_LABEL: Record<HunkAction, string> = {
  stage: "Stage",
  unstage: "Unstage",
  discard: "Discard",
};

const ACTION_HOVER: Record<HunkAction, string> = {
  stage: "Stage this hunk",
  unstage: "Unstage this hunk",
  discard: "Discard this hunk",
};

export const INLINE_CLASS: Record<DiffRow["kind"], string | null> = {
  Added: "cm-diff-added",
  Removed: "cm-diff-removed",
  Context: null,
  Hunk: "cm-diff-hunk",
};

export const SPLIT_CLASS: Record<SplitRow["kind"], string | null> = {
  Added: "cm-diff-added",
  Removed: "cm-diff-removed",
  Context: null,
  Hunk: "cm-diff-hunk",
  Filler: "cm-diff-filler",
};

/** Strong intra-line (changed-character) background class for a row kind.
 *  Hunk headers use the mark to wrap their `@@ … @@` label in a span that can
 *  be pinned (sticky) against horizontal scrolling. */
export function wordClassFor(kind: string): string | null {
  if (kind === "Added") return "cm-diff-added-word";
  if (kind === "Removed") return "cm-diff-removed-word";
  if (kind === "Hunk") return "cm-diff-hunk-label";
  return null;
}

/** Intra-line mark ranges for a row: the changed-character segments, or the
 *  whole label for a hunk header. */
export function segmentsFor(kind: string, text: string, segments?: Segment[]): Segment[] | undefined {
  if (kind === "Hunk") return text.length > 0 ? [{ from: 0, to: text.length }] : undefined;
  return segments;
}


// Inline widget rendered at the very start of a hunk header line (left of the
// `@@ … @@` text). Renders the per-hunk actions as the app's normal buttons.
class ActionWidget extends WidgetType {
  constructor(
    private readonly hunkIndex: number,
    private readonly actions: HunkAction[],
    private readonly onAction?: (hunkIndex: number, action: HunkAction) => void
  ) {
    super();
  }
  eq(other: ActionWidget) {
    return other.hunkIndex === this.hunkIndex && other.actions.join() === this.actions.join();
  }
  toDOM() {
    const wrap = document.createElement("span");
    wrap.className = "cm-diff-hunk-actions";
    for (const action of this.actions) {
      const btn = document.createElement("button");
      btn.type = "button";
      if (action === "discard") btn.classList.add("cm-diff-discard");
      btn.textContent = ACTION_LABEL[action];
      btn.title = ACTION_HOVER[action];
      btn.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return; // left only; let right-click open the menu
        e.preventDefault();
        e.stopPropagation();
        this.onAction?.(this.hunkIndex, action);
      });
      wrap.appendChild(btn);
    }
    return wrap;
  }
  ignoreEvent() {
    return true;
  }
}

// A fixed-width column at the start of every (non-header) line, between the
// number gutters and the code. On a changed line it holds a +/− button that
// stages/unstages just that line. It is a GUTTER, not part of the document
// content: in editable mode the caret and typed text must never interact
// with it (an inline widget would sit inside the text flow), and gutters are
// sticky against horizontal scrolling for free.
class LineActionMarker extends GutterMarker {
  constructor(
    private readonly op: "stage" | "unstage",
    private readonly hunkIndex: number,
    private readonly lineIndex: number,
    private readonly onLineAction?: LineActionHandler
  ) {
    super();
  }
  eq(other: LineActionMarker) {
    return (
      other.op === this.op &&
      other.hunkIndex === this.hunkIndex &&
      other.lineIndex === this.lineIndex
    );
  }
  toDOM() {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cm-diff-line-action";
    btn.title = this.op === "stage" ? "Stage this line" : "Unstage this line";
    btn.appendChild(plusMinusIcon(this.op === "stage"));
    btn.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return; // left only; let right-click open the menu
      e.preventDefault();
      e.stopPropagation();
      this.onLineAction?.(this.hunkIndex, [this.lineIndex], this.op);
    });
    return btn;
  }
}



/** A line-number gutter that resolves each doc line's row through the row
 *  markers, so numbers stay correct (or blank, for user-inserted lines) while
 *  the document is edited. Read-only docs never change, so this is identical
 *  to direct indexing there. */
export function lineNumberGutter(
  rowState: RowState,
  getNo: (rowIndex: number) => number | null,
  cls: string,
  expanderFor?: (rowIndex: number) => GutterMarker | null
) {
  return gutter({
    class: cls,
    lineMarker(view, line) {
      const lineNo = view.state.doc.lineAt(line.from).number;
      const rowIndex = rowState.rowIndexAtLine(view.state, lineNo);
      if (rowIndex != null && expanderFor) {
        const marker = expanderFor(rowIndex);
        if (marker) return marker;
      }
      const n = rowIndex == null ? null : getNo(rowIndex);
      return n == null ? null : new NumberMarker(String(n));
    },
  });
}

export interface LineDeco {
  /** Full-line background class (lighter tint). */
  cls: string | null;
  /** Changed-character background class (stronger), applied over `segments`. */
  wordCls: string | null;
  segments?: Segment[];
  /** Inline widget at the line end (hunk action buttons). */
  widget?: () => WidgetType;
}

/**
 * Line-background + intra-line mark decorations and an optional trailing
 * hunk-action widget — all driven by a per-row lookup. (The per-line +/−
 * action column is a gutter, not a decoration: see `lineActionGutter`.)
 */
export function decorationField(getLine: (i: number) => LineDeco | null): StateField<DecorationSet> {
  const build = (state: EditorState): DecorationSet => {
    const ranges: Range<Decoration>[] = [];
    const total = state.doc.lines;
    for (let i = 0; i < total; i++) {
      const info = getLine(i);
      if (!info) continue;
      const line = state.doc.line(i + 1);
      if (info.cls) ranges.push(Decoration.line({ class: info.cls }).range(line.from));
      if (info.widget) {
        // At the line end so flex order is [text … actions]; pushed right via CSS.
        ranges.push(Decoration.widget({ widget: info.widget(), side: 1 }).range(line.to));
      }
      if (info.wordCls && info.segments) {
        for (const s of info.segments) {
          const from = line.from + s.from;
          const to = line.from + s.to;
          if (to > from && to <= line.to) {
            ranges.push(Decoration.mark({ class: info.wordCls }).range(from, to));
          }
        }
      }
    }
    return Decoration.set(ranges, true); // sort by position/side
  };
  return StateField.define<DecorationSet>({
    create: build,
    // Never rebuilt; mapped through edits so widgets and tints stay anchored
    // to their (moving) lines. A no-op for read-only docs.
    update: (value, tr) => (tr.docChanged ? value.map(tr.changes) : value),
    provide: (f) => EditorView.decorations.from(f),
  });
}

// --- Syntax highlighting ----------------------------------------------------
// A second, independent decoration layer: `cm-syn-*` marks arrive
// asynchronously (the language chunk is lazy-loaded and the hunk sides parsed
// off the mount path) via a StateEffect, then map through edits like the diff
// marks. Syntax marks set only `color`; the diff word marks set only
// `background-color`, so the two layers compose on the same span.

const setSyntaxDecorations = StateEffect.define<DecorationSet>();

export const syntaxField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setSyntaxDecorations)) return e.value;
    return tr.docChanged ? value.map(tr.changes) : value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/**
 * Kick off async highlighting for a freshly mounted pane: load the language
 * for `path`, compute per-row segments from the reconstructed hunk sides, and
 * dispatch them as decorations. Returns a cancel function for unmount. The
 * segments are computed against the mount-time document; if the user edited
 * the pane before the language arrived (only possible in the first instants),
 * the stale highlights are dropped rather than misapplied.
 */
export function applySyntaxHighlights(
  view: EditorView,
  rows: readonly SyntaxRow[],
  path: string,
  contextSide: ContextSide
): () => void {
  if (rows.reduce((n, r) => n + r.text.length, 0) > MAX_SYNTAX_CHARS) return () => {};
  let cancelled = false;
  const mountDoc = view.state.doc;
  void loadParserForPath(path).then((parser) => {
    if (!parser || cancelled) return;
    const segments = computeSyntaxSegments(rows, parser, contextSide);
    if (cancelled || view.state.doc !== mountDoc) return;
    const ranges: Range<Decoration>[] = [];
    segments.forEach((list, i) => {
      if (list.length === 0) return;
      const line = mountDoc.line(i + 1);
      for (const s of list) {
        const from = line.from + s.from;
        const to = line.from + s.to;
        if (to > from && to <= line.to) {
          ranges.push(Decoration.mark({ class: s.cls }).range(from, to));
        }
      }
    });
    view.dispatch({ effects: setSyntaxDecorations.of(Decoration.set(ranges, true)) });
  });
  return () => {
    cancelled = true;
  };
}

const editedLineDeco = Decoration.line({ class: "cm-diff-edited" });

/** Accumulates a `cm-diff-edited` line decoration for every line the user
 *  touches; mapped through subsequent changes. The edited tint overrides the
 *  (now stale) diff tint for that line. */
const editedLinesField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    if (!tr.docChanged) return value;
    let mapped = value.map(tr.changes);
    const add: Range<Decoration>[] = [];
    tr.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
      const start = tr.state.doc.lineAt(fromB).number;
      const end = tr.state.doc.lineAt(toB).number;
      for (let line = start; line <= end; line++) {
        add.push(editedLineDeco.range(tr.state.doc.line(line).from));
      }
    });
    if (add.length) {
      // Avoid stacking duplicates on a line that already carries the class.
      const starts = new Set<number>();
      mapped.between(0, tr.state.doc.length, (from) => {
        starts.add(from);
      });
      const fresh = add.filter((r) => !starts.has(r.from));
      if (fresh.length) mapped = mapped.update({ add: fresh, sort: true });
    }
    return mapped;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** Extensions for an editable pane: history/undo, edit keys, save key,
 *  edited-line highlight, dirty notification, and a visible caret. */
export function editableExtensions(
  onDirty: (() => void) | undefined,
  onSaveRequest: (() => void) | undefined
) {
  return [
    history(),
    keymap.of([
      {
        key: "Mod-s",
        preventDefault: true,
        run: () => {
          onSaveRequest?.();
          return true;
        },
      },
      ...defaultKeymap,
      ...historyKeymap,
    ]),
    editedLinesField,
    EditorView.updateListener.of((update) => {
      if (update.docChanged) onDirty?.();
    }),
    EditorView.theme({
      ".cm-content": { caretColor: "var(--panel-fg)" },
      ".cm-diff-edited": {
        backgroundColor: "var(--diff-edited-bg)",
      },
      // An edited line's diff tint and word marks are stale; neutralize them.
      ".cm-diff-edited.cm-diff-added, .cm-diff-edited.cm-diff-removed": {
        backgroundColor: "var(--diff-edited-bg)",
        color: "var(--panel-fg)",
      },
      ".cm-diff-edited .cm-diff-added-word, .cm-diff-edited .cm-diff-removed-word": {
        backgroundColor: "transparent",
      },
      // Syntax marks on an edited line may straddle stale boundaries; neutralize
      // them like the word marks (the line re-highlights after save/rebuild).
      '.cm-diff-edited [class*="cm-syn-"]': {
        color: "inherit",
      },
    }),
  ];
}

// ACTION PARITY INVARIANT: the inline and split views must offer the SAME hunk
// and per-line actions. Both wire their capabilities through the shared helpers
// below — `hunkActionWidget` (header buttons), `lineActionGutter` (per-line column)
// and `contextMenuExtension` (right-click menu) — and both mount functions take
// the same (actions, onAction, onContextMenu, lineActionOp, onLineAction,
// editable, onDirty, onSaveRequest, resolve, syntaxPath) parameters. Editability is part
// of the invariant: inline applies it to its single editor, split to its
// RIGHT pane (the left/old side is not new-side content and stays read-only).
// Resolve mode is shared too: both mounts honour the same `resolve` flag via
// the RESOLVE_* kind sets (inline edits all three kinds; split divides them:
// left owns ours, right owns context + theirs) and expose the same
// collectResolve() region collection. Any NEW hunk/line capability must be
// added via a shared helper and applied in BOTH mountInline and mountSplit;
// never wire one view only.

/** The hunk-action button widget for a header row, or undefined when N/A. */
export function hunkActionWidget(
  hunkIndex: number,
  kind: string,
  actions: HunkAction[],
  onAction?: (hunkIndex: number, action: HunkAction) => void
): (() => WidgetType) | undefined {
  if (kind !== "Hunk" || hunkIndex < 0 || actions.length === 0) return undefined;
  return () => new ActionWidget(hunkIndex, actions, onAction);
}

/** The per-line +/− action gutter: a fixed column between the number gutters
 *  and the code, shared by inline and split panes. A gutter (not content!):
 *  the caret and typed text can never interact with it, and it stays visible
 *  under horizontal scrolling. Changed lines get a button; other lines an
 *  empty cell. */
export function lineActionGutter(
  rowState: RowState,
  rows: { kind: string; hunkIndex: number; lineIndex: number }[],
  lineActionOp: "stage" | "unstage",
  onLineAction?: LineActionHandler
) {
  return gutter({
    class: "cm-diff-action-gutter",
    lineMarker(view, line) {
      const lineNo = view.state.doc.lineAt(line.from).number;
      const rowIndex = rowState.rowIndexAtLine(view.state, lineNo);
      const r = rowIndex == null ? null : rows[rowIndex];
      // Header rows: continue the grey band through this column too.
      if (r?.kind === "Hunk") return new HeaderBandMarker();
      if (!r || (r.kind !== "Added" && r.kind !== "Removed") || r.lineIndex < 0) return null;
      return new LineActionMarker(lineActionOp, r.hunkIndex, r.lineIndex, onLineAction);
    },
  });
}

/** Hidden lines directly above each hunk (0 = header has nothing to
 *  reveal, so no expander is rendered). */
export function hunkGapsAbove(diff: TextDiff): number[] {
  return diff.hunks.map((h, i) => {
    const prevEnd = i > 0 ? diff.hunks[i - 1].new_start + diff.hunks[i - 1].new_lines : 1;
    return Math.max(0, h.new_start - prevEnd);
  });
}

/** Buttonless header-band filler for gutter columns that would otherwise
 *  puncture the hunk header's grey bar (e.g. the per-line action gutter). */
export class HeaderBandMarker extends GutterMarker {
  override eq(): boolean {
    return true;
  }
  override toDOM(): HTMLElement {
    return headerBand(false);
  }
}

/** Marker for one header row: first hunk reveals only upward (the gap is
 *  bounded by the file start), the trailing row (-1) only downward, gaps
 *  with nothing to reveal keep the band without buttons. */
export function expanderMarker(
  hunkIndex: number,
  gapsAbove: number[],
  onExpand: (hunkIndex: number, dir: "up" | "down") => void,
  span2: boolean,
): HunkExpanderMarker {
  if (hunkIndex === -1) return new HunkExpanderMarker(-1, onExpand, span2, "down");
  if (gapsAbove[hunkIndex] <= 0) return new HunkExpanderMarker(hunkIndex, null, span2);
  return new HunkExpanderMarker(hunkIndex, onExpand, span2, hunkIndex === 0 ? "up" : "both");
}

/** GitHub-style context expander sitting in the number gutter of a hunk
 *  header row: stacked ↓/↑ buttons revealing more context per click. */
export class HunkExpanderMarker extends GutterMarker {
  constructor(
    readonly hunkIndex: number,
    /** null = nothing left to reveal: render the band without buttons so
     *  the header's grey bar still runs across the gutters. */
    readonly onExpand: ((hunkIndex: number, dir: "up" | "down") => void) | null,
    readonly spanTwoColumns = false,
    readonly dirs: "both" | "up" | "down" = "both",
  ) {
    super();
  }
  override eq(other: HunkExpanderMarker): boolean {
    return (
      other.hunkIndex === this.hunkIndex &&
      other.spanTwoColumns === this.spanTwoColumns &&
      other.dirs === this.dirs &&
      (other.onExpand === null) === (this.onExpand === null)
    );
  }
  override toDOM(): HTMLElement {
    const expand = this.onExpand;
    const el =
      expand === null
        ? headerBand(this.spanTwoColumns)
        : expanderPair((dir) => expand(this.hunkIndex, dir), this.spanTwoColumns, this.dirs);
    // Single-column markers cover the cell's padding via the absolute fill
    // (the number-gutter cells are position: relative); the two-column
    // variant already uses its own measured overlay.
    if (!this.spanTwoColumns) el.classList.add("cm-hunk-expander-fill");
    return el;
  }
}

/** A `contextmenu` handler that maps the clicked position to its row's hunk and,
 *  if the row is a changed line, that line's index. Rows are resolved through
 *  the row markers so the mapping stays correct while the doc is edited.
 *  When the click lands inside a non-empty text selection, the changed lines
 *  of the clicked hunk covered by that selection ride along (`selectedLines`)
 *  so the menu can offer "Stage N lines" (single-hunk rule; see
 *  `selectedHunkLines`). Shared by the inline view and both split panes -
 *  selection behavior stays in action parity by construction. */
export function contextMenuExtension(
  rowState: RowState,
  rows: { hunkIndex: number; lineIndex: number; kind: string }[],
  onContextMenu: ContextMenuHandler
) {
  return EditorView.domEventHandlers({
    contextmenu(e, view) {
      const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
      if (pos == null) return false;
      const lineNo = view.state.doc.lineAt(pos).number;
      const rowIndex = rowState.rowIndexAtLine(view.state, lineNo);
      const row = rowIndex == null ? null : rows[rowIndex];
      if (!row || row.hunkIndex < 0) return false;
      e.preventDefault();
      const lineIndex =
        row.lineIndex >= 0 && (row.kind === "Added" || row.kind === "Removed")
          ? row.lineIndex
          : null;
      const selectedLines =
        rowIndex == null ? null : selectionLinesAt(view, pos, rowState, rows, rowIndex);
      onContextMenu(row.hunkIndex, lineIndex, e, selectedLines);
      return true;
    },
  });
}

/** The `selectedLines` payload for a right-click at `pos`: the clicked hunk's
 *  changed lines covered by the selection, or null when the click is outside
 *  every non-empty selection range (the menu then targets the clicked line). */
function selectionLinesAt(
  view: EditorView,
  pos: number,
  rowState: RowState,
  rows: { hunkIndex: number; lineIndex: number; kind: string }[],
  clickedRowIndex: number
): number[] | null {
  const ranges = view.state.selection.ranges.filter((r) => !r.empty);
  if (!ranges.some((r) => r.from <= pos && pos <= r.to)) return null;
  const doc = view.state.doc;
  const covered: number[] = [];
  for (const range of ranges) {
    const fromLine = doc.lineAt(range.from).number;
    const toLineObj = doc.lineAt(range.to);
    // A range ending exactly at a line start (full-line mouse selections do)
    // does not visually include that line - exclude it.
    const toLine =
      range.to === toLineObj.from && toLineObj.number > fromLine
        ? toLineObj.number - 1
        : toLineObj.number;
    for (let lineNo = fromLine; lineNo <= toLine; lineNo++) {
      const idx = rowState.rowIndexAtLine(view.state, lineNo);
      if (idx != null) covered.push(idx);
    }
  }
  return selectedHunkLines(rows, covered, clickedRowIndex);
}

