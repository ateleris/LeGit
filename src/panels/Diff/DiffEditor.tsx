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
//
// The extensions live in diffExtensions.ts, the mount functions (and the
// ACTION PARITY invariant) in mountDiff.ts.

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import type { TextDiff } from "../../lib/types";
import { mountInline, mountSplit, type MountedEditor, type ScrollAnchor } from "./mountDiff";
import type {
  ContextMenuHandler,
  HunkAction,
  LineActionHandler,
  LineActionOp,
} from "./diffExtensions";

export type {
  ContextMenuHandler,
  HunkAction,
  LineActionHandler,
  LineActionOp,
} from "./diffExtensions";
export type DiffViewMode = "inline" | "split";

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

