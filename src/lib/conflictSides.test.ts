// Maps git's ours/theirs to the real branch names per in-progress operation.
// The rebase case is the trap this encodes: during a rebase "ours" is the
// side being rebased ONTO, "theirs" the branch being rebased.

import { describe, expect, it } from "vitest";
import { opSideNames } from "./conflictSides";
import type { RepoOpState } from "./types";

describe("opSideNames", () => {
  it("merge: ours is the current branch, theirs the merged branch", () => {
    const op: RepoOpState = { kind: "merge", branch: "feature/x", message: null };
    expect(opSideNames(op, "dev")).toEqual({ ours: "dev", theirs: "feature/x" });
  });

  it("rebase: ours is the onto side, theirs the rebased branch", () => {
    const op: RepoOpState = {
      kind: "rebase",
      onto: "main",
      head_name: "feature/x",
      current_step: 1,
      total_steps: 3,
    };
    expect(opSideNames(op, null)).toEqual({ ours: "main", theirs: "feature/x" });
  });

  it("cherry-pick and revert: theirs is the shortened commit", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    expect(opSideNames({ kind: "cherry_pick", sha }, "dev")).toEqual({
      ours: "dev",
      theirs: "01234567",
    });
    expect(opSideNames({ kind: "revert", sha }, "dev")).toEqual({
      ours: "dev",
      theirs: "01234567",
    });
  });

  it("no operation (stash-apply conflicts): ours is still the current branch", () => {
    expect(opSideNames({ kind: "none" }, "dev")).toEqual({ ours: "dev", theirs: null });
    expect(opSideNames(null, "dev")).toEqual({ ours: "dev", theirs: null });
    expect(opSideNames(undefined, null)).toEqual({ ours: null, theirs: null });
  });

  it("missing op details fall back to null, not placeholders", () => {
    expect(opSideNames({ kind: "merge", branch: null, message: null }, null)).toEqual({
      ours: null,
      theirs: null,
    });
    expect(
      opSideNames(
        { kind: "rebase", onto: null, head_name: null, current_step: null, total_steps: null },
        "dev",
      ),
    ).toEqual({ ours: null, theirs: null });
  });
});
