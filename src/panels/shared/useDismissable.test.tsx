// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React, { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MENU_LAYER_ATTR } from "../Commits/menu/primitives";
import { useDismissable } from "./useDismissable";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let outside: HTMLDivElement;

beforeEach(() => {
  host = document.createElement("div");
  outside = document.createElement("div");
  document.body.append(host, outside);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  outside.remove();
});

function Probe({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useDismissable(open, onClose, [ref]);
  return <div ref={ref} data-testid="inside" />;
}

const mouseDownOn = (el: Element) =>
  act(async () => {
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  });

const pressEscape = () =>
  act(async () => {
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
  });

describe("useDismissable", () => {
  it("closes on outside mousedown, not on inside mousedown", async () => {
    const onClose = vi.fn();
    await act(async () => root.render(<Probe open onClose={onClose} />));
    await mouseDownOn(host.querySelector("[data-testid=inside]")!);
    expect(onClose).not.toHaveBeenCalled();
    await mouseDownOn(outside);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("treats a marked menu layer as inside (portaled flyouts)", async () => {
    const onClose = vi.fn();
    outside.setAttribute(MENU_LAYER_ATTR, "");
    await act(async () => root.render(<Probe open onClose={onClose} />));
    await mouseDownOn(outside);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes on Escape and stops propagation (maximize-exit contract)", async () => {
    const onClose = vi.fn();
    const windowSpy = vi.fn();
    window.addEventListener("keydown", windowSpy);
    await act(async () => root.render(<Probe open onClose={onClose} />));
    await pressEscape();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(windowSpy).not.toHaveBeenCalled();
    window.removeEventListener("keydown", windowSpy);
  });

  it("does nothing while closed", async () => {
    const onClose = vi.fn();
    await act(async () => root.render(<Probe open={false} onClose={onClose} />));
    await mouseDownOn(outside);
    await pressEscape();
    expect(onClose).not.toHaveBeenCalled();
  });
});
