import { beforeEach, describe, expect, it } from "vitest";
import { RepoBusyError, repoWriteClass, runRepoWrite, useRepoWriteStore } from "./repoWrites";

const long = { kind: "long", label: "Merging main…" } as const;
const quick = { kind: "quick" } as const;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

beforeEach(() => useRepoWriteStore.setState({ running: {} }));

describe("repoWriteClass", () => {
  it("classifies long-running, quick and non-locking commands", () => {
    expect(repoWriteClass("repoMerge", ["r", "main", {}])).toEqual(long);
    expect(repoWriteClass("repoPull", ["r"])).toEqual({ kind: "long", label: "Pulling…" });
    expect(repoWriteClass("repoStage", ["r", []])).toEqual(quick);
    for (const read of ["repoStatus", "repoLog", "repoDiff", "repoFetch", "repoPush", "repoDeleteTag"]) {
      expect(repoWriteClass(read, ["r"]), read).toBeNull();
    }
  });
});

describe("runRepoWrite", () => {
  it("refuses any write while a long-running one holds the repository", async () => {
    const gate = deferred();
    const merge = runRepoWrite("r", long, () => gate.promise);
    expect(useRepoWriteStore.getState().running.r).toBe("Merging main…");

    await expect(runRepoWrite("r", quick, async () => "staged")).rejects.toBeInstanceOf(RepoBusyError);
    await expect(runRepoWrite("r", long, async () => "rebased")).rejects.toThrow(/Merging main\)/);

    gate.resolve();
    await merge;
    expect(useRepoWriteStore.getState().running.r).toBeUndefined();
    await expect(runRepoWrite("r", quick, async () => "staged")).resolves.toBe("staged");
  });

  it("never holds back another repository", async () => {
    const gate = deferred();
    const merge = runRepoWrite("r", long, () => gate.promise);
    await expect(runRepoWrite("other", quick, async () => "ok")).resolves.toBe("ok");
    gate.resolve();
    await merge;
  });

  it("makes quick writes take turns instead of overlapping", async () => {
    const order: string[] = [];
    const first = deferred();
    const a = runRepoWrite("r", quick, async () => {
      order.push("a:start");
      await first.promise;
      order.push("a:end");
    });
    const b = runRepoWrite("r", quick, async () => {
      order.push("b:start");
    });
    await Promise.resolve();
    expect(order).toEqual(["a:start"]);
    first.resolve();
    await Promise.all([a, b]);
    expect(order).toEqual(["a:start", "a:end", "b:start"]);
  });

  it("releases the repository when the write fails", async () => {
    await expect(
      runRepoWrite("r", long, async () => {
        throw new Error("conflict");
      }),
    ).rejects.toThrow("conflict");
    expect(useRepoWriteStore.getState().running.r).toBeUndefined();
    await expect(runRepoWrite("r", long, async () => 1)).resolves.toBe(1);
  });
});
