import { describe, expect, it } from "vitest";
import { submoduleBadge, submoduleSelectTarget } from "./submodules";
import type { DiffEntry, SubmoduleChange, SubmoduleInfo, SubmoduleState } from "./types";

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

describe("submoduleSelectTarget", () => {
  const NEW = "b".repeat(40);
  const sub = (over: Partial<SubmoduleChange> = {}): DiffEntry => ({
    Submodule: {
      path: "vendor/lib",
      old_sha: "a".repeat(40),
      new_sha: NEW,
      dirty: false,
      ...over,
    },
  });

  it("returns the new pointer of a submodule diff", () => {
    expect(submoduleSelectTarget(sub())).toBe(NEW);
  });
  it("returns null when the submodule was removed (no new pointer)", () => {
    expect(submoduleSelectTarget(sub({ new_sha: null }))).toBeNull();
  });
  it("returns null for a non-submodule diff", () => {
    const text: DiffEntry = {
      Text: { old_path: "a.txt", new_path: "a.txt", hunks: [] },
    };
    expect(submoduleSelectTarget(text)).toBeNull();
  });
});
