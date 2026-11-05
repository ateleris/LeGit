import { afterEach, describe, expect, it } from "vitest";
import { confirmDropUnsavedEdits } from "./unsavedEdits";
import { useConfirmStore } from "../../store/confirm";
import { useSettingsStore } from "../../store/settings";

const setGate = (on: boolean) =>
  useSettingsStore.setState({ settings: { confirm_discard: on } } as never);

describe("confirmDropUnsavedEdits", () => {
  afterEach(() => {
    for (const p of useConfirmStore.getState().queue) {
      useConfirmStore.getState().settle(p.id, false);
    }
  });

  it("resolves true without a dialog when the editor is pristine", async () => {
    setGate(true);
    const before = useConfirmStore.getState().queue.length;
    await expect(confirmDropUnsavedEdits(false, "src/a.ts")).resolves.toBe(true);
    expect(useConfirmStore.getState().queue.length).toBe(before);
  });

  it("asks through the central dialog when dirty, naming the file", async () => {
    setGate(true);
    const result = confirmDropUnsavedEdits(true, "src/a.ts");
    const pending = useConfirmStore.getState().queue.at(-1);
    expect(pending).toBeDefined();
    expect(pending!.detail).toBe("src/a.ts");
    expect(pending!.confirmLabel).toBe("Discard edits");
    useConfirmStore.getState().settle(pending!.id, true);
    await expect(result).resolves.toBe(true);
  });

  it("resolves false when the dialog is cancelled", async () => {
    setGate(true);
    const result = confirmDropUnsavedEdits(true, "src/a.ts");
    const pending = useConfirmStore.getState().queue.at(-1)!;
    useConfirmStore.getState().settle(pending.id, false);
    await expect(result).resolves.toBe(false);
  });

  it("resolves true at once when the confirmation setting is off", async () => {
    setGate(false);
    const before = useConfirmStore.getState().queue.length;
    await expect(confirmDropUnsavedEdits(true, "src/a.ts")).resolves.toBe(true);
    expect(useConfirmStore.getState().queue.length).toBe(before);
  });
});
