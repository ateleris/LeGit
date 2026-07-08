import { describe, expect, test } from "vitest";
import { pickNextActive, pushActivation } from "./repoActivation";

describe("pushActivation", () => {
  test("moves a re-activated id to the front without duplicating", () => {
    let h = pushActivation([], "a");
    h = pushActivation(h, "b");
    h = pushActivation(h, "a");
    expect(h).toEqual(["a", "b"]);
  });

  test("caps the history length", () => {
    let h: string[] = [];
    for (let i = 0; i < 60; i++) h = pushActivation(h, `r${i}`, 50);
    expect(h.length).toBe(50);
    expect(h[0]).toBe("r59");
  });
});

describe("pickNextActive", () => {
  test("returns the most recently activated repo that is still open", () => {
    // History: c (current, just closed), b, a - b is the previous one.
    expect(pickNextActive(["c", "b", "a"], ["a", "b"])).toBe("b");
  });

  test("skips closed repos in the history", () => {
    expect(pickNextActive(["c", "x", "a"], ["a", "d"])).toBe("a");
  });

  test("falls back to the first open repo with no usable history", () => {
    expect(pickNextActive([], ["d", "e"])).toBe("d");
    expect(pickNextActive(["gone"], ["d", "e"])).toBe("d");
  });

  test("returns null when nothing is open", () => {
    expect(pickNextActive(["a"], [])).toBeNull();
  });
});
