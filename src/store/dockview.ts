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

/** Exit focus mode in whichever dock is maximized (the Escape path). */
export function exitMaximizedPanel(): boolean {
  const { globalApi, repoApi } = useDockviewStore.getState();
  return exitMaximized(repoApi, globalApi);
}

/**
 * True when a window-level Escape keydown is "unclaimed" and may exit focus
 * mode. Escape consumers keep it from ever qualifying in one of three ways:
 * preventDefault (InlineRenameInput, RevPicker), stopPropagation on their
 * document-level listeners (confirm dialog, askpass prompt, repo-add menu,
 * lane-lock popover, the Commits quick-jump overlay) - the window listener
 * never sees those - or by being an editable target (inline branch/stash
 * editors, the commit search box), rejected here.
 */
export function isUnclaimedEscape(e: {
  key: string;
  defaultPrevented: boolean;
  target: unknown;
}): boolean {
  if (e.key !== "Escape" || e.defaultPrevented) return false;
  const el = e.target as { tagName?: unknown; isContentEditable?: unknown } | null;
  if (el && typeof el.tagName === "string") {
    if (["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)) return false;
    if (el.isContentEditable === true) return false;
  }
  return true;
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
