import { describe, test, expect } from "vitest";
import { contrastRatio, wcagBadge } from "./contrast";

describe("contrastRatio", () => {
  test("black on white is the WCAG maximum 21:1", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    // Symmetric: the ratio ignores which side is fg/bg.
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 5);
  });

  test("identical colors are 1:1", () => {
    expect(contrastRatio("#4a9eff", "#4a9eff")).toBeCloseTo(1, 5);
  });

  test("short hex expands (#fff == #ffffff)", () => {
    expect(contrastRatio("#fff", "#000")).toBeCloseTo(21, 5);
  });

  test("non-hex input yields null (indicator hidden, not wrong)", () => {
    expect(contrastRatio("red", "#fff")).toBeNull();
    expect(contrastRatio("#fff", "rgb(0,0,0)")).toBeNull();
  });
});

describe("wcagBadge", () => {
  test("threshold tiers", () => {
    expect(wcagBadge(null)).toBe("Fail");
    expect(wcagBadge(2.9)).toBe("Fail");
    expect(wcagBadge(3)).toBe("AA Large");
    expect(wcagBadge(4.5)).toBe("AA");
    expect(wcagBadge(7)).toBe("AAA");
    expect(wcagBadge(21)).toBe("AAA");
  });
});
