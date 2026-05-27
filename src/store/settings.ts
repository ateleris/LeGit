import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { getGlobalSettings, saveGlobalLayout, saveRepoLayout } from "../lib/commands";
import type { GlobalSettings, RegionPlacement } from "../lib/types";

interface SettingsStore {
  settings: GlobalSettings | null;
  init: () => Promise<void>;
  saveGlobalLayoutDebounced: (layout: unknown) => void;
  saveRepoLayoutDebounced: (layout: unknown) => void;
  setRegionPlacement: (placement: RegionPlacement) => Promise<void>;
}

let globalLayoutTimer: ReturnType<typeof setTimeout> | null = null;
let repoLayoutTimer: ReturnType<typeof setTimeout> | null = null;

export const useSettingsStore = create<SettingsStore>((set, get) => ({
  settings: null,

  async init() {
    if (get().settings) return;
    const settings = await getGlobalSettings();
    set({ settings });
  },

  saveGlobalLayoutDebounced(layout: unknown) {
    if (globalLayoutTimer) clearTimeout(globalLayoutTimer);
    globalLayoutTimer = setTimeout(() => {
      saveGlobalLayout(layout).catch((e) => {
        console.warn("save_global_layout failed", e);
      });
    }, 500);
  },

  saveRepoLayoutDebounced(layout: unknown) {
    if (repoLayoutTimer) clearTimeout(repoLayoutTimer);
    repoLayoutTimer = setTimeout(() => {
      saveRepoLayout(layout).catch((e) => {
        console.warn("save_repo_layout failed", e);
      });
    }, 500);
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
