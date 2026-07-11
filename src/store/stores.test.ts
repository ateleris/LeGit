// Unit tests for the small per-repo zustand stores: draft isolation, progress
// lifecycle, and lane-lock caching (the concurrency-adjacent lane registry).

import { describe, test, expect, vi, beforeEach } from "vitest";
import { useCommitDraftStore } from "./commitDraft";
import { useRemoteProgressStore } from "./remoteProgress";
import { useLaneLocksStore } from "./laneLocks";
import { listLaneLocks, setLaneLock, unsetLaneLock } from "../lib/commands";
import type { RemoteProgress } from "../lib/types";

vi.mock("../lib/commands", () => ({
  listLaneLocks: vi.fn(),
  setLaneLock: vi.fn(),
  unsetLaneLock: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  useCommitDraftStore.setState({ drafts: {} });
  useRemoteProgressStore.setState({ byOp: {} });
  useLaneLocksStore.setState({ locks: {} });
});

describe("commitDraft store", () => {
  test("drafts are isolated per repo and clear individually", () => {
    const s = useCommitDraftStore.getState();
    s.setDraft("r1", "feat: one");
    s.setDraft("r2", "fix: two");
    s.clearDraft("r1");
    const drafts = useCommitDraftStore.getState().drafts;
    expect(drafts.r1).toBeUndefined();
    expect(drafts.r2).toBe("fix: two");
  });

  test("clearing an absent draft does not produce a new state object", () => {
    const before = useCommitDraftStore.getState().drafts;
    useCommitDraftStore.getState().clearDraft("ghost");
    expect(useCommitDraftStore.getState().drafts).toBe(before);
  });
});

describe("remoteProgress store", () => {
  const progress = (pct: number): RemoteProgress =>
    ({ phase: "Receiving objects", percent: pct } as unknown as RemoteProgress);

  test("report then clear per opId", () => {
    const s = useRemoteProgressStore.getState();
    s.report("op1", progress(10));
    s.report("op1", progress(90));
    s.report("op2", progress(5));
    expect(useRemoteProgressStore.getState().byOp.op1).toEqual(progress(90));
    s.clear("op1");
    const byOp = useRemoteProgressStore.getState().byOp;
    expect(byOp.op1).toBeUndefined();
    expect(byOp.op2).toEqual(progress(5));
  });

  test("clearing an absent op does not produce a new state object", () => {
    const before = useRemoteProgressStore.getState().byOp;
    useRemoteProgressStore.getState().clear("ghost");
    expect(useRemoteProgressStore.getState().byOp).toBe(before);
  });
});

describe("laneLocks store", () => {
  test("mutations refresh the per-repo cache from the returned list", async () => {
    vi.mocked(setLaneLock).mockResolvedValue([{ refName: "refs/heads/main", laneIndex: 0 }]);
    await useLaneLocksStore.getState().setLock("r1", "refs/heads/main", 0);
    expect(useLaneLocksStore.getState().getLocks("r1")).toEqual([
      { refName: "refs/heads/main", laneIndex: 0 },
    ]);

    vi.mocked(unsetLaneLock).mockResolvedValue([]);
    await useLaneLocksStore.getState().unsetLock("r1", "refs/heads/main");
    expect(useLaneLocksStore.getState().getLocks("r1")).toEqual([]);
  });

  test("locks are cached per repo id", async () => {
    vi.mocked(listLaneLocks).mockResolvedValue([{ refName: "refs/heads/dev", laneIndex: 2 }]);
    await useLaneLocksStore.getState().loadLocks("r1");
    expect(useLaneLocksStore.getState().getLocks("r1")).toHaveLength(1);
    expect(useLaneLocksStore.getState().getLocks("r2")).toEqual([]);
  });

  test("a failed load keeps the previous cache (warn, not throw)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    useLaneLocksStore.setState({ locks: { r1: [{ refName: "x", laneIndex: 1 }] } });
    vi.mocked(listLaneLocks).mockRejectedValue(new Error("ipc down"));
    await useLaneLocksStore.getState().loadLocks("r1");
    expect(useLaneLocksStore.getState().getLocks("r1")).toHaveLength(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
