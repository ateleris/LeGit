import { useEffect } from "react";
import { useLayersStore, layerToDismiss, type Layer } from "../store/layers";
import { useRepoStore } from "../store/repos";
import { eventToChord, isEditableTarget, PLATFORM, type Platform } from "./chord";
import { useKeymapStore } from "./keymap";
import { COMMANDS, defaultKeymap, type Command, type KeyContext } from "./registry";
import { resolve } from "./resolve";

/**
 * The single keydown arbitration point
 * (design/2026-08-24-keyboard-shortcuts-system.md §3): one window-level
 * capture-phase listener, mounted once. Escape pops the topmost layer; every
 * other keydown resolves against the keymap. THE LOAD-BEARING RULE: the event
 * is cancelled only when a layer was popped or a command actually dispatched -
 * every non-match passes through completely untouched, which is what protects
 * all focus-local key handling (forms, type-to-jump, CodeMirror) at once.
 */

export interface DispatcherDeps {
  commands: readonly Command[];
  getByChord: () => ReadonlyMap<string, readonly string[]>;
  getLayers: () => readonly Layer[];
  removeLayer: (id: string) => void;
  getContext: () => KeyContext;
  platform: Platform;
}

export function createKeydownHandler(deps: DispatcherDeps): (e: KeyboardEvent) => void {
  return (e: KeyboardEvent) => {
    const editable = isEditableTarget(e.target);

    if (e.key === "Escape") {
      const target = layerToDismiss(deps.getLayers(), editable);
      if (!target) return;
      e.preventDefault();
      e.stopPropagation();
      deps.removeLayer(target.id);
      target.onDismiss();
      return;
    }

    const chord = eventToChord(e, deps.platform);
    if (!chord) return;
    const ctx = deps.getContext();
    const cmd = resolve(chord, {
      commands: deps.commands,
      byChord: deps.getByChord(),
      layers: deps.getLayers(),
      focusPanel: ctx.focusPanel,
      repoActive: ctx.repoActive,
      editableTarget: editable,
    });
    if (!cmd) return;
    if (cmd.when && !cmd.when(ctx)) return;
    e.preventDefault();
    e.stopPropagation();
    cmd.run(ctx);
  };
}

function productionDeps(): DispatcherDeps {
  return {
    commands: COMMANDS,
    getByChord: () => useKeymapStore.getState().byChord,
    getLayers: () => useLayersStore.getState().layers,
    removeLayer: (id) => useLayersStore.getState().remove(id),
    getContext: () => ({
      repoActive: useRepoStore.getState().activeRepoId !== null,
      // Panel-scoped commands need focus tracking (phase 3); until then no
      // command declares a panel scope, so null is never consulted.
      focusPanel: null,
    }),
    platform: PLATFORM,
  };
}

/** Mounted once in AppLayout. */
export function KeyDispatcher() {
  useEffect(() => {
    useKeymapStore.getState().reset(defaultKeymap());
    const handler = createKeydownHandler(productionDeps());
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, []);
  return null;
}
