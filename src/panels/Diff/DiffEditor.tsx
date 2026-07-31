// CodeMirror 6 renderer for a single file's text diff.
//
// Inline and split share ONE rendering primitive so their baseline looks
// identical — same decoration classes, same real-line-number gutters, same
// theme. The only difference is the row source:
//   - inline: one editor over interleaved rows (buildRows), two number gutters
//     (old + new).
//   - split: two editors over the aligned left/right rows (buildSplitRows),
//     each with one number gutter; the panes are scroll-synced.
//
// CodeMirror core has no split-diff view, and @codemirror/merge's MergeView
// renders its own (different) line numbers and change styling — so we don't use
// it; we build split from the same model as inline instead.

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { EditorState, type Range, StateEffect, StateField } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  GutterMarker,
  ViewPlugin,
  WidgetType,
  gutter,
  keymap,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import type { TextDiff } from "../../lib/types";
import {
  buildRows,
  buildSplitRows,
  type DiffRow,
  type Segment,
  type SplitRow,
} from "./diffModel";
import {
  collectHunkNewSideTexts,
  type PaneDoc,
  type ResolveRegions,
  type RowMeta,
} from "./editModel";
import { createRowState, selectionGuard, type RowState } from "./editableState";
import { selectedHunkLines } from "./selectionModel";
import { EXPANDER_THEME, expanderPair, headerBand } from "./hunkExpanders";
import {
  MAX_SYNTAX_CHARS,
  computeSyntaxSegments,
  type ContextSide,
  type SyntaxRow,
} from "./syntaxModel";
import { loadParserForPath } from "./syntaxLanguages";

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

interface DiffEditorProps {
  diff: TextDiff;
  mode: DiffViewMode;
  /** Which per-hunk actions to offer; empty for read-only (commit) diffs. */
  actions: HunkAction[];
  onAction?: (hunkIndex: number, action: HunkAction) => void;
  /** Right-click on a hunk; see `ContextMenuHandler`. */
  onContextMenu?: ContextMenuHandler;
  /** Op for the hover per-line affordance ("stage"/"unstage"), or null. */
  lineActionOp: LineActionOp;
  /** Apply an action to changed lines of one hunk; see `LineActionHandler`. */
  onLineAction?: LineActionHandler;
  /** Identity of the shown file/source. Scroll is preserved across diff content
   *  refetches but reset to top when this changes (a different file). */
  scrollResetKey: string;
  /** Allow editing new-side lines (working-tree unstaged diffs only). */
  editable?: boolean;
  /** Unsaved edits exist; visually disables hunk/line actions (CSS only —
   *  deliberately NOT a mount dependency, so toggling it keeps the edits). */
  dirty?: boolean;
  /** Called on every document change. */
  onDirty?: () => void;
  /** Called on Mod-s inside the editor. */
  onSaveRequest?: () => void;
  /** Bump to force a rebuild from the (possibly unchanged) diff data — needed
   *  after discarding edits, where the refetched diff is identical so no other
   *  dependency changes. Scroll position is preserved. */
  rebuildKey?: number;
  /** Chunked-view context expansion (GitHub-style ↓/↑ on hunk headers).
   *  Must be mount-stable; absent = no expanders. */
  onExpandHunk?: (hunkIndex: number, dir: "up" | "down") => void;
  /** Show the synthetic tail header (expand-down for lines after the last
   *  hunk). The panel decides from the known file length. */
  trailingExpander?: boolean;
  /** Repo-relative path used to pick a syntax-highlighting language, or null
   *  when highlighting is off (setting disabled / no file context). */
  syntaxPath?: string | null;
}

export interface DiffEditorHandle {
  /** Current per-hunk new-side lines from the edited doc, or null if the
   *  editor is not mounted in editable mode. */
  collectHunkTexts(): string[][] | null;
}

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

const INLINE_CLASS: Record<DiffRow["kind"], string | null> = {
  Added: "cm-diff-added",
  Removed: "cm-diff-removed",
  Context: null,
  Hunk: "cm-diff-hunk",
};

