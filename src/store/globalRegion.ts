import { create } from "zustand";

interface GlobalRegionStore {
  collapsed: boolean;
  setCollapsed: (collapsed: boolean) => void;
}

export const useGlobalRegionStore = create<GlobalRegionStore>((set) => ({
  collapsed: false,
  setCollapsed: (collapsed) => set({ collapsed }),
}));
