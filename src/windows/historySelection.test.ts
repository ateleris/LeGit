import { describe, expect, it } from "vitest";
import { nextSelection } from "./historySelection";
import type { FileHistoryEntry } from "../lib/types";

const e = (sha: string, path = "a.ts"): FileHistoryEntry => ({
  commit_id: sha,
  path,
  old_path: null,
  author: "x",
  summary: sha,
  timestamp: 1,
});

describe("nextSelection", () => {
  it("selects the first entry initially", () => {
    expect(nextSelection([e("a"), e("b")], null)?.commit_id).toBe("a");
  });

  it("keeps the current entry while it still exists", () => {
    expect(nextSelection([e("a"), e("b")], e("b"))?.commit_id).toBe("b");
  });

  it("falls back to the newest entry when the current one vanished", () => {
    expect(nextSelection([e("c"), e("a")], e("b"))?.commit_id).toBe("c");
  });

  it("returns null for an empty history", () => {
    expect(nextSelection([], e("a"))).toBeNull();
  });
});
