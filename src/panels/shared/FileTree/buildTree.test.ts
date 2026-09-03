// The file-listing panels' shared row model: path splitting, single-child
// chain compression, collapse behavior, and ordering. High blast radius -
// every file list in the app renders through flatten().

import { describe, test, expect } from "vitest";
import { baseName, flatten, type FileTreeEntry, type Row } from "./buildTree";

const files = (...paths: string[]): FileTreeEntry[] => paths.map((path) => ({ path }));
const none = new Set<string>();

const shape = (rows: Row[]) =>
  rows.map((r) =>
    r.kind === "dir"
      ? `dir:${r.depth}:${r.label}(${r.fileCount})`
      : `file:${r.depth}:${r.path}`,
  );

describe("baseName", () => {
  test("last segment, or the whole path without slashes", () => {
    expect(baseName("a/b/c.txt")).toBe("c.txt");
    expect(baseName("c.txt")).toBe("c.txt");
  });

  test("ignores a trailing slash (untracked nested repo paths)", () => {
    expect(baseName("a/b/")).toBe("b");
    expect(baseName("b/")).toBe("b");
  });
});

describe("flatten (flat mode)", () => {
  test("sorted by full path, all depth 0", () => {
    const rows = flatten(files("z.txt", "a/b.txt", "a.txt"), "flat", none);
    expect(shape(rows)).toEqual(["file:0:a.txt", "file:0:a/b.txt", "file:0:z.txt"]);
  });
});

describe("flatten (tree mode)", () => {
  test("dirs first (sorted), then files (sorted by basename)", () => {
    const rows = flatten(files("readme.md", "src/main.rs", "assets/logo.png"), "tree", none);
    expect(shape(rows)).toEqual([
      "dir:0:assets(1)",
      "file:1:assets/logo.png",
      "dir:0:src(1)",
      "file:1:src/main.rs",
      "file:0:readme.md",
    ]);
  });

  test("single-child chains compress into one row (VS Code style)", () => {
    const rows = flatten(files("src/panels/Commits/menu/a.ts"), "tree", none);
    expect(shape(rows)).toEqual([
      "dir:0:src/panels/Commits/menu(1)",
      "file:1:src/panels/Commits/menu/a.ts",
    ]);
  });

  test("compression stops where a directory has own files or siblings", () => {
    const rows = flatten(files("src/panels/a.ts", "src/lib.rs"), "tree", none);
    expect(shape(rows)).toEqual([
      "dir:0:src(2)",
      "dir:1:panels(1)",
      "file:2:src/panels/a.ts",
      "file:1:src/lib.rs",
    ]);
  });

  test("collapsed dirs keep their row (with total count) but hide children", () => {
    const collapsed = new Set(["src"]);
    const rows = flatten(files("src/a.ts", "src/deep/b.ts", "top.txt"), "tree", collapsed);
    expect(shape(rows)).toEqual(["dir:0:src(2)", "file:0:top.txt"]);
    expect((rows[0] as { collapsed: boolean }).collapsed).toBe(true);
  });

  test("a trailing slash does not create a nameless leaf", () => {
    // git status reports a nested repo as `dir/`; the entry must render as a
    // file row named after the last real segment, not an empty leaf.
    const rows = flatten(files("app/backend/FlowControl.NET/"), "tree", none);
    expect(shape(rows)).toEqual([
      "dir:0:app/backend(1)",
      "file:1:app/backend/FlowControl.NET/",
    ]);
  });

  test("a compressed chain collapses under its FULL path key", () => {
    // The collapse id is the compressed path (e.g. "a/b"), not the first
    // segment - collapsing must survive compression.
    const collapsed = new Set(["a/b"]);
    const rows = flatten(files("a/b/c.txt"), "tree", collapsed);
    expect(shape(rows)).toEqual(["dir:0:a/b(1)"]);
  });
});
