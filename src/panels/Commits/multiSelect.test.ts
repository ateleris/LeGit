// Multi-commit selection decision logic: which rows a click gesture selects
// (plain / Ctrl / Shift / Ctrl+Shift), and what a bulk action does with the
// resulting set (ordering for cherry-pick vs revert, the compare pair, the
// merge-commit guard). Pure data-in/data-out, like the other Commits helpers.
import { describe, it, expect } from "vitest";
import { applyRowClickSelection, bulkActionPlan, type SelectionState } from "./multiSelect";

const ROWS = ["e", "d", "c", "b", "a"]; // display order: newest first
const selectable = (id: string) => id !== "wd" && id !== "stash1";
const none: SelectionState = { lead: null, ids: new Set() };
const sel = (lead: string | null, ...ids: string[]): SelectionState => ({
  lead,
  ids: new Set(ids),
});

describe("applyRowClickSelection", () => {
  it("plain click selects only the clicked row and moves the lead", () => {
    const out = applyRowClickSelection(sel("d", "d", "c"), ROWS, "b", { ctrl: false, shift: false }, selectable);
    expect(out).toEqual(sel("b", "b"));
  });

  it("plain click works on non-multi-selectable rows (workdir, stash)", () => {
    const rows = ["wd", ...ROWS];
    const out = applyRowClickSelection(sel("c", "c"), rows, "wd", { ctrl: false, shift: false }, selectable);
    expect(out).toEqual(sel("wd", "wd"));
  });

  it("ctrl+click adds and removes rows from the selection", () => {
    let s = applyRowClickSelection(sel("d", "d"), ROWS, "b", { ctrl: true, shift: false }, selectable);
    expect(s).toEqual(sel("b", "d", "b"));
    s = applyRowClickSelection(s, ROWS, "d", { ctrl: true, shift: false }, selectable);
    expect(s).toEqual(sel("d", "b"));
  });

  it("ctrl+click on a non-selectable row is a no-op", () => {
    const rows = ["wd", ...ROWS];
    const s = sel("d", "d", "c");
    expect(applyRowClickSelection(s, rows, "wd", { ctrl: true, shift: false }, selectable)).toBe(s);
  });

  it("ctrl+click drops a non-selectable id a previous plain click left behind", () => {
    // Plain click on the workdir row put it in the set; growing a multi
    // selection from there must not keep it.
    const rows = ["wd", ...ROWS];
    const out = applyRowClickSelection(sel("wd", "wd"), rows, "c", { ctrl: true, shift: false }, selectable);
    expect(out).toEqual(sel("c", "c"));
  });

  it("shift+click ranges from the lead over the display order", () => {
    const out = applyRowClickSelection(sel("d", "d"), ROWS, "b", { ctrl: false, shift: true }, selectable);
    expect(out).toEqual(sel("d", "d", "c", "b"));
  });

  it("shift+click ranges upward too and keeps the lead as anchor", () => {
    const out = applyRowClickSelection(sel("b", "b"), ROWS, "e", { ctrl: false, shift: true }, selectable);
    expect(out).toEqual(sel("b", "e", "d", "c", "b"));
  });

  it("successive shift+clicks re-range from the same anchor", () => {
    let s = applyRowClickSelection(sel("d", "d"), ROWS, "a", { ctrl: false, shift: true }, selectable);
    expect(s).toEqual(sel("d", "d", "c", "b", "a"));
    s = applyRowClickSelection(s, ROWS, "c", { ctrl: false, shift: true }, selectable);
    expect(s).toEqual(sel("d", "d", "c"));
  });

  it("shift+click skips non-selectable rows inside the range", () => {
    const rows = ["e", "stash1", "c", "b", "a"];
    const out = applyRowClickSelection(sel("e", "e"), rows, "b", { ctrl: false, shift: true }, selectable);
    expect(out).toEqual(sel("e", "e", "c", "b"));
  });

  it("ctrl+shift+click adds the range to the existing selection", () => {
    const out = applyRowClickSelection(sel("e", "e", "a"), ROWS, "d", { ctrl: true, shift: true }, selectable);
    expect(out).toEqual(sel("e", "e", "d", "a"));
  });

  it("shift+click without a usable anchor selects just the clicked row", () => {
    const out = applyRowClickSelection(none, ROWS, "c", { ctrl: false, shift: true }, selectable);
    expect(out).toEqual(sel("c", "c"));
  });
});

describe("bulkActionPlan", () => {
  const row = (id: string, isMerge = false) => ({ id, isMerge });
  const rows = [row("e"), row("d", true), row("c"), row("b"), row("a")];

  it("orders cherry-pick oldest-first and revert newest-first", () => {
    const plan = bulkActionPlan(new Set(["b", "d", "c"]), [row("e"), row("d"), row("c"), row("b"), row("a")]);
    expect(plan.count).toBe(3);
    expect(plan.cherryPickShas).toEqual(["b", "c", "d"]);
    expect(plan.revertShas).toEqual(["d", "c", "b"]);
    expect(plan.containsMerge).toBe(false);
  });

  it("ignores selected ids that are no longer in the rows", () => {
    const plan = bulkActionPlan(new Set(["c", "b", "gone"]), rows);
    expect(plan.count).toBe(2);
    expect(plan.cherryPickShas).toEqual(["b", "c"]);
  });

  it("offers the compare pair (older to newer) only for exactly two", () => {
    const two = bulkActionPlan(new Set(["b", "e"]), rows);
    expect(two.compare).toEqual({ from: "b", to: "e" });
    const three = bulkActionPlan(new Set(["a", "b", "c"]), rows);
    expect(three.compare).toBeNull();
  });

  it("flags a merge commit in the selection", () => {
    expect(bulkActionPlan(new Set(["d", "c"]), rows).containsMerge).toBe(true);
    expect(bulkActionPlan(new Set(["b", "c"]), rows).containsMerge).toBe(false);
  });
});
