import { describe, expect, it } from "vitest";
import { fileRowIndent } from "./useFileRowMetrics";

// Regression: the fixed-px sweep once produced `"0.667em" + depth * 14` -
// string concatenation ("0.667em0", "0.667em14", ...), invalid CSS that the
// browser silently drops, collapsing the row gutter AND all tree indentation
// to zero. The indent must always be a single valid em length.
describe("fileRowIndent", () => {
  it("is 0.667em (8px at the 12px base) at depth 0", () => {
    expect(fileRowIndent(0)).toBe("0.667em");
  });

  it("adds 1.167em (14px at the 12px base) per depth level", () => {
    expect(fileRowIndent(1)).toBe("1.833em");
    expect(fileRowIndent(2)).toBe("3em");
  });

  it("always yields a valid CSS em length", () => {
    for (let depth = 0; depth <= 10; depth++) {
      expect(fileRowIndent(depth)).toMatch(/^\d+(\.\d+)?em$/);
    }
  });
});
