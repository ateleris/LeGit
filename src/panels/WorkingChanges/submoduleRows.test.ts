import { describe, expect, it } from "vitest";
import { isSubmodulePath, submodulePathSet } from "./submoduleRows";
import type { SubmoduleInfo } from "../../lib/types";

const sub = (path: string, recorded: string | null): SubmoduleInfo => ({
  name: path,
  path,
  url: null,
  gitmodules_url: "https://x.invalid/lib.git",
  branch: null,
  recorded_sha: recorded,
  checked_out_sha: null,
  head_branch: null,
  state: {
    initialized: false,
    populated: false,
    pointer_moved: false,
    dirty_tracked: false,
    dirty_untracked: false,
    conflicted: false,
    orphan_gitlink: false,
    config_drift: false,
  },
});

describe("submodulePathSet", () => {
  it("includes declared-but-never-added submodules (no recorded sha)", () => {
    const set = submodulePathSet([sub("docs/baseline", null), sub("libs/core", "a".repeat(40))]);
    expect(set.has("docs/baseline")).toBe(true);
    expect(set.has("libs/core")).toBe(true);
  });
});

describe("isSubmodulePath", () => {
  const set = new Set(["docs/baseline"]);

  it("matches the untracked collapsed-directory form (trailing slash)", () => {
    expect(isSubmodulePath("docs/baseline/", set)).toBe(true);
  });

  it("matches the staged gitlink form (no trailing slash)", () => {
    expect(isSubmodulePath("docs/baseline", set)).toBe(true);
  });

  it("does not match files inside or next to the submodule", () => {
    expect(isSubmodulePath("docs/baseline/file.txt", set)).toBe(false);
    expect(isSubmodulePath("docs/baseline2", set)).toBe(false);
    expect(isSubmodulePath("docs", set)).toBe(false);
  });
});
