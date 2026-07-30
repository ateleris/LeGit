// Unit tests for the lane-assignment algorithm.
//
// These cover every edge case called out in DESIGN-v0.4.md §H plus the
// load-more stability constraint (§F.5), which is the single most
// important correctness property of the algorithm.

import { describe, test, expect } from "vitest";
import { computeLanes } from "./lanes";
import type { CommitForGraph, LaneEdge, LockMap, RefsAtCommit } from "./types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a CommitForGraph array (newest-first) from an adjacency list.
 *
 * Each tuple is `[id, ...parentIds]`. The list is consumed in order, so
 * the caller writes commits newest-first naturally.
 */
function makeCommits(
  pairs: [string, ...string[]][],
): CommitForGraph[] {
  return pairs.map(([id, ...parentIds]) => ({ id, parentIds }));
}

/** Build an empty refs-at map (no decorations). */
function noRefs(): RefsAtCommit {
  return new Map();
}

/** Canonical sort so edge sets compare independent of emission order. */
function sortedEdges(edges: LaneEdge[]): LaneEdge[] {
  return [...edges].sort(
    (a, b) =>
      a.fromCommitId.localeCompare(b.fromCommitId) ||
      a.toCommitId.localeCompare(b.toCommitId) ||
      a.fromLane - b.fromLane ||
      a.toLane - b.toLane,
  );
}

