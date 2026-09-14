// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useLayer, useLayersStore } from "./layers";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  useLayersStore.setState({ layers: [] });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

function Probe({ active, onDismiss }: { active: boolean; onDismiss: () => void }) {
  useLayer(active, "dialog", onDismiss);
  return null;
}

describe("useLayer", () => {
  it("pushes while active, pops on deactivate and unmount", async () => {
    await act(async () => root.render(<Probe active onDismiss={() => {}} />));
    expect(useLayersStore.getState().layers.map((l) => l.kind)).toEqual(["dialog"]);
    await act(async () => root.render(<Probe active={false} onDismiss={() => {}} />));
    expect(useLayersStore.getState().layers).toHaveLength(0);
    await act(async () => root.render(<Probe active onDismiss={() => {}} />));
    await act(async () => root.unmount());
    expect(useLayersStore.getState().layers).toHaveLength(0);
  });

  it("dismiss calls the latest callback without re-pushing the layer", async () => {
    const first = vi.fn();
    const second = vi.fn();
    await act(async () => root.render(<Probe active onDismiss={first} />));
    const pushed = useLayersStore.getState().layers[0];
    await act(async () => root.render(<Probe active onDismiss={second} />));
    expect(useLayersStore.getState().layers[0]).toBe(pushed);
    pushed.onDismiss();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
