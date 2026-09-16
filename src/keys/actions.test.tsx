// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  hasCommandAction,
  runCommandAction,
  useCommandAction,
  useCommandActionsStore,
} from "./actions";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  useCommandActionsStore.setState({ actions: {} });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

function Probe({ fn }: { fn: (() => void) | null }) {
  useCommandAction("repo.fetch", fn);
  return null;
}

describe("command actions", () => {
  it("registers while mounted and unregisters on unmount", async () => {
    await act(async () => root.render(<Probe fn={() => {}} />));
    expect(hasCommandAction("repo.fetch")).toBe(true);
    await act(async () => root.unmount());
    expect(hasCommandAction("repo.fetch")).toBe(false);
  });

  it("running invokes the latest handler without re-registering", async () => {
    const first = vi.fn();
    const second = vi.fn();
    await act(async () => root.render(<Probe fn={first} />));
    await act(async () => root.render(<Probe fn={second} />));
    expect(runCommandAction("repo.fetch")).toBe(true);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("a null handler means not registered (temporarily unavailable)", async () => {
    await act(async () => root.render(<Probe fn={null} />));
    expect(hasCommandAction("repo.fetch")).toBe(false);
    expect(runCommandAction("repo.fetch")).toBe(false);
  });

  it("running an unregistered action reports false", () => {
    expect(runCommandAction("repo.push")).toBe(false);
  });
});
