import { describe, expect, it } from "vitest";
import { allUntracked } from "./dirGitignore";
import type { FileTreeEntry } from "../shared/FileTree/buildTree";

const entry = (path: string, change: string): FileTreeEntry => ({
  path,
  change: change as FileTreeEntry["change"],
});

describe("allUntracked", () => {
  it("accepts a folder holding only untracked files", () => {
    const files = [entry("gen/a.ts", "Untracked"), entry("gen/b.ts", "Untracked")];
    expect(allUntracked(["gen/a.ts", "gen/b.ts"], files)).toBe(true);
  });

  it("rejects a folder holding a tracked change", () => {
    const files = [entry("src/a.ts", "Untracked"), entry("src/b.ts", "Modified")];
    expect(allUntracked(["src/a.ts", "src/b.ts"], files)).toBe(false);
  });

  it("rejects a path missing from the section", () => {
    expect(allUntracked(["gen/a.ts"], [])).toBe(false);
  });

  it("rejects an empty folder", () => {
    expect(allUntracked([], [entry("gen/a.ts", "Untracked")])).toBe(false);
  });
});
