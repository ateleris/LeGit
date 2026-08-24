import { beforeEach, describe, expect, test, vi } from "vitest";
import { notify, useNotificationsStore } from "./notifications";

beforeEach(() => {
  useNotificationsStore.getState().clear();
});

describe("notifications store", () => {
  test("push defaults: no action, not sticky", () => {
    const id = notify.info("hello");
    const toast = useNotificationsStore.getState().toasts.find((t) => t.id === id)!;
    expect(toast.kind).toBe("info");
    expect(toast.sticky).toBeUndefined();
    expect(toast.action).toBeUndefined();
  });

  test("push carries sticky and action through to the toast", () => {
    const action = vi.fn();
    const id = useNotificationsStore.getState().push("info", "update available", {
      sticky: true,
      action,
    });
    const toast = useNotificationsStore.getState().toasts.find((t) => t.id === id)!;
    expect(toast.sticky).toBe(true);
    expect(toast.action).toBe(action);
  });

  test("update replaces the message of a live toast in place", () => {
    const id = notify.info("Downloading… 0%");
    useNotificationsStore.getState().update(id, "Downloading… 50%");
    const toast = useNotificationsStore.getState().toasts.find((t) => t.id === id)!;
    expect(toast.message).toBe("Downloading… 50%");
  });

  test("update on a dismissed toast is a no-op", () => {
    const id = notify.info("gone");
    useNotificationsStore.getState().dismiss(id);
    useNotificationsStore.getState().update(id, "resurrected?");
    expect(useNotificationsStore.getState().toasts).toHaveLength(0);
  });
});
