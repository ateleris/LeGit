import { useEffect } from "react";
import { focusedDockPanelId } from "../store/dockview";
import { useLayersStore, layerToDismiss, type Layer } from "../store/layers";
import { useRepoStore } from "../store/repos";
import { eventChordCandidates, isEditableTarget, PLATFORM, type Platform } from "./chord";
import { useKeymapStore } from "./keymap";
import { initKeymap } from "./persistence";
import { trackRepoActivations } from "./repoTabCycle";
import { COMMANDS, type Command, type KeyContext } from "./registry";
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
    const layers = deps.getLayers();
    if (layers[layers.length - 1]?.kind === "capture") return;

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

    const ctx = deps.getContext();
    // A keydown may match several stored spellings ("Mod+Tab" matches a
    // "Ctrl+Tab" binding; Windows AltGr composition maps back to the
    // physical key); the first spelling that resolves wins.
    for (const candidate of eventChordCandidates(e, deps.platform)) {
      const cmd = resolve(candidate, {
        commands: deps.commands,
        byChord: deps.getByChord(),
        layers: deps.getLayers(),
        focusPanel: ctx.focusPanel,
        repoActive: ctx.repoActive,
        editableTarget: editable,
      });
      if (!cmd) continue;
      // Widget-handled: the chord belongs to a focused widget's own listener
      // (e.g. the stage toggle in a file list) - stand down entirely.
      if (cmd.handledBy === "widget") return;
      if (cmd.when && !cmd.when(ctx)) continue;
      e.preventDefault();
      e.stopPropagation();
      cmd.run(ctx);
      return;
    }
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
      focusPanel: focusedDockPanelId(),
    }),
    platform: PLATFORM,
  };
}

/** Mounted once in AppLayout. */
export function KeyDispatcher() {
  useEffect(() => {
    void initKeymap();
    const untrack = trackRepoActivations();
    const handler = createKeydownHandler(productionDeps());
    window.addEventListener("keydown", handler, true);
    return () => {
      window.removeEventListener("keydown", handler, true);
      untrack();
    };
    // COMMANDS is constant in production; as a dep it makes dev hot reloads
    // of the registry rewire the live listener (a stale mount effect
    // otherwise keeps dispatching the old command set until a full reload).
  }, [COMMANDS]);
  return null;
}
