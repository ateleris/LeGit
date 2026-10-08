import { describe, expect, it } from "vitest";
import { pushUpToTarget } from "./pushUpTo";

const pushable = new Set(["c3", "c2", "c1"]);

describe("pushUpToTarget", () => {
  it("targets the upstream's remote for a pushable commit", () => {
    expect(
      pushUpToTarget({
        commitId: "c2",
        pushable,
        branchName: "main",
        upstream: "refs/remotes/origin/main",
        remotes: ["origin"],
      }),
    ).toEqual({ remote: "origin", branch: "main" });
  });

  it("hides the entry for a commit outside the eligible set", () => {
    expect(
      pushUpToTarget({
        commitId: "side",
        pushable,
        branchName: "main",
        upstream: "refs/remotes/origin/main",
        remotes: ["origin"],
      }),
    ).toBeNull();
  });

  it("hides the entry on a detached HEAD", () => {
    expect(
      pushUpToTarget({
        commitId: "c2",
        pushable,
        branchName: null,
        upstream: null,
        remotes: ["origin"],
      }),
    ).toBeNull();
  });

  it("hides the entry when the upstream's remote is no longer configured", () => {
    // resolveBranchPushPlan treats that as untracked (re-publish), and a
    // partial push needs a real upstream to be meaningful.
    expect(
      pushUpToTarget({
        commitId: "c2",
        pushable,
        branchName: "main",
        upstream: "refs/remotes/gone/main",
        remotes: ["origin"],
      }),
    ).toBeNull();
  });
});
