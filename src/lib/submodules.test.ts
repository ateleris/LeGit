import { describe, expect, it } from "vitest";
import { submoduleBadge } from "./submodules";
import type { SubmoduleInfo, SubmoduleState } from "./types";

const state = (over: Partial<SubmoduleState> = {}): SubmoduleState => ({
  initialized: true,
  populated: true,
  pointer_moved: false,
  dirty_tracked: false,
  dirty_untracked: false,
  conflicted: false,
  orphan_gitlink: false,
  config_drift: false,
  ...over,
});

const info = (over: Partial<SubmoduleInfo> = {}): SubmoduleInfo => ({
  name: "lib",
  path: "vendor/lib",
  url: "u",
  gitmodules_url: "u",
  branch: null,
  recorded_sha: "a".repeat(40),
  checked_out_sha: "a".repeat(40),
  head_branch: "main",
  state: state(),
  ...over,
});

describe("submoduleBadge", () => {
  it("returns null for a clean submodule on a branch", () => {
    expect(submoduleBadge(info())).toBeNull();
  });
  it("prefers conflict over everything", () => {
    const i = info({ state: state({ conflicted: true, pointer_moved: true }) });
    expect(submoduleBadge(i)?.label).toBe("conflict");
  });
  it("pointer move beats dirty", () => {
    const i = info({ state: state({ pointer_moved: true, dirty_tracked: true }) });
    expect(submoduleBadge(i)?.label).toBe("pointer moved");
  });
  it("flags detached HEAD", () => {
    expect(submoduleBadge(info({ head_branch: null }))?.label).toBe("detached");
  });
  it("flags uninitialized before detached", () => {
    const i = info({
      head_branch: null,
      state: state({ initialized: false, populated: false }),
    });
    expect(submoduleBadge(i)?.label).toBe("uninitialized");
  });
});
