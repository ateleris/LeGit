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
  EditorState,
  MapMode,
  RangeSet,
  RangeValue,
  StateField,
  type Extension,
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
