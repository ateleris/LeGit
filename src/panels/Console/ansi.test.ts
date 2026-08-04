// Unit tests for the Git Console's ANSI SGR parser. Git's actual output
// shapes (diff/status/log with color.ui=always) drive the cases.
import { describe, it, expect } from "vitest";
import { parseAnsiLine } from "./ansi";

const RED = "var(--console-ansi-red)";
const GREEN = "var(--console-ansi-green)";
const YELLOW = "var(--console-ansi-yellow)";
const CYAN = "var(--console-ansi-cyan)";
const BRIGHT_BLUE = "var(--console-ansi-bright-blue)";

describe("parseAnsiLine", () => {
  it("returns a single unstyled span for a plain line", () => {
    expect(parseAnsiLine("On branch main")).toEqual([{ text: "On branch main" }]);
  });

  it("returns no spans for an empty line", () => {
    expect(parseAnsiLine("")).toEqual([]);
  });

  it("parses git's removed-diff-line shape (31m … m reset)", () => {
    // `git diff` emits: ESC[31m-old lineESC[m
    expect(parseAnsiLine("\x1b[31m-old line\x1b[m")).toEqual([
      { text: "-old line", color: RED },
    ]);
  });

  it("parses a colour change mid-line into separate spans", () => {
    expect(parseAnsiLine("\x1b[32m+added\x1b[m plain \x1b[31m-removed\x1b[m")).toEqual([
      { text: "+added", color: GREEN },
      { text: " plain " },
      { text: "-removed", color: RED },
    ]);
  });

  it("parses git log's decorated header (bold yellow + multi-code)", () => {
    // `git log` emits: ESC[33mcommit deadbeefESC[m (yellow), decorations bold.
    expect(parseAnsiLine("\x1b[1;33mcommit deadbeef\x1b[m")).toEqual([
      { text: "commit deadbeef", color: YELLOW, bold: true },
    ]);
  });

  it("treats ESC[m as a full reset", () => {
    expect(parseAnsiLine("\x1b[36m@@ -1 +1 @@\x1b[m context")).toEqual([
      { text: "@@ -1 +1 @@", color: CYAN },
      { text: " context" },
    ]);
  });

  it("supports bright colours (90-97) and background (41m)", () => {
    expect(parseAnsiLine("\x1b[94mblue\x1b[0m\x1b[41mon red\x1b[0m")).toEqual([
      { text: "blue", color: BRIGHT_BLUE },
      { text: "on red", background: RED },
    ]);
  });

  it("supports inverse (SGR 7, git's whitespace-error marker)", () => {
    expect(parseAnsiLine("\x1b[7mtrailing  \x1b[27mok")).toEqual([
      { text: "trailing  ", inverse: true },
      { text: "ok" },
    ]);
  });

  it("resets only the changed attribute for 22/24/39/49", () => {
    expect(parseAnsiLine("\x1b[1;4;31mX\x1b[22mY\x1b[39mZ")).toEqual([
      { text: "X", color: RED, bold: true, underline: true },
      { text: "Y", color: RED, underline: true },
      { text: "Z", underline: true },
    ]);
  });

  it("maps basic 256-colour codes (38;5;0-15) and drops the rest", () => {
    expect(parseAnsiLine("\x1b[38;5;1mred\x1b[0m\x1b[38;5;12mbright\x1b[0m")).toEqual([
      { text: "red", color: RED },
      { text: "bright", color: BRIGHT_BLUE },
    ]);
    // 256-colour beyond the basic 16: unthemable, stays the stream default.
    expect(parseAnsiLine("\x1b[38;5;208morange\x1b[0m")).toEqual([{ text: "orange" }]);
  });

  it("drops 24-bit colours without corrupting later codes", () => {
    expect(parseAnsiLine("\x1b[38;2;255;128;0mrgb\x1b[0m\x1b[31mred\x1b[0m")).toEqual([
      { text: "rgb" },
      { text: "red", color: RED },
    ]);
  });

  it("strips non-SGR escape sequences (cursor movement, erase, OSC)", () => {
    expect(parseAnsiLine("\x1b[2Ktext\x1b[1A\x1b]0;title\x07end")).toEqual([
      { text: "text" },
      { text: "end" },
    ]);
  });

  it("collapses \\r-rewriting progress lines to the final segment", () => {
    expect(parseAnsiLine("Receiving objects: 47%\rReceiving objects: 100%, done.")).toEqual([
      { text: "Receiving objects: 100%, done." },
    ]);
    // Trailing \r: the last non-empty segment wins.
    expect(parseAnsiLine("Counting: 10\rCounting: 20\r")).toEqual([{ text: "Counting: 20" }]);
  });

  it("keeps text after an unterminated escape prefix intact", () => {
    // A lone ESC+char is stripped, the rest survives.
    expect(parseAnsiLine("a\x1bXb")).toEqual([{ text: "a" }, { text: "b" }]);
  });
});
