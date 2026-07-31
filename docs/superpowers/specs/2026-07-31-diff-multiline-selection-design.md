# Diff viewer: stage/unstage/discard a multi-line selection

**Date:** 2026-07-31
**Status:** Approved
**Backlog item:** "Diff viewer: stage/unstage a multi-line selection"

## Problem

In a working-changes diff, the per-line context menu entry ("Stage line" /
"Unstage line" / "Discard line") targets only the clicked line. When the user
has selected multiple lines, the entry should become "Stage N lines" (and the
unstage/discard counterparts match) and act on all selected changed lines.

## Decisions

- **Single hunk only** (user decision): the selection acts on changed lines
  within the hunk under the right-click; selected lines of other hunks are
  ignored and the shown count N reflects that. No backend change:
  `apply_lines` / `repoStageLines` and friends already accept a list of line
  indices within one hunk. Multi-hunk atomic apply is a possible later
  backlog item.
- **Click inside selection** (user decision): the entry acts on the selection
  only when the right-click position falls inside a non-empty selection
  range; otherwise it acts on the clicked line, as today.
- **Discard entries gain the inline confirm** (user decision): "Discard
  line" / "Discard N lines" / "Discard chunk" go through the standard
  `useMenuConfirm` takeover, skipped when the global destructive-confirmation
  setting is off (`useConfirmDestructive`) - closing an existing parity gap
  with the project's destructive-menu-action rule. Stage/unstage stay
  immediate.

## Design

1. **Selection model** - new pure module `src/panels/Diff/selectionModel.ts`:
   - `selectedHunkLines(rows, coveredRowIndices, clickedRowIndex): number[] | null`
     - from the rows covered by the selection, keep changed lines
     (`Added`/`Removed`) belonging to the clicked row's hunk, deduped and
     sorted; `null` when none (or when the clicked row has no hunk).
   - `lineActionLabel(action, n): string` - "Stage line" / "Stage 3 lines" /
     unstage / discard variants (replaces the static `LINE_LABEL` map).
2. **Context-menu extension** (`DiffEditor.tsx`) - `contextMenuExtension`
   additionally checks whether the click position lies inside any non-empty
   selection range of that editor view; if so it collects the doc lines
   covered by all non-empty ranges, maps them through the existing
   `rowState`/`rows` machinery, and passes the `selectedHunkLines` result as
   a fourth argument: `onContextMenu(hunkIndex, lineIndex, event,
   selectedLines)`. The extension is shared by the inline builder and both
   split panes, so inline/split action parity holds by construction (old
   pane selections yield Removed lines, new pane Added lines).
3. **Menu + plumbing** (`DiffPanel.tsx`):
   - `onLineAction` generalizes to `(hunkIndex, lineIndices: number[],
     action)`; the hover gutter button wraps its single line in an array
     (behavior unchanged).
   - When `selectedLines` is non-null the line entries act on it with the
     pluralized label; otherwise on the clicked line. A right-click on a
     context line inside a selection also shows the line entries (the
     selection supplies the changed lines).
   - Discard entries chain through `useMenuConfirm` ("Discard 3 lines?"),
     gated by `useConfirmDestructive`.

## Out of scope

- Backend: untouched.
- The hover gutter per-line affordance stays single-line.
- Multi-hunk selections apply only to the clicked hunk (see Decisions).

## Testing

- `selectionModel.test.ts`: mixed Added/Removed grouping, context-line and
  cross-hunk exclusion, empty selection -> null, dedup + sort, clicked row
  without hunk -> null, label pluralization for all three actions.
- The CodeMirror-dependent glue stays thin (position-in-range check + line
  iteration); no new colors or tokens, all menu primitives reused, so the
  theme suites are unaffected.
