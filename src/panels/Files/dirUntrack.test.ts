import { describe, test, expect } from "vitest";
import { canUntrackFolder } from "./dirUntrack";
import type { RepoFileKind } from "../../lib/types";

const kinds = (entries: [string, RepoFileKind][]) => new Map<string, RepoFileKind>(entries);

describe("canUntrackFolder", () => {
  test("a folder with tracked files can be untracked", () => {
    expect(
      canUntrackFolder(
        ["src/a.ts", "src/b.txt"],
        kinds([
          ["src/a.ts", "tracked"],
          ["src/b.txt", "untracked"],
        ]),
        new Set(),
      ),
    ).toBe(true);
  });

  test("a folder with only untracked or ignored files has nothing to untrack", () => {
    expect(
      canUntrackFolder(
        ["out/a.o", "out/b.o"],
        kinds([
          ["out/a.o", "untracked"],
          ["out/b.o", "ignored"],
        ]),
        new Set(),
      ),
    ).toBe(false);
  });

  test("a folder containing a submodule is excluded (gitlink removal is not untracking)", () => {
    expect(
      canUntrackFolder(
        ["vendor/a.ts", "vendor/lib"],
        kinds([
          ["vendor/a.ts", "tracked"],
          ["vendor/lib", "tracked"],
        ]),
        new Set(["vendor/lib"]),
      ),
    ).toBe(false);
  });

  test("an empty folder listing cannot be untracked", () => {
    expect(canUntrackFolder([], kinds([]), new Set())).toBe(false);
  });
});
