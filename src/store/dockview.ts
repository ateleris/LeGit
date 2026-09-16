import { create } from "zustand";
import type { DockviewApi, DockviewGroupPanel } from "dockview-react";
import { useLayersStore } from "./layers";

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

/** Structural subset of `DockviewApi` used by the maximize toggle - kept
 * minimal so the decision logic is unit-testable with fakes (maximize.test.ts). */
export interface MaximizeTarget {
  hasMaximizedGroup(): boolean;
  exitMaximizedGroup(): void;
  readonly activePanel:
    | {
        readonly api: { maximize(): void };
        readonly group: { readonly api: { readonly isVisible: boolean } };
      }
    | undefined;
}

/**
 * Toggle "focus mode" across the two docks: exit whichever dock holds a
 * maximized group; otherwise maximize the primary dock's active panel group.
 * Restoring is otherwise dockview's own behaviour - activating another group
 * (any summon), moving/hiding views, or closing the maximized panel all exit
 * maximize automatically.
 *
 * Guard: never maximize a hidden group (the console group starts collapsed
 * via setVisible(false)) - dockview does not un-hide the maximized node
 * itself, so the whole dock would go blank.
 */
export function toggleMaximize(
  primary: MaximizeTarget | null,
  other: MaximizeTarget | null,
): "exited" | "maximized" | "noop" {
  if (exitMaximized(primary, other)) return "exited";
  const panel = primary?.activePanel;
  if (!panel || !panel.group.api.isVisible) return "noop";
  panel.api.maximize();
  return "maximized";
}

/**
 * Toggle-maximize the active panel of the focused dock (the global dock when
 * DOM focus sits inside its region, else the repo dock). Wired to the
 * Ctrl+Shift+M shortcut (AppLayout) and the View menu.
 */
export function toggleMaximizeActivePanel() {
  const { globalApi, repoApi } = useDockviewStore.getState();
  const focusInGlobal = !!document.activeElement?.closest(".legit-global-region");
  return toggleMaximize(focusInGlobal ? globalApi : repoApi, focusInGlobal ? repoApi : globalApi);
}

/** Exit whichever dock holds a maximized group. Returns whether one exited. */
export function exitMaximized(
  a: Pick<MaximizeTarget, "hasMaximizedGroup" | "exitMaximizedGroup"> | null,
  b: Pick<MaximizeTarget, "hasMaximizedGroup" | "exitMaximizedGroup"> | null,
): boolean {
  for (const dock of [a, b]) {
    if (dock?.hasMaximizedGroup()) {
      dock.exitMaximizedGroup();
      return true;
    }
  }
  return false;
}

/** Structural subset of `DockviewApi` used by the mode-layer wiring - kept
 * minimal so it is unit-testable with fakes (maximize.test.ts). */
export interface MaximizeSource {
  hasMaximizedGroup(): boolean;
  exitMaximizedGroup(): void;
  onDidMaximizedGroupChange(cb: () => void): unknown;
}

/**
 * Keep a "mode" layer on the stack while this dock has a maximized group, so
 * Escape exits focus mode through the key dispatcher (topmost layer first: a
 * menu opened over a maximized panel is popped before the maximize). Covers
 * every exit path - dockview fires the change event also when maximize ends
 * implicitly (activating another group, closing the panel).
 */
export function wireMaximizeModeLayer(api: MaximizeSource, dockId: "global" | "repo"): void {
  const layerId = `maximize:${dockId}`;
  api.onDidMaximizedGroupChange(() => {
    const { push, remove } = useLayersStore.getState();
    if (api.hasMaximizedGroup()) {
      push({ id: layerId, kind: "mode", onDismiss: () => api.exitMaximizedGroup() });
    } else {
      remove(layerId);
    }
  });
}

/**
 * The panel that panel-scoped shortcuts target. DOM focus wins: when focus
 * sits inside a panel's content (the registry wrapper carries
 * `data-panel-id`), that panel is the target even if a summon made another
 * panel the dock's active one (selecting a file summons Diff, but Ctrl+A
 * must keep addressing the focused file list). With focus nowhere specific
 * (body), fall back to the active panel of the dock owning the focus region
 * (the global dock while focus sits in its region, else the repo dock -
 * same rule as toggleMaximizeActivePanel).
 */
export function focusedDockPanelId(): string | null {
  const holder = document.activeElement?.closest("[data-panel-id]");
  const focusedId = holder?.getAttribute("data-panel-id");
  if (focusedId) return focusedId;
  const { globalApi, repoApi } = useDockviewStore.getState();
  const focusInGlobal = !!document.activeElement?.closest(".legit-global-region");
  return (focusInGlobal ? globalApi : repoApi)?.activePanel?.id ?? null;
}

/** Whether either dock currently has a maximized group (View menu label). */
export function hasMaximizedPanel(): boolean {
  const { globalApi, repoApi } = useDockviewStore.getState();
  return !!(repoApi?.hasMaximizedGroup() || globalApi?.hasMaximizedGroup());
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
