import { describe, expect, it } from "vitest";
import { groupRemoteBranches, shortRemoteBranchName } from "./branchGroups";
import type { Branch } from "./types";

const remoteBranch = (name: string): Branch => ({
  name,
  is_current: false,
  is_remote: true,
  upstream: null,
  head: null,
  ahead: null,
  behind: null,
  upstream_gone: false,
});

describe("groupRemoteBranches", () => {
  it("groups branches by remote in the given remotes order", () => {
    const groups = groupRemoteBranches(
      [remoteBranch("upstream/main"), remoteBranch("origin/dev"), remoteBranch("origin/main")],
      ["origin", "upstream"],
    );
    expect(groups.map((g) => g.remote)).toEqual(["origin", "upstream"]);
    expect(groups[0].branches.map((b) => b.name)).toEqual(["origin/dev", "origin/main"]);
    expect(groups[1].branches.map((b) => b.name)).toEqual(["upstream/main"]);
  });

  it("matches the longest remote prefix, not the first slash", () => {
    // A remote named "fork/alice" must win over a remote named "fork".
    const groups = groupRemoteBranches(
      [remoteBranch("fork/alice/main"), remoteBranch("fork/main")],
      ["fork", "fork/alice"],
    );
    expect(groups.map((g) => g.remote)).toEqual(["fork", "fork/alice"]);
    expect(groups[0].branches.map((b) => b.name)).toEqual(["fork/main"]);
    expect(groups[1].branches.map((b) => b.name)).toEqual(["fork/alice/main"]);
  });

  it("keeps branches of unknown remotes via first-segment fallback, appended last", () => {
    const groups = groupRemoteBranches(
      [remoteBranch("gone-remote/main"), remoteBranch("origin/main")],
      ["origin"],
    );
    expect(groups.map((g) => g.remote)).toEqual(["origin", "gone-remote"]);
    expect(groups[1].branches.map((b) => b.name)).toEqual(["gone-remote/main"]);
  });

  it("omits remotes with no branches", () => {
    const groups = groupRemoteBranches([remoteBranch("origin/main")], ["origin", "upstream"]);
    expect(groups.map((g) => g.remote)).toEqual(["origin"]);
  });

  it("handles an empty branch list", () => {
    expect(groupRemoteBranches([], ["origin"])).toEqual([]);
  });
});

describe("shortRemoteBranchName", () => {
  it("strips the remote prefix", () => {
    expect(shortRemoteBranchName("origin/feat/x", "origin")).toBe("feat/x");
  });

  it("leaves a non-matching name untouched", () => {
    expect(shortRemoteBranchName("origin/main", "upstream")).toBe("origin/main");
  });
});
