import { describe, expect, it } from "vitest";
import { caseDriftByPath, caseDriftTitle, selectionDiffAction, splitDriftTargets, withCaseDriftRows } from "./caseDrift";
import type { CaseDriftEntry } from "../../lib/types";
import type { FileTreeEntry } from "../shared/FileTree/buildTree";

const drift = (index_path: string, disk_path: string, is_dir = false): CaseDriftEntry => ({
  index_path,
  disk_path,
  is_dir,
});

const row = (path: string): FileTreeEntry => ({ path, change: "Modified" });

describe("withCaseDriftRows", () => {
  it("appends a synthetic rename row under the on-disk path", () => {
    const out = withCaseDriftRows([row("other.c")], [drift("test.c", "Test.c")]);
    expect(out).toHaveLength(2);
    expect(out[1]).toMatchObject({
      path: "Test.c",
      change: "Renamed",
      old_path: "test.c",
    });
  });

  it("returns the list unchanged when there is no drift", () => {
    const rows = [row("a.c")];
    expect(withCaseDriftRows(rows, [])).toBe(rows);
  });

  it("skips a drift entry whose disk path collides with a status row", () => {
    const out = withCaseDriftRows([row("Test.c")], [drift("test.c", "Test.c")]);
    expect(out).toHaveLength(1);
  });
});

describe("caseDriftByPath", () => {
  it("keys entries by their on-disk path", () => {
    const e = drift("src", "Src", true);
    const map = caseDriftByPath([e]);
    expect(map.get("Src")).toBe(e);
    expect(map.has("src")).toBe(false);
  });
});

describe("selectionDiffAction", () => {
  const driftPaths = caseDriftByPath([drift("test.c", "Test.c")]);

  it("opens the rename notice when a single case-drift row is selected", () => {
    // Regression (two rounds): skipping the update left the PREVIOUS file's
    // diff standing; plain-opening showed a bogus whole-file diff. The drift
    // row opens a rename-pair request, which renders the "Renamed from ..."
    // notice.
    expect(selectionDiffAction("unstaged", ["Test.c"], driftPaths)).toBe("open_drift");
  });

  it("opens the diff for a single normal row", () => {
    expect(selectionDiffAction("unstaged", ["other.c"], driftPaths)).toBe("open");
  });

  it("treats a same-named staged row as a normal row", () => {
    // Drift rows exist only in the unstaged list; a staged row that happens
    // to share the on-disk name is a real change with a real diff.
    expect(selectionDiffAction("staged", ["Test.c"], driftPaths)).toBe("open");
  });

  it("leaves the slot alone for multi or empty selections", () => {
    expect(selectionDiffAction("unstaged", ["Test.c", "other.c"], driftPaths)).toBe("keep");
    expect(selectionDiffAction("unstaged", [], driftPaths)).toBe("keep");
  });
});

describe("caseDriftTitle", () => {
  it("names the tracked spelling and the fix for a file", () => {
    const title = caseDriftTitle(drift("test.c", "Test.c"));
    expect(title).toContain("test.c");
    expect(title).toContain("Stage rename");
  });

  it("says folder for a directory entry", () => {
    expect(caseDriftTitle(drift("src", "Src", true))).toContain("folder");
  });
});

describe("splitDriftTargets", () => {
  const map = caseDriftByPath([drift("test.c", "Test.c")]);

  it("routes drift rows to their entries and keeps the rest as paths", () => {
    const out = splitDriftTargets(["a.c", "Test.c", "b.c"], map);
    expect(out.rest).toEqual(["a.c", "b.c"]);
    expect(out.drift).toEqual([drift("test.c", "Test.c")]);
  });

  it("passes a drift-free selection through", () => {
    expect(splitDriftTargets(["a.c"], map)).toEqual({ drift: [], rest: ["a.c"] });
  });
});
