import { describe, expect, it } from "vitest";
import { branchTreeRows, folderHoldsCurrent, leafName } from "./branchTree";

const names = ["main", "feature/api", "feature/new-pricing"];

describe("branchTreeRows", () => {
  it("groups slash-prefixed names under folder rows, folders first", () => {
    const rows = branchTreeRows(names, new Set());
    expect(rows.map((r) => (r.kind === "dir" ? `D:${r.path}` : `B:${r.path}`))).toEqual([
      "D:feature",
      "B:feature/api",
      "B:feature/new-pricing",
      "B:main",
    ]);
  });

  it("reports the branch count on the folder row", () => {
    const rows = branchTreeRows(names, new Set());
    const dir = rows.find((r) => r.kind === "dir");
    expect(dir && dir.kind === "dir" && dir.fileCount).toBe(2);
  });

  it("hides a collapsed folder's branches", () => {
    const rows = branchTreeRows(names, new Set(["feature"]));
    expect(rows.map((r) => r.path)).toEqual(["feature", "main"]);
    const dir = rows[0];
    expect(dir.kind === "dir" && dir.collapsed).toBe(true);
  });

  it("compresses single-child folder chains into one row", () => {
    const rows = branchTreeRows(["release/v1/hotfix"], new Set());
    const dir = rows.find((r) => r.kind === "dir");
    expect(dir && dir.kind === "dir" && dir.label).toBe("release/v1");
    expect(dir && dir.kind === "dir" && dir.path).toBe("release/v1");
  });

  it("indents nested rows by depth", () => {
    const rows = branchTreeRows(["a/b", "a/c/d"], new Set());
    const byPath = new Map(rows.map((r) => [r.path, r.depth]));
    expect(byPath.get("a")).toBe(0);
    expect(byPath.get("a/b")).toBe(1);
    expect(byPath.get("a/c")).toBe(1);
    expect(byPath.get("a/c/d")).toBe(2);
  });
});

describe("leafName", () => {
  it("returns the last path segment", () => {
    expect(leafName("feature/new-pricing")).toBe("new-pricing");
    expect(leafName("main")).toBe("main");
  });
});

describe("folderHoldsCurrent", () => {
  it("is true when the current branch lives under the folder (any depth)", () => {
    expect(folderHoldsCurrent("feature", "feature/api")).toBe(true);
    expect(folderHoldsCurrent("feature", "feature/x/y")).toBe(true);
  });

  it("is false for siblings, prefixes, and no current branch", () => {
    expect(folderHoldsCurrent("feature", "featureX/api")).toBe(false);
    expect(folderHoldsCurrent("feature", "main")).toBe(false);
    expect(folderHoldsCurrent("feature", null)).toBe(false);
    expect(folderHoldsCurrent("feature", undefined)).toBe(false);
  });
});
