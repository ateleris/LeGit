import { describe, expect, it } from "vitest";
import { takeSideLabels } from "./conflictLabels";

describe("takeSideLabels", () => {
  it("names the branches when known", () => {
    expect(takeSideLabels("both_modified", { ours: "dev", theirs: "feature/x" })).toEqual({
      ours: "Take 'dev' (current)",
      theirs: "Take 'feature/x' (incoming)",
    });
  });

  it("the delete consequence replaces the side word on named labels", () => {
    expect(takeSideLabels("deleted_by_them", { ours: "dev", theirs: "feature/x" })).toEqual({
      ours: "Take 'dev' (keeps file)",
      theirs: "Take 'feature/x' (deletes file)",
    });
    expect(takeSideLabels("deleted_by_us", { ours: "dev", theirs: "feature/x" })).toEqual({
      ours: "Take 'dev' (deletes file)",
      theirs: "Take 'feature/x' (keeps file)",
    });
  });

  it("falls back to current/incoming with the git side word when unnamed", () => {
    const plain = { ours: "Take current (ours)", theirs: "Take incoming (theirs)" };
    expect(takeSideLabels("both_modified", { ours: null, theirs: null })).toEqual(plain);
    expect(takeSideLabels("both_added", undefined)).toEqual(plain);
    expect(takeSideLabels(undefined, undefined)).toEqual(plain);
  });

  it("unnamed delete conflicts keep both the side word and the consequence", () => {
    expect(takeSideLabels("deleted_by_them", undefined)).toEqual({
      ours: "Take current (ours, keeps file)",
      theirs: "Take incoming (theirs, deletes file)",
    });
    expect(takeSideLabels("deleted_by_us", { ours: null, theirs: null })).toEqual({
      ours: "Take current (ours, deletes file)",
      theirs: "Take incoming (theirs, keeps file)",
    });
  });

  it("sides can be named independently (stash conflicts name only ours)", () => {
    expect(takeSideLabels("both_modified", { ours: "dev", theirs: null })).toEqual({
      ours: "Take 'dev' (current)",
      theirs: "Take incoming (theirs)",
    });
  });
});
