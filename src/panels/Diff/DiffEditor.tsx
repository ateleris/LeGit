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

import { useEffect, useRef } from "react";
import { EditorState, type Range, StateField } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  GutterMarker,
  WidgetType,
  gutter,
} from "@codemirror/view";
import type { TextDiff } from "../../lib/types";
import {
  buildRows,
  buildSplitRows,
  type DiffRow,
  type Segment,
  type SplitRow,
} from "./diffModel";

export type HunkAction = "stage" | "unstage" | "discard";
export type DiffViewMode = "inline" | "split";
/** Per-line action offered for a working-tree diff (null = read-only commit). */
export type LineActionOp = "stage" | "unstage" | null;

interface DiffEditorProps {
  diff: TextDiff;
  mode: DiffViewMode;
  /** Which per-hunk actions to offer; empty for read-only (commit) diffs. */
  actions: HunkAction[];
  onAction?: (hunkIndex: number, action: HunkAction) => void;
  /** Right-click on a hunk; `lineIndex` is the clicked changed line, else null. */
  onContextMenu?: (hunkIndex: number, lineIndex: number | null, event: MouseEvent) => void;
  /** Op for the hover per-line affordance ("stage"/"unstage"), or null. */
  lineActionOp: LineActionOp;
  /** Apply an action to a single changed line. */
  onLineAction?: (hunkIndex: number, lineIndex: number, action: HunkAction) => void;
  /** Identity of the shown file/source. Scroll is preserved across diff content
   *  refetches but reset to top when this changes (a different file). */
  scrollResetKey: string;
}

const ACTION_LABEL: Record<HunkAction, string> = {
  stage: "Stage",
  unstage: "Unstage",
  discard: "Discard",
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

/** Strong intra-line (changed-character) background class for a row kind. */
function wordClassFor(kind: string): string | null {
  if (kind === "Added") return "cm-diff-added-word";
  if (kind === "Removed") return "cm-diff-removed-word";
  return null;
}

/** 0-based index into the row model for a gutter `line` block. */
function rowIndexOf(view: EditorView, lineFrom: number): number {
  return view.state.doc.lineAt(lineFrom).number - 1;
}

class NumberMarker extends GutterMarker {
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
      btn.title = `${ACTION_LABEL[action]} this hunk`;
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
// stages/unstages just that line, revealed on row hover; on a context/filler
// line it is an empty spacer so the code stays aligned.
class LineLeadWidget extends WidgetType {
  constructor(
    private readonly op: LineActionOp,
    private readonly hunkIndex: number,
    private readonly lineIndex: number,
    private readonly onLineAction?: (hunkIndex: number, lineIndex: number, action: HunkAction) => void
  ) {
    super();
  }
  eq(other: LineLeadWidget) {
    return (
      other.op === this.op &&
      other.hunkIndex === this.hunkIndex &&
      other.lineIndex === this.lineIndex
    );
  }
  toDOM() {
    const wrap = document.createElement("span");
    wrap.className = "cm-diff-line-col";
    // Actionable line (op set and a real changed line) → hover button.
    if (this.op && this.lineIndex >= 0) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "cm-diff-line-action";
      btn.title = this.op === "stage" ? "Stage this line" : "Unstage this line";
      btn.appendChild(plusMinusIcon(this.op === "stage"));
      const op = this.op;
      btn.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return; // left only; let right-click open the menu
        e.preventDefault();
        e.stopPropagation();
        if (op) this.onLineAction?.(this.hunkIndex, this.lineIndex, op);
      });
      wrap.appendChild(btn);
    }
    return wrap;
  }
  ignoreEvent() {
    return true;
  }
}

/** A lucide-style plus (stage) or minus (unstage) icon, stroked in currentColor
 *  so it follows the button's `diff.action.*` colour. */
