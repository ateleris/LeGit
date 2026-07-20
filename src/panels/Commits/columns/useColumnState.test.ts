import { describe, expect, it } from "vitest";
import { parsePreferences } from "./useColumnState";
import type { ColumnId } from "./types";

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
