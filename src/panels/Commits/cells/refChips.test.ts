import { describe, expect, it } from "vitest";
import { branchesAt, buildChips, computeVisibleCount } from "./refChips";
import type { RefDecoration } from "../../../lib/types";

const branch = (value: string): RefDecoration => ({ type: "branch", value });
const tag = (value: string): RefDecoration => ({ type: "tag", value });
const remote = (value: string): RefDecoration => ({ type: "remote", value });
const other = (value: string): RefDecoration => ({ type: "other", value });
const stash = (value: string): RefDecoration => ({ type: "stash", value });
const headOf = (value: string): RefDecoration => ({ type: "headOf", value });

const NO_UPSTREAM = new Map<string, string>();
const upstreams = (pairs: Record<string, string>) =>
  new Map(Object.entries(pairs));

describe("buildChips", () => {
  it("fuses a local branch with its upstream remote on the same commit", () => {
    const out = buildChips(
      [branch("refs/heads/dev"), remote("refs/remotes/origin/dev")],
      upstreams({ "refs/heads/dev": "refs/remotes/origin/dev" }),
    );
    expect(out).toEqual([
      { kind: "fusedBranch", local: "refs/heads/dev", remote: "refs/remotes/origin/dev" },
    ]);
  });

  it("does not fuse when the upstream remote is absent on this commit (diverged)", () => {
    const out = buildChips(
      [branch("refs/heads/dev")],
      upstreams({ "refs/heads/dev": "refs/remotes/origin/dev" }),
    );
    expect(out).toEqual([{ kind: "branch", value: "refs/heads/dev" }]);
  });

  it("renders a remote-only branch as a standalone remote chip", () => {
    const out = buildChips([remote("refs/remotes/origin/feature")], NO_UPSTREAM);
    expect(out).toEqual([{ kind: "remote", value: "refs/remotes/origin/feature" }]);
  });

  it("omits the remote's symbolic HEAD ref", () => {
    const out = buildChips(
      [remote("refs/remotes/origin/HEAD"), remote("refs/remotes/origin/main")],
      NO_UPSTREAM,
    );
    expect(out).toEqual([{ kind: "remote", value: "refs/remotes/origin/main" }]);
  });

  it("fuses only the configured upstream; other remotes stay standalone", () => {
    const out = buildChips(
      [
        branch("refs/heads/dev"),
        remote("refs/remotes/origin/dev"),
        remote("refs/remotes/upstream/dev"),
      ],
      upstreams({ "refs/heads/dev": "refs/remotes/origin/dev" }),
    );
    expect(out).toEqual([
      { kind: "fusedBranch", local: "refs/heads/dev", remote: "refs/remotes/origin/dev" },
      { kind: "remote", value: "refs/remotes/upstream/dev" },
    ]);
  });

  it("does not fuse when no upstream is configured", () => {
    const out = buildChips(
      [branch("refs/heads/dev"), remote("refs/remotes/origin/dev")],
      NO_UPSTREAM,
    );
    expect(out).toEqual([
      { kind: "branch", value: "refs/heads/dev" },
      { kind: "remote", value: "refs/remotes/origin/dev" },
    ]);
  });

  it("expands HEAD -> into a (fused) branch chip, with no separate indicator", () => {
    // The checked-out state is shown as a dot inside the branch chip, not as
    // a `HEAD →` chip of its own.
    const out = buildChips(
      [headOf("refs/heads/main"), remote("refs/remotes/origin/main")],
      upstreams({ "refs/heads/main": "refs/remotes/origin/main" }),
    );
    expect(out).toEqual([
      { kind: "fusedBranch", local: "refs/heads/main", remote: "refs/remotes/origin/main" },
    ]);
  });

  it("orders: checked-out branch, branches, remotes, tags, other", () => {
    const out = buildChips(
      [
        tag("refs/tags/v1.0"),
        remote("refs/remotes/origin/release"),
        other("refs/notes/commits"),
        stash("stash@{0}"),
        branch("refs/heads/dev"),
        headOf("refs/heads/main"),
      ],
      NO_UPSTREAM,
    );
    expect(out).toEqual([
      { kind: "branch", value: "refs/heads/main" },
      { kind: "branch", value: "refs/heads/dev" },
      { kind: "remote", value: "refs/remotes/origin/release" },
      { kind: "tag", value: "refs/tags/v1.0" },
      { kind: "other", value: "refs/notes/commits" },
    ]);
  });

  it("emits no chip for a stash decoration (the graph node marks the stash)", () => {
    const out = buildChips([stash("stash@{2}")], NO_UPSTREAM);
    expect(out).toEqual([]);
  });

  it("keeps a detached HEAD chip first", () => {
    const out = buildChips([tag("refs/tags/v1.0"), { type: "head" }], NO_UPSTREAM);
    expect(out).toEqual([{ kind: "head" }, { kind: "tag", value: "refs/tags/v1.0" }]);
  });

  it("preserves git order within a group", () => {
    const out = buildChips(
      [branch("refs/heads/a"), branch("refs/heads/b")],
      NO_UPSTREAM,
    );
    expect(out).toEqual([
      { kind: "branch", value: "refs/heads/a" },
      { kind: "branch", value: "refs/heads/b" },
    ]);
  });
});

