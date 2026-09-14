import { beforeEach, describe, expect, it } from "vitest";
import {
  hasBlockingLayer,
  layerToDismiss,
  topLayer,
  useLayersStore,
  type Layer,
} from "./layers";

const layer = (id: string, kind: Layer["kind"]): Layer => ({
  id,
  kind,
  onDismiss: () => {},
});

beforeEach(() => {
  useLayersStore.setState({ layers: [] });
});

describe("layers store", () => {
  it("pushes on top and removes by id, in any order", () => {
    const { push, remove } = useLayersStore.getState();
    push(layer("a", "menu"));
    push(layer("b", "popover"));
    push(layer("c", "dialog"));
    remove("b");
    expect(useLayersStore.getState().layers.map((l) => l.id)).toEqual(["a", "c"]);
    remove("a");
    expect(useLayersStore.getState().layers.map((l) => l.id)).toEqual(["c"]);
  });

  it("re-pushing an existing id moves it to the top without duplicating", () => {
    const { push } = useLayersStore.getState();
    push(layer("a", "mode"));
    push(layer("b", "menu"));
    push(layer("a", "mode"));
    expect(useLayersStore.getState().layers.map((l) => l.id)).toEqual(["b", "a"]);
  });

  it("removing an unknown id is a no-op", () => {
    const { push, remove } = useLayersStore.getState();
    push(layer("a", "menu"));
    remove("ghost");
    expect(useLayersStore.getState().layers.map((l) => l.id)).toEqual(["a"]);
  });
});

describe("topLayer", () => {
  it("returns the last pushed layer, or null when empty", () => {
    expect(topLayer([])).toBeNull();
    const stack = [layer("a", "mode"), layer("b", "menu")];
    expect(topLayer(stack)?.id).toBe("b");
  });
});

describe("hasBlockingLayer", () => {
  it("dialog and menu block; popover and mode do not", () => {
    expect(hasBlockingLayer([layer("d", "dialog")])).toBe(true);
    expect(hasBlockingLayer([layer("m", "menu")])).toBe(true);
    expect(hasBlockingLayer([layer("p", "popover")])).toBe(false);
    expect(hasBlockingLayer([layer("x", "mode")])).toBe(false);
    expect(hasBlockingLayer([])).toBe(false);
    expect(hasBlockingLayer([layer("x", "mode"), layer("p", "popover")])).toBe(false);
    expect(hasBlockingLayer([layer("p", "popover"), layer("m", "menu")])).toBe(true);
  });
});

describe("layerToDismiss (the Escape decision)", () => {
  it("returns null for an empty stack", () => {
    expect(layerToDismiss([], false)).toBeNull();
  });

  it("returns exactly the topmost layer: menu over a maximized mode pops the menu", () => {
    const mode = layer("maximize", "mode");
    const menu = layer("ctx-menu", "menu");
    expect(layerToDismiss([mode, menu], false)?.id).toBe("ctx-menu");
  });

  it("returns a mode layer when the target is not editable", () => {
    expect(layerToDismiss([layer("maximize", "mode")], false)?.id).toBe("maximize");
  });

  it("a mode layer yields to an editable target (inline rename inside a maximized panel)", () => {
    expect(layerToDismiss([layer("maximize", "mode")], true)).toBeNull();
  });

  it("dialogs and menus do not yield to editable targets (Escape in a dialog textarea cancels)", () => {
    expect(layerToDismiss([layer("d", "dialog")], true)?.id).toBe("d");
    expect(layerToDismiss([layer("m", "menu")], true)?.id).toBe("m");
  });
});
