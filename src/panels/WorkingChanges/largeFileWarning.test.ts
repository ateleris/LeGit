import { describe, expect, it } from "vitest";
import { cappedLargeFiles, formatMb, largeStagedFiles } from "./largeFileWarning";
import type { StagedBlobSize } from "../../lib/types";

const sizes: StagedBlobSize[] = [
  { path: "exactly.bin", size: 10_000_000 },
  { path: "over.bin", size: 10_000_001 },
  { path: "small.txt", size: 500 },
];

describe("largeStagedFiles", () => {
  it("returns only files strictly over the threshold", () => {
    expect(largeStagedFiles(sizes, 10)).toEqual([{ path: "over.bin", size: 10_000_001 }]);
  });

  it("threshold 0 disables the warning entirely", () => {
    expect(largeStagedFiles(sizes, 0)).toEqual([]);
  });

  it("sorts largest first", () => {
    const many: StagedBlobSize[] = [
      { path: "b", size: 11_000_000 },
      { path: "c", size: 12_000_000 },
    ];
    expect(largeStagedFiles(many, 10).map((f) => f.path)).toEqual(["c", "b"]);
  });
});

describe("cappedLargeFiles", () => {
  const many: StagedBlobSize[] = Array.from({ length: 7 }, (_, i) => ({
    path: `f${i}.bin`,
    size: 11_000_000 + i,
  }));

  it("caps at 5 shown and counts the rest", () => {
    const { shown, hidden } = cappedLargeFiles(many);
    expect(shown).toHaveLength(5);
    expect(hidden).toBe(2);
  });

  it("shows everything when under the cap", () => {
    const { shown, hidden } = cappedLargeFiles(many.slice(0, 3));
    expect(shown).toHaveLength(3);
    expect(hidden).toBe(0);
  });
});

describe("formatMb", () => {
  it("formats with one decimal, MB = 10^6", () => {
    expect(formatMb(23_400_000)).toBe("23.4 MB");
    expect(formatMb(10_000_001)).toBe("10.0 MB");
  });
});
