import { create } from "zustand";
import type { DockviewApi } from "dockview-react";

interface DockviewStore {
  api: DockviewApi | null;
  setApi: (api: DockviewApi | null) => void;
}

/** Exposes the live `DockviewApi` to anything outside the PanelHost — e.g.,
 *  the View menu in the top bar. Set by `PanelHost` on dockview ready. */
export const useDockviewStore = create<DockviewStore>((set) => ({
  api: null,
  setApi: (api) => set({ api }),
}));
