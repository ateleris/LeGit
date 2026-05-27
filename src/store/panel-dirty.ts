import { create } from "zustand";

interface PanelDirtyStore {
  dirty: Record<string, boolean>;
  setDirty: (panelId: string, isDirty: boolean) => void;
}

export const usePanelDirtyStore = create<PanelDirtyStore>((set) => ({
  dirty: {},
  setDirty(panelId, isDirty) {
    set((s) => ({ dirty: { ...s.dirty, [panelId]: isDirty } }));
  },
}));
