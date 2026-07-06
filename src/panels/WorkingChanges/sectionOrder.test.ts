import { describe, it, expect } from "vitest";
import { orderedWorkingChangesSections } from "./sectionOrder";

describe("orderedWorkingChangesSections", () => {
  it("defaults to unstaged → staged → commit when empty or null", () => {
    expect(orderedWorkingChangesSections(undefined)).toEqual(["unstaged", "staged", "commit"]);
    expect(orderedWorkingChangesSections(null)).toEqual(["unstaged", "staged", "commit"]);
    expect(orderedWorkingChangesSections([])).toEqual(["unstaged", "staged", "commit"]);
  });

  it("honors a full custom order", () => {
    expect(orderedWorkingChangesSections(["commit", "staged", "unstaged"])).toEqual([
      "commit",
      "staged",
      "unstaged",
    ]);
  });

  it("appends missing sections in canonical order", () => {
    // Only "commit" stored → it leads, then the rest in default order.
    expect(orderedWorkingChangesSections(["commit"])).toEqual(["commit", "unstaged", "staged"]);
    expect(orderedWorkingChangesSections(["staged"])).toEqual(["staged", "unstaged", "commit"]);
  });

  it("drops unknown ids and de-duplicates", () => {
    expect(orderedWorkingChangesSections(["bogus", "staged", "staged", "commit"])).toEqual([
      "staged",
      "commit",
      "unstaged",
    ]);
  });
});