const SPLIT_CLASS: Record<SplitRow["kind"], string | null> = {
  Added: "cm-diff-added",
  Removed: "cm-diff-removed",
  Context: null,
  Hunk: "cm-diff-hunk",
  Filler: "cm-diff-filler",
};

/** Strong intra-line (changed-character) background class for a row kind.
 *  Hunk headers use the mark to wrap their `@@ … @@` label in a span that can
 *  be pinned (sticky) against horizontal scrolling. */
function wordClassFor(kind: string): string | null {
  if (kind === "Added") return "cm-diff-added-word";
  if (kind === "Removed") return "cm-diff-removed-word";
  if (kind === "Hunk") return "cm-diff-hunk-label";
  return null;
}

/** Intra-line mark ranges for a row: the changed-character segments, or the
 *  whole label for a hunk header. */
function segmentsFor(kind: string, text: string, segments?: Segment[]): Segment[] | undefined {
  if (kind === "Hunk") return text.length > 0 ? [{ from: 0, to: text.length }] : undefined;
  return segments;
}

export class NumberMarker extends GutterMarker {
  constructor(private readonly value: string) {
    super();
  }
  eq(other: NumberMarker) {
    return other.value === this.value;
  }
  toDOM() {
    return document.createTextNode(this.value);
  }
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

/** A lucide-style plus (stage) or minus (unstage) icon, stroked in currentColor
 *  so it follows the button's `diff.action.*` colour. */
export function plusMinusIcon(plus: boolean): SVGSVGElement {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2.5");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  const horizontal = document.createElementNS(NS, "path");
  horizontal.setAttribute("d", "M5 12h14");
  svg.appendChild(horizontal);
  if (plus) {
    const vertical = document.createElementNS(NS, "path");
    vertical.setAttribute("d", "M12 5v14");
    svg.appendChild(vertical);
  }
  return svg;
}

// The gutters are sticky and overlay horizontally scrolled content, so a
// sticky-left element inside a line must pin just RIGHT of them. Their width
// is not a CSS constant (it scales with the font size and the number digit
// count), so this plugin mirrors it into `--cm-gutters-width` on the scroller.
const guttersWidthMeasure = {
  read(view: EditorView): number {
    const gutters = view.scrollDOM.querySelector(".cm-gutters");
    return gutters instanceof HTMLElement ? gutters.offsetWidth : 0;
  },
  write(width: number, view: EditorView) {
    view.scrollDOM.style.setProperty("--cm-gutters-width", `${width}px`);
  },
};

const guttersWidthVar = ViewPlugin.define((view) => {
  view.requestMeasure(guttersWidthMeasure);
  return {
    update(update) {
      if (update.geometryChanged) update.view.requestMeasure(guttersWidthMeasure);
    },
  };
});

// Combined width of the NUMBER gutter columns only (excludes the action /
// checkbox gutters) — the hunk expander stretches across exactly these.
const numberGuttersMeasure = {
  read(view: EditorView): number {
    let width = 0;
    view.scrollDOM.querySelectorAll(".cm-gutter.cm-diff-gutter").forEach((g) => {
      if (g instanceof HTMLElement) width += g.offsetWidth;
    });
    return width;
  },
  write(width: number, view: EditorView) {
    view.scrollDOM.style.setProperty("--cm-number-gutters-width", `${width}px`);
  },
};

export const numberGuttersWidthVar = ViewPlugin.define((view) => {
  view.requestMeasure(numberGuttersMeasure);
  return {
    update(update) {
      if (update.geometryChanged) update.view.requestMeasure(numberGuttersMeasure);
    },
  };
});

/** A line-number gutter that resolves each doc line's row through the row
 *  markers, so numbers stay correct (or blank, for user-inserted lines) while
 *  the document is edited. Read-only docs never change, so this is identical
 *  to direct indexing there. */
function lineNumberGutter(
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

interface LineDeco {
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
function decorationField(getLine: (i: number) => LineDeco | null): StateField<DecorationSet> {
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

const syntaxField = StateField.define<DecorationSet>({
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
function applySyntaxHighlights(
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

/** Shared editor chrome (exported for the Merge panel's view). */
export const baseTheme = EditorView.theme({
  ...EXPANDER_THEME,
  "&": {
    height: "100%",
    fontSize: "var(--fz-md)",
    backgroundColor: "var(--panel-bg)",
    color: "var(--panel-fg)",
  },
  ".cm-scroller": {
    fontFamily:
      'ui-monospace, SFMono-Regular, "SF Mono", Consolas, "Liberation Mono", monospace',
    lineHeight: "1.5",
  },
  ".cm-conflict-side-label": {
    fontSize: "var(--fz-xs)",
    fontStyle: "italic",
    padding: "1px 8px",
    opacity: "0.9",
    display: "flex",
    alignItems: "center",
    gap: "6px",
    cursor: "default",
  },
  ".cm-conflict-side-label input": {
    margin: "0",
    cursor: "pointer",
  },
  ".cm-conflict-dim": {
    opacity: "0.4",
  },
  ".cm-conflict-check-gutter": {
    width: "1.6em",
  },
  ".cm-conflict-check-gutter .cm-gutterElement": {
    overflow: "visible",
  },
  ".cm-conflict-check": {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: "var(--fz-md)",
  },
  ".cm-conflict-check input": {
    margin: "0",
    cursor: "pointer",
  },
  ".cm-diff-added": { backgroundColor: "var(--diff-added-bg)", color: "var(--diff-added-fg)" },
  ".cm-diff-removed": {
    backgroundColor: "var(--diff-removed-bg)",
    color: "var(--diff-removed-fg)",
  },
  // Stronger background on just the characters that changed within a line.
  ".cm-diff-added-word": { backgroundColor: "var(--diff-added-word-bg)", borderRadius: "2px" },
  ".cm-diff-removed-word": { backgroundColor: "var(--diff-removed-word-bg)", borderRadius: "2px" },
  ".cm-diff-hunk": {
    backgroundColor: "var(--diff-hunk-header-bg)",
    color: "var(--diff-hunk-header-fg)",
    fontStyle: "italic",
    display: "flex",
    alignItems: "center",
    boxSizing: "border-box",
    height: "calc(var(--fz-lg) * 1.5 + 16px)",
    padding: "0 8px",
  },
  ".cm-diff-filler": {
    backgroundColor: "color-mix(in srgb, var(--panel-fg) 7%, transparent)",
  },
  // Syntax highlighting (colour only — diff tints/word marks own backgrounds).
  ".cm-syn-keyword": { color: "var(--syntax-keyword)" },
  ".cm-syn-string": { color: "var(--syntax-string)" },
  ".cm-syn-number": { color: "var(--syntax-number)" },
  ".cm-syn-comment": { color: "var(--syntax-comment)" },
  ".cm-syn-function": { color: "var(--syntax-function)" },
  ".cm-syn-type": { color: "var(--syntax-type)" },
  ".cm-syn-variable": { color: "var(--syntax-variable)" },
  ".cm-syn-property": { color: "var(--syntax-property)" },
  ".cm-syn-operator": { color: "var(--syntax-operator)" },
  ".cm-syn-punctuation": { color: "var(--syntax-punctuation)" },
  ".cm-syn-constant": { color: "var(--syntax-constant)" },
  ".cm-syn-tag": { color: "var(--syntax-tag)" },
  ".cm-gutters": {
    backgroundColor: "var(--diff-gutter-bg)",
    color: "var(--diff-gutter-fg)",
    border: "none",
  },
  ".cm-diff-gutter .cm-gutterElement": {
    padding: "0 4px",
    minWidth: "2.5ch",
    textAlign: "right",
    // The hunk expander overlay positions against its cell and reaches
    // into the neighbouring number column - no clipping.
    position: "relative",
    overflow: "visible",
  },
  ".cm-diff-gutter": {
    overflow: "visible",
  },
  // Per-line action gutter (between the number gutters and the code). A real
  // gutter, so the buttons are never part of the editable content. Buttons are
  // hidden until the pointer is over the gutter column: the whole column then
  // shows its buttons faintly, the hovered cell fully.
  ".cm-diff-action-gutter .cm-gutterElement": {
    width: "1.8em",
    padding: "0",
  },
  ".cm-diff-line-action": {
    opacity: "0",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: "100%",
    height: "100%",
    padding: "0",
    border: "none",
    borderRadius: "0",
    background: "transparent",
    // Same colours as the stage/unstage buttons (icon strokes currentColor).
    color: "var(--diff-action-fg)",
    cursor: "pointer",
  },
  // Icon nearly the full line height; `block` + auto margins keep it centred and
  // remove the inline baseline gap.
  ".cm-diff-line-action svg": { display: "block", margin: "auto", width: "1.3em", height: "1.3em" },
  ".cm-diff-action-gutter:hover .cm-diff-line-action": { opacity: "0.5" },
  ".cm-diff-action-gutter .cm-gutterElement:hover .cm-diff-line-action": { opacity: "1" },
  ".cm-diff-line-action:hover": { color: "var(--diff-action-hover-fg)" },
  // The `@@ … @@` label at the start of a hunk header row: sticky just right
  // of the (sticky, overlaying) gutters so it stays readable while the row
  // scrolls horizontally. The header line is display:flex, so the label mark
  // span is blockified and sticky applies cleanly.
  ".cm-diff-hunk-label": {
    position: "sticky",
    left: "calc(var(--cm-gutters-width, 0px) + 8px)",
  },
  // Per-hunk action buttons, rendered inline at the end of the `@@` header
  // row. `margin-left: auto` pushes them to the row's right end; `sticky`
  // pins them to the visible scrollport edge when the diff is wider than the
  // pane (otherwise they would scroll away with the content).
  ".cm-diff-hunk-actions": {
    marginLeft: "auto",
    display: "inline-flex",
    gap: "4px",
    position: "sticky",
    right: "8px",
  },
  ".cm-diff-hunk-actions button": {
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, "Helvetica Neue", sans-serif',
    fontSize: "var(--fz-lg)",
    fontStyle: "normal",
    background: "var(--diff-action-bg)",
    color: "var(--diff-action-fg)",
  },
  ".cm-diff-hunk-actions button:hover:not(:disabled)": {
    background: "var(--diff-action-hover-bg)",
    color: "var(--diff-action-hover-fg)",
  },
  ".cm-diff-hunk-actions button.cm-diff-discard": {
    background: "var(--diff-discard-bg)",
    color: "var(--diff-discard-fg)",
  },
  ".cm-diff-hunk-actions button.cm-diff-discard:hover:not(:disabled)": {
    background: "var(--diff-discard-hover-bg)",
    color: "var(--diff-discard-hover-fg)",
  },
});

/** Read-only pane extensions (exported for the Merge panel's view). */
export const readOnly = [
  EditorState.readOnly.of(true),
  EditorView.editable.of(false),
  // Belt and braces: non-editable panes never show a caret. Kept out of
  // baseTheme so editable panes get the normal visible caret regardless of
  // theme-rule ordering.
  EditorView.theme({ ".cm-content": { caretColor: "transparent" } }),
];

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
function editableExtensions(
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
function hunkActionWidget(
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
function lineActionGutter(
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
function hunkGapsAbove(diff: TextDiff): number[] {
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
function expanderMarker(
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
function contextMenuExtension(
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

/** Build the inline (single, interleaved) editor. */
// Scroll anchor carried across view recreations. We anchor on the top visible
// *line* (not a pixel offset): after a stage/unstage the content shrinks, and a
// pixel offset would clamp against CodeMirror's estimated height and jump —
// whereas re-scrolling the same line to the top via the editor's own
// scrollIntoView is measurement-accurate and keeps the unchanged region put.
interface ScrollAnchor {
  /** 1-based document line shown at the top of the viewport. */
  line: number;
  /** Horizontal scroll offset (px). */
  left: number;
}

/** Restore `anchor` in `view`, then keep it updated as the view scrolls.
 *  Returns a cleanup that detaches the listener. */
function restoreAndTrack(view: EditorView, anchor: ScrollAnchor): () => void {
  const scroller = view.scrollDOM;
  const lineCount = view.state.doc.lines;
  const lineNo = Math.min(Math.max(anchor.line, 1), lineCount);
  view.dispatch({
    effects: EditorView.scrollIntoView(view.state.doc.line(lineNo).from, { y: "start" }),
  });
  scroller.scrollLeft = anchor.left;

  const onScroll = () => {
    const block = view.lineBlockAtHeight(scroller.scrollTop);
    anchor.line = view.state.doc.lineAt(block.from).number;
    anchor.left = scroller.scrollLeft;
  };
  scroller.addEventListener("scroll", onScroll);
  return () => scroller.removeEventListener("scroll", onScroll);
}

/** What a mount returns: teardown plus the editable-doc collector. */
interface MountedEditor {
  destroy: () => void;
  /** Per-hunk new-side lines from the current (possibly edited) document. */
  collect: () => string[][];
}

/** Snapshot a pane's current document + row lookup for the pure collectors. */
function paneDocOf(view: EditorView, rowState: RowState, rows: RowMeta[]): PaneDoc {
  const state = view.state;
  const docLines: string[] = [];
  for (let i = 1; i <= state.doc.lines; i++) docLines.push(state.doc.line(i).text);
  return { docLines, rowIndexAt: (i) => rowState.rowIndexAtLine(state, i + 1), rows };
}

/** Per-hunk new-side lines from a pane's current doc via its row markers. */
function collectFromView(
  view: EditorView,
  rowState: RowState,
  rows: RowMeta[],
  hunkCount: number
): string[][] {
  const pane = paneDocOf(view, rowState, rows);
  return collectHunkNewSideTexts(pane.docLines, pane.rowIndexAt, pane.rows, hunkCount);
}

function mountInline(
  host: HTMLElement,
  diff: TextDiff,
  actions: HunkAction[],
  onAction: ((hunkIndex: number, action: HunkAction) => void) | undefined,
  onContextMenu: ContextMenuHandler | undefined,
  lineActionOp: LineActionOp,
  onLineAction: LineActionHandler | undefined,
  anchor: ScrollAnchor,
  editable: boolean,
  onDirty: (() => void) | undefined,
  onSaveRequest: (() => void) | undefined,
  syntaxPath: string | null,
  onExpandHunk?: (hunkIndex: number, dir: "up" | "down") => void,
  trailingExpander = false
): MountedEditor {
  // Read-only diffs (no hunk actions) drop headers whose gap is gone.
  const skipGapless = !!onExpandHunk && actions.length === 0;
  const rows = buildRows(diff, trailingExpander && !!onExpandHunk, skipGapless);
  const doc = rows.map((r) => r.text).join("\n");
  const rowState = createRowState(rows);
  const gapsAbove = hunkGapsAbove(diff);
  const expanderFor = onExpandHunk
    ? (i: number) =>
        rows[i]?.kind === "Hunk"
          ? expanderMarker(rows[i].hunkIndex, gapsAbove, onExpandHunk, true)
          : null
    : undefined;
  const extensions = [
    baseTheme,
    guttersWidthVar,
    numberGuttersWidthVar,
    syntaxField,
    rowState.field,
    // Keep the caret off header/expander (and filler) rows in BOTH modes -
    // they are synthetic chrome, not content (BACKLOG bug, 2026-07-30).
    selectionGuard(rowState, rows),
    ...(editable
      ? [rowState.guard, ...editableExtensions(onDirty, onSaveRequest)]
      : readOnly),
    lineNumberGutter(rowState, (i) => rows[i]?.oldNo ?? null, "cm-diff-gutter cm-diff-gutter-old", expanderFor),
    lineNumberGutter(rowState, (i) => rows[i]?.newNo ?? null, "cm-diff-gutter cm-diff-gutter-new"),
    ...(lineActionOp ? [lineActionGutter(rowState, rows, lineActionOp, onLineAction)] : []),
    decorationField((i) => {
      const r = rows[i];
      if (!r) return null;
      return {
        cls: INLINE_CLASS[r.kind],
        wordCls: wordClassFor(r.kind),
        segments: segmentsFor(r.kind, r.text, r.segments),
        widget: hunkActionWidget(r.hunkIndex, r.kind, actions, onAction),
      };
    }),
  ];
  if (actions.length > 0 && onContextMenu) {
    extensions.push(contextMenuExtension(rowState, rows, onContextMenu));
  }
  const view = new EditorView({
    state: EditorState.create({ doc, extensions }),
    parent: host,
  });
  const cancelSyntax = syntaxPath ? applySyntaxHighlights(view, rows, syntaxPath, "new") : null;
  const untrack = restoreAndTrack(view, anchor);
  return {
    destroy: () => {
      cancelSyntax?.();
      untrack();
      view.destroy();
    },
    collect: () => collectFromView(view, rowState, rows, diff.hunks.length),
  };
}

/** Build the split (two-pane, aligned) editors and sync their scrolling. */
function mountSplit(
  host: HTMLElement,
  diff: TextDiff,
  actions: HunkAction[],
  onAction: ((hunkIndex: number, action: HunkAction) => void) | undefined,
  onContextMenu: ContextMenuHandler | undefined,
  lineActionOp: LineActionOp,
  onLineAction: LineActionHandler | undefined,
  anchor: ScrollAnchor,
  editable: boolean,
  onDirty: (() => void) | undefined,
  onSaveRequest: (() => void) | undefined,
  syntaxPath: string | null,
  onExpandHunk?: (hunkIndex: number, dir: "up" | "down") => void,
  trailingExpander = false
): MountedEditor {
  const skipGapless = !!onExpandHunk && actions.length === 0;
  const { left, right } = buildSplitRows(diff, trailingExpander && !!onExpandHunk, skipGapless);
  const gapsAbove = hunkGapsAbove(diff);

  const wrap = document.createElement("div");
  wrap.style.display = "flex";
  wrap.style.height = "100%";
  const leftEl = document.createElement("div");
  const rightEl = document.createElement("div");
  for (const el of [leftEl, rightEl]) {
    el.style.flex = "1";
    el.style.minWidth = "0";
    el.style.height = "100%";
    el.style.overflow = "hidden";
  }
  leftEl.style.borderRight = "1px solid var(--panel-border)";
  wrap.append(leftEl, rightEl);
  host.append(wrap);

  // `withActions` puts the hunk-action buttons on this pane's header (only the
  // new/right side, to avoid duplicating them on both panes). `paneEditable`
  // is true only for the right pane in normal mode (the left/old side is not
  // new-side content); resolve mode makes BOTH panes editable, split by
  // `paneKinds` (left owns ours, right owns context + theirs).
  const pane = (
    el: HTMLElement,
    rows: SplitRow[],
    withActions: boolean,
    paneEditable: boolean,
    withExpanders = false
  ) => {
    const rowState = createRowState(rows);
    const expanderFor =
      withExpanders && onExpandHunk
        ? (i: number) =>
            rows[i]?.kind === "Hunk"
              ? expanderMarker(rows[i].hunkIndex, gapsAbove, onExpandHunk, false)
              : null
        : undefined;
    const extensions = [
      baseTheme,
      guttersWidthVar,
      syntaxField,
      rowState.field,
      // Chrome rows (headers, fillers) never take the caret - see the
      // inline builder's matching extension.
      selectionGuard(rowState, rows),
      ...(paneEditable
        ? [rowState.guard, ...editableExtensions(onDirty, onSaveRequest)]
        : readOnly),
      lineNumberGutter(rowState, (i) => rows[i]?.no ?? null, "cm-diff-gutter", expanderFor),
      ...(lineActionOp ? [lineActionGutter(rowState, rows, lineActionOp, onLineAction)] : []),
      decorationField((i) => {
        const r = rows[i];
        if (!r) return null;
        return {
          cls: SPLIT_CLASS[r.kind],
          wordCls: wordClassFor(r.kind),
          segments: segmentsFor(r.kind, r.text, r.segments),
          widget: withActions
            ? hunkActionWidget(r.hunkIndex, r.kind, actions, onAction)
            : undefined,
        };
      }),
    ];
    // Right-click → menu works from either pane.
    if (actions.length > 0 && onContextMenu) {
      extensions.push(contextMenuExtension(rowState, rows, onContextMenu));
    }
    const view = new EditorView({
      state: EditorState.create({ doc: rows.map((r) => r.text).join("\n"), extensions }),
      parent: el,
    });
    return { view, rowState };
  };

  const leftPane = pane(leftEl, left, false, false, true);
  const rightPane = pane(rightEl, right, true, editable, true);
  const leftView = leftPane.view;
  const rightView = rightPane.view;

  // Each pane highlights against its own complete side: the left pane's old
  // side holds context + removed rows, the right pane's new side context +
  // added rows (hence the differing context attribution).
  const cancelSyntax = syntaxPath
    ? [
        applySyntaxHighlights(leftView, left, syntaxPath, "old"),
        applySyntaxHighlights(rightView, right, syntaxPath, "new"),
      ]
    : [];

  // Keep the two panes scroll-locked (vertical + horizontal).
  let lock = false;
  const link = (src: EditorView, dst: EditorView) => () => {
    if (lock) return;
    lock = true;
    dst.scrollDOM.scrollTop = src.scrollDOM.scrollTop;
    dst.scrollDOM.scrollLeft = src.scrollDOM.scrollLeft;
    lock = false;
  };
  const onLeft = link(leftView, rightView);
  const onRight = link(rightView, leftView);
  leftView.scrollDOM.addEventListener("scroll", onLeft);
  rightView.scrollDOM.addEventListener("scroll", onRight);

  // The panes stay scroll-synced, so anchor/track on the left; restoring it
  // mirrors to the right via the sync listener above.
  const untrack = restoreAndTrack(leftView, anchor);

  return {
    destroy: () => {
      for (const cancel of cancelSyntax) cancel();
      leftView.scrollDOM.removeEventListener("scroll", onLeft);
      rightView.scrollDOM.removeEventListener("scroll", onRight);
      untrack();
      leftView.destroy();
      rightView.destroy();
      wrap.remove();
    },
    // Edits land in the right pane; its rows carry the new-side content.
    collect: () => collectFromView(rightView, rightPane.rowState, right, diff.hunks.length),
  };
}

export const DiffEditor = forwardRef<DiffEditorHandle, DiffEditorProps>(function DiffEditor(
  {
    diff,
    mode,
    actions,
    onAction,
    onContextMenu,
    lineActionOp,
    onLineAction,
    scrollResetKey,
    editable = false,
    dirty = false,
    onDirty,
    onSaveRequest,
    rebuildKey = 0,
    onExpandHunk,
    trailingExpander = false,
    syntaxPath = null,
  },
  ref
) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const mountRef = useRef<MountedEditor | null>(null);
  // Scroll anchor carried across view recreations (e.g. after a stage/unstage
  // refetch). Reset to the top when the shown file changes.
  const anchorRef = useRef<ScrollAnchor>({ line: 1, left: 0 });
  useEffect(() => {
    anchorRef.current = { line: 1, left: 0 };
  }, [scrollResetKey]);

  useImperativeHandle(ref, () => ({
    collectHunkTexts: () => (editable ? mountRef.current?.collect() ?? null : null),
  }));

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const anchor = anchorRef.current;
    const mounted =
      mode === "split"
        ? mountSplit(host, diff, actions, onAction, onContextMenu, lineActionOp, onLineAction, anchor, editable, onDirty, onSaveRequest, syntaxPath, onExpandHunk, trailingExpander)
        : mountInline(host, diff, actions, onAction, onContextMenu, lineActionOp, onLineAction, anchor, editable, onDirty, onSaveRequest, syntaxPath, onExpandHunk, trailingExpander);
    mountRef.current = mounted;
    return () => {
      mountRef.current = null;
      mounted.destroy();
    };
    // NOTE: `dirty` is intentionally NOT a dependency: recreating the editor
    // would discard the user's unsaved edits. It only drives the CSS class.
  }, [diff, mode, actions, onAction, onContextMenu, lineActionOp, onLineAction, editable, onDirty, onSaveRequest, rebuildKey, onExpandHunk, trailingExpander, syntaxPath]);

  return (
    <div
      ref={hostRef}
      className={dirty ? "diff-editor-host diff-editor-host--dirty" : "diff-editor-host"}
      style={{ height: "100%", overflow: "auto" }}
    />
  );
});
