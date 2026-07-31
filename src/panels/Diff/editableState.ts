// State-level machinery for the editable diff: row-identity markers that
// survive edits, and the change filter that keeps read-only rows untouchable.
//
// Row identity: the row model (DiffRow[] / SplitRow[]) is built once per
// mount. Each row's line start gets a point marker in a RangeSet; the set is
// mapped through every document change, so "which original row is doc line N"
// stays answerable after insertions and deletions. A line the user inserted
// has no marker: no gutter number, no diff tint, and the write-back collector
// attributes it to the enclosing hunk (see editModel.collectHunkNewSideTexts).
//
// Only @codemirror/state imports here: this module is unit-tested headlessly.

import {
  EditorSelection,
  EditorState,
  MapMode,
  RangeSet,
  RangeValue,
  StateField,
  type Extension,
  type SelectionRange,
} from "@codemirror/state";
import type { RowMeta } from "./editModel";

/** Row kinds whose text the user may edit (new-side content). */
export const EDITABLE_KINDS = new Set(["Context", "Added"]);

class RowMarker extends RangeValue {
  // Drop the marker when its exact position is deleted (the line is gone).
  mapMode = MapMode.TrackDel;

  constructor(readonly rowIndex: number) {
    super();
  }
  eq(other: RangeValue): boolean {
    return other instanceof RowMarker && other.rowIndex === this.rowIndex;
  }
}

export interface RowState {
  /** RangeSet of one marker per original row, kept mapped through changes. */
  field: StateField<RangeSet<RowMarker>>;
  /** changeFilter rejecting edits that touch a non-editable row. */
  guard: Extension;
  /** Original row index for a (current) 1-based doc line, or null (inserted). */
  rowIndexAtLine(state: EditorState, lineNumber: number): number | null;
}

/**
 * Build the row-identity field and edit guard for one editor pane. `rows`
 * must parallel the pane's initial document lines (row i = doc line i + 1).
 * `editableKinds` selects which row kinds accept edits (resolve mode widens
 * or narrows the default new-side set per pane).
 */
export function createRowState(
  rows: RowMeta[],
  editableKinds: ReadonlySet<string> = EDITABLE_KINDS,
): RowState {
  const field = StateField.define<RangeSet<RowMarker>>({
    create(state) {
      const ranges = [];
      const count = Math.min(rows.length, state.doc.lines);
      for (let i = 0; i < count; i++) {
        ranges.push(new RowMarker(i).range(state.doc.line(i + 1).from));
      }
      return RangeSet.of(ranges, true);
    },
    update(value, tr) {
      return tr.docChanged ? value.map(tr.changes) : value;
    },
  });

  const rowIndexAtLine = (state: EditorState, lineNumber: number): number | null => {
    // Search the whole line span, not just the line start: an insertion at a
    // line's first position can nudge the marker a step into the line, and a
    // merge of two editable lines leaves two markers on one line (the first
    // one wins; the merged line is one line now, so one row is correct).
    const line = state.doc.line(lineNumber);
    let found: number | null = null;
    state.field(field).between(line.from, line.to, (_from, _to, value) => {
      found = value.rowIndex;
      return false;
    });
    return found;
  };

  const isLineEditable = (state: EditorState, lineNumber: number): boolean => {
    const rowIndex = rowIndexAtLine(state, lineNumber);
    if (rowIndex == null) return true; // user-inserted line
    const row = rows[rowIndex];
    return row != null && editableKinds.has(row.kind);
  };

  const guard = EditorState.changeFilter.of((tr) => {
    if (!tr.docChanged) return true;
    let ok = true;
    tr.changes.iterChangedRanges((fromA, toA) => {
      if (!ok) return;
      const start = tr.startState.doc.lineAt(fromA).number;
      const end = tr.startState.doc.lineAt(toA).number;
      for (let line = start; line <= end; line++) {
        if (!isLineEditable(tr.startState, line)) {
          ok = false;
          return;
        }
      }
    });
    return ok;
  });

  return { field, guard, rowIndexAtLine };
}

/** Row kinds that are synthetic chrome, not content: the `@@ … @@` header
 *  lines (incl. the trailing expander row) and the split view's alignment
 *  fillers. A text caret must never sit on them. */
export const CHROME_KINDS: ReadonlySet<string> = new Set(["Hunk", "Filler"]);

/**
 * Selection filter keeping the caret off chrome rows: a caret landing on a
 * header/filler line (click, arrow keys, Home/End, …) moves to the nearest
 * content line - onward in the direction of travel, back the other way at
 * the document edge - keeping its goal column. Only EMPTY ranges are
 * adjusted: multi-line selections legitimately span headers (the diff's
 * "Stage N lines" selection flow depends on that) and are left untouched.
 * Doc-changing transactions are exempt too - the change guard already keeps
 * edits (and therefore their carets) inside editable rows.
 */
export function selectionGuard(
  rowState: RowState,
  rows: readonly RowMeta[],
  chromeKinds: ReadonlySet<string> = CHROME_KINDS,
): Extension {
  const isChromeLine = (state: EditorState, lineNumber: number): boolean => {
    const rowIndex = rowState.rowIndexAtLine(state, lineNumber);
    if (rowIndex == null) return false; // user-inserted line = content
    const row = rows[rowIndex];
    return row != null && chromeKinds.has(row.kind);
  };

  /** First non-chrome line from `start` walking `dir`, else null. */
  const scan = (state: EditorState, start: number, dir: 1 | -1): number | null => {
    for (let n = start; n >= 1 && n <= state.doc.lines; n += dir) {
      if (!isChromeLine(state, n)) return n;
    }
    return null;
  };

  return EditorState.transactionFilter.of((tr) => {
    if (!tr.selection || tr.docChanged) return tr;
    const doc = tr.newDoc;
    const prevHead = tr.startState.selection.main.head;
    let changed = false;
    const ranges: SelectionRange[] = tr.newSelection.ranges.map((range) => {
      if (!range.empty) return range;
      const state = tr.startState; // selection-only: doc and field are current
      const line = doc.lineAt(range.head);
      if (!isChromeLine(state, line.number)) return range;
      // Continue in the direction the caret was travelling; from a plain
      // click (no meaningful previous head) downward reads most natural.
      const dir: 1 | -1 = range.head >= prevHead ? 1 : -1;
      const target =
        scan(state, line.number + dir, dir) ?? scan(state, line.number - dir, -dir as 1 | -1);
      if (target == null) return range; // all-chrome doc; leave it be
      const targetLine = doc.line(target);
      const column = Math.min(range.head - line.from, targetLine.length);
      changed = true;
      return EditorSelection.cursor(targetLine.from + column);
    });
    if (!changed) return tr;
    return [
      tr,
      { selection: EditorSelection.create(ranges, tr.newSelection.mainIndex), sequential: true },
    ];
  });
}
