import { describe, expect, it } from "vitest";
import type { FileTreeEntry } from "../shared/FileTree/buildTree";
import {
  NO_PENDING,
  dimPending,
  mergePending,
  prunePending,
  removePending,
} from "./pendingDim";

const entries: FileTreeEntry[] = [
  { path: "a.txt", change: "Modified" },
  { path: "b.txt", change: "Modified", dimmed: true },
  { path: "c.txt", change: "Added" },
];

describe("dimPending", () => {
  it("marks in-flight rows dimmed and leaves the rest untouched", () => {
    const out = dimPending(entries, new Set(["a.txt"]));
    expect(out.map((e) => !!e.dimmed)).toEqual([true, true, false]);
    expect(out[2]).toBe(entries[2]);
  });

  it("keeps a row's own dimmed flag when it is not pending", () => {
    expect(dimPending(entries, new Set(["c.txt"]))[1].dimmed).toBe(true);
  });

  it("returns the input array identity when nothing is pending (no re-render churn)", () => {
    expect(dimPending(entries, new Set())).toBe(entries);
  });
});

// Rapid keyboard staging queues several ops: the pending set must ACCUMULATE
// per section (every in-flight file stays dimmed), shrink per file as git
// confirms the moves, and drop an op's paths when it fails.
describe("pending set accumulation", () => {
  it("mergePending unions paths per section", () => {
    let p = mergePending(NO_PENDING, "unstaged", ["a.txt"]);
    p = mergePending(p, "unstaged", ["b.txt"]);
    p = mergePending(p, "staged", ["c.txt"]);
    expect([...p.unstaged].sort()).toEqual(["a.txt", "b.txt"]);
    expect([...p.staged]).toEqual(["c.txt"]);
  });

  it("prunePending keeps only paths still present in the section", () => {
    let p = mergePending(NO_PENDING, "unstaged", ["a.txt", "b.txt"]);
    p = prunePending(p, "unstaged", new Set(["b.txt", "z.txt"]));
    expect([...p.unstaged]).toEqual(["b.txt"]);
  });

  it("prunePending preserves identity when nothing changed (no re-render churn)", () => {
    const p = mergePending(NO_PENDING, "unstaged", ["a.txt"]);
    expect(prunePending(p, "unstaged", new Set(["a.txt", "x.txt"]))).toBe(p);
    expect(prunePending(NO_PENDING, "staged", new Set())).toBe(NO_PENDING);
  });

  it("removePending drops a failed op's paths, leaving other in-flight ones", () => {
    let p = mergePending(NO_PENDING, "unstaged", ["a.txt", "b.txt"]);
    p = removePending(p, "unstaged", ["a.txt"]);
    expect([...p.unstaged]).toEqual(["b.txt"]);
  });
});
