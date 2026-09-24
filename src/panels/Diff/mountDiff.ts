// Mounting the inline and split diff editors. ACTION PARITY INVARIANT: both
// views offer the SAME hunk and per-line actions, wired exclusively through
// the shared helpers in diffExtensions.ts; any NEW capability must be applied
// in BOTH mount functions, never one view only. Editability is part of the
// invariant: inline applies it to its single editor, split to its RIGHT pane
// (the left/old side is not new-side content and stays read-only).

import { EditorState } from "@codemirror/state";
import { EditorView, type GutterMarker } from "@codemirror/view";
import type { TextDiff } from "../../lib/types";
import { buildRows, buildSplitRows, type SplitRow } from "./diffModel";
import { collectHunkNewSideTexts, type PaneDoc, type RowMeta } from "./editModel";
import { createRowState, selectionGuard, type RowState } from "./editableState";
import { baseTheme, readOnly } from "../codemirror/theme";
import { guttersWidthVar, numberGuttersWidthVar } from "../codemirror/gutters";
import {
  INLINE_CLASS,
  SPLIT_CLASS,
  applySyntaxHighlights,
  contextMenuExtension,
  decorationField,
  editableExtensions,
  expanderMarker,
  hunkActionWidget,
  hunkGapsAbove,
  lineActionGutter,
  lineNumberGutter,
  segmentsFor,
  syntaxField,
  wordClassFor,
  type ContextMenuHandler,
  type HunkAction,
  type LineActionHandler,
  type LineActionOp,
} from "./diffExtensions";

/** Build the inline (single, interleaved) editor. */
// Scroll anchor carried across view recreations. We anchor on the top visible
// *line* (not a pixel offset): after a stage/unstage the content shrinks, and a
// pixel offset would clamp against CodeMirror's estimated height and jump —
// whereas re-scrolling the same line to the top via the editor's own
// scrollIntoView is measurement-accurate and keeps the unchanged region put.
export interface ScrollAnchor {
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
export interface MountedEditor {
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

export function mountInline(
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
export function mountSplit(
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