describe("branchesAt", () => {
  it("lists local branches with short names", () => {
    const out = branchesAt([branch("refs/heads/dev"), branch("refs/heads/fix/x")]);
    expect(out.local).toEqual([
      { name: "dev", isCurrent: false },
      { name: "fix/x", isCurrent: false },
    ]);
    expect(out.remote).toEqual([]);
  });

  it("synthesizes the checked-out branch from HEAD -> and marks it current, first", () => {
    // git folds the current branch into `HEAD -> x` with no separate branch
    // decoration — the menu must still offer it.
    const out = branchesAt([branch("refs/heads/dev"), headOf("refs/heads/main")]);
    expect(out.local).toEqual([
      { name: "main", isCurrent: true },
      { name: "dev", isCurrent: false },
    ]);
  });

  it("does not duplicate the current branch when git lists it explicitly", () => {
    const out = branchesAt([headOf("refs/heads/main"), branch("refs/heads/main")]);
    expect(out.local).toEqual([{ name: "main", isCurrent: true }]);
  });

  it("lists remotes with short names, skipping the symbolic HEAD", () => {
    const out = branchesAt([
      remote("refs/remotes/origin/HEAD"),
      remote("refs/remotes/origin/main"),
    ]);
    expect(out.remote).toEqual(["origin/main"]);
  });

  it("ignores tags, stashes, detached HEAD, and other refs", () => {
    const out = branchesAt([
      tag("refs/tags/v1"),
      stash("stash@{0}"),
      { type: "head" },
      other("refs/notes/commits"),
    ]);
    expect(out).toEqual({ local: [], remote: [] });
  });
});

describe("computeVisibleCount", () => {
  // Chips 30px wide, 3px gaps, "+N" chip 24px wide.
  const widths = [30, 30, 30, 30];

  it("shows all chips when they fit", () => {
    // 4*30 + 3*3 = 129
    expect(computeVisibleCount(widths, 129, 3, 24)).toBe(4);
  });

  it("collapses trailing chips behind the overflow chip", () => {
    // 2 chips + gap + overflow: 30+3+30 + 3+24 = 90 fits in 100; 3 don't.
    expect(computeVisibleCount(widths, 100, 3, 24)).toBe(2);
  });

  it("never hides just one chip without need", () => {
    // All four at 129 — exactly fits, no overflow chip.
    expect(computeVisibleCount(widths, 129, 3, 24)).toBe(4);
    // 128 → all do not fit; 3 chips + overflow = 96+3+24 = 123 ≤ 128.
    expect(computeVisibleCount(widths, 128, 3, 24)).toBe(3);
  });

  it("always keeps at least one chip visible", () => {
    expect(computeVisibleCount(widths, 10, 3, 24)).toBe(1);
  });

  it("handles empty input", () => {
    expect(computeVisibleCount([], 100, 3, 24)).toBe(0);
  });
});
