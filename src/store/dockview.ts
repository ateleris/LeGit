import { create } from "zustand";
import type { DockviewApi, DockviewGroupPanel } from "dockview-react";

/** Minimum width (px) every dockview panel/group is constrained to. Overrides
 * dockview's 100px default. */
export const PANEL_MIN_WIDTH = 300;

/**
 * Constrain every current and future group in a dock to `PANEL_MIN_WIDTH`.
 * Dockview has no global default-constraint option, so we apply it per group:
 * existing groups now, and new ones (created by summon/split) via `onDidAddGroup`.
 * Call once in each dock's `onReady`, after the initial layout is built.
 */
export function applyPanelConstraints(api: DockviewApi) {
  const apply = (group: DockviewGroupPanel) =>
    group.api.setConstraints({ minimumWidth: PANEL_MIN_WIDTH });
  api.groups.forEach(apply);
  api.onDidAddGroup(apply);
}

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
