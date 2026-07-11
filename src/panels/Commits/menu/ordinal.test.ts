import { describe, test, expect } from "vitest";
import { ordinal } from "./ordinal";

describe("ordinal", () => {
  test("basic suffixes (input is a 0-based index)", () => {
    expect(ordinal(0)).toBe("1st");
    expect(ordinal(1)).toBe("2nd");
    expect(ordinal(2)).toBe("3rd");
    expect(ordinal(3)).toBe("4th");
  });

  test("teens are always th", () => {
    expect(ordinal(10)).toBe("11th");
    expect(ordinal(11)).toBe("12th");
    expect(ordinal(12)).toBe("13th");
  });

  test("twenties follow the last digit again", () => {
    // Regression: a plain 1/2/3 switch rendered lane 21 as "21th".
    expect(ordinal(20)).toBe("21st");
    expect(ordinal(21)).toBe("22nd");
    expect(ordinal(22)).toBe("23rd");
    expect(ordinal(23)).toBe("24th");
    // Lane locks cap at 64.
    expect(ordinal(63)).toBe("64th");
  });
});
