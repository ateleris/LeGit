import { describe, expect, it } from "vitest";
import { lineActionLabel, selectedHunkLines, type SelectableRow } from "./selectionModel";

const row = (hunkIndex: number, lineIndex: number, kind: string): SelectableRow => ({
  hunkIndex,
  lineIndex,
  kind,
});

describe("selectedHunkLines", () => {
  it("collects the clicked hunk's changed lines from the covered rows, sorted", () => {
    const rows = [
      row(0, -1, "Hunk"),
      row(0, 0, "Context"),
      row(0, 1, "Removed"),
      row(0, 2, "Added"),
      row(0, 3, "Context"),
      row(0, 4, "Added"),
    ];
    // Selection covers rows 2..5, click landed on row 4 (a context line).
    expect(selectedHunkLines(rows, [2, 3, 4, 5], 4)).toEqual([1, 2, 4]);
  });

  it("excludes context lines and header rows from the result", () => {
    const rows = [row(0, -1, "Hunk"), row(0, 0, "Context"), row(0, 1, "Added")];
    expect(selectedHunkLines(rows, [0, 1, 2], 2)).toEqual([1]);
  });

  it("ignores selected lines belonging to other hunks", () => {
    const rows = [
      row(0, 0, "Added"),
      row(0, 1, "Removed"),
      row(1, -1, "Hunk"),
      row(1, 0, "Added"),
    ];
    expect(selectedHunkLines(rows, [0, 1, 2, 3], 0)).toEqual([0, 1]);
  });

  it("returns null when the selection covers no changed line of the clicked hunk", () => {
    const rows = [row(0, 0, "Context"), row(0, 1, "Context"), row(1, 0, "Added")];
    expect(selectedHunkLines(rows, [0, 1], 0)).toBeNull();
  });

  it("returns null when the clicked row is not part of a hunk", () => {
    // Trailing expander / filler rows carry hunkIndex -1.
    const rows = [row(-1, -1, "Hunk"), row(0, 0, "Added")];
    expect(selectedHunkLines(rows, [0, 1], 0)).toBeNull();
  });

  it("returns null when the clicked row index resolves to no row", () => {
    const rows = [row(0, 0, "Added")];
    expect(selectedHunkLines(rows, [0], 5)).toBeNull();
  });

  it("dedupes covered rows that map to the same hunk line", () => {
    const rows = [row(0, 0, "Added"), row(0, 0, "Added"), row(0, 1, "Removed")];
    expect(selectedHunkLines(rows, [0, 1, 2], 0)).toEqual([0, 1]);
  });
});

describe("lineActionLabel", () => {
  it("uses the singular label for a single line", () => {
    expect(lineActionLabel("stage", 1)).toBe("Stage line");
    expect(lineActionLabel("unstage", 1)).toBe("Unstage line");
    expect(lineActionLabel("discard", 1)).toBe("Discard line");
  });

  it("counts the lines in the plural label", () => {
    expect(lineActionLabel("stage", 3)).toBe("Stage 3 lines");
    expect(lineActionLabel("unstage", 2)).toBe("Unstage 2 lines");
    expect(lineActionLabel("discard", 12)).toBe("Discard 12 lines");
  });
});
