import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { collectHunkNewSideTexts, type RowMeta } from "./editModel";
import { createRowState, selectionGuard } from "./editableState";

// One hunk, inline rows: header / context / removed / added / context.
const ROWS: RowMeta[] = [
  { kind: "Hunk", hunkIndex: 0 },
  { kind: "Context", hunkIndex: 0 },
  { kind: "Removed", hunkIndex: 0 },
  { kind: "Added", hunkIndex: 0 },
  { kind: "Context", hunkIndex: 0 },
];
const DOC = "@@ -1,3 +1,3 @@\nctx1\nold\nnew\nctx2";

function makeState(rows: RowMeta[], doc: string) {
  const rowState = createRowState(rows);
  const state = EditorState.create({
    doc,
    extensions: [rowState.field, rowState.guard],
  });
  return { rowState, state };
}

/** Apply a change; returns the new state (unchanged doc = change was rejected). */
function apply(state: EditorState, from: number, to: number, insert: string) {
  return state.update({ changes: { from, to, insert } }).state;
}

describe("createRowState guard", () => {
  it("allows editing an Added line", () => {
    const { state } = makeState(ROWS, DOC);
    const line = state.doc.line(4); // "new"
    const next = apply(state, line.from, line.to, "edited");
    expect(next.doc.line(4).text).toBe("edited");
  });

  it("allows editing a Context line", () => {
    const { state } = makeState(ROWS, DOC);
    const line = state.doc.line(2); // "ctx1"
    const next = apply(state, line.from, line.from, "x");
    expect(next.doc.line(2).text).toBe("xctx1");
  });

  it("rejects editing a Removed line", () => {
    const { state } = makeState(ROWS, DOC);
    const line = state.doc.line(3); // "old"
    const next = apply(state, line.from, line.to, "nope");
    expect(next.doc.toString()).toBe(DOC);
  });

  it("rejects editing the hunk header", () => {
    const { state } = makeState(ROWS, DOC);
    const line = state.doc.line(1);
    const next = apply(state, line.from, line.from, "nope");
    expect(next.doc.toString()).toBe(DOC);
  });

  it("rejects deleting the boundary newline into a read-only line", () => {
    const { state } = makeState(ROWS, DOC);
    // Deleting from end of "ctx1" (editable) to start of "old" (read-only)
    // would merge an editable line into a read-only one.
    const ctx1 = state.doc.line(2);
    const old = state.doc.line(3);
    const next = apply(state, ctx1.to, old.from, "");
    expect(next.doc.toString()).toBe(DOC);
  });
});

describe("createRowState editable kinds", () => {
  it("honours custom editable kinds (resolve mode: Removed is editable)", () => {
    const rowState = createRowState(ROWS, new Set(["Context", "Added", "Removed"]));
    const state = EditorState.create({ doc: DOC, extensions: [rowState.field, rowState.guard] });
    const old = state.doc.line(3); // "old" (Removed)
    const next = apply(state, old.from, old.to, "edited-ours");
    expect(next.doc.line(3).text).toBe("edited-ours");
    // The hunk header stays read-only regardless.
    const header = next.doc.line(1);
    const next2 = apply(next, header.from, header.from, "x");
    expect(next2.doc.line(1).text).toBe(next.doc.line(1).text);
  });
});

describe("createRowState markers", () => {
  it("maps row identity through an insertion (new line has no row)", () => {
    const { rowState, state } = makeState(ROWS, DOC);
    const added = state.doc.line(4); // "new"
    // Split the line: press Enter at its end -> a new line 5 appears.
    const next = apply(state, added.to, added.to, "\ninserted");
    expect(next.doc.lines).toBe(6);
    expect(rowState.rowIndexAtLine(next, 4)).toBe(3); // still the Added row
    expect(rowState.rowIndexAtLine(next, 5)).toBe(null); // inserted line
    expect(rowState.rowIndexAtLine(next, 6)).toBe(4); // trailing Context row
  });

  it("keeps save-collection correct after a whole-line delete", () => {
    const { rowState, state } = makeState(ROWS, DOC);
    const added = state.doc.line(4); // "new" (editable)
    // Delete the line's text plus its trailing newline (the whole line).
    const next = apply(state, added.from, added.to + 1, "");
    expect(next.doc.lines).toBe(4);
    // Both boundary markers survive the deletion and land on the merged
    // line; the first wins, so the line reports row 3 (the deleted Added
    // row). That is stale for gutter display (accepted while dirty) but
    // harmless for saving: the guard means marker merges only ever happen
    // between editable rows of the SAME hunk, so the line is still collected
    // exactly once into the right hunk.
    expect(rowState.rowIndexAtLine(next, 4)).toBe(3);
    const docLines: string[] = [];
    for (let i = 1; i <= next.doc.lines; i++) docLines.push(next.doc.line(i).text);
    const out = collectHunkNewSideTexts(
      docLines,
      (i) => rowState.rowIndexAtLine(next, i + 1),
      ROWS,
      1
    );
    expect(out).toEqual([["ctx1", "ctx2"]]);
  });
});

