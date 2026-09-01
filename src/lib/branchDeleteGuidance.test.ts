import { describe, expect, it } from "vitest";
import { branchDeleteGuidance } from "./branchDeleteGuidance";

describe("branchDeleteGuidance", () => {
  it("names the containing ref for a true merge and gives the all-clear", () => {
    const g = branchDeleteGuidance(
      { merged_into: ["main", "origin/main"], equivalent_in: null },
      "feature",
    );
    expect(g.message).toContain("'main'");
    expect(g.message.toLowerCase()).toContain("force delete is safe");
    expect(g.warning).toBeUndefined();
  });

  it("explains squash/rebase equivalence against the baseline", () => {
    const g = branchDeleteGuidance(
      { merged_into: [], equivalent_in: "origin/main" },
      "feature",
    );
    expect(g.message).toContain("'origin/main'");
    expect(g.message.toLowerCase()).toContain("squash");
    expect(g.message.toLowerCase()).toContain("force delete is safe");
    expect(g.warning).toBeUndefined();
  });

  it("prefers the containment signal over patch-id equivalence", () => {
    const g = branchDeleteGuidance(
      { merged_into: ["main"], equivalent_in: "origin/main" },
      "feature",
    );
    expect(g.message).toContain("'main'");
    expect(g.message.toLowerCase()).not.toContain("squash");
    expect(g.warning).toBeUndefined();
  });

  it("warns about permanent loss when nothing indicates a merge", () => {
    const g = branchDeleteGuidance({ merged_into: [], equivalent_in: null }, "feature");
    expect(g.warning).toBeTruthy();
    expect(g.warning!.toLowerCase()).toContain("permanently");
  });

  it("warns (hedged) when the analysis itself failed", () => {
    const g = branchDeleteGuidance(null, "feature");
    expect(g.warning).toBeTruthy();
    expect(g.warning!.toLowerCase()).toContain("could not");
  });
});
