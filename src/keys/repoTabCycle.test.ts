import { describe, expect, it } from "vitest";
import { cycleOrder, promote, stepCycle, type CycleState } from "./repoTabCycle";

describe("promote", () => {
  it("moves the id to the front without duplicating", () => {
    expect(promote(["a", "b", "c"], "b")).toEqual(["b", "a", "c"]);
    expect(promote([], "a")).toEqual(["a"]);
    expect(promote(["a"], "a")).toEqual(["a"]);
  });
});

describe("cycleOrder", () => {
  it("orders visited tabs most-recent-first, then unvisited tabs in tab order", () => {
    expect(cycleOrder(["c", "a"], ["a", "b", "c", "d"], "c")).toEqual(["c", "a", "b", "d"]);
  });

  it("drops closed tabs from the MRU history", () => {
    expect(cycleOrder(["x", "b", "a"], ["a", "b"], "b")).toEqual(["b", "a"]);
  });

  it("forces the active tab to the head even if the MRU is stale", () => {
    expect(cycleOrder(["a", "b"], ["a", "b", "c"], "b")).toEqual(["b", "a", "c"]);
  });

  it("works with an empty history (nothing visited yet)", () => {
    expect(cycleOrder([], ["a", "b", "c"], "b")).toEqual(["b", "a", "c"]);
  });
});

describe("stepCycle", () => {
  const order = ["active", "prev", "older", "oldest"];

  it("a fresh forward step targets the previously selected tab", () => {
    const s = stepCycle(null, order, 1);
    expect(s.snapshot[s.index]).toBe("prev");
  });

  it("a fresh backward step wraps to the least recently used tab", () => {
    const s = stepCycle(null, order, -1);
    expect(s.snapshot[s.index]).toBe("oldest");
  });

  it("holding the modifier walks deeper in the frozen recent order", () => {
    let s: CycleState = stepCycle(null, order, 1);
    s = stepCycle(s, order, 1);
    expect(s.snapshot[s.index]).toBe("older");
    s = stepCycle(s, order, 1);
    expect(s.snapshot[s.index]).toBe("oldest");
    s = stepCycle(s, order, 1);
    expect(s.snapshot[s.index]).toBe("active");
  });

  it("a backward step inside a cycle retraces the last step", () => {
    let s: CycleState = stepCycle(null, order, 1);
    s = stepCycle(s, order, 1);
    s = stepCycle(s, order, -1);
    expect(s.snapshot[s.index]).toBe("prev");
  });

  it("the snapshot stays frozen even if the live order changed", () => {
    let s: CycleState = stepCycle(null, order, 1);
    s = stepCycle(s, ["something", "else"], 1);
    expect(s.snapshot).toEqual(order);
  });

  it("wraps in both directions on a two-tab set", () => {
    const two = ["a", "b"];
    let s: CycleState = stepCycle(null, two, 1);
    expect(s.snapshot[s.index]).toBe("b");
    s = stepCycle(s, two, 1);
    expect(s.snapshot[s.index]).toBe("a");
  });
});
