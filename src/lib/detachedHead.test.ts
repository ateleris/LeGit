import { describe, expect, it } from "vitest";
import { isDetachedHead } from "./detachedHead";
import type { Commit, RefDecoration } from "./types";

const sig = { name: "A", email: "a@b.c", timestamp: 0, tz_offset_minutes: 0 };

function commit(decorations?: RefDecoration[]): Commit {
  return {
    id: "abc123",
    parents: [],
    author: sig,
    committer: sig,
    message: "m",
    timestamp: 0,
    signature: null,
    decorations,
  };
}

describe("isDetachedHead", () => {
  it("is true for a bare head decoration (detached)", () => {
    expect(isDetachedHead(commit([{ type: "head" }]))).toBe(true);
  });

  it("is false when HEAD points at a branch", () => {
    expect(isDetachedHead(commit([{ type: "headOf", value: "main" }]))).toBe(false);
  });

  it("is true when detached at a commit that branches also point to", () => {
    expect(
      isDetachedHead(commit([{ type: "branch", value: "main" }, { type: "head" }])),
    ).toBe(true);
  });

  it("is false without decorations", () => {
    expect(isDetachedHead(commit(undefined))).toBe(false);
    expect(isDetachedHead(commit([]))).toBe(false);
  });

  it("is false for no commit (unborn repo: committing creates the branch)", () => {
    expect(isDetachedHead(null)).toBe(false);
  });
});
