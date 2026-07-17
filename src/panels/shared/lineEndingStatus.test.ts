import { describe, expect, it } from "vitest";
import { rowChipContent } from "./lineEndingStatus";
import type { LineEndingStatusEntry } from "../../lib/types";

const entry = (over: Partial<LineEndingStatusEntry>): LineEndingStatusEntry => ({
  path: "f.txt",
  unstaged: null,
  staged: null,
  mixed: false,
  working_raw: "lf",
  ...over,
});

describe("rowChipContent", () => {
  it("is attention-only: nothing for a clean entry", () => {
    expect(rowChipContent(entry({}), "unstaged")).toBeNull();
    expect(rowChipContent(entry({}), "staged")).toBeNull();
  });

  it("shows the transition for its own side only", () => {
    const e = entry({ unstaged: { from: "lf", to: "crlf" } });
    expect(rowChipContent(e, "unstaged")).toEqual({
      text: "LF→CRLF",
      title: "Line endings: LF → CRLF",
      revertTarget: "lf",
    });
    expect(rowChipContent(e, "staged")).toBeNull();
  });

  it("staged transitions never offer a revert (it rewrites the working file)", () => {
    const e = entry({ staged: { from: "crlf", to: "lf" } });
    expect(rowChipContent(e, "staged")).toEqual({
      text: "CRLF→LF",
      title: "Line endings: CRLF → LF",
      revertTarget: null,
    });
  });

  it("mixed working file gets a passive Mixed chip on the unstaged side", () => {
    const e = entry({ mixed: true, working_raw: "mixed" });
    expect(rowChipContent(e, "unstaged")).toEqual({
      text: "Mixed",
      title: "Line endings: Mixed",
      revertTarget: null,
    });
    expect(rowChipContent(e, "staged")).toBeNull();
  });

  it("a transition wins over the mixed flag", () => {
    const e = entry({ mixed: true, unstaged: { from: "crlf", to: "mixed" } });
    expect(rowChipContent(e, "unstaged")?.text).toBe("CRLF→Mixed");
    // `mixed` is not a concrete revert target, but `crlf` (the from side) is.
    expect(rowChipContent(e, "unstaged")?.revertTarget).toBe("crlf");
  });
});
