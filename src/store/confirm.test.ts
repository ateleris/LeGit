// The prompt variant of the central dialog: resolves the edited text on
// confirm, null on cancel - backs the bulk-squash message editor.
import { describe, expect, it } from "vitest";
import { confirmDestructiveAction, promptDialog, useConfirmStore } from "./confirm";
import { useSettingsStore } from "./settings";

describe("promptDialog", () => {
  it("resolves the edited value on confirm", async () => {
    const p = promptDialog({
      title: "Squash 3 commits",
      message: "Commit message for the squashed commit:",
      confirmLabel: "Squash",
      input: { initialValue: "a\n\nb" },
    });
    const pending = useConfirmStore.getState().queue.at(-1)!;
    expect(pending.input?.initialValue).toBe("a\n\nb");
    useConfirmStore.getState().settle(pending.id, true, "edited message");
    await expect(p).resolves.toBe("edited message");
  });

  it("resolves null on cancel", async () => {
    const p = promptDialog({
      message: "m",
      confirmLabel: "Ok",
      input: { initialValue: "x" },
    });
    const pending = useConfirmStore.getState().queue.at(-1)!;
    useConfirmStore.getState().settle(pending.id, false);
    await expect(p).resolves.toBeNull();
  });
});

describe("promptDialog allowEmpty", () => {
  it("is carried on the pending request for the host's confirm gating", () => {
    // The worktree lock reason is OPTIONAL: a blank value must be
    // confirmable when the caller says so (default stays blank-disabled).
    void promptDialog({
      message: "Lock reason (optional):",
      confirmLabel: "Lock",
      input: { initialValue: "", allowEmpty: true },
    });
    const pending = useConfirmStore.getState().queue.at(-1)!;
    expect(pending.input?.allowEmpty).toBe(true);
    useConfirmStore.getState().settle(pending.id, true, "");
  });
});

describe("confirmDestructiveAction", () => {
  const setGate = (on: boolean) =>
    useSettingsStore.setState({ settings: { confirm_discard: on } } as never);

  it("resolves true without a dialog when the setting is off", async () => {
    setGate(false);
    const before = useConfirmStore.getState().queue.length;
    await expect(confirmDestructiveAction({ message: "Drop?", confirmLabel: "Drop" })).resolves.toBe(true);
    expect(useConfirmStore.getState().queue.length).toBe(before);
  });

  it("asks through the central dialog when the setting is on", async () => {
    setGate(true);
    const p = confirmDestructiveAction({ message: "Drop?", confirmLabel: "Drop" });
    const pending = useConfirmStore.getState().queue.at(-1)!;
    expect(pending.message).toBe("Drop?");
    useConfirmStore.getState().settle(pending.id, false);
    await expect(p).resolves.toBe(false);
  });
});
