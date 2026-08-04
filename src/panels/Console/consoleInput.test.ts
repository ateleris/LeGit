// Decision table for the Git Console's control commands vs git commands,
// and the follow-scroll pinning rule.
import { describe, it, expect } from "vitest";
import { classifyConsoleInput, isScrolledToBottom, spaceKeyAction } from "./consoleInput";

describe("classifyConsoleInput (idle)", () => {
  it("empty or whitespace input is a noop", () => {
    expect(classifyConsoleInput("", false)).toEqual({ kind: "noop" });
    expect(classifyConsoleInput("   ", false)).toEqual({ kind: "noop" });
  });

  it("clear and cls clear the scrollback (case-insensitive)", () => {
    expect(classifyConsoleInput("clear", false)).toEqual({ kind: "clear" });
    expect(classifyConsoleInput("CLS", false)).toEqual({ kind: "clear" });
    expect(classifyConsoleInput("  clear  ", false)).toEqual({ kind: "clear" });
  });

  it("q/:q with nothing running explain themselves instead of erroring", () => {
    expect(classifyConsoleInput("q", false)).toEqual({ kind: "hint", message: "nothing to quit" });
    expect(classifyConsoleInput(":q", false).kind).toBe("hint");
  });

  it("shell habits get a pointer, not git's confusing error", () => {
    const action = classifyConsoleInput("ls -la", false);
    expect(action.kind).toBe("hint");
    expect((action as { message: string }).message).toContain("'ls'");
    expect(classifyConsoleInput("cd ..", false).kind).toBe("hint");
  });

  it("ordinary input is a git command", () => {
    expect(classifyConsoleInput("status --short", false)).toEqual({
      kind: "git",
      command: "status --short",
    });
  });

  it("strips a typed `git ` prefix", () => {
    expect(classifyConsoleInput("git status", false)).toEqual({
      kind: "git",
      command: "status",
    });
  });

  it("does not treat commands starting with control words as control", () => {
    // `clean` starts like `clear` but is a git command; `quiet` isn't `q`.
    expect(classifyConsoleInput("clean -fd", false).kind).toBe("git");
  });
});

describe("classifyConsoleInput (while a command runs)", () => {
  it("q and :q cancel", () => {
    expect(classifyConsoleInput("q", true)).toEqual({ kind: "cancel" });
    expect(classifyConsoleInput(":q", true)).toEqual({ kind: "cancel" });
    expect(classifyConsoleInput("Q", true)).toEqual({ kind: "cancel" });
  });

  it("anything else gets the how-to-cancel hint, never a second command", () => {
    const action = classifyConsoleInput("status", true);
    expect(action.kind).toBe("hint");
    expect((action as { message: string }).message).toContain("Ctrl+C");
  });

  it("empty input stays a noop", () => {
    expect(classifyConsoleInput("", true)).toEqual({ kind: "noop" });
  });
});

describe("spaceKeyAction", () => {
  it("pages while the pager holds", () => {
    expect(spaceKeyAction(true, true, "")).toBe("feed");
  });

  it("swallows held-space repeats between pages", () => {
    // After a feed the paused flag clears optimistically; the key repeats
    // arriving before the next pause announcement must NOT become literal
    // spaces in the input (they blocked all further paging until deleted).
    expect(spaceKeyAction(true, false, "")).toBe("swallow");
  });

  it("stays normal text entry when idle or mid-word", () => {
    expect(spaceKeyAction(false, false, "")).toBe("type");
    expect(spaceKeyAction(false, false, "log --oneline")).toBe("type");
    // Typing a control word while running still allows the space key
    // (input is non-empty, e.g. nothing today - but never break typing).
    expect(spaceKeyAction(true, true, "q")).toBe("type");
  });
});

describe("isScrolledToBottom", () => {
  it("tolerates the fractional residual left by display scaling", () => {
    // Windows 125%/150% scaling: scrollTop is fractional, the heights are
    // rounded - at the TRUE bottom the residual can be a few px. A 2px
    // epsilon un-pinned the follow-scroll here (output then landed below
    // the fold, looking like a hung command).
    expect(isScrolledToBottom(1000, 799.33, 198, 15.6)).toBe(true);
  });

  it("still counts a sub-line offset as at-bottom", () => {
    expect(isScrolledToBottom(1000, 790, 200, 15.6)).toBe(true);
  });

  it("a genuine scroll-up unpins", () => {
    expect(isScrolledToBottom(1000, 700, 200, 15.6)).toBe(false);
    expect(isScrolledToBottom(1000, 0, 200, 15.6)).toBe(false);
  });
});
