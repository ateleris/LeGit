import { create } from "zustand";
import { getSettings, saveLayout } from "../lib/commands";
import type { AppSettings } from "../lib/types";

interface SettingsStore {
  settings: AppSettings | null;
  init: () => Promise<void>;
  saveLayoutDebounced: (layout: unknown) => void;
}

let layoutTimer: ReturnType<typeof setTimeout> | null = null;

export const useSettingsStore = create<SettingsStore>((set, get) => ({
  settings: null,

  async init() {
    if (get().settings) return;
    const settings = await getSettings();
    set({ settings });
  },

  saveLayoutDebounced(layout: unknown) {
    if (layoutTimer) clearTimeout(layoutTimer);
    layoutTimer = setTimeout(() => {
      saveLayout(layout).catch((e) => {
        console.warn("save_layout failed", e);
      });
    }, 500);
  },
}));
