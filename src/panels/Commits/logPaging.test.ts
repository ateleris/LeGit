import { describe, test, expect } from "vitest";
import { appendLogPage, countRealCommits } from "./logPaging";
import type { Commit } from "../../lib/types";

const commit = (id: string): Commit =>
  ({ id, message: "m", timestamp: 0, parents: [], decorations: [] }) as unknown as Commit;

const stash = (id: string): Commit =>
  ({
    id,
    message: "WIP",
    timestamp: 0,
    parents: [],
    decorations: [{ type: "stash", value: "stash@{0}" }],
  }) as unknown as Commit;

const ids = (commits: Commit[]) => commits.map((c) => c.id);

describe("countRealCommits", () => {
  test("ignores injected stash nodes", () => {
    expect(countRealCommits([commit("a"), stash("s"), commit("b")])).toBe(2);
    expect(countRealCommits([])).toBe(0);
  });
});

describe("appendLogPage", () => {
  test("appends new commits after the loaded window", () => {
    const acc = [commit("a"), commit("b")];
    const page = [commit("c"), commit("d")];
    expect(ids(appendLogPage(acc, page))).toEqual(["a", "b", "c", "d"]);
  });

  test("trims displaced trailing stashes so the page can place them", () => {
    // The backend appends stashes older than the whole window at its end;
    // the next page injects the same stash at its true position.
    const acc = [commit("a"), commit("b"), stash("s1"), stash("s2")];
    const page = [commit("c"), stash("s1"), commit("d"), stash("s2")];
    expect(ids(appendLogPage(acc, page))).toEqual(["a", "b", "c", "s1", "d", "s2"]);
  });

  test("keeps a correctly placed stash and drops the page's re-injected copy", () => {
    // A stash placed inside the window is injected again at the next page's
    // head (it is newer than everything in that page).
    const acc = [commit("a"), stash("s"), commit("b")];
    const page = [stash("s"), commit("c")];
    expect(ids(appendLogPage(acc, page))).toEqual(["a", "s", "b", "c"]);
  });

  test("drops overlapping real commits when refs moved between pages", () => {
    const acc = [commit("a"), commit("b")];
    const page = [commit("b"), commit("c")];
    expect(ids(appendLogPage(acc, page))).toEqual(["a", "b", "c"]);
  });

  test("a page without real commits leaves the window unchanged", () => {
    // At the end of history a trailing stash is correctly placed; a page
    // that adds no commits must not strip it.
    const acc = [commit("a"), stash("s")];
    expect(appendLogPage(acc, [])).toBe(acc);
    expect(appendLogPage(acc, [stash("s")])).toBe(acc);
  });

  test("a stash displaced again lands at the new window's end", () => {
    // Older than both pages: trimmed from the first window, appended by the
    // backend at the second page's end, kept there until placed or history
    // ends.
    const acc = [commit("a"), stash("s")];
    const page = [commit("b"), stash("s")];
    expect(ids(appendLogPage(acc, page))).toEqual(["a", "b", "s"]);
  });
});
