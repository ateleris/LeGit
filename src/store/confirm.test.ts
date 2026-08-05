// Unit tests for the confirmation-dialog store: promise settlement, queue
// order, and settle-by-id semantics.
import { describe, it, expect, beforeEach } from "vitest";
import { useConfirmStore, confirmDialog } from "./confirm";

beforeEach(() => {
  useConfirmStore.setState({ queue: [] });
});

describe("confirm store", () => {
  it("resolves true on confirm and false on cancel", async () => {
    const a = confirmDialog({ title: "A", message: "m", confirmLabel: "Do" });
    const b = confirmDialog({ title: "B", message: "m", confirmLabel: "Do" });
    const [idA, idB] = useConfirmStore.getState().queue.map((p) => p.id);

    useConfirmStore.getState().settle(idA, true);
    useConfirmStore.getState().settle(idB, false);
    await expect(a).resolves.toBe(true);
    await expect(b).resolves.toBe(false);
    expect(useConfirmStore.getState().queue).toEqual([]);
  });

  it("queues requests in order; settling removes only the addressed one", () => {
    void confirmDialog({ title: "first", message: "m", confirmLabel: "Do" });
    void confirmDialog({ title: "second", message: "m", confirmLabel: "Do" });
    const { queue, settle } = useConfirmStore.getState();
    expect(queue.map((p) => p.title)).toEqual(["first", "second"]);

    settle(queue[0].id, false);
    expect(useConfirmStore.getState().queue.map((p) => p.title)).toEqual(["second"]);
  });

  it("settling an unknown id is a no-op", () => {
    void confirmDialog({ title: "A", message: "m", confirmLabel: "Do" });
    useConfirmStore.getState().settle(9999, true);
    expect(useConfirmStore.getState().queue).toHaveLength(1);
  });
});
