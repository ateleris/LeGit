import { describe, expect, it } from "vitest";
import { expandUnstagePaths } from "./unstagePaths";
import type { FileTreeEntry } from "../shared/FileTree/buildTree";

const rename = (path: string, old_path: string): FileTreeEntry => ({
  path,
  change: "Renamed",
  old_path,
});
const modified = (path: string): FileTreeEntry => ({ path, change: "Modified" });

describe("expandUnstagePaths", () => {
  it("adds the rename source for a selected rename row", () => {
    // Regression: `restore --staged` on the new path alone left the
    // source's deletion staged (rename split into add + staged delete).
    const out = expandUnstagePaths(["Test.c"], [rename("Test.c", "test.c")]);
    expect(out).toEqual(["Test.c", "test.c"]);
  });

  it("leaves non-rename selections alone", () => {
    expect(expandUnstagePaths(["a.c"], [modified("a.c")])).toEqual(["a.c"]);
  });

  it("does not duplicate an already-selected source path", () => {
    const staged = [rename("b.c", "a.c"), modified("a.c")];
    expect(expandUnstagePaths(["b.c", "a.c"], staged)).toEqual(["b.c", "a.c"]);
  });

  it("ignores renames outside the selection", () => {
    const staged = [rename("b.c", "a.c"), modified("other.c")];
    expect(expandUnstagePaths(["other.c"], staged)).toEqual(["other.c"]);
  });
});
