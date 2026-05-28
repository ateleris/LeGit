import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { getGlobalSettings } from "../lib/commands";
import type { GlobalSettings, RegionPlacement } from "../lib/types";

interface SettingsStore {
  settings: GlobalSettings | null;
  init: () => Promise<void>;
  setRegionPlacement: (placement: RegionPlacement) => Promise<void>;
}

export const useSettingsStore = create<SettingsStore>((set, get) => ({
  settings: null,

  async init() {
    if (get().settings) return;
    const settings = await getGlobalSettings();
    set({ settings });
  },

  async setRegionPlacement(placement: RegionPlacement) {
    const s = get().settings;
    await invoke("save_region_state", {
      placement,
      sizeTop: s?.global_region_size_top ?? null,
      sizeLeft: s?.global_region_size_left ?? null,
      collapsed: s?.global_dock_collapsed ?? false,
    });
    if (s) {
      set({ settings: { ...s, global_region_placement: placement } });
    }
  },
}));
