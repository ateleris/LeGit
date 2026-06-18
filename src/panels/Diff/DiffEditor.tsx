// CodeMirror 6 renderer for a single file's text diff.
//
// Inline and split share ONE rendering primitive so their baseline looks
// identical — same decoration classes, same real-line-number gutters, same
// theme. The only difference is the row source:
//   - inline: one editor over interleaved rows (buildRows), two number gutters
//     (old + new) and an action gutter for per-hunk staging.
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

interface DiffEditorProps {
  diff: TextDiff;
  mode: DiffViewMode;
  /** Which per-hunk actions to offer; empty for read-only (commit) diffs. */
  actions: HunkAction[];
  onAction?: (hunkIndex: number, action: HunkAction) => void;
  /** Right-click on a hunk (inline mode, working-tree diffs). */
  onHunkContextMenu?: (hunkIndex: number, event: MouseEvent) => void;
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
        // mousedown (not click) so focus changes don't swallow it.
        e.preventDefault();
        e.stopPropagation();
        this.onAction?.(this.hunkIndex, action);
      });
      wrap.appendChild(btn);
    }
    return wrap;
  }
  ignoreEvent() {
    return true; // let the buttons' own handlers run; not editor input
  }
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
  /** Optional inline widget rendered at the start of the line (e.g. hunk actions). */
  widget?: () => WidgetType;
}

/**
 * Line-background decorations plus intra-line (changed-character) mark
 * decorations, driven by a per-row lookup. A modified line gets the light
 * full-line background AND a stronger background on just its changed ranges.
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
        ranges.push(
          Decoration.widget({ widget: info.widget(), side: 1 }).range(line.to)
        );
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
    // Flex row: `@@` text vertically centred on the left, action buttons pushed
    // to the right. The taller band also separates one chunk from the next.
    display: "flex",
    alignItems: "center",
    // FIXED height (independent of whether this pane carries the action buttons)
    // so the header is identical on both split panes and the two sides stay
    // row-aligned. Sized to comfortably hold the normal-size buttons.
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
  // Per-hunk action buttons, rendered inline just left of the `@@` header text.
  // The buttons themselves inherit the app's normal <button> styling (global
  // CSS); only layout and a compact size are set here.
  ".cm-diff-hunk-actions": {
    marginLeft: "auto", // push to the right edge of the flex row
    display: "inline-flex",
    gap: "4px",
  },
  // Normal app-button look (matches the commit button): app font, not the
  // editor's monospace; default size/padding from the global button rule.
  // Colours come from configurable diff.action.* tokens (default to the normal
  // button palette).
  ".cm-diff-hunk-actions button": {
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, "Helvetica Neue", sans-serif',
    fontSize: "var(--fz-lg)",
    fontStyle: "normal",
    background: "var(--diff-action-bg)",
    color: "var(--diff-action-fg)",
  },
  // `:not(:disabled)` to outrank the global `button:hover:not(:disabled)` rule.
  ".cm-diff-hunk-actions button:hover:not(:disabled)": {
    background: "var(--diff-action-hover-bg)",
    color: "var(--diff-action-hover-fg)",
  },
  // The destructive discard button gets its own (danger) colours.
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
// actions. Both wire their per-hunk capabilities through the two shared helpers
// below — `hunkActionWidget` (header buttons) and `contextMenuExtension`
// (right-click menu) — and both mount functions take the same
// (actions, onAction, onHunkContextMenu) parameters. Any NEW hunk-level
// capability must be added via a shared helper and applied in BOTH
// mountInline and mountSplit; never wire one view only.

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

/** A `contextmenu` handler that maps the clicked position to its row's hunk. */
function contextMenuExtension(
  rows: { hunkIndex: number }[],
  onHunkContextMenu: (hunkIndex: number, event: MouseEvent) => void
) {
  return EditorView.domEventHandlers({
    contextmenu(e, view) {
      const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
      if (pos == null) return false;
      const row = rows[view.state.doc.lineAt(pos).number - 1];
      if (!row) return false;
      e.preventDefault();
      onHunkContextMenu(row.hunkIndex, e);
      return true;
    },
  });
}

/** Build the inline (single, interleaved) editor. */
function mountInline(
  host: HTMLElement,
  diff: TextDiff,
  actions: HunkAction[],
  onAction?: (hunkIndex: number, action: HunkAction) => void,
  onHunkContextMenu?: (hunkIndex: number, event: MouseEvent) => void
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
      };
    }),
  ];
  if (actions.length > 0 && onHunkContextMenu) {
    extensions.push(contextMenuExtension(rows, onHunkContextMenu));
  }
  const view = new EditorView({
    state: EditorState.create({ doc, extensions }),
    parent: host,
  });
  return () => view.destroy();
}

/** Build the split (two-pane, aligned) editors and sync their scrolling. */
function mountSplit(
  host: HTMLElement,
  diff: TextDiff,
  actions: HunkAction[],
  onAction?: (hunkIndex: number, action: HunkAction) => void,
  onHunkContextMenu?: (hunkIndex: number, event: MouseEvent) => void
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
        const widget = withActions
          ? hunkActionWidget(r.hunkIndex, r.kind, actions, onAction)
          : undefined;
        return { cls: SPLIT_CLASS[r.kind], wordCls: wordClassFor(r.kind), segments: r.segments, widget };
      }),
    ];
    // Right-click → hunk menu works from either pane.
    if (actions.length > 0 && onHunkContextMenu) {
      extensions.push(contextMenuExtension(rows, onHunkContextMenu));
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

  return () => {
    leftView.scrollDOM.removeEventListener("scroll", onLeft);
    rightView.scrollDOM.removeEventListener("scroll", onRight);
    leftView.destroy();
    rightView.destroy();
    wrap.remove();
  };
}

export function DiffEditor({ diff, mode, actions, onAction, onHunkContextMenu }: DiffEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    return mode === "split"
      ? mountSplit(host, diff, actions, onAction, onHunkContextMenu)
      : mountInline(host, diff, actions, onAction, onHunkContextMenu);
  }, [diff, mode, actions, onAction, onHunkContextMenu]);

  return <div ref={hostRef} style={{ height: "100%", overflow: "auto" }} />;
}
