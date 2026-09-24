// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React, { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { KeyDispatcher } from "../../keys/Dispatcher";
import { useLayersStore, type LayerKind } from "../../store/layers";
import { MENU_LAYER_ATTR } from "../shared/menu/primitives";
import { useDismissable } from "./useDismissable";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let outside: HTMLDivElement;

beforeEach(() => {
  useLayersStore.setState({ layers: [] });
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

function Probe({
  open,
  onClose,
  kind,
}: {
  open: boolean;
  onClose: () => void;
  kind?: LayerKind;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useDismissable(open, onClose, [ref], kind);
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

  it("pushes a menu layer while open and pops it on close and unmount", async () => {
    await act(async () => root.render(<Probe open onClose={() => {}} />));
    expect(useLayersStore.getState().layers).toHaveLength(1);
    expect(useLayersStore.getState().layers[0].kind).toBe("menu");
    await act(async () => root.render(<Probe open={false} onClose={() => {}} />));
    expect(useLayersStore.getState().layers).toHaveLength(0);
    await act(async () => root.render(<Probe open onClose={() => {}} />));
    expect(useLayersStore.getState().layers).toHaveLength(1);
    await act(async () => root.unmount());
    expect(useLayersStore.getState().layers).toHaveLength(0);
  });

  it("passes a popover kind through (hover flyouts must not block commands)", async () => {
    await act(async () => root.render(<Probe open onClose={() => {}} kind="popover" />));
    expect(useLayersStore.getState().layers[0].kind).toBe("popover");
  });

  it("Escape via the dispatcher closes it and stops propagation (maximize-exit contract)", async () => {
    const onClose = vi.fn();
    const windowSpy = vi.fn();
    window.addEventListener("keydown", windowSpy);
    await act(async () =>
      root.render(
        <>
          <KeyDispatcher />
          <Probe open onClose={onClose} />
        </>,
      ),
    );
    await pressEscape();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(windowSpy).not.toHaveBeenCalled();
    expect(useLayersStore.getState().layers).toHaveLength(0);
    window.removeEventListener("keydown", windowSpy);
  });

  it("does nothing while closed", async () => {
    const onClose = vi.fn();
    await act(async () => root.render(<Probe open={false} onClose={onClose} />));
    await mouseDownOn(outside);
    await pressEscape();
    expect(onClose).not.toHaveBeenCalled();
    expect(useLayersStore.getState().layers).toHaveLength(0);
  });
});
