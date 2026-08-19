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
    expect(contrastRatio("#fff", "#00000080", "oklch(0.2 0 0)")).toBeNull();
  });
});

// Regression: translucent washes (diff line tints, chip fills, selected rows)
// must be composited over their base surface, not scored as if opaque — the
// pre-fix check dropped the alpha channel entirely and reported the wash's
// full-strength colour.
describe("contrastRatio alpha compositing", () => {
  test("a fully transparent bg over a base is just the base", () => {
    expect(contrastRatio("#ffffff", "#3498db00", "#000000")).toBeCloseTo(
      contrastRatio("#ffffff", "#000000")!,
      5,
    );
  });

  test("an opaque bg ignores the base", () => {
    expect(contrastRatio("#ffffff", "#3498db", "#000000")).toBeCloseTo(
      contrastRatio("#ffffff", "#3498db")!,
      5,
    );
  });

  test("a translucent bg composites over the base (50% black on white ≈ mid gray)", () => {
    // 0x80/255 ≈ 0.502 alpha → composited channel ≈ 127.
    expect(contrastRatio("#ffffff", "#00000080", "#ffffff")).toBeCloseTo(
      contrastRatio("#ffffff", "#7f7f7f")!,
      1,
    );
  });

  test("the built-in Dark diff wash is nearly the panel colour, not full-strength blue", () => {
    // #3498db33 over #252526: a 20% wash. Treating it as opaque #3498db (the
    // old behaviour) misstates the ratio by more than a full WCAG tier.
    const composited = contrastRatio("#e0e0e0", "#3498db33", "#252526")!;
    const asOpaque = contrastRatio("#e0e0e0", "#3498db")!;
    const vsPanel = contrastRatio("#e0e0e0", "#252526")!;
    expect(Math.abs(composited - vsPanel)).toBeLessThan(Math.abs(composited - asOpaque));
    expect(composited).not.toBeCloseTo(asOpaque, 0);
  });

  test("a layered base flattens deepest-first (word highlight on line wash on panel)", () => {
    // 50% black over white ≈ #7f7f7f, so the two-layer stack must score like
    // a single pre-composited base.
    expect(contrastRatio("#ffffff", "#00000080", ["#00000080", "#ffffff"])).toBeCloseTo(
      contrastRatio("#ffffff", "#00000080", "#7f7f7f")!,
      1,
    );
    // An unparseable layer anywhere in the stack yields null.
    expect(contrastRatio("#ffffff", "#00000080", ["#00000080", "rgb(0,0,0)"])).toBeNull();
  });

  test("a translucent fg composites over the effective background", () => {
    // Fully transparent text is invisible: ratio 1 against any background.
    expect(contrastRatio("#ffffff00", "#000000")).toBeCloseTo(1, 5);
  });

  test("without a base, a translucent bg keeps the old opaque interpretation", () => {
    expect(contrastRatio("#ffffff", "#00000080")).toBeCloseTo(
      contrastRatio("#ffffff", "#000000")!,
      5,
    );
  });
});

describe("wcagBadge", () => {
  test("threshold tiers", () => {
    expect(wcagBadge(2.9)).toBe("Fail");
    expect(wcagBadge(3)).toBe("AA Large");
    expect(wcagBadge(4.5)).toBe("AA");
    expect(wcagBadge(7)).toBe("AAA");
    expect(wcagBadge(21)).toBe("AAA");
  });

  test("unparseable colours are unknown, not a failure", () => {
    // rgb()/oklch() palette values are valid themes the JS mirror can't
    // evaluate — a wall of false "Fail" badges would be wrong.
    expect(wcagBadge(null)).toBe("n/a");
  });
});
