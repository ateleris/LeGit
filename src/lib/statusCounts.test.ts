import { describe, expect, it } from "vitest";
import type { FileStatus } from "./types";
import {
  STATUS_COUNTS_AUTO_MAX,
  countableEntries,
  mergeStatusCounts,
  statusCountsMode,
} from "./statusCounts";

const entry = (path: string, staged: boolean, over: Partial<FileStatus> = {}): FileStatus => ({
  path,
  state: "Modified",
  staged,
  additions: null,
  deletions: null,
  binary: false,
  old_path: null,
  ...over,
});

describe("mergeStatusCounts", () => {
  it("fills counts per side and keeps the fast list as the truth", () => {
    const fast = [entry("a.txt", true), entry("a.txt", false), entry("new.txt", false)];
    const counted = [
      entry("a.txt", true, { additions: 3, deletions: 1 }),
      entry("a.txt", false, { additions: 0, deletions: 2 }),
      entry("gone.txt", false, { additions: 9, deletions: 9 }),
      entry("pic.bin", true, { binary: true }),
    ];
    const merged = mergeStatusCounts(fast, counted);
    expect(merged.map((m) => [m.path, m.staged, m.additions, m.deletions])).toEqual([
      ["a.txt", true, 3, 1],
      ["a.txt", false, 0, 2],
      ["new.txt", false, null, null],
    ]);
  });

  it("carries the binary flag", () => {
    const merged = mergeStatusCounts(
      [entry("pic.bin", true)],
      [entry("pic.bin", true, { binary: true })],
    );
    expect(merged[0].binary).toBe(true);
  });

  it("returns the fast list untouched while no counts exist", () => {
    const fast = [entry("a.txt", true)];
    expect(mergeStatusCounts(fast, undefined)).toBe(fast);
    expect(mergeStatusCounts(fast, [])).toBe(fast);
  });
});

describe("statusCountsMode", () => {
  it("counts only entries git reports line counts for", () => {
    const status = [
      entry("a.txt", true),
      entry("u.txt", false, { state: "Untracked" }),
      entry("c.txt", false, { state: "Conflicted" }),
      entry("sub", false, { state: "SubmoduleChanged" }),
    ];
    expect(countableEntries(status)).toBe(1);
  });

  it("loads automatically up to the threshold and on demand above it", () => {
    expect(statusCountsMode(0)).toBe("none");
    expect(statusCountsMode(1)).toBe("auto");
    expect(statusCountsMode(STATUS_COUNTS_AUTO_MAX)).toBe("auto");
    expect(statusCountsMode(STATUS_COUNTS_AUTO_MAX + 1)).toBe("on_demand");
  });
});
