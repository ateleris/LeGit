// The shared CodeMirror chrome for every code-rendering panel (Diff, Merge,
// File View): one theme so their baseline look is identical, plus the shared
// read-only pane extensions.

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { EXPANDER_THEME } from "./hunkExpanders";

/** Shared editor chrome. */
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
    padding: "0.083em 0.667em",
    opacity: "0.9",
    display: "flex",
    alignItems: "center",
    gap: "0.5em",
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
    padding: "0 0.667em",
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
    padding: "0 0.333em",
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
    gap: "0.333em",
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

/** Read-only pane extensions. */
export const readOnly = [
  EditorState.readOnly.of(true),
  EditorView.editable.of(false),
  // Belt and braces: non-editable panes never show a caret. Kept out of
  // baseTheme so editable panes get the normal visible caret regardless of
  // theme-rule ordering.
  EditorView.theme({ ".cm-content": { caretColor: "transparent" } }),
];
