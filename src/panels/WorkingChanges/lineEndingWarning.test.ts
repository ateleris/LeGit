import { describe, expect, it } from "vitest";
import { formatEolChanges, stagedEolChanges } from "./lineEndingWarning";
import type { LineEndingStatusEntry } from "../../lib/types";

const entry = (path: string, over: Partial<LineEndingStatusEntry>): LineEndingStatusEntry => ({
  path,
  unstaged: null,
  staged: null,
  mixed: false,
  working_raw: "lf",
  ...over,
});

describe("stagedEolChanges", () => {
  it("collects staged transitions for staged paths only", () => {
    const entries = [
      entry("a.ts", { staged: { from: "crlf", to: "lf" } }),
      entry("b.ts", { staged: { from: "lf", to: "crlf" } }),
      entry("c.ts", { unstaged: { from: "lf", to: "crlf" } }), // unstaged only: not committed
    ];
    const out = stagedEolChanges(entries, new Set(["a.ts", "c.ts"]));
    expect(out).toEqual([{ path: "a.ts", from: "CRLF", to: "LF" }]);
  });
});

describe("formatEolChanges", () => {
  const c = (p: string) => ({ path: p, from: "CRLF", to: "LF" });
  it("lists every file under the cap", () => {
    expect(formatEolChanges([c("a"), c("b")])).toBe("a CRLF→LF, b CRLF→LF");
  });
  it("caps at 5 with a +N more tail", () => {
    const changes = ["a", "b", "c", "d", "e", "f", "g"].map(c);
    expect(formatEolChanges(changes)).toBe(
      "a CRLF→LF, b CRLF→LF, c CRLF→LF, d CRLF→LF, e CRLF→LF (+2 more)",
    );
  });
});
