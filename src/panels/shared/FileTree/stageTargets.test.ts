import { describe, expect, it } from "vitest";
import type { FileTreeEntry, Row } from "./buildTree";
import { nextCursorPath, spaceStageTargets } from "./stageTargets";

const entry = (path: string): FileTreeEntry => ({ path, change: "Modified" });

const FILES = [
  entry("a.txt"),
  entry("src/one.ts"),
  entry("src/two.ts"),
  entry("src/deep/three.ts"),
  entry("srcish/other.ts"),
];

const fileRow = (path: string): Row => ({ kind: "file", path, depth: 0, file: entry(path) });
const dirRow = (path: string): Row => ({
  kind: "dir",
  path,
  label: path,
  depth: 0,
  fileCount: 0,
  collapsed: false,
});

describe("spaceStageTargets", () => {
  it("a folder targets every file beneath it, collapsed or not - never lookalike siblings", () => {
    expect(spaceStageTargets(dirRow("src"), new Set(), FILES)).toEqual([
      "src/one.ts",
      "src/two.ts",
      "src/deep/three.ts",
    ]);
  });

  it("a file inside the selection targets the whole selection", () => {
    expect(
      spaceStageTargets(fileRow("src/one.ts"), new Set(["src/one.ts", "a.txt"]), FILES),
    ).toEqual(["src/one.ts", "a.txt"]);
  });

  it("a file outside the selection targets just itself", () => {
    expect(spaceStageTargets(fileRow("a.txt"), new Set(["src/one.ts"]), FILES)).toEqual([
      "a.txt",
    ]);
  });

  it("no cursor row falls back to the selection (Ctrl+A then Space)", () => {
    expect(spaceStageTargets(undefined, new Set(["a.txt", "src/two.ts"]), FILES)).toEqual([
      "a.txt",
      "src/two.ts",
    ]);
    expect(spaceStageTargets(undefined, new Set(), FILES)).toEqual([]);
  });
});

// Space-stage triage: after staging, the cursor/selection lands on the next
// surviving FILE row in the SAME pane (dir rows are skipped - landing on one
// would make the next Space stage a whole folder).
describe("nextCursorPath", () => {
  const rows: Row[] = [
    fileRow("a.txt"),
    dirRow("src"),
    fileRow("src/one.ts"),
    fileRow("src/two.ts"),
    fileRow("z.txt"),
  ];

  it("advances to the next surviving file row", () => {
    expect(nextCursorPath(rows, 2, new Set(["src/one.ts"]))).toBe("src/two.ts");
  });

  it("skips staged rows and dir rows on the way down", () => {
    expect(nextCursorPath(rows, 0, new Set(["a.txt", "src/one.ts"]))).toBe("src/two.ts");
  });

  it("falls back to the previous surviving file when the last one was staged", () => {
    expect(nextCursorPath(rows, 4, new Set(["z.txt"]))).toBe("src/two.ts");
  });

  it("a staged folder advances past all of its files", () => {
    expect(nextCursorPath(rows, 1, new Set(["src/one.ts", "src/two.ts"]))).toBe("z.txt");
  });

  it("returns null when nothing survives", () => {
    expect(
      nextCursorPath(rows, 0, new Set(["a.txt", "src/one.ts", "src/two.ts", "z.txt"])),
    ).toBeNull();
  });

  it("with no cursor yet, lands on the first surviving file", () => {
    expect(nextCursorPath(rows, -1, new Set(["a.txt"]))).toBe("src/one.ts");
  });
});
