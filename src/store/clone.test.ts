// Unit tests for the in-flight clone store.
//
// The bug this pins: the op id used to live in `CloneForm`'s ref, so
// dismissing the clone dialog orphaned the clone — uncancellable, with no
// progress meter and a silently swallowed outcome. The store now owns the
// op id, so it is reachable (and cancellable) with no component mounted.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const cancelClone = vi.fn((_opId: string) => Promise.resolve(true));
vi.mock("../lib/commands", () => ({ cancelClone: (id: string) => cancelClone(id) }));

import { useCloneStore } from "./clone";
import { useNotificationsStore } from "./notifications";
import { useRemoteProgressStore } from "./remoteProgress";
import { useRepoStore } from "./repos";

/** A clone that never settles until the returned handle is used. */
function deferredClone() {
  let resolve!: (v: unknown) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const cloneRepo = vi.fn(() => promise);
  useRepoStore.setState({ cloneRepo } as never);
  return { resolve, reject, cloneRepo };
}

const START = {
  url: "https://example.com/legit.git",
  parentDir: "/src",
  name: "legit",
  profileId: null,
  options: {},
};

/** Let the store's async `finally` run. */
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  cancelClone.mockClear();
  useCloneStore.setState({ jobs: {}, completedCount: 0 });
  useNotificationsStore.setState({ toasts: [] });
  useRemoteProgressStore.setState({ byOp: {} });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("clone store job lifecycle", () => {
  it("registers the job synchronously, so a dismissed dialog can still cancel it", async () => {
    const { resolve } = deferredClone();

    // The caller (the form) starts the clone and immediately forgets the id -
    // exactly what happens when the dialog is dismissed.
    useCloneStore.getState().start(START);

    const ids = Object.keys(useCloneStore.getState().jobs);
    expect(ids).toHaveLength(1);
    const opId = ids[0];
    expect(useCloneStore.getState().jobs[opId]).toMatchObject({
      opId,
      name: "legit",
      url: START.url,
      parentDir: "/src",
      cancelling: false,
    });

    useCloneStore.getState().cancel(opId);
    expect(cancelClone).toHaveBeenCalledWith(opId);
    expect(useCloneStore.getState().jobs[opId].cancelling).toBe(true);

    resolve({ id: "repo-1" });
    await settle();
    expect(useCloneStore.getState().jobs).toEqual({});
  });

  it("passes the store-minted op id to cloneRepo", async () => {
    const { resolve, cloneRepo } = deferredClone();
    const opId = useCloneStore.getState().start({ ...START, profileId: "p1" });

    expect(cloneRepo).toHaveBeenCalledWith(
      START.url,
      "/src",
      "legit",
      "p1",
      opId,
      START.options,
    );
    resolve({ id: "repo-1" });
    await settle();
  });

  it("drops the job and clears its progress meter on success", async () => {
    const { resolve } = deferredClone();
    const opId = useCloneStore.getState().start(START);
    useRemoteProgressStore.getState().report(opId, { phase: "Receiving objects", percent: 42 });

    resolve({ id: "repo-1" });
    await settle();

    expect(useCloneStore.getState().jobs).toEqual({});
    expect(useRemoteProgressStore.getState().byOp[opId]).toBeUndefined();
    expect(useCloneStore.getState().completedCount).toBe(1);
    expect(useNotificationsStore.getState().toasts.map((t) => [t.kind, t.message])).toEqual([
      ["success", "Cloned legit"],
    ]);
  });

  it("drops the job and clears its progress meter on failure", async () => {
    const { reject } = deferredClone();
    const opId = useCloneStore.getState().start(START);
    useRemoteProgressStore.getState().report(opId, { phase: "Receiving objects", percent: 7 });

    reject("repository not found");
    await settle();

    expect(useCloneStore.getState().jobs).toEqual({});
    expect(useRemoteProgressStore.getState().byOp[opId]).toBeUndefined();
    expect(useCloneStore.getState().completedCount).toBe(1);
  });

  it("cancelling twice only reaches the backend once", async () => {
    const { resolve } = deferredClone();
    const opId = useCloneStore.getState().start(START);

    useCloneStore.getState().cancel(opId);
    useCloneStore.getState().cancel(opId);
    expect(cancelClone).toHaveBeenCalledTimes(1);

    resolve({ id: "repo-1" });
    await settle();
    // A cancel for a settled job is a no-op, not a stray backend call.
    useCloneStore.getState().cancel(opId);
    expect(cancelClone).toHaveBeenCalledTimes(1);
  });

  it("runs two clones side by side and cancels them independently", async () => {
    let resolveA!: (v: unknown) => void;
    let resolveB!: (v: unknown) => void;
    const promises = [
      new Promise((r) => (resolveA = r)),
      new Promise((r) => (resolveB = r)),
    ];
    let call = 0;
    useRepoStore.setState({ cloneRepo: vi.fn(() => promises[call++]) } as never);

    const a = useCloneStore.getState().start({ ...START, name: "alpha" });
    const b = useCloneStore.getState().start({ ...START, name: "beta" });
    expect(Object.keys(useCloneStore.getState().jobs)).toHaveLength(2);

    useCloneStore.getState().cancel(a);
    expect(cancelClone).toHaveBeenCalledTimes(1);
    expect(cancelClone).toHaveBeenCalledWith(a);
    expect(useCloneStore.getState().jobs[b].cancelling).toBe(false);

    resolveA({ id: "repo-a" });
    await settle();
    expect(Object.keys(useCloneStore.getState().jobs)).toEqual([b]);

    resolveB({ id: "repo-b" });
    await settle();
    expect(useCloneStore.getState().jobs).toEqual({});
  });
});

describe("clone store outcome toasts", () => {
  const gitError = (kind: string, details?: unknown) => ({
    kind: "Git",
    details: { kind, details },
  });

  const messages = () =>
    useNotificationsStore.getState().toasts.map((t) => [t.kind, t.message]);

  it("stays silent for a user cancel", async () => {
    const { reject } = deferredClone();
    useCloneStore.getState().start(START);
    reject(gitError("CloneCancelled", { cleanup_failed: null }));
    await settle();
    expect(messages()).toEqual([]);
  });

  it("reports a cancel whose cleanup failed", async () => {
    const { reject } = deferredClone();
    useCloneStore.getState().start(START);
    reject(gitError("CloneCancelled", { cleanup_failed: "could not remove /src/legit" }));
    await settle();
    expect(messages()).toEqual([["error", "could not remove /src/legit"]]);
  });

  it("gives the profile hint for an auth failure", async () => {
    const { reject } = deferredClone();
    useCloneStore.getState().start(START);
    reject(gitError("AuthFailed"));
    await settle();
    expect(messages()[0][0]).toBe("error");
    expect(messages()[0][1]).toContain("authentication failed");
    expect(messages()[0][1]).toContain("legit");
  });

  it("surfaces any other failure - the dismissed dialog used to swallow it", async () => {
    const { reject } = deferredClone();
    useCloneStore.getState().start(START);
    reject(gitError("Other", "repository not found"));
    await settle();
    expect(messages()[0][0]).toBe("error");
    expect(messages()[0][1]).toContain("repository not found");
  });
});
