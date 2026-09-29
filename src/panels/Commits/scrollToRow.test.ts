import { describe, it, expect } from "vitest";
import { growJumpWindow, pendingJumpAction, shouldCenterScroll } from "./scrollToRow";

describe("shouldCenterScroll", () => {
  const range = { startIndex: 10, endIndex: 20 };

  it("scrolls when the row is above the visible range", () => {
    expect(shouldCenterScroll(3, range)).toBe(true);
  });

  it("scrolls when the row is below the visible range", () => {
    expect(shouldCenterScroll(42, range)).toBe(true);
  });

  it("scrolls for the edge rows (possibly clipped by the viewport)", () => {
    expect(shouldCenterScroll(10, range)).toBe(true);
    expect(shouldCenterScroll(20, range)).toBe(true);
  });

  it("does not move the list when the row is safely visible", () => {
    expect(shouldCenterScroll(11, range)).toBe(false);
    expect(shouldCenterScroll(15, range)).toBe(false);
    expect(shouldCenterScroll(19, range)).toBe(false);
  });

  it("scrolls when the virtualizer has not measured yet", () => {
    expect(shouldCenterScroll(5, null)).toBe(true);
  });

  it("scrolls when only one row fits the viewport", () => {
    expect(shouldCenterScroll(7, { startIndex: 7, endIndex: 7 })).toBe(true);
  });
});

describe("pendingJumpAction", () => {
  it("scrolls as soon as the commit is loaded, even at the end of the log", () => {
    expect(pendingJumpAction(true, true, 500, 50_000)).toBe("scroll");
    expect(pendingJumpAction(true, false, 500, 50_000)).toBe("scroll");
  });

  it("extends the walk while the backend still returns full pages", () => {
    expect(pendingJumpAction(false, true, 500, 50_000)).toBe("extend");
  });

  it("gives up once the log is exhausted - the commit is unreachable", () => {
    expect(pendingJumpAction(false, false, 500, 50_000)).toBe("giveUp");
  });

  it("asks before walking past the limit instead of loading unbounded", () => {
    expect(pendingJumpAction(false, true, 50_000, 50_000)).toBe("askToContinue");
    expect(pendingJumpAction(false, true, 64_000, 50_000)).toBe("askToContinue");
  });

  it("a raised limit lets the seek continue", () => {
    expect(pendingJumpAction(false, true, 64_000, 100_000)).toBe("extend");
  });

  it("scrolling and exhaustion are never blocked by the limit", () => {
    expect(pendingJumpAction(true, true, 64_000, 50_000)).toBe("scroll");
    expect(pendingJumpAction(false, false, 64_000, 50_000)).toBe("giveUp");
  });
});

describe("growJumpWindow", () => {
  it("doubles the total window (extraPages sequence 0, 1, 3, 7, ...)", () => {
    // totalToFetch = PAGE_SIZE * (1 + extraPages): each step doubles it.
    expect(growJumpWindow(0)).toBe(1);
    expect(growJumpWindow(1)).toBe(3);
    expect(growJumpWindow(3)).toBe(7);
    expect(growJumpWindow(7)).toBe(15);
  });

  it("also grows past a large window built by infinite scroll", () => {
    expect(growJumpWindow(10)).toBe(21);
  });
});
