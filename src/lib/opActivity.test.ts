import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACTIVITY_BAR_DELAY_MS, useOpActivityStore, withOpActivity } from "./opActivity";

const running = () => useOpActivityStore.getState().ops;

beforeEach(() => {
  vi.useFakeTimers();
  useOpActivityStore.setState({ ops: [] });
});
afterEach(() => vi.useRealTimers());

describe("withOpActivity", () => {
  it("never lists an operation that finishes within the delay", async () => {
    await withOpActivity("Merging main…", async () => {
      await vi.advanceTimersByTimeAsync(ACTIVITY_BAR_DELAY_MS - 1);
      expect(running()).toHaveLength(0);
    });
    await vi.advanceTimersByTimeAsync(ACTIVITY_BAR_DELAY_MS * 2);
    expect(running()).toHaveLength(0);
  });

  it("lists a slow operation with its repo while it runs and removes it when it settles", async () => {
    let release!: () => void;
    const op = withOpActivity("Merging main…", () => new Promise<void>((r) => (release = r)), "repo-1");
    await vi.advanceTimersByTimeAsync(ACTIVITY_BAR_DELAY_MS);
    expect(running()).toMatchObject([{ label: "Merging main…", repoId: "repo-1" }]);
    release();
    await op;
    expect(running()).toHaveLength(0);
  });

  it("removes the entry and rethrows when the operation fails", async () => {
    const op = withOpActivity("Rebasing…", async () => {
      await vi.advanceTimersByTimeAsync(ACTIVITY_BAR_DELAY_MS);
      expect(running()).toHaveLength(1);
      throw new Error("boom");
    });
    await expect(op).rejects.toThrow("boom");
    expect(running()).toHaveLength(0);
  });
});
