// @vitest-environment happy-dom
//
// Auto-dismiss policy of the toast overlay: success/info disappear quickly,
// errors disappear after a LONGER time (they used to persist forever; the
// full detail survives in the Git Command Log), sticky toasts never time
// out (they are the only pointer to their flow, e.g. update-available).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Toasts } from "./Toasts";
import { notify, useNotificationsStore } from "../store/notifications";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  useNotificationsStore.getState().clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<Toasts />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

const advance = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

describe("toast auto-dismiss", () => {
  it("info toasts dismiss after a few seconds", () => {
    act(() => void notify.info("done"));
    expect(container.textContent).toContain("done");
    advance(4_000);
    expect(container.textContent).not.toContain("done");
  });

  it("error toasts outlive the short timeout but dismiss after the long one", () => {
    act(() => void notify.error("push failed"));
    advance(4_000);
    expect(container.textContent).toContain("push failed");
    advance(26_000); // 30s total
    expect(container.textContent).not.toContain("push failed");
  });

  it("sticky toasts never time out", () => {
    act(() => void notify.info("update available", { sticky: true }));
    advance(120_000);
    expect(container.textContent).toContain("update available");
  });
});
