import { describe, expect, it } from "vitest";
import { diffSides } from "./diffSides";

describe("diffSides", () => {
  it("maps each diff source to its old/new rev specs", () => {
    expect(diffSides({ kind: "working_unstaged" })).toEqual({ rev: null, oldRev: ":" });
    expect(diffSides({ kind: "working_staged" })).toEqual({ rev: ":", oldRev: "HEAD" });
    expect(diffSides({ kind: "commit", commit_id: "abc" })).toEqual({ rev: "abc", oldRev: "abc^" });
    expect(diffSides({ kind: "commit_range", from: "a", to: "b" })).toEqual({
      rev: "b",
      oldRev: "a",
    });
  });
});
