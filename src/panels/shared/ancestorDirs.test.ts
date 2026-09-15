import { describe, expect, it } from "vitest";
import { ancestorDirs } from "./ancestorDirs";

describe("ancestorDirs", () => {
  it("lists every folder layer, deepest first", () => {
    expect(ancestorDirs("src/panels/shared/a.ts")).toEqual([
      "src/panels/shared",
      "src/panels",
      "src",
    ]);
  });

  it("returns nothing for a root-level path", () => {
    expect(ancestorDirs("a.ts")).toEqual([]);
  });
});
