// Wording for the .gitmodules consistency warning banner - one line per
// finding, precise about which half is missing so the fix is obvious.

import { describe, expect, it } from "vitest";
import { gitmodulesFindingLabel } from "./gitmodulesWarning";

describe("gitmodulesFindingLabel", () => {
  it("names a dangling entry with its path", () => {
    const msg = gitmodulesFindingLabel({
      kind: "entry_without_gitlink",
      name: "subs/ghost",
      path: "subs/ghost",
    });
    expect(msg).toContain("'subs/ghost'");
    expect(msg).toContain("no submodule");
  });

  it("says when a section has no path at all", () => {
    const msg = gitmodulesFindingLabel({
      kind: "entry_without_gitlink",
      name: "broken",
      path: "",
    });
    expect(msg).toContain("'broken'");
    expect(msg).toContain("no path");
  });

  it("names an orphaned gitlink and what breaks", () => {
    const msg = gitmodulesFindingLabel({
      kind: "gitlink_without_entry",
      path: "subs/move-me",
    });
    expect(msg).toContain("'subs/move-me'");
    expect(msg).toContain("no .gitmodules entry");
  });
});
