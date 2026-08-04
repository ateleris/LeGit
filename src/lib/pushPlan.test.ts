// Unit tests for the branch push-target decision: given a branch's upstream
// and the configured remotes, where does "Push" send it, and does it need to
// publish (--set-upstream) or ask the user to pick a remote first?

import { describe, test, expect } from "vitest";
import { resolveBranchPushPlan } from "./pushPlan";

describe("resolveBranchPushPlan", () => {
  test("tracked branch pushes to its upstream's remote without set-upstream", () => {
    expect(resolveBranchPushPlan("origin/feature", ["origin"])).toEqual({
      kind: "push",
      remote: "origin",
      setUpstream: false,
    });
  });

  test("accepts a full upstream ref (refs/remotes/…)", () => {
    expect(
      resolveBranchPushPlan("refs/remotes/origin/feat/x", ["origin", "fork"]),
    ).toEqual({ kind: "push", remote: "origin", setUpstream: false });
  });

  test("matches the longest remote name (remote names can contain '/')", () => {
    expect(
      resolveBranchPushPlan("a/b/feature", ["a", "a/b"]),
    ).toEqual({ kind: "push", remote: "a/b", setUpstream: false });
  });

  test("upstream on a no-longer-configured remote is treated as untracked", () => {
    expect(resolveBranchPushPlan("gone/feature", ["origin"])).toEqual({
      kind: "push",
      remote: "origin",
      setUpstream: true,
    });
  });

  test("untracked branch with a single remote publishes there", () => {
    expect(resolveBranchPushPlan(null, ["origin"])).toEqual({
      kind: "push",
      remote: "origin",
      setUpstream: true,
    });
  });

  test("untracked branch with several remotes needs a choice", () => {
    expect(resolveBranchPushPlan(null, ["origin", "fork"])).toEqual({
      kind: "choose",
      remotes: ["origin", "fork"],
    });
  });

  test("no remotes configured means no push target", () => {
    expect(resolveBranchPushPlan(null, [])).toEqual({ kind: "none" });
    expect(resolveBranchPushPlan("origin/feature", [])).toEqual({ kind: "none" });
  });
});
