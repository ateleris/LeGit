import { create } from "zustand";
import type { DockviewApi, DockviewGroupPanel } from "dockview-react";

/** Panel min width/height as multiples of the base UI font size — so they scale
 * with it. At the default 12px base these give 300×96, overriding dockview's
 * 100px default. */
const MIN_WIDTH_EM = 25;
const MIN_HEIGHT_EM = 8;

const FALLBACK_FONT = 12;

/** Current base UI font size in px, read from the `--ui-font-size` CSS var (set
 * by the settings store). Avoids a settings↔dockview import cycle. */
function baseFontSize(): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--ui-font-size");
  const v = parseFloat(raw);
  return Number.isFinite(v) && v > 0 ? v : FALLBACK_FONT;
}

/** Panel minimum width (px), derived from the base font size. */
export function panelMinWidth(): number {
  return Math.round(baseFontSize() * MIN_WIDTH_EM);
}

function panelMinHeight(): number {
  return Math.round(baseFontSize() * MIN_HEIGHT_EM);
}

/**
 * Constrain every current and future group in a dock to the font-derived panel
 * minimum size. Dockview has no global default-constraint option, so we apply
 * it per group: existing groups now, and new ones (created by summon/split) via
 * `onDidAddGroup`. Call once in each dock's `onReady`, after the layout is built.
 */
export function applyPanelConstraints(api: DockviewApi) {
  const constraints = { minimumWidth: panelMinWidth(), minimumHeight: panelMinHeight() };
  const apply = (group: DockviewGroupPanel) => group.api.setConstraints(constraints);
  api.groups.forEach(apply);
  api.onDidAddGroup(apply);
}

/** Re-apply constraints to all groups in both docks. Call after the base font
 * size changes so the (now stale) minimums are recomputed. */
export function reapplyPanelConstraints() {
  const constraints = { minimumWidth: panelMinWidth(), minimumHeight: panelMinHeight() };
  const { globalApi, repoApi } = useDockviewStore.getState();
  for (const api of [globalApi, repoApi]) {
    if (api) api.groups.forEach((g) => g.api.setConstraints(constraints));
  }
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
