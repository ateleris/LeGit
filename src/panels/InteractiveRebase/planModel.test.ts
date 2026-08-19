import { describe, expect, it } from "vitest";
import {
  closesAfterOutcome,
  isUnchanged,
  nextRebaseWatch,
  planError,
  pushedShas,
  toTodoOrder,
  type PlanRow,
} from "./planModel";

const row = (sha: string, action: PlanRow["action"] = "pick", message = ""): PlanRow => ({
  sha,
  shortSha: sha.slice(0, 8),
  subject: `s-${sha}`,
  action,
  originalMessage: `s-${sha}\n\nbody`,
  message,
});

describe("planModel", () => {
  it("toTodoOrder reverses display (newest first) into git order (oldest first)", () => {
    expect(toTodoOrder([row("c"), row("b"), row("a")]).map((r) => r.sha)).toEqual(["a", "b", "c"]);
  });

  it("planError: the first kept todo step may be a pick or a reword", () => {
    expect(planError([row("a", "reword", "msg"), row("b")])).toBeNull();
    expect(planError([row("a", "squash")])).toContain("below");
    expect(planError([row("a", "drop")])).toContain("dropped");
    expect(planError([])).toBeNull();
  });

  it("planError: rewords need a non-blank message", () => {
    expect(planError([row("a"), row("b", "reword", "  ")])).toContain("message");
    expect(planError([row("a"), row("b", "reword", "new msg")])).toBeNull();
  });

  it("isUnchanged: order, action, and reworded text all count", () => {
    const rows = [row("b"), row("a")];
    expect(isUnchanged(rows, ["b", "a"])).toBe(true);
    expect(isUnchanged([row("a"), row("b")], ["b", "a"])).toBe(false);
    // A reword whose text EQUALS the original message is no change.
    const same = { ...row("b", "reword"), message: "s-b\n\nbody" };
    expect(isUnchanged([same, row("a")], ["b", "a"])).toBe(true);
    const changed = { ...row("b", "reword"), message: "different" };
    expect(isUnchanged([changed, row("a")], ["b", "a"])).toBe(false);
    // Squash/fixup/drop are always a change.
    expect(isUnchanged([row("b", "drop"), row("a")], ["b", "a"])).toBe(false);
  });

  it("pushedShas: plan shas minus the unpushed set; null upstream = none", () => {
    expect(pushedShas(["a", "b", "c"], ["b"])).toEqual(new Set(["a", "c"]));
    expect(pushedShas(["a"], null)).toEqual(new Set());
    expect(pushedShas(["a"], undefined)).toEqual(new Set());
  });
});

describe("transient panel lifecycle", () => {
  it("closesAfterOutcome: only a conflict keeps the panel open", () => {
    expect(closesAfterOutcome("completed")).toBe(true);
    expect(closesAfterOutcome("already_up_to_date")).toBe(true);
    // The REBASE is finished; the leftover stash conflict is resolved in
    // Working Changes, not here.
    expect(closesAfterOutcome("completed_with_stash_conflicts")).toBe(true);
    expect(closesAfterOutcome("conflicts")).toBe(false);
  });

  it("nextRebaseWatch: a stale 'none' before the rebase op was observed never closes", () => {
    // The op-state query may still hold "none" from before the conflicted
    // start landed - closing on that would kill the panel instantly.
    expect(nextRebaseWatch(false, "none")).toEqual({ armed: false, close: false });
  });

  it("nextRebaseWatch: arms on seeing the rebase op, closes when it ends", () => {
    expect(nextRebaseWatch(false, "rebase")).toEqual({ armed: true, close: false });
    expect(nextRebaseWatch(true, "rebase")).toEqual({ armed: true, close: false });
    // Finished via Continue or aborted via Abort - both end as kind "none".
    expect(nextRebaseWatch(true, "none")).toEqual({ armed: true, close: true });
  });

  it("nextRebaseWatch: loading (null) and foreign ops leave the watch unchanged", () => {
    expect(nextRebaseWatch(false, null)).toEqual({ armed: false, close: false });
    expect(nextRebaseWatch(true, null)).toEqual({ armed: true, close: false });
    expect(nextRebaseWatch(false, "merge")).toEqual({ armed: false, close: false });
  });
});
