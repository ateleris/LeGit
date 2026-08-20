// Decision logic for the "Undo last commit" convenience action
// (`reset --soft <head>~1`): where the entry appears and when it warns.
// Soft reset loses nothing locally, so the only warning case is a pushed
// tip - undoing it makes the branch diverge from its remote (same
// detection as the amend-pushed warning).

import { describe, expect, it } from "vitest";
import { undoLastCommitPlan } from "./undoLastCommit";

const plan = (over: Partial<Parameters<typeof undoLastCommitPlan>[0]> = {}) =>
  undoLastCommitPlan({
    isHeadRow: true,
    hasParent: true,
    opInProgress: false,
    hasUpstream: true,
    ahead: 2,
    ...over,
  });

describe("undoLastCommitPlan", () => {
  it("runs without a warning while the tip is local (ahead of upstream)", () => {
    expect(plan()).toBe("run");
  });

  it("runs without a warning when there is no upstream at all", () => {
    expect(plan({ hasUpstream: false, ahead: null })).toBe("run");
  });

  it("warns when the tip is already on the remote (upstream and ahead 0)", () => {
    expect(plan({ ahead: 0 })).toBe("warn_pushed");
  });

  it("is hidden on non-HEAD rows", () => {
    expect(plan({ isHeadRow: false })).toBe("hidden");
  });

  it("is hidden on a root commit (nothing before it to reset to)", () => {
    expect(plan({ hasParent: false })).toBe("hidden");
  });

  it("is hidden while a merge/rebase/cherry-pick/revert is in progress", () => {
    expect(plan({ opInProgress: true })).toBe("hidden");
  });

  it("does not treat ahead=0 without an upstream as pushed", () => {
    // tracking can be null (no upstream) - ahead 0 only means "published"
    // when an upstream actually exists.
    expect(plan({ hasUpstream: false, ahead: 0 })).toBe("run");
  });
});
