import { beforeEach, describe, expect, test, vi } from "vitest";
import { notify, problemSurface, useNotificationsStore } from "./notifications";
import { useSettingsStore } from "./settings";

const setStyle = (style: "toast" | "banner" | "popup") =>
  useSettingsStore.setState({ settings: { problem_notice_style: style } } as never);

beforeEach(() => {
  useNotificationsStore.getState().clear();
  useNotificationsStore.setState({ bannerHosts: 0 });
  useSettingsStore.setState({ settings: null } as never);
});

describe("problemSurface", () => {
  test("follows the setting for an error the user caused", () => {
    expect(problemSurface("toast", {}, true)).toBe("toast");
    expect(problemSurface("banner", {}, true)).toBe("banner");
    expect(problemSurface("popup", {}, true)).toBe("popup");
    expect(problemSurface(undefined, {}, true)).toBe("toast");
  });

  test("background notices stay toasts in every mode", () => {
    expect(problemSurface("popup", { background: true }, true)).toBe("toast");
    expect(problemSurface("banner", { background: true }, true)).toBe("toast");
  });

  test("notices with their own click action or lifetime stay toasts", () => {
    expect(problemSurface("popup", { action: () => {} }, true)).toBe("toast");
    expect(problemSurface("banner", { sticky: true }, true)).toBe("toast");
  });

  test("a window without a banner slot shows the popup instead", () => {
    expect(problemSurface("banner", {}, false)).toBe("popup");
  });
});

describe("problem notices", () => {
  test("popup mode keeps errors and warnings out of the toasts", () => {
    setStyle("popup");
    notify.error("push failed");
    notify.warning("stopped");
    notify.success("fine");
    const s = useNotificationsStore.getState();
    expect(s.problems.map((p) => [p.kind, p.message, p.surface])).toEqual([
      ["error", "push failed", "popup"],
      ["warning", "stopped", "popup"],
    ]);
    expect(s.toasts.map((t) => t.message)).toEqual(["fine"]);
  });

  test("banner mode uses the banner once a banner slot is mounted", () => {
    setStyle("banner");
    useNotificationsStore.setState({ bannerHosts: 1 });
    notify.error("push failed");
    expect(useNotificationsStore.getState().problems[0].surface).toBe("banner");
  });

  test("a background error stays a toast in popup mode", () => {
    setStyle("popup");
    notify.error("Settings sync: offline", { background: true });
    const s = useNotificationsStore.getState();
    expect(s.problems).toHaveLength(0);
    expect(s.toasts).toHaveLength(1);
  });

  test("an error repeating a pending warning adds no second notice", () => {
    setStyle("popup");
    const id = notify.warning("The operation was stopped.");
    expect(notify.error("Merge failed: The operation was stopped.")).toBe(id);
    expect(useNotificationsStore.getState().problems).toHaveLength(1);
  });

  test("dismiss removes one problem, dismissProblems a whole surface", () => {
    setStyle("popup");
    const id = notify.error("one");
    notify.error("two");
    useNotificationsStore.getState().dismiss(id);
    expect(useNotificationsStore.getState().problems.map((p) => p.message)).toEqual(["two"]);
    useNotificationsStore.getState().dismissProblems("popup");
    expect(useNotificationsStore.getState().problems).toHaveLength(0);
  });
});

describe("notifications store", () => {
  test("push defaults: no action, not sticky", () => {
    const id = notify.info("hello");
    const toast = useNotificationsStore.getState().toasts.find((t) => t.id === id)!;
    expect(toast.kind).toBe("info");
    expect(toast.sticky).toBeUndefined();
    expect(toast.action).toBeUndefined();
  });

  test("an error repeating a warning on screen adds no second toast", () => {
    const id = notify.warning("The operation was stopped.");
    expect(notify.error("Merge failed: The operation was stopped.")).toBe(id);
    expect(useNotificationsStore.getState().toasts).toHaveLength(1);
    notify.error("something else");
    expect(useNotificationsStore.getState().toasts).toHaveLength(2);
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
