import { describe, expect, it } from "vitest";
import { parsePreferences } from "./useColumnState";
import type { ColumnId } from "./types";
import { columnGridTrack, columnsMinWidth } from "./types";

/** A well-formed v1 document, as persisted before the Signed column existed. */
function v1Doc(order: ColumnId[], hidden: ColumnId[] = []) {
  return {
    format: "legit-commits-columns",
    formatVersion: 1,
    order,
    hidden,
    widths: { refs: 120 },
  };
}

describe("parsePreferences - missing-column insertion", () => {
  it("inserts a newly added column at its default-relative position", () => {
    // Persisted prefs predate the Signed column: it must appear right after
    // graph (its default neighbour), NOT dangle at the far right.
    const state = parsePreferences(
      v1Doc(["refs", "graph", "subject", "date", "author", "sha"]),
    );
    expect(state?.order).toEqual([
      "refs", "graph", "signed", "subject", "date", "author", "sha",
    ]);
  });

  it("follows the user's custom order when inserting", () => {
    // graph moved to the front: signed still lands right after it.
    const state = parsePreferences(
      v1Doc(["graph", "subject", "refs", "date", "author", "sha"]),
    );
    expect(state?.order).toEqual([
      "graph", "signed", "subject", "refs", "date", "author", "sha",
    ]);
  });

  it("inserts at the front when no preceding default column exists", () => {
    // Degenerate doc holding only later columns: refs/graph/signed go first,
    // in default order.
    const state = parsePreferences(v1Doc(["subject", "date", "author", "sha"]));
    expect(state?.order).toEqual([
      "refs", "graph", "signed", "subject", "date", "author", "sha",
    ]);
  });

  it("keeps hidden state and rejects duplicate orders", () => {
    const state = parsePreferences(v1Doc(["refs", "graph", "subject", "date", "author", "sha"], ["sha"]));
    expect(state?.hidden).toEqual(["sha"]);
    expect(
      parsePreferences(v1Doc(["refs", "refs", "graph", "subject", "date", "author", "sha"])),
    ).toBeNull();
  });
});

describe("columnGridTrack", () => {
  const ctx = { graphColWidth: 36, signedColWidth: 16, subjectMinWidth: 120, widths: {} };

  it("gives the subject column a floor - a bare 1fr collapsed to 0px when the panel was narrower than the fixed columns (E2E 1280x800 regression)", () => {
    expect(columnGridTrack("subject", ctx)).toBe("minmax(120px, 1fr)");
  });

  it("keeps computed and persisted px widths for the other columns", () => {
    expect(columnGridTrack("graph", ctx)).toBe("36px");
    expect(columnGridTrack("signed", ctx)).toBe("16px");
    expect(columnGridTrack("refs", ctx)).toBe("150px"); // DEFAULT_WIDTHS fallback
    expect(columnGridTrack("date", { ...ctx, widths: { date: 88 } })).toBe("88px");
  });
});

// Regression (2026-08-18): rows and header were width-100%-of-viewport, so
// with a horizontal scrollbar the selection background ended mid-row and
// the header never scrolled with the columns. Both now share this floor.
describe("columnsMinWidth", () => {
  const ctx = { graphColWidth: 36, signedColWidth: 16, subjectMinWidth: 120, widths: {} };

  it("sums the tracks' px floors plus gaps plus padding", () => {
    // graph 36 + signed 16 + subject floor 120 = 172; 2 gaps of 8 = 16; padding 24.
    expect(columnsMinWidth(["graph", "signed", "subject"], ctx, 8, 24)).toBe(212);
  });

  it("uses persisted/default widths for the fixed columns", () => {
    // refs falls back to DEFAULT_WIDTHS (150), date takes its persisted 88.
    expect(
      columnsMinWidth(["refs", "date"], { ...ctx, widths: { date: 88 } }, 8, 24),
    ).toBe(150 + 88 + 8 + 24);
  });

  it("handles a single column without gaps", () => {
    expect(columnsMinWidth(["subject"], ctx, 8, 0)).toBe(120);
  });
});
