import { describe, expect, it } from "vitest";
import { branchWorktreeMap, detachedWorktreeHeads, worktreeBadges, worktreeLabel } from "./worktreeRows";
import type { WorktreeInfo } from "../../lib/types";

const wt = (over: Partial<WorktreeInfo>): WorktreeInfo => ({
  path: "/home/u/app-wt",
  head: "1111111111111111111111111111111111111111",
  branch: "feature",
  is_main: false,
  detached: false,
  bare: false,
  locked: null,
  prunable: null,
  dirty: null,
  ...over,
});

describe("worktreeLabel", () => {
  it("uses the last path segment", () => {
    expect(worktreeLabel(wt({ path: "/home/u/app-wt" }))).toBe("app-wt");
    expect(worktreeLabel(wt({ path: "C:/repos/app-wt" }))).toBe("app-wt");
    expect(worktreeLabel(wt({ path: "C:\\repos\\app-wt" }))).toBe("app-wt");
  });
});

describe("worktreeBadges", () => {
  it("orders main/current/dirty/detached/locked/prunable", () => {
    expect(worktreeBadges(wt({ is_main: true }), null)).toEqual(["main"]);
    expect(worktreeBadges(wt({}), "/home/u/app-wt")).toEqual(["current"]);
    expect(worktreeBadges(wt({ detached: true, branch: null }), null)).toEqual(["detached"]);
    expect(worktreeBadges(wt({ locked: "usb" }), null)).toEqual(["locked"]);
    expect(worktreeBadges(wt({ prunable: "gone" }), null)).toEqual(["prunable"]);
    expect(worktreeBadges(wt({ dirty: true, detached: true, branch: null }), null)).toEqual([
      "dirty",
      "detached",
    ]);
    // Clean and unprobed both show nothing - the badge only asserts, never guesses.
    expect(worktreeBadges(wt({ dirty: false }), null)).toEqual([]);
    expect(worktreeBadges(wt({ is_main: true, locked: "" }), "/home/u/app-wt")).toEqual([
      "main",
      "current",
      "locked",
    ]);
  });
});

describe("branchWorktreeMap", () => {
  it("maps branches held by OTHER worktrees to their worktree path", () => {
    const list = [
      wt({ path: "/repo", is_main: true, branch: "main" }),
      wt({ path: "/wt-a", branch: "feature" }),
      wt({ path: "/wt-b", branch: null, detached: true }),
    ];
    const map = branchWorktreeMap(list, "/repo");
    expect(map.get("feature")).toEqual({ path: "/wt-a", dirty: false });
    // The current worktree's own branch is not "locked" for this session.
    expect(map.has("main")).toBe(false);
    expect(map.size).toBe(1);
  });

  it("normalizes windows-style current paths", () => {
    const list = [wt({ path: "C:/repos/app", is_main: true, branch: "main" })];
    expect(branchWorktreeMap(list, "C:\\repos\\app").size).toBe(0);
  });
});

describe("detachedWorktreeHeads", () => {
  it("groups OTHER detached worktrees by their HEAD sha", () => {
    const sha = "1111111111111111111111111111111111111111";
    const list = [
      wt({ path: "/repo", is_main: true, branch: "main" }),
      wt({ path: "/wt-a", branch: null, detached: true, head: sha }),
      wt({ path: "/wt-b", branch: null, detached: true, head: sha }),
      wt({ path: "/wt-c", branch: "feature" }),
    ];
    const map = detachedWorktreeHeads(list, "/repo");
    expect(map.get(sha)).toEqual([
      { name: "wt-a", path: "/wt-a", dirty: false },
      { name: "wt-b", path: "/wt-b", dirty: false },
    ]);
    expect(map.size).toBe(1);
  });

  it("carries the dirty flag through", () => {
    const sha = "3333333333333333333333333333333333333333";
    const list = [wt({ path: "/wt-a", branch: null, detached: true, head: sha, dirty: true })];
    expect(detachedWorktreeHeads(list, null).get(sha)).toEqual([
      { name: "wt-a", path: "/wt-a", dirty: true },
    ]);
  });

  it("excludes the current worktree even when detached", () => {
    const sha = "2222222222222222222222222222222222222222";
    const list = [wt({ path: "/wt-a", branch: null, detached: true, head: sha })];
    expect(detachedWorktreeHeads(list, "/wt-a").size).toBe(0);
  });
});
