import { describe, expect, it } from "vitest";
import { repoKeys } from "./keys";

describe("repoKeys", () => {
  it("produces the historical [repoId, domain] shapes", () => {
    expect(repoKeys.domain("r", "log")).toEqual(["r", "log"]);
    expect(repoKeys.status("r")).toEqual(["r", "status"]);
    expect(repoKeys.branches("r")).toEqual(["r", "branches"]);
    expect(repoKeys.remotes("r")).toEqual(["r", "remotes"]);
    expect(repoKeys.tags("r")).toEqual(["r", "tags"]);
    expect(repoKeys.remoteTags("r", "origin")).toEqual(["r", "remote-tags", "origin"]);
    expect(repoKeys.remoteTags("r", null)).toEqual(["r", "remote-tags", null]);
    expect(repoKeys.tracking("r")).toEqual(["r", "tracking"]);
    expect(repoKeys.stashes("r")).toEqual(["r", "stashes"]);
    expect(repoKeys.worktrees("r")).toEqual(["r", "worktrees"]);
    expect(repoKeys.submodules("r")).toEqual(["r", "submodules"]);
    expect(repoKeys.lfs("r")).toEqual(["r", "lfs"]);
    expect(repoKeys.opState("r")).toEqual(["r", "op_state"]);
  });

  it("keeps a missing repo id in place", () => {
    expect(repoKeys.status(undefined)).toEqual([undefined, "status"]);
    expect(repoKeys.lfs(null)).toEqual([null, "lfs"]);
  });
});
