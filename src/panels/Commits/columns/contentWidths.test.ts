import { describe, expect, it } from "vitest";
import { contentWidthCap } from "./contentWidths";
import { MIN_COLUMN_WIDTH } from "./types";

// Fake measurers: 7px per cell character, 5px per header character - the
// decision logic must not care where the numbers come from.
const cell = (t: string) => t.length * 7;
const header = (t: string) => t.length * 5;

describe("contentWidthCap", () => {
  it("caps at the widest cell text plus padding", () => {
    // "Bernadette" (10 chars * 7px = 70) is the widest; header "Author"
    // measures 30. Cap = 70 + 8 padding.
    const cap = contentWidthCap(["Ada", "Bernadette", "Bo"], "Author", cell, header, 8);
    expect(cap).toBe(78);
  });

  it("the header label wins when it is wider than every cell", () => {
    // Header (12 chars * 5px = 60) beats cells "Al"/"Bo" (14 each): headers
    // must not ellipsize under the cap either.
    const cap = contentWidthCap(["Al", "Bo"], "Committed at", cell, header, 8);
    expect(cap).toBe(68);
  });

  it("floors at MIN_COLUMN_WIDTH so the cap never undercuts the resize minimum", () => {
    const cap = contentWidthCap(["a"], "D", cell, header, 2);
    expect(cap).toBe(MIN_COLUMN_WIDTH);
  });

  it("handles an empty cell list (header + padding only)", () => {
    const cap = contentWidthCap([], "Long header label", cell, header, 8);
    expect(cap).toBe("Long header label".length * 5 + 8);
  });

  it("rounds fractional measurements up, never clipping the text", () => {
    const cap = contentWidthCap(["x"], "H", () => 55.2, () => 0, 0);
    expect(cap).toBe(56);
  });
});
