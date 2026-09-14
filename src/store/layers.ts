import { useEffect, useId, useRef } from "react";
import { create } from "zustand";

/**
 * The overlay layer stack (design/2026-08-24-keyboard-shortcuts-system.md §3).
 * Every dismissable surface pushes a layer while open; the key dispatcher pops
 * exactly the topmost one on Escape. "dialog" and "menu" layers block command
 * resolution below them; "popover" (incl. hover flyouts) and "mode" (e.g. a
 * maximized panel) do not.
 */
export type LayerKind = "dialog" | "menu" | "popover" | "mode";

export interface Layer {
  id: string;
  kind: LayerKind;
  onDismiss: () => void;
}

interface LayersStore {
  layers: Layer[];
  push: (layer: Layer) => void;
  remove: (id: string) => void;
}

export const useLayersStore = create<LayersStore>((set) => ({
  layers: [],
  push: (layer) =>
    set((s) => ({ layers: [...s.layers.filter((l) => l.id !== layer.id), layer] })),
  remove: (id) => set((s) => ({ layers: s.layers.filter((l) => l.id !== id) })),
}));

export function topLayer(layers: readonly Layer[]): Layer | null {
  return layers.length > 0 ? layers[layers.length - 1] : null;
}

export function hasBlockingLayer(layers: readonly Layer[]): boolean {
  return layers.some((l) => l.kind === "dialog" || l.kind === "menu");
}

/**
 * Declarative layer membership for a component: on the stack while `active`,
 * dismissed through the latest `onDismiss`. Used by dialogs/prompts and mode
 * overlays; dropdowns go through useDismissable (which adds click-outside).
 */
export function useLayer(active: boolean, kind: LayerKind, onDismiss: () => void): void {
  const id = useId();
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;
  useEffect(() => {
    if (!active) return;
    const { push, remove } = useLayersStore.getState();
    push({ id, kind, onDismiss: () => onDismissRef.current() });
    return () => remove(id);
  }, [active, kind, id]);
}

/**
 * Which layer an Escape keydown should dismiss, if any. A "mode" layer yields
 * to an editable target (Escape in an inline rename inside a maximized panel
 * cancels the rename, not the maximize); dialogs, menus and popovers do not
 * (Escape in a dialog's textarea cancels the dialog - the pre-stack behaviour).
 */
export function layerToDismiss(
  layers: readonly Layer[],
  editableTarget: boolean,
): Layer | null {
  const top = topLayer(layers);
  if (!top) return null;
  if (top.kind === "mode" && editableTarget) return null;
  return top;
}
