import { describe, test, expect, vi } from "vitest";
import {
  buildLockMap,
  buildRefsAt,
  buildStashSelectorById,
  buildUpstreamMap,
} from "./commitRows";
import type { Branch, Commit } from "../../lib/types";

const commit = (id: string, decorations: Commit["decorations"]): Commit =>
  ({
    id,
    message: "m",
    author_name: "a",
    author_email: "a@x",
    timestamp: 0,
    parents: [],
    decorations,
  }) as unknown as Commit;

describe("buildLockMap", () => {
  test("first lock per lane wins, later claims dropped", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const map = buildLockMap([
      { refName: "refs/heads/main", laneIndex: 0 },
      { refName: "refs/heads/dev", laneIndex: 0 },
      { refName: "refs/heads/feat", laneIndex: 2 },
    ]);
    expect(map).toEqual({ "refs/heads/main": 0, "refs/heads/feat": 2 });
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe("buildUpstreamMap", () => {
  test("maps local branches with upstreams, skips remotes and untracked", () => {
    const branches = [
      { name: "dev", is_remote: false, upstream: "refs/remotes/origin/dev" },
      { name: "local-only", is_remote: false, upstream: null },
      { name: "origin/dev", is_remote: true, upstream: null },
    ] as unknown as Branch[];
    expect(buildUpstreamMap(branches)).toEqual(
      new Map([["refs/heads/dev", "refs/remotes/origin/dev"]]),
    );
  });
});

describe("buildRefsAt", () => {
  test("collects branch, headOf and tag decorations; skips undecorated", () => {
    const commits = [
      commit("c1", [
        { type: "branch", value: "refs/heads/dev" },
        { type: "tag", value: "refs/tags/v1" },
      ]),
      // headOf must count: git folds the checked-out branch into
      // `HEAD -> refs/heads/x` with no separate branch decoration.
      commit("c2", [{ type: "headOf", value: "refs/heads/main" }]),
      commit("c3", []),
      commit("c4", [{ type: "stash", value: "stash@{0}" }]),
    ] as unknown as Commit[];
    const map = buildRefsAt(commits);
    expect(map.get("c1")).toEqual(["refs/heads/dev", "refs/tags/v1"]);
    expect(map.get("c2")).toEqual(["refs/heads/main"]);
    expect(map.has("c3")).toBe(false);
    expect(map.has("c4")).toBe(false);
  });
});

describe("buildStashSelectorById", () => {
  test("maps stash decorations only", () => {
    const commits = [
      commit("s1", [{ type: "stash", value: "stash@{0}" }]),
      commit("c1", [{ type: "branch", value: "refs/heads/dev" }]),
    ] as unknown as Commit[];
    expect(buildStashSelectorById(commits)).toEqual(new Map([["s1", "stash@{0}"]]));
  });
});
