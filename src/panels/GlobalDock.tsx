import { useCallback, useEffect, useRef } from "react";
import {
  DockviewReact,
  type DockviewApi,
  type DockviewReadyEvent,
} from "dockview-react";
import { applyPanelConstraints, useDockviewStore } from "../store/dockview";
import { useGlobalRegionStore } from "../store/globalRegion";
import { GLOBAL_DOCKVIEW_COMPONENTS, GLOBAL_DOCKVIEW_TAB_COMPONENTS, GLOBAL_PANELS, PANEL_TITLES } from "./registry";
import { applyBakedGlobalLayout, applyGlobalLayoutJson } from "./layoutSnapshot";
import { DockWatermark } from "./shared/DockWatermark";

const LAYOUT_KEY = "legit.global-dock-layout";
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function persistLayout(data: unknown) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(data)); } catch { /* quota */ }
  }, 300);
}

/**
 * Global-scope dockview instance. Hosts Repositories, Theme Editor, and
 * Global Settings. See DESIGN-v0.2.md §C.2 and §F.1.
 */
export function GlobalDock() {
  const setGlobalApi = useDockviewStore((s) => s.setGlobalApi);
  const apiRef = useRef<DockviewApi | null>(null);

  const onReady = useCallback(
    (event: DockviewReadyEvent) => {
      apiRef.current = event.api;
      readyGlobalDock(event.api);
    },
    []
  );

  useEffect(
    () => () => {
      setGlobalApi(null);
    },
    [setGlobalApi]
  );

  return (
    <div style={{ height: "100%", position: "relative" }}>
      <DockviewReact
        components={GLOBAL_DOCKVIEW_COMPONENTS}
        tabComponents={GLOBAL_DOCKVIEW_TAB_COMPONENTS}
        watermarkComponent={DockWatermark}
        onReady={onReady}
        className="dockview-theme-abyss"
      />
    </div>
  );
}

/**
 * Restore the dock's persisted layout (or build the default), THEN register
 * the api. The order is load-bearing: registering publishes the api to
 * pending summons (summonGlobalPanel), which then act on the dock - if that
 * happened before the restore, the summoned panel would be added to an empty
 * dock and immediately wiped or buried by fromJSON replacing the layout.
 * Extracted from the component so the sequencing is unit-testable.
 */
export function readyGlobalDock(api: DockviewApi) {
  let restored = false;
  const raw = localStorage.getItem(LAYOUT_KEY);
  if (raw) {
    try {
      // Sanitized apply: retired panels in a stale layout are pruned
      // instead of blowing up fromJSON.
      restored = applyGlobalLayoutJson(api, JSON.parse(raw));
    } catch (e) {
      console.warn("could not restore global dock layout, using default", e);
    }
    if (!restored) {
      console.warn("global dock layout not restorable, using default");
    }
  }
  if (!restored) {
    // First launch (or broken persisted layout): the baked-in default,
    // with the programmatic builder as last resort.
    if (!applyBakedGlobalLayout(api)) {
      buildDefaultGlobalLayout(api);
    }
  }

  // Enforce the panel minimum width on existing and future groups.
  applyPanelConstraints(api);

  api.onDidLayoutChange(() => {
    try { persistLayout(api.toJSON()); } catch { /* ignore */ }
  });

  // Deliver a summon that was waiting for this mount. Deliberately NOT
  // cleared here but on a microtask: in dev, React StrictMode mounts
  // DockviewReact twice back-to-back (mount, dispose, remount) within one
  // task, and only the second instance survives - a summon consumed by the
  // first mount alone never reached the dock the user sees. Every mount in
  // the current task replays it (focus is idempotent); afterwards it is
  // spent, so a later manual collapse/expand does not replay it.
  if (pendingSummon !== null) {
    const target = pendingSummon;
    queueMicrotask(() => {
      if (pendingSummon === target) pendingSummon = null;
    });
    openGlobalPanel(api, target);
  }

  // Last: the dock is fully initialized - only now publish the api.
  useDockviewStore.getState().setGlobalApi(api);
}

/** First-launch global layout; also the fallback for "Reset to default layout"
 * when no saved snapshot exists (ViewMenu). */
export function buildDefaultGlobalLayout(api: DockviewApi) {
  api.addPanel({
    id: "repositories",
    component: "repositories",
    title: PANEL_TITLES["repositories"],
  });
  api.addPanel({
    id: "theme-editor",
    component: "theme-editor",
    title: PANEL_TITLES["theme-editor"],
    position: { referencePanel: "repositories", direction: "right" },
  });
  api.addPanel({
    id: "global-settings",
    component: "global-settings",
    tabComponent: "confirm-close",
    title: PANEL_TITLES["global-settings"],
    position: { referencePanel: "theme-editor", direction: "within" },
  });
}

/** Panel waiting for the global dock to mount (region was collapsed when it
 *  was summoned). Only the latest summon is kept - the last click wins. */
let pendingSummon: string | null = null;

/**
 * Open or focus a global panel, expanding the global region first if it is
 * collapsed. A collapsed region has NO mounted GlobalDock (AppLayout renders
 * it conditionally), so `globalApi` is null and a plain `openGlobalPanel`
 * would be a silent no-op - exactly what the View menu must not do. The
 * summon uncollapses (via the globalRegion store AppLayout subscribes to)
 * and the freshly mounted dock delivers the summon in readyGlobalDock.
 */
export function summonGlobalPanel(id: string) {
  useGlobalRegionStore.getState().setCollapsed(false);
  const api = useDockviewStore.getState().globalApi;
  if (api) {
    openGlobalPanel(api, id);
    return;
  }
  pendingSummon = id;
}

/** Open or focus a global panel by id. */
export function openGlobalPanel(api: DockviewApi | null, id: string) {
  if (!api) return;
  const desc = GLOBAL_PANELS.find((p) => p.id === id);
  if (!desc) return;
  const existing = api.getPanel(id);
  if (existing) {
    existing.focus();
    return;
  }
  api.addPanel({ id: desc.id, component: desc.id, title: desc.title });
}
