// Unit tests for the leading-edge coalescing repo invalidator.
//
// The module holds a process-wide `lastFired` map with no reset hook, so each
// test uses a unique repo id to stay isolated from the others.

import { describe, test, expect, vi } from "vitest";
import type { QueryClient } from "@tanstack/react-query";
import { invalidateRepoDomains, withDerivedDomains } from "./repoInvalidation";

/** A QueryClient stub that just records the keys it was asked to invalidate. */
function fakeClient() {
  const calls: unknown[][] = [];
  const qc = {
    invalidateQueries: ({ queryKey }: { queryKey: unknown[] }) => {
      calls.push(queryKey);
    },
  } as unknown as QueryClient;
  return { qc, calls };
}

describe("invalidateRepoDomains", () => {
  test("manual then watcher within the window → single invalidation", () => {
    const { qc, calls } = fakeClient();
    invalidateRepoDomains(qc, "r1", ["log"], { now: 0 });
    invalidateRepoDomains(qc, "r1", ["log"], { coalesce: true, now: 300 });
    expect(calls).toEqual([["r1", "log"]]);
  });

  test("manual then watcher after the window → two invalidations", () => {
    const { qc, calls } = fakeClient();
    invalidateRepoDomains(qc, "r2", ["log"], { now: 0 });
    invalidateRepoDomains(qc, "r2", ["log"], { coalesce: true, now: 401 });
    expect(calls).toEqual([["r2", "log"], ["r2", "log"]]);
  });

  test("two watcher emissions within the window → single invalidation", () => {
    const { qc, calls } = fakeClient();
    invalidateRepoDomains(qc, "r3", ["log"], { coalesce: true, now: 0 });
    invalidateRepoDomains(qc, "r3", ["log"], { coalesce: true, now: 50 });
    expect(calls).toEqual([["r3", "log"]]);
  });

  test("two manual calls within the window → both fire (manual never suppressed)", () => {
    const { qc, calls } = fakeClient();
    invalidateRepoDomains(qc, "r4", ["status"], { now: 0 });
    invalidateRepoDomains(qc, "r4", ["status"], { now: 100 });
    expect(calls).toEqual([["r4", "status"], ["r4", "status"]]);
  });

  test("distinct domains do not suppress each other", () => {
    const { qc, calls } = fakeClient();
    invalidateRepoDomains(qc, "r5", ["log", "branches", "status"], { now: 0 });
    // A coalescing pass for a different domain still fires.
    invalidateRepoDomains(qc, "r5", ["log"], { coalesce: true, now: 10 }); // suppressed
    invalidateRepoDomains(qc, "r5", ["status"], { coalesce: true, now: 10 }); // suppressed
    expect(calls).toEqual([["r5", "log"], ["r5", "branches"], ["r5", "status"]]);
  });

  test("falls back to Date.now() when no `now` is given", () => {
    const { qc, calls } = fakeClient();
    const spy = vi.spyOn(Date, "now").mockReturnValue(1_000);
    invalidateRepoDomains(qc, "r6", ["log"]);
    invalidateRepoDomains(qc, "r6", ["log"], { coalesce: true });
    spy.mockRestore();
    expect(calls).toEqual([["r6", "log"]]);
  });
});

describe("withDerivedDomains", () => {
  test("adds submodules alongside status", () => {
    expect(withDerivedDomains(["status"])).toEqual(["status", "submodules"]);
  });
  test("adds submodules and tracking alongside branches", () => {
    expect(withDerivedDomains(["branches", "log"])).toEqual([
      "branches",
      "log",
      "submodules",
      "tracking",
    ]);
  });
  test("leaves unrelated domains alone", () => {
    expect(withDerivedDomains(["tags"])).toEqual(["tags"]);
  });
  test("does not duplicate", () => {
    expect(withDerivedDomains(["status", "submodules"])).toEqual(["status", "submodules"]);
  });
  test("external ref moves refresh the ahead/behind counter", () => {
    // An external `git fetch` classifies as branches only; the tracking
    // query domain must be derived or the sync toolbar goes stale.
    expect(withDerivedDomains(["branches"])).toEqual(["branches", "submodules", "tracking"]);
    expect(withDerivedDomains(["status"])).not.toContain("tracking");
  });
});
