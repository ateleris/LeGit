import { describe, expect, it } from "vitest";
import { formatAppVersion } from "./appVersion";

describe("formatAppVersion", () => {
  it("appends the build hash as +metadata", () => {
    expect(formatAppVersion("1.0.3", "abc1234")).toBe("1.0.3+abc1234");
  });

  it("stays clean without a hash (release builds)", () => {
    expect(formatAppVersion("1.0.3", null)).toBe("1.0.3");
    expect(formatAppVersion("1.0.3", "")).toBe("1.0.3");
  });

  it("is null while the version has not resolved yet", () => {
    expect(formatAppVersion(null, "abc1234")).toBeNull();
  });
});