function plusMinusIcon(plus: boolean): SVGSVGElement {
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

/** A line-number gutter driven by a per-row number lookup. */
function lineNumberGutter(getNo: (i: number) => number | null, cls: string) {
  return gutter({
    class: cls,
    lineMarker(view, line) {
      const n = getNo(rowIndexOf(view, line.from));
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
  /** Inline widget at the line start (per-line action column / spacer). */
  lead?: () => WidgetType;
}

/**
 * Line-background + intra-line mark decorations, an optional leading per-line
 * action column, and an optional trailing hunk-action widget — all driven by a
 * per-row lookup.
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
      if (info.lead) {
        ranges.push(Decoration.widget({ widget: info.lead(), side: -1 }).range(line.from));
      }
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
    update: (value) => value, // doc is read-only; never rebuild
    provide: (f) => EditorView.decorations.from(f),
  });
}

const baseTheme = EditorView.theme({
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
  ".cm-content": { caretColor: "transparent" },
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
  ".cm-gutters": {
    backgroundColor: "var(--diff-gutter-bg)",
    color: "var(--diff-gutter-fg)",
    border: "none",
  },
  ".cm-diff-gutter .cm-gutterElement": {
    padding: "0 4px",
    minWidth: "2.5ch",
    textAlign: "right",
  },
  // Per-line action column (between the number gutters and the code). Reserves a
  // fixed width on every line so the code stays aligned; the +/− button is
  // hidden until the line is hovered.
  // A symmetric column spanning the line height (line-height 1.5), centring its
  // content both ways so the button sits centred (no asymmetric margin).
  ".cm-diff-line-col": {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "1.8em",
    height: "1.5em",
    verticalAlign: "top",
    userSelect: "none",
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
  ".cm-line:hover .cm-diff-line-action": { opacity: "1" },
  ".cm-diff-line-action:hover": { color: "var(--diff-action-hover-fg)" },
  // Per-hunk action buttons, rendered inline just left of the `@@` header text.
  ".cm-diff-hunk-actions": {
    marginLeft: "auto",
    display: "inline-flex",
    gap: "4px",
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

const readOnly = [EditorState.readOnly.of(true), EditorView.editable.of(false)];

// ACTION PARITY INVARIANT: the inline and split views must offer the SAME hunk
// and per-line actions. Both wire their capabilities through the shared helpers
// below — `hunkActionWidget` (header buttons), `lineLeadWidget` (per-line column)
// and `contextMenuExtension` (right-click menu) — and both mount functions take
// the same (actions, onAction, onContextMenu, lineActionOp, onLineAction)
// parameters. Any NEW hunk/line capability must be added via a shared helper and
// applied in BOTH mountInline and mountSplit; never wire one view only.

/** The hunk-action button widget for a header row, or undefined when N/A. */
function hunkActionWidget(
  hunkIndex: number,
  kind: string,
  actions: HunkAction[],
  onAction?: (hunkIndex: number, action: HunkAction) => void
): (() => WidgetType) | undefined {
  if (kind !== "Hunk" || actions.length === 0) return undefined;
  return () => new ActionWidget(hunkIndex, actions, onAction);
}

/** The leading per-line action column for a row, or undefined (no column). */
function lineLeadWidget(
  kind: string,
  hunkIndex: number,
  lineIndex: number,
  lineActionOp: LineActionOp,
  onLineAction?: (hunkIndex: number, lineIndex: number, action: HunkAction) => void
): (() => WidgetType) | undefined {
  if (!lineActionOp || kind === "Hunk") return undefined;
  const actionable = kind === "Added" || kind === "Removed";
  // Changed line → button; context/filler → spacer (op passed as null to spacer).
  return () =>
    new LineLeadWidget(
      actionable ? lineActionOp : null,
      hunkIndex,
      actionable ? lineIndex : -1,
      onLineAction
    );
}

/** A `contextmenu` handler that maps the clicked position to its row's hunk and,
 *  if the row is a changed line, that line's index. */
function contextMenuExtension(
  rows: { hunkIndex: number; lineIndex: number; kind: string }[],
  onContextMenu: (hunkIndex: number, lineIndex: number | null, event: MouseEvent) => void
) {
  return EditorView.domEventHandlers({
    contextmenu(e, view) {
      const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
      if (pos == null) return false;
      const row = rows[view.state.doc.lineAt(pos).number - 1];
      if (!row) return false;
      e.preventDefault();
      const lineIndex =
        row.lineIndex >= 0 && (row.kind === "Added" || row.kind === "Removed")
          ? row.lineIndex
          : null;
      onContextMenu(row.hunkIndex, lineIndex, e);
      return true;
    },
  });
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

function mountInline(
  host: HTMLElement,
  diff: TextDiff,
  actions: HunkAction[],
  onAction: ((hunkIndex: number, action: HunkAction) => void) | undefined,
  onContextMenu: ((hunkIndex: number, lineIndex: number | null, event: MouseEvent) => void) | undefined,
  lineActionOp: LineActionOp,
  onLineAction: ((hunkIndex: number, lineIndex: number, action: HunkAction) => void) | undefined,
  anchor: ScrollAnchor
): () => void {
  const rows = buildRows(diff);
  const doc = rows.map((r) => r.text).join("\n");
  const extensions = [
    baseTheme,
    ...readOnly,
    lineNumberGutter((i) => rows[i]?.oldNo ?? null, "cm-diff-gutter cm-diff-gutter-old"),
    lineNumberGutter((i) => rows[i]?.newNo ?? null, "cm-diff-gutter cm-diff-gutter-new"),
    decorationField((i) => {
      const r = rows[i];
      if (!r) return null;
      return {
        cls: INLINE_CLASS[r.kind],
        wordCls: wordClassFor(r.kind),
        segments: r.segments,
        widget: hunkActionWidget(r.hunkIndex, r.kind, actions, onAction),
        lead: lineLeadWidget(r.kind, r.hunkIndex, r.lineIndex, lineActionOp, onLineAction),
      };
    }),
  ];
  if (actions.length > 0 && onContextMenu) {
    extensions.push(contextMenuExtension(rows, onContextMenu));
  }
  const view = new EditorView({
    state: EditorState.create({ doc, extensions }),
    parent: host,
  });
  const untrack = restoreAndTrack(view, anchor);
  return () => {
    untrack();
    view.destroy();
  };
}

/** Build the split (two-pane, aligned) editors and sync their scrolling. */
function mountSplit(
  host: HTMLElement,
  diff: TextDiff,
  actions: HunkAction[],
  onAction: ((hunkIndex: number, action: HunkAction) => void) | undefined,
  onContextMenu: ((hunkIndex: number, lineIndex: number | null, event: MouseEvent) => void) | undefined,
  lineActionOp: LineActionOp,
  onLineAction: ((hunkIndex: number, lineIndex: number, action: HunkAction) => void) | undefined,
  anchor: ScrollAnchor
): () => void {
  const { left, right } = buildSplitRows(diff);

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
  // new/right side, to avoid duplicating them on both panes).
  const pane = (el: HTMLElement, rows: SplitRow[], withActions: boolean) => {
    const extensions = [
      baseTheme,
      ...readOnly,
      lineNumberGutter((i) => rows[i]?.no ?? null, "cm-diff-gutter"),
      decorationField((i) => {
        const r = rows[i];
        if (!r) return null;
        return {
          cls: SPLIT_CLASS[r.kind],
          wordCls: wordClassFor(r.kind),
          segments: r.segments,
          widget: withActions
            ? hunkActionWidget(r.hunkIndex, r.kind, actions, onAction)
            : undefined,
          lead: lineLeadWidget(r.kind, r.hunkIndex, r.lineIndex, lineActionOp, onLineAction),
        };
      }),
    ];
    // Right-click → menu works from either pane.
    if (actions.length > 0 && onContextMenu) {
      extensions.push(contextMenuExtension(rows, onContextMenu));
    }
    return new EditorView({
      state: EditorState.create({ doc: rows.map((r) => r.text).join("\n"), extensions }),
      parent: el,
    });
  };

  const leftView = pane(leftEl, left, false);
  const rightView = pane(rightEl, right, true);

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

  return () => {
    leftView.scrollDOM.removeEventListener("scroll", onLeft);
    rightView.scrollDOM.removeEventListener("scroll", onRight);
    untrack();
    leftView.destroy();
    rightView.destroy();
    wrap.remove();
  };
}

export function DiffEditor({
  diff,
  mode,
  actions,
  onAction,
  onContextMenu,
  lineActionOp,
  onLineAction,
  scrollResetKey,
}: DiffEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  // Scroll anchor carried across view recreations (e.g. after a stage/unstage
  // refetch). Reset to the top when the shown file changes.
  const anchorRef = useRef<ScrollAnchor>({ line: 1, left: 0 });
  useEffect(() => {
    anchorRef.current = { line: 1, left: 0 };
  }, [scrollResetKey]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const anchor = anchorRef.current;
    return mode === "split"
      ? mountSplit(host, diff, actions, onAction, onContextMenu, lineActionOp, onLineAction, anchor)
      : mountInline(host, diff, actions, onAction, onContextMenu, lineActionOp, onLineAction, anchor);
  }, [diff, mode, actions, onAction, onContextMenu, lineActionOp, onLineAction]);

  return <div ref={hostRef} style={{ height: "100%", overflow: "auto" }} />;
}
