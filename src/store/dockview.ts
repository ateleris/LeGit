import { create } from "zustand";
import type { DockviewApi } from "dockview-react";

interface DockviewStore {
  /** Global dock API (Repositories, Theme Editor, Global Settings). */
  globalApi: DockviewApi | null;
  /** Repo dock API (Console, Repo Settings). */
  repoApi: DockviewApi | null;
  setGlobalApi: (api: DockviewApi | null) => void;
  setRepoApi: (api: DockviewApi | null) => void;
}

export const useDockviewStore = create<DockviewStore>((set) => ({
  globalApi: null,
  repoApi: null,
  setGlobalApi: (globalApi) => set({ globalApi }),
  setRepoApi: (repoApi) => set({ repoApi }),
}));
