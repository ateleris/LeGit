import { describe, expect, it } from "vitest";
import { pickHeadCommitId, repoHasNoCommits } from "./headId";
import type { Commit, RefDecoration, Signature } from "../../lib/types";

const SIG: Signature = { name: "t", email: "t@t", timestamp: 0, tz_offset_minutes: 0 };

function commit(id: string, decorations: RefDecoration[] = []): Commit {
  return {
    id,
    parents: [],
    author: SIG,
    committer: SIG,
    message: id,
    timestamp: 0,
    signature: null,
    has_signature: false,
    decorations,
  };
}

describe("pickHeadCommitId", () => {
  it("finds the commit with a headOf decoration", () => {
    const commits = [
      commit("a"),
      commit("b", [{ type: "headOf", value: "refs/heads/main" }]),
    ];
    expect(pickHeadCommitId(commits)).toBe("b");
  });

  it("finds a detached HEAD decoration", () => {
    const commits = [commit("a"), commit("b", [{ type: "head" }])];
    expect(pickHeadCommitId(commits)).toBe("b");
  });

  it("falls back to the newest commit when HEAD is outside the window", () => {
    expect(pickHeadCommitId([commit("newest"), commit("older")])).toBe("newest");
  });

  it("fallback skips injected stash nodes", () => {
    // Regression: a stash newer than every commit sits at commits[0]; the
    // working-dir row must not hang off it.
    const commits = [
      commit("stash-node", [{ type: "stash", value: "stash@{0}" }]),
      commit("real"),
    ];
    expect(pickHeadCommitId(commits)).toBe("real");
  });

  it("returns null for an empty window or stash-only window", () => {
    expect(pickHeadCommitId([])).toBeNull();
    expect(
      pickHeadCommitId([commit("s", [{ type: "stash", value: "stash@{0}" }])]),
    ).toBeNull();
  });
});

describe("repoHasNoCommits", () => {
  it("is true only for a loaded, unfiltered, headless log", () => {
    expect(repoHasNoCommits(true, false, null)).toBe(true);
  });

  it("is false while the log is still loading", () => {
    expect(repoHasNoCommits(false, false, null)).toBe(false);
  });

  it("is false when a filter empties the window of a repo with commits", () => {
    expect(repoHasNoCommits(true, true, null)).toBe(false);
  });

  it("is false once a HEAD commit is known", () => {
    expect(repoHasNoCommits(true, false, "abc")).toBe(false);
  });
});
