import { describe, expect, it } from "vitest";
import { createOpQueue } from "./opQueue";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("createOpQueue", () => {
  it("runs ops strictly in order, one at a time", async () => {
    const enqueue = createOpQueue();
    const log: string[] = [];
    let releaseFirst!: () => void;
    const first = enqueue(async () => {
      log.push("first:start");
      await new Promise<void>((r) => (releaseFirst = r));
      log.push("first:end");
      return 1;
    });
    const second = enqueue(async () => {
      log.push("second");
      return 2;
    });
    await tick();
    expect(log).toEqual(["first:start"]);
    releaseFirst();
    expect(await first).toBe(1);
    expect(await second).toBe(2);
    expect(log).toEqual(["first:start", "first:end", "second"]);
  });

  it("delivers each op's own result", async () => {
    const enqueue = createOpQueue();
    const results = await Promise.all([
      enqueue(async () => "a"),
      enqueue(async () => "b"),
    ]);
    expect(results).toEqual(["a", "b"]);
  });

  it("a rejected op does not stall the queue", async () => {
    const enqueue = createOpQueue();
    const failing = enqueue(async () => {
      throw new Error("boom");
    });
    const after = enqueue(async () => "ok");
    await expect(failing).rejects.toThrow("boom");
    expect(await after).toBe("ok");
  });
});
