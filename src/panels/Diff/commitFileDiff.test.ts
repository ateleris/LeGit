import { describe, expect, it } from "vitest";
import { commitDiffRequest } from "./CommitFileDiff";
import type { FileHistoryEntry } from "../../lib/types";

const entry: FileHistoryEntry = {
  commit_id: "abc123def",
  path: "src/new-name.ts",
  old_path: "src/old-name.ts",
  author: "ada",
  summary: "rename",
  timestamp: 1700000000,
};

describe("commitDiffRequest", () => {
  it("targets the commit and pairs the rename sides", () => {
    expect(commitDiffRequest("repo1", entry)).toEqual({
      repoId: "repo1",
      path: "src/new-name.ts",
      oldPath: "src/old-name.ts",
      source: { kind: "commit", commit_id: "abc123def" },
    });
  });

  it("omits oldPath for a plain entry", () => {
    const req = commitDiffRequest("repo1", { ...entry, old_path: null });
    expect(req.oldPath ?? null).toBeNull();
  });
});
