import { describe, test, expect } from "vitest";
import { matchesRefFilter, filterRemoteGroups } from "./refFilter";
import type { RemoteBranchGroup } from "./branchGroups";
import type { Branch } from "./types";

describe("matchesRefFilter", () => {
  test("case-insensitive substring", () => {
    expect(matchesRefFilter("feature/Login-Form", "login")).toBe(true);
    expect(matchesRefFilter("feature/login-form", "LOGIN")).toBe(true);
    expect(matchesRefFilter("feature/login-form", "signup")).toBe(false);
  });

  test("empty or whitespace-only query matches everything", () => {
    expect(matchesRefFilter("anything", "")).toBe(true);
    expect(matchesRefFilter("anything", "   ")).toBe(true);
  });

  test("query is trimmed before matching", () => {
    expect(matchesRefFilter("fix/crash", " crash ")).toBe(true);
  });
});

const branch = (name: string): Branch =>
  ({ name, is_remote: true }) as Branch;

const groups: RemoteBranchGroup[] = [
  { remote: "origin", branches: [branch("origin/main"), branch("origin/fix/crash")] },
  { remote: "fork", branches: [branch("fork/main")] },
];

describe("filterRemoteGroups", () => {
  test("matches on the short name, not the remote prefix", () => {
    // "fix" appears in no remote name; "origin" must not make everything match.
    const out = filterRemoteGroups(groups, "fix");
    expect(out).toEqual([
      { remote: "origin", branches: [branch("origin/fix/crash")] },
    ]);
    expect(filterRemoteGroups(groups, "origin")).toEqual([]);
  });

  test("groups with no matches disappear, others keep their order", () => {
    const out = filterRemoteGroups(groups, "main");
    expect(out.map((g) => g.remote)).toEqual(["origin", "fork"]);
    expect(out[0].branches).toEqual([branch("origin/main")]);
  });

  test("empty query returns the groups unchanged", () => {
    expect(filterRemoteGroups(groups, "")).toEqual(groups);
  });
});