// Rows with chrome at both ends and in the middle, plus a split-pane Filler.
const CHROME_ROWS: RowMeta[] = [
  { kind: "Hunk", hunkIndex: 0 },     // line 1  "@@ a"
  { kind: "Context", hunkIndex: 0 },  // line 2  "ctx1"
  { kind: "Added", hunkIndex: 0 },    // line 3  "new"
  { kind: "Hunk", hunkIndex: 1 },     // line 4  "@@ b"
  { kind: "Filler", hunkIndex: 1 },   // line 5  ""
  { kind: "Removed", hunkIndex: 1 },  // line 6  "old"
];
const CHROME_DOC = "@@ a\nctx1\nnew\n@@ b\n\nold";

function makeGuardedState(rows: RowMeta[], doc: string) {
  const rowState = createRowState(rows);
  const state = EditorState.create({
    doc,
    extensions: [rowState.field, rowState.guard, selectionGuard(rowState, rows)],
  });
  return { rowState, state };
}

/** Dispatch a selection-only transaction; returns the resulting state. */
function select(state: EditorState, anchor: number, head?: number) {
  return state.update({ selection: { anchor, head: head ?? anchor } }).state;
}

describe("selectionGuard", () => {
  it("moves a caret off a hunk-header line to the next content line", () => {
    const { state } = makeGuardedState(CHROME_ROWS, CHROME_DOC);
    const header = state.doc.line(1);
    const next = select(state, header.from);
    expect(next.doc.lineAt(next.selection.main.head).number).toBe(2);
  });

  it("moves a caret off a Filler line", () => {
    const { state } = makeGuardedState(CHROME_ROWS, CHROME_DOC);
    const filler = state.doc.line(5);
    const next = select(state, filler.from);
    expect(next.doc.lineAt(next.selection.main.head).number).toBe(6);
  });

  it("sends an upward move onto a header to the content line above", () => {
    const { state } = makeGuardedState(CHROME_ROWS, CHROME_DOC);
    // Start on line 6 ("old"), move the caret up onto the header at line 4.
    const start = select(state, state.doc.line(6).from);
    const next = select(start, start.doc.line(4).from);
    expect(next.doc.lineAt(next.selection.main.head).number).toBe(3);
  });

  it("keeps the goal column when jumping lines", () => {
    const { state } = makeGuardedState(CHROME_ROWS, CHROME_DOC);
    const header = state.doc.line(1);
    const next = select(state, header.from + 3);
    const head = next.selection.main.head;
    const line = next.doc.lineAt(head);
    expect(line.number).toBe(2);
    expect(head - line.from).toBe(3);
  });

  it("leaves carets on content lines alone", () => {
    const { state } = makeGuardedState(CHROME_ROWS, CHROME_DOC);
    const ctx = state.doc.line(2);
    const next = select(state, ctx.from + 1);
    expect(next.selection.main.head).toBe(ctx.from + 1);
  });

  it("leaves non-empty selections spanning chrome untouched", () => {
    const { state } = makeGuardedState(CHROME_ROWS, CHROME_DOC);
    // Select from "ctx1" across the second header into "old".
    const anchor = state.doc.line(2).from;
    const head = state.doc.line(6).to;
    const next = select(state, anchor, head);
    expect(next.selection.main.anchor).toBe(anchor);
    expect(next.selection.main.head).toBe(head);
  });
});