/** Build a linear chain `c0 -> c1 -> ... -> c{n-1}`. */
function linearChain(n: number, prefix = "c"): CommitForGraph[] {
  const pairs: [string, ...string[]][] = [];
  for (let i = 0; i < n; i++) {
    const id = `${prefix}${i}`;
    if (i < n - 1) pairs.push([id, `${prefix}${i + 1}`]);
    else pairs.push([id]);
  }
  return makeCommits(pairs);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("computeLanes", () => {
  test("linear chain", () => {
    const commits = makeCommits([
      ["A", "B"],
      ["B", "C"],
      ["C"],
    ]);
    const result = computeLanes(commits, {}, noRefs());
    expect(result.assignments.get("A")).toBe(0);
    expect(result.assignments.get("B")).toBe(0);
    expect(result.assignments.get("C")).toBe(0);
    expect(result.maxLane).toBe(0);
  });

  test("simple branch and merge", () => {
    // A is a merge of two branches: main (B) and feature (D).
    // History (newest first):
    //   A -> B, D     (merge)
    //   B -> C
    //   D -> E
    //   C -> F        (merged base)
    //   E -> F
    //   F             (root)
    const commits = makeCommits([
      ["A", "B", "D"],
      ["B", "C"],
      ["D", "E"],
      ["C", "F"],
      ["E", "F"],
      ["F"],
    ]);
    const result = computeLanes(commits, {}, noRefs());

    // A claims lane 0 (the merge spine).
    expect(result.assignments.get("A")).toBe(0);
    // B continues A's lane; D takes a new lane.
    expect(result.assignments.get("B")).toBe(0);
    expect(result.assignments.get("D")).toBeGreaterThan(0);
    // F is reached from both; should land on the lower (lane 0) lane.
    expect(result.assignments.get("F")).toBe(0);
    expect(result.maxLane).toBeGreaterThanOrEqual(1);

    // Every commit must have an assignment.
    for (const c of commits) {
      expect(result.assignments.has(c.id)).toBe(true);
    }
  });

  test("locked lane stays left", () => {
    // main is locked to lane 0. A feature branch off main should
    // appear in a different lane; main's commits stay on lane 0.
    //
    //   M3 ── main tip (commit on main)
    //   |
    //   M2  ── another main commit (no branch tip ref)
    //   |
    //   M1  ← merge of feature F1 into main
    //   |\
    //   | F1  ── feature tip
    //   |  |
    //   M0 F0  ── feature's first commit, branched from M0
    //   |  |
    //   ROOT
    const commits = makeCommits([
      ["M3", "M2"],
      ["M2", "M1"],
      ["M1", "M0", "F1"],
      ["F1", "F0"],
      ["M0", "ROOT"],
      ["F0", "ROOT"],
      ["ROOT"],
    ]);
    const refsAt: RefsAtCommit = new Map([
      ["M3", ["refs/heads/main"]],
      ["F1", ["refs/heads/feature"]],
    ]);
    const locks: LockMap = { "refs/heads/main": 0 };

    const result = computeLanes(commits, locks, refsAt);

    expect(result.assignments.get("M3")).toBe(0);
    expect(result.assignments.get("M2")).toBe(0);
    expect(result.assignments.get("M1")).toBe(0);
    // The feature branch must not steal lane 0.
    expect(result.assignments.get("F1")).not.toBe(0);
    expect(result.assignments.get("F0")).not.toBe(0);
    // ROOT lands on the lowest waiting lane (0).
    expect(result.assignments.get("ROOT")).toBe(0);
  });

  test("octopus merge", () => {
    // M is a 3-parent merge.
    const commits = makeCommits([
      ["M", "P1", "P2", "P3"],
      ["P1", "BASE"],
      ["P2", "BASE"],
      ["P3", "BASE"],
      ["BASE"],
    ]);
    const result = computeLanes(commits, {}, noRefs());

    expect(result.assignments.get("M")).toBe(0);
    expect(result.assignments.get("P1")).toBe(0);
    expect(result.assignments.get("P2")).toBeGreaterThan(0);
    expect(result.assignments.get("P3")).toBeGreaterThan(0);
    // The three parent lanes must be distinct.
    const p1 = result.assignments.get("P1")!;
    const p2 = result.assignments.get("P2")!;
    const p3 = result.assignments.get("P3")!;
    expect(new Set([p1, p2, p3]).size).toBe(3);
    // BASE collapses everything back to the lowest waiting lane.
    expect(result.assignments.get("BASE")).toBe(0);
  });

  test("disconnected histories", () => {
    // Two unrelated roots — no shared ancestry, no merge.
    const commits = makeCommits([
      ["A1", "A2"],
      ["B1", "B2"],
      ["A2"],
      ["B2"],
    ]);
    const result = computeLanes(commits, {}, noRefs());

    // Both branches get assignments; their lanes must differ.
    const a1 = result.assignments.get("A1")!;
    const b1 = result.assignments.get("B1")!;
    expect(a1).not.toBe(b1);
    expect(result.assignments.get("A2")).toBe(a1);
    expect(result.assignments.get("B2")).toBe(b1);
  });

  test("window edge — bottom commit has no parent in window", () => {
    // The oldest commit references a parent that isn't in the loaded
    // window. The algorithm must not crash; the commit should still
    // get a lane.
    const commits = makeCommits([
      ["A", "B"],
      ["B", "OFFSCREEN_PARENT"],
    ]);
    const result = computeLanes(commits, {}, noRefs());
    expect(result.assignments.get("A")).toBe(0);
    expect(result.assignments.get("B")).toBe(0);
    // OFFSCREEN_PARENT is not in commits, so it shouldn't appear in
    // assignments.
    expect(result.assignments.has("OFFSCREEN_PARENT")).toBe(false);
  });

  test("stability under load-more", () => {
    // Compute lanes for a linear 500-commit window, then extend to
    // 1000 commits with the first 500 as previousAssignments. The
    // first 500 lane assignments MUST be identical.
    const first500 = linearChain(500);
    const result1 = computeLanes(first500, {}, noRefs());

    const all1000 = linearChain(1000);
    const result2 = computeLanes(all1000, {}, noRefs(), result1.assignments);

    for (const [id, lane] of result1.assignments) {
      expect(result2.assignments.get(id)).toBe(lane);
    }
    // The new commits also got assigned.
    expect(result2.assignments.size).toBe(1000);
  });

  test("stability under load-more with branching", () => {
    // A richer stability test: a graph with a branch and a merge.
    // First load covers up to the merge; load-more reveals the
    // older history.
    const window1 = makeCommits([
      ["A", "B", "D"],
      ["B", "C"],
      ["D", "E"],
      ["C", "F"],
      ["E", "F"],
    ]);
    const r1 = computeLanes(window1, {}, noRefs());

    const window2 = makeCommits([
      ["A", "B", "D"],
      ["B", "C"],
      ["D", "E"],
      ["C", "F"],
      ["E", "F"],
      ["F", "G"],
      ["G"],
    ]);
    const r2 = computeLanes(window2, {}, noRefs(), r1.assignments);

    for (const [id, lane] of r1.assignments) {
      expect(r2.assignments.get(id)).toBe(lane);
    }
    expect(r2.assignments.has("F")).toBe(true);
    expect(r2.assignments.has("G")).toBe(true);
  });

  // Regression tests for the load-more edge-loss bug (BACKLOG "Commit graph
  // breaks on bigger repos"): the incremental path kept prior ASSIGNMENTS
  // verbatim but never re-emitted their EDGES, so after every load-more all
  // edges among previously loaded rows vanished. The pinned property: a
  // two-pass (load-more) run must produce the same edge set as a full
  // one-pass recompute of the same window.

  test("load-more keeps edges of previously assigned commits", () => {
    const first500 = linearChain(500);
    const r1 = computeLanes(first500, {}, noRefs());

    const all1000 = linearChain(1000);
    const incremental = computeLanes(all1000, {}, noRefs(), r1.assignments);
    const full = computeLanes(all1000, {}, noRefs());

    // The direct symptom: edges among the previously loaded rows must
    // still exist (c0 -> c1 is the newest edge, deep in the old region).
    expect(
      incremental.edges.find(
        (e) => e.fromCommitId === "c0" && e.toCommitId === "c1",
      ),
    ).toBeDefined();

    expect(sortedEdges(incremental.edges)).toEqual(sortedEdges(full.edges));
  });

  test("load-more edge set equals full recompute with branching", () => {
    const window1 = makeCommits([
      ["A", "B", "D"],
      ["B", "C"],
      ["D", "E"],
      ["C", "F"],
      ["E", "F"],
    ]);
    const r1 = computeLanes(window1, {}, noRefs());

    const window2 = makeCommits([
      ["A", "B", "D"],
      ["B", "C"],
      ["D", "E"],
      ["C", "F"],
      ["E", "F"],
      ["F", "G"],
      ["G"],
    ]);
    const incremental = computeLanes(window2, {}, noRefs(), r1.assignments);
    const full = computeLanes(window2, {}, noRefs());

    // Assignments stay stable (the existing contract) …
    for (const [id, lane] of r1.assignments) {
      expect(incremental.assignments.get(id)).toBe(lane);
    }
    // … AND the edge set matches a from-scratch computation.
    expect(sortedEdges(incremental.edges)).toEqual(sortedEdges(full.edges));
  });

  test("load-more regenerates the lane of a merge parent beyond the boundary", () => {
    // Window 1 ends with a merge whose second parent (X) is not loaded
    // yet: A spawns a lane waiting for X. The old incremental path lost
    // that pending slot on reconstruction (the spawned lane has no
    // assigned commits to rebuild it from), on top of dropping the
    // A -> X edge itself.
    const window1 = makeCommits([
      ["A", "B", "X"],
      ["B", "C"],
    ]);
    const r1 = computeLanes(window1, {}, noRefs());

    const window2 = makeCommits([
      ["A", "B", "X"],
      ["B", "C"],
      ["X", "C"],
      ["C"],
    ]);
    const incremental = computeLanes(window2, {}, noRefs(), r1.assignments);
    const full = computeLanes(window2, {}, noRefs());

    expect(sortedEdges(incremental.edges)).toEqual(sortedEdges(full.edges));

    // The merge edge must point at the lane X actually lands in.
    const mergeEdge = incremental.edges.find(
      (e) => e.fromCommitId === "A" && e.toCommitId === "X",
    );
    expect(mergeEdge).toBeDefined();
    expect(mergeEdge!.toLane).toBe(incremental.assignments.get("X"));
  });

  test("lock conflict — two locks to same lane", () => {
    // Two refs both locked to lane 0 (inconsistent state from
    // hand-edited settings). The algorithm should not crash; a
    // deterministic resolution (lowest-index winner per ref) keeps
    // things sane.
    const commits = makeCommits([
      ["MAIN_TIP", "BASE"],
      ["DEV_TIP", "BASE"],
      ["BASE"],
    ]);
    const refsAt: RefsAtCommit = new Map([
      ["MAIN_TIP", ["refs/heads/main"]],
      ["DEV_TIP", ["refs/heads/dev"]],
    ]);
    const locks: LockMap = {
      "refs/heads/main": 0,
      "refs/heads/dev": 0, // conflicting
    };

    expect(() => computeLanes(commits, locks, refsAt)).not.toThrow();
    const result = computeLanes(commits, locks, refsAt);
    // Both commits claim some lane (algorithm is permissive); each
    // must have an assignment.
    expect(result.assignments.has("MAIN_TIP")).toBe(true);
    expect(result.assignments.has("DEV_TIP")).toBe(true);
    expect(result.assignments.has("BASE")).toBe(true);
  });

  test("orphaned lock — locked ref has no commits in window", () => {
    // A lock points at a ref that doesn't appear in the loaded
    // commits or in refsAt. The algorithm should run without
    // crashing; the locked lane is effectively reserved but never
    // claimed.
    const commits = makeCommits([
      ["A", "B"],
      ["B", "C"],
      ["C"],
    ]);
    const refsAt: RefsAtCommit = new Map();
    const locks: LockMap = { "refs/heads/deleted-branch": 0 };

    expect(() => computeLanes(commits, locks, refsAt)).not.toThrow();
    const result = computeLanes(commits, locks, refsAt);
    expect(result.assignments.size).toBe(3);
    // The locked lane (0) is reserved, so the linear chain shifts
    // into lane 1.
    expect(result.assignments.get("A")).toBe(1);
    expect(result.assignments.get("B")).toBe(1);
    expect(result.assignments.get("C")).toBe(1);
  });

  test("merge into locked branch", () => {
    // A feature branch terminates into main (locked lane 0).
    //
    //   M2 ── main tip
    //   |
    //   M1  ← merge of feature F1 into main
    //   |\
    //   | F1
    //   M0 |
    //   |  F0
    //   |  /
    //   BASE
    const commits = makeCommits([
      ["M2", "M1"],
      ["M1", "M0", "F1"],
      ["F1", "F0"],
      ["M0", "BASE"],
      ["F0", "BASE"],
      ["BASE"],
    ]);
    const refsAt: RefsAtCommit = new Map([
      ["M2", ["refs/heads/main"]],
      ["F1", ["refs/heads/feature"]],
    ]);
    const locks: LockMap = { "refs/heads/main": 0 };

    const result = computeLanes(commits, locks, refsAt);

    // Main stays on lane 0 throughout.
    expect(result.assignments.get("M2")).toBe(0);
    expect(result.assignments.get("M1")).toBe(0);
    expect(result.assignments.get("M0")).toBe(0);
    // Feature lives in some non-locked lane.
    const featLane = result.assignments.get("F1")!;
    expect(featLane).not.toBe(0);
    expect(result.assignments.get("F0")).toBe(featLane);

    // There must be a merge edge from M1 (lane 0) to F1 (feature lane).
    // In the newest-first walk this is how a merge is encoded: the
    // merge commit emanates an edge to each non-first parent.
    const mergeIntoMain = result.edges.find(
      (e) =>
        e.fromCommitId === "M1" &&
        e.toCommitId === "F1" &&
        e.fromLane === 0 &&
        e.toLane === featLane,
    );
    expect(mergeIntoMain).toBeDefined();
  });

  test("branch off locked branch", () => {
    // A non-locked branch starts from a locked branch.
    //
    //   F1 ── feature tip
    //   |
    //   F0 ── branched off main at M0
    //   |
    //   M0 ── main (locked to lane 0)
    const commits = makeCommits([
      ["F1", "F0"],
      ["F0", "M0"],
      ["M0"],
    ]);
    const refsAt: RefsAtCommit = new Map([
      ["M0", ["refs/heads/main"]],
      ["F1", ["refs/heads/feature"]],
    ]);
    const locks: LockMap = { "refs/heads/main": 0 };

    const result = computeLanes(commits, locks, refsAt);

    // M0 (the only main commit) sits in lane 0.
    expect(result.assignments.get("M0")).toBe(0);
    // The feature branch does not use lane 0.
    expect(result.assignments.get("F1")).not.toBe(0);
    expect(result.assignments.get("F0")).not.toBe(0);

    // There must be an edge from F0's lane to lane 0 at M0
    // (the branch-off point).
    const branchOff = result.edges.find(
      (e) => e.toCommitId === "M0" && e.toLane === 0,
    );
    expect(branchOff).toBeDefined();
  });

  test("jog lane is reused for a merge parent on the same commit", () => {
    // A commit C is simultaneously a jog convergence (lane 1 dies here)
    // and a merge commit (has a second parent P2). P2 reuses lane 1 — the
    // lane its predecessor just vacated — keeping the graph compact. The
    // jog arc (up into C's dot) and the new child arc (down out of it)
    // occupy different halves of the row, rendering as the lane pinching
    // through the merge dot.
    //
    //   A ── lane 0
    //   F ── lane 1 (dies at C)
    //   C ── merge commit (lane 0), jog from lane 1 + second parent P2
    //   P2, BASE
    const commits = makeCommits([
      ["A", "C"],
      ["F", "C"],
      ["C", "BASE", "P2"],
      ["P2", "BASE"],
      ["BASE"],
    ]);
    const result = computeLanes(commits, {}, noRefs());

    expect(result.assignments.get("C")).toBe(0);
    // P2 reuses the just-freed jog lane.
    expect(result.assignments.get("P2")).toBe(1);
    // The jog edge from lane 1 → lane 0 must exist at C.
    const jog = result.edges.find(
      (e) => e.fromCommitId === "C" && e.toCommitId === "C" &&
        e.fromLane === 1 && e.toLane === 0,
    );
    expect(jog).toBeDefined();
    // The merge edge from C to P2 goes to the reused lane.
    const mergeEdge = result.edges.find(
      (e) => e.fromCommitId === "C" && e.toCommitId === "P2",
    );
    expect(mergeEdge).toBeDefined();
    expect(mergeEdge!.toLane).toBe(1);
  });

  test("sequential PR merges share one feature lane (no rightward drift)", () => {
    // KingCost-style history: every PR branches off develop and merges
    // straight back. Each next feature must reuse the lane the previous
    // one vacated — features never coexist, so the graph needs only two
    // lanes, not an alternating third.
    const commits = makeCommits([
      ["M1", "M2", "F1"],
      ["F1", "M2"],
      ["M2", "M3", "F2"],
      ["F2", "M3"],
      ["M3", "M4", "F3"],
      ["F3", "M4"],
      ["M4"],
    ]);
    const result = computeLanes(commits, {}, noRefs());
    expect(result.assignments.get("F1")).toBe(1);
    expect(result.assignments.get("F2")).toBe(1);
    expect(result.assignments.get("F3")).toBe(1);
    expect(result.maxLane).toBe(1);
  });

  test("empty input", () => {
    const result = computeLanes([], {}, noRefs());
    expect(result.assignments.size).toBe(0);
    expect(result.edges).toEqual([]);
    expect(result.maxLane).toBe(-1);
  });

  test("single root commit", () => {
    const commits = makeCommits([["ROOT"]]);
    const result = computeLanes(commits, {}, noRefs());
    expect(result.assignments.get("ROOT")).toBe(0);
    expect(result.maxLane).toBe(0);
  });

  test("stability holds when load-more reveals new branches", () => {
    // First window: linear. Load-more reveals an older merge that
    // brings in a second branch. The first-window commits must still
    // be in their original lanes.
    const window1 = makeCommits([
      ["A", "B"],
      ["B", "C"],
    ]);
    const r1 = computeLanes(window1, {}, noRefs());
    expect(r1.assignments.get("A")).toBe(0);
    expect(r1.assignments.get("B")).toBe(0);

    const window2 = makeCommits([
      ["A", "B"],
      ["B", "C"],
      ["C", "D", "E"], // merge
      ["D", "F"],
      ["E", "F"],
      ["F"],
    ]);
    const r2 = computeLanes(window2, {}, noRefs(), r1.assignments);
    expect(r2.assignments.get("A")).toBe(0);
    expect(r2.assignments.get("B")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// First-parent ownership for locked lanes (DESIGN: bidirectional cross-merge).
//
// Two long-lived branches, main (locked lane 0) and development (locked lane
// 1), that merge into each other and share a long first-parent spine. The
// lane of a locked branch is determined by *first-parent ownership*: a commit
// on a locked ref's first-parent ancestry is pinned to that ref's lane, and
// when a commit lies on more than one locked ref's first-parent line the
// lowest lane index wins (so the shared spine goes to main).
// ---------------------------------------------------------------------------

describe("computeLanes — first-parent ownership", () => {
  const LOCKS: LockMap = {
    "refs/heads/main": 0,
    "refs/heads/development": 1,
  };

  /**
   * Bidirectional cross-merge fixture.
   *
   *   main first-parent line:  A3 → A2 → M  → A1 → S → R
   *   dev  first-parent line:  DT → X  → D2 → D1 → S → R
   *
   *   M = merge development into main  (fp=A1, 2nd parent=D1)
   *   X = merge main into development  (fp=D2, 2nd parent=A2)
   *   S, R = shared spine (on both first-parent lines)
   */
  function crossMerge(): CommitForGraph[] {
    return makeCommits([
      ["DT", "X"], // development tip
      ["A3", "A2"], // main tip
      ["X", "D2", "A2"], // merge main → development
      ["A2", "M"],
      ["M", "A1", "D1"], // merge development → main
      ["D2", "D1"],
      ["A1", "S"],
      ["D1", "S"],
      ["S", "R"],
      ["R"],
    ]);
  }
  const crossRefs: RefsAtCommit = new Map([
    ["A3", ["refs/heads/main"]],
    ["DT", ["refs/heads/development"]],
  ]);

  test("bidirectional cross-merge — first-parent lines own their lanes", () => {
    const r = computeLanes(crossMerge(), LOCKS, crossRefs);

    // main's first-parent line → lane 0
    for (const id of ["A3", "A2", "M", "A1", "S", "R"]) {
      expect(r.assignments.get(id)).toBe(0);
    }
    // development's first-parent-only commits → lane 1
    for (const id of ["DT", "X", "D2", "D1"]) {
      expect(r.assignments.get(id)).toBe(1);
    }
  });

  test("both merge directions render as crossing edges", () => {
    const r = computeLanes(crossMerge(), LOCKS, crossRefs);

    // development → main: merge commit M (lane 0) connects to D1 (lane 1).
    const devIntoMain = r.edges.find(
      (e) => e.fromCommitId === "M" && e.toCommitId === "D1" &&
        e.fromLane === 0 && e.toLane === 1,
    );
    expect(devIntoMain).toBeDefined();

    // main → development: merge commit X (lane 1) connects to A2 (lane 0).
    const mainIntoDev = r.edges.find(
      (e) => e.fromCommitId === "X" && e.toCommitId === "A2" &&
        e.fromLane === 1 && e.toLane === 0,
    );
    expect(mainIntoDev).toBeDefined();
  });

  test("priority — a commit on both first-parent lines goes to the lower lane", () => {
    const r = computeLanes(crossMerge(), LOCKS, crossRefs);
    // S and R are on both first-parent lines; main (lane 0) wins.
    expect(r.assignments.get("S")).toBe(0);
    expect(r.assignments.get("R")).toBe(0);
  });

  test("fast-forward-collapsed spine — dev only owns its divergence", () => {
    // main and development share their entire recent spine; development has a
    // small divergence (D1) off shared commit C.
    //   main: MT → C → B → A
    //   dev:  DT → D1 → C → B → A   (forked at C)
    const commits = makeCommits([
      ["DT", "D1"], // development tip
      ["MT", "C"], // main tip
      ["D1", "C"], // dev's one unique commit, branched off C
      ["C", "B"],
      ["B", "A"],
      ["A"],
    ]);
    const refsAt: RefsAtCommit = new Map([
      ["MT", ["refs/heads/main"]],
      ["DT", ["refs/heads/development"]],
    ]);
    const r = computeLanes(commits, LOCKS, refsAt);

    // Shared spine + main-only → lane 0.
    for (const id of ["MT", "C", "B", "A"]) {
      expect(r.assignments.get(id)).toBe(0);
    }
    // development's unique first-parent commits → lane 1.
    expect(r.assignments.get("DT")).toBe(1);
    expect(r.assignments.get("D1")).toBe(1);
  });

  test("ownership is order-independent", () => {
    const base = computeLanes(crossMerge(), LOCKS, crossRefs);

    // Reverse the commit array (still a valid set, different walk order —
    // simulates date-order interleaving). Owned commits must not move.
    const reversed = [...crossMerge()].reverse();
    const r = computeLanes(reversed, LOCKS, crossRefs);

    for (const id of ["A3", "A2", "M", "A1", "S", "R", "DT", "X", "D2", "D1"]) {
      expect(r.assignments.get(id)).toBe(base.assignments.get(id));
    }
  });

  test("ownership overrides stale previousAssignments", () => {
    // Simulate a prior (buggy) computation that put a main-spine commit in
    // the wrong lane. Ownership must correct it on the next pass.
    const stale = new Map<string, number>([
      ["A3", 0],
      ["S", 3], // wrong — S is on main's first-parent line
    ]);
    const r = computeLanes(crossMerge(), LOCKS, crossRefs, stale);
    expect(r.assignments.get("S")).toBe(0);
  });

  test("first parent on a locked lane terminates as a jog, not a cross-edge", () => {
    // feature branched off main; feature's base commit F0 has the main commit
    // M1 as its first parent. The branch-off must render as a jog at the
    // convergence (M1) — matching how an unlocked branch-off looks — rather
    // than a cross-edge drawn at F0.
    //
    //   FT ── feature tip
    //   |
    //   F0 ── feature base, first parent M1 (on main)
    //   |
    //   M1 ── main commit
    //   |
    //   M0 ── root
    const commits = makeCommits([
      ["FT", "F0"],
      ["MT", "M1"], // main tip
      ["F0", "M1"],
      ["M1", "M0"],
      ["M0"],
    ]);
    const refsAt: RefsAtCommit = new Map([
      ["MT", ["refs/heads/main"]],
      ["FT", ["refs/heads/feature"]],
    ]);
    const r = computeLanes(commits, { "refs/heads/main": 0 }, refsAt);

    const featLane = r.assignments.get("FT")!;
    expect(featLane).not.toBe(0);
    expect(r.assignments.get("F0")).toBe(featLane);

    // The transition is a JOG at M1 — a self-edge into the locked lane …
    const jog = r.edges.find(
      (e) => e.fromCommitId === "M1" && e.toCommitId === "M1" &&
        e.fromLane === featLane && e.toLane === 0,
    );
    expect(jog).toBeDefined();

    // … and NOT a cross-edge drawn at F0.
    const crossAtChild = r.edges.find(
      (e) => e.fromCommitId === "F0" && e.toCommitId === "M1" && e.fromLane !== e.toLane,
    );
    expect(crossAtChild).toBeUndefined();
  });

  test("orphaned locked tip — ref not in window does not crash or claim", () => {
    // development is locked but its tip is absent from the window/refsAt.
    const commits = makeCommits([
      ["MT", "C"],
      ["C", "B"],
      ["B"],
    ]);
    const refsAt: RefsAtCommit = new Map([["MT", ["refs/heads/main"]]]);
    expect(() => computeLanes(commits, LOCKS, refsAt)).not.toThrow();
    const r = computeLanes(commits, LOCKS, refsAt);
    // main's line owns lane 0; lane 1 stays reserved but unclaimed.
    expect(r.assignments.get("MT")).toBe(0);
    expect(r.assignments.get("C")).toBe(0);
    expect(r.assignments.get("B")).toBe(0);
    for (const lane of r.assignments.values()) expect(lane).not.toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Synthetic nodes (working-dir row, injected stashes) may sit on a locked
// lane when their first parent is owned by it. The `inheritsParentLane`
// flag confines this to synthetic nodes — a regular branch tip forked off a
// locked branch must NOT jump onto the locked lane.
// ---------------------------------------------------------------------------

describe("computeLanes — synthetic nodes inherit locked lanes", () => {
  const LOCKS: LockMap = { "refs/heads/main": 0 };
  const refs: RefsAtCommit = new Map([["T", ["refs/heads/main"]]]);

  test("flagged working-dir row inherits HEAD's locked lane", () => {
    const commits: CommitForGraph[] = [
      { id: "WD", parentIds: ["T"], inheritsParentLane: true },
      ...makeCommits([
        ["T", "B"],
        ["B", "R"],
        ["R"],
      ]),
    ];
    const r = computeLanes(commits, LOCKS, refs);
    expect(r.assignments.get("WD")).toBe(0);
  });

  test("flagged stash with an owned base inherits the locked lane", () => {
    const commits: CommitForGraph[] = [
      ...makeCommits([["T", "B"]]),
      { id: "ST", parentIds: ["B"], inheritsParentLane: true },
      ...makeCommits([
        ["B", "R"],
        ["R"],
      ]),
    ];
    const r = computeLanes(commits, LOCKS, refs);
    expect(r.assignments.get("ST")).toBe(0);
  });

  test("flagged stash with an unowned base stays off the locked lane", () => {
    // F is a feature commit off R, not on main's first-parent line.
    const commits: CommitForGraph[] = [
      ...makeCommits([["T", "B"]]),
      { id: "ST", parentIds: ["F"], inheritsParentLane: true },
      ...makeCommits([
        ["F", "R"],
        ["B", "R"],
        ["R"],
      ]),
    ];
    const r = computeLanes(commits, LOCKS, refs);
    expect(r.assignments.get("ST")).not.toBe(0);
    expect(r.assignments.get("ST")).toBe(r.assignments.get("F"));
  });

  test("unflagged child of an owned commit does not inherit (regression guard)", () => {
    const commits = makeCommits([
      ["FT", "T"], // normal branch tip forked off main's locked tip
      ["T", "B"],
      ["B", "R"],
      ["R"],
    ]);
    const r = computeLanes(commits, LOCKS, refs);
    expect(r.assignments.get("FT")).not.toBe(0);
  });
});
