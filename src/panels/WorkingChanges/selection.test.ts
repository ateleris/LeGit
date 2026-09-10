import { describe, expect, it } from "vitest";
import { dropSelection, moveSelection, type Selection } from "./selection";

const sel = (section: "staged" | "unstaged", ...paths: string[]): Selection => ({
  section,
  paths,
});

describe("moveSelection", () => {
  it("leaves a selection in the other section untouched", () => {
    const s = sel("staged", "a.txt");
    expect(moveSelection(s, "unstaged", "staged", ["a.txt"])).toBe(s);
  });

  it("leaves the selection when none of it moved", () => {
    const s = sel("unstaged", "a.txt");
    expect(moveSelection(s, "unstaged", "staged", ["b.txt"])).toBe(s);
  });

  it("follows the selection into the target section when all of it moved", () => {
    expect(moveSelection(sel("unstaged", "a.txt", "b.txt"), "unstaged", "staged", ["a.txt", "b.txt"])).toEqual(
      sel("staged", "a.txt", "b.txt"),
    );
  });

  it("keeps only the not-moved paths in the source section on a partial move", () => {
    expect(moveSelection(sel("unstaged", "a.txt", "b.txt"), "unstaged", "staged", ["a.txt"])).toEqual(
      sel("unstaged", "b.txt"),
    );
  });

  it("passes a null selection through", () => {
    expect(moveSelection(null, "unstaged", "staged", ["a.txt"])).toBeNull();
  });
});

describe("dropSelection", () => {
  it("ignores a staged selection", () => {
    const s = sel("staged", "a.txt");
    expect(dropSelection(s, ["a.txt"])).toBe(s);
  });

  it("removes discarded paths from an unstaged selection", () => {
    expect(dropSelection(sel("unstaged", "a.txt", "b.txt"), ["a.txt"])).toEqual(
      sel("unstaged", "b.txt"),
    );
  });

  it("clears the selection when everything was discarded", () => {
    expect(dropSelection(sel("unstaged", "a.txt"), ["a.txt"])).toBeNull();
  });

  it("passes a null selection through", () => {
    expect(dropSelection(null, ["a.txt"])).toBeNull();
  });
});
