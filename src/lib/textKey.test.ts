import { describe, expect, it, vi } from "vitest";
import { runKeyed, textKey } from "./textKey";

describe("textKey", () => {
  it("matches the published FNV-1a 32-bit vectors", () => {
    expect(textKey("")).toBe(0x811c9dc5);
    expect(textKey("a")).toBe(0xe40c292c);
    expect(textKey("foobar")).toBe(0xbf9cf968);
  });
});

describe("runKeyed", () => {
  it("runs the action whose key matches, ignoring case", () => {
    const action = vi.fn();
    const table = { [textKey("some text")]: action };
    expect(runKeyed(table, "Some Text")).toBe(true);
    expect(action).toHaveBeenCalledTimes(1);
  });

  it("runs nothing for other text", () => {
    const action = vi.fn();
    const table = { [textKey("some text")]: action };
    for (const text of ["", "some", "some text ", "other"]) {
      expect(runKeyed(table, text)).toBe(false);
    }
    expect(action).not.toHaveBeenCalled();
  });
});
