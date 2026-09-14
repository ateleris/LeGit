// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLayersStore, type Layer } from "../store/layers";
import { createKeydownHandler, type DispatcherDeps } from "./Dispatcher";
import { reverseIndex } from "./keymap";
import type { Command } from "./registry";

const run = vi.fn();
const gated = vi.fn();

const COMMANDS: Command[] = [
  {
    id: "panel.toggleMaximize",
    title: "Maximize panel",
    scope: "global",
    defaultBinding: ["Mod+Shift+M"],
    run,
  },
  {
    id: "gated.cmd",
    title: "Gated",
    scope: "global",
    defaultBinding: ["F6"],
    when: () => false,
    run: gated,
  },
];

function deps(): DispatcherDeps {
  return {
    commands: COMMANDS,
    getByChord: () => reverseIndex({ "panel.toggleMaximize": ["Mod+Shift+M"], "gated.cmd": ["F6"] }),
    getLayers: () => useLayersStore.getState().layers,
    removeLayer: (id) => useLayersStore.getState().remove(id),
    getContext: () => ({ repoActive: true, focusPanel: null }),
    platform: { isMac: false },
  };
}

let handler: (e: KeyboardEvent) => void;
let bubbleSpy: ReturnType<typeof vi.fn<(e: KeyboardEvent) => void>>;
let input: HTMLInputElement;

beforeEach(() => {
  useLayersStore.setState({ layers: [] });
  run.mockClear();
  gated.mockClear();
  handler = createKeydownHandler(deps());
  window.addEventListener("keydown", handler, true);
  bubbleSpy = vi.fn<(e: KeyboardEvent) => void>();
  window.addEventListener("keydown", bubbleSpy);
  input = document.createElement("input");
  document.body.appendChild(input);
});

afterEach(() => {
  window.removeEventListener("keydown", handler, true);
  window.removeEventListener("keydown", bubbleSpy);
  input.remove();
});

const press = (init: KeyboardEventInit, target: Element = document.body) => {
  const e = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
};

const layer = (id: string, kind: Layer["kind"], onDismiss = () => {}): Layer => ({
  id,
  kind,
  onDismiss,
});

describe("Escape and the layer stack", () => {
  it("pops exactly the topmost layer: menu over maximized mode (regression)", () => {
    const modeDismiss = vi.fn();
    const menuDismiss = vi.fn();
    useLayersStore.getState().push(layer("maximize", "mode", modeDismiss));
    useLayersStore.getState().push(layer("ctx-menu", "menu", menuDismiss));

    const e = press({ key: "Escape" });

    expect(menuDismiss).toHaveBeenCalledTimes(1);
    expect(modeDismiss).not.toHaveBeenCalled();
    expect(useLayersStore.getState().layers.map((l) => l.id)).toEqual(["maximize"]);
    expect(e.defaultPrevented).toBe(true);
    expect(bubbleSpy).not.toHaveBeenCalled();
  });

  it("a second Escape then pops the mode layer", () => {
    const modeDismiss = vi.fn();
    useLayersStore.getState().push(layer("maximize", "mode", modeDismiss));
    press({ key: "Escape" });
    expect(modeDismiss).toHaveBeenCalledTimes(1);
    expect(useLayersStore.getState().layers).toEqual([]);
  });

  it("a mode layer yields to an editable target (inline rename wins)", () => {
    const modeDismiss = vi.fn();
    useLayersStore.getState().push(layer("maximize", "mode", modeDismiss));
    const e = press({ key: "Escape" }, input);
    expect(modeDismiss).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
    expect(bubbleSpy).toHaveBeenCalledTimes(1);
  });

  it("Escape with an empty stack passes through untouched", () => {
    const e = press({ key: "Escape" });
    expect(e.defaultPrevented).toBe(false);
    expect(bubbleSpy).toHaveBeenCalledTimes(1);
  });
});

describe("command dispatch", () => {
  it("runs the resolved command and consumes the event", () => {
    const e = press({ key: "m", ctrlKey: true, shiftKey: true });
    expect(run).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(true);
    expect(bubbleSpy).not.toHaveBeenCalled();
  });

  it("a false when-gate leaves the event untouched", () => {
    const e = press({ key: "F6" });
    expect(gated).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
    expect(bubbleSpy).toHaveBeenCalledTimes(1);
  });

  it("an unmatched chord passes through completely untouched (the load-bearing rule)", () => {
    const e = press({ key: "Enter", ctrlKey: true });
    expect(e.defaultPrevented).toBe(false);
    expect(bubbleSpy).toHaveBeenCalledTimes(1);
  });

  it("a binding without allowInInput passes through in an editable target", () => {
    const e = press({ key: "m", ctrlKey: true, shiftKey: true }, input);
    expect(run).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
    expect(bubbleSpy).toHaveBeenCalledTimes(1);
  });

  it("a blocking layer suppresses commands but never cancels the event", () => {
    useLayersStore.getState().push(layer("d", "dialog"));
    const e = press({ key: "m", ctrlKey: true, shiftKey: true });
    expect(run).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });
});
