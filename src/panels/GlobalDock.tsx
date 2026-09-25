import { useCallback, useEffect, useRef } from "react";
import {
  DockviewReact,
  type DockviewApi,
  type DockviewReadyEvent,
} from "dockview-react";
import { applyPanelConstraints, useDockviewStore, wireMaximizeModeLayer } from "../store/dockview";
import { useLayoutsStore } from "../store/layouts";
import { GLOBAL_DOCKVIEW_COMPONENTS, GLOBAL_DOCKVIEW_TAB_COMPONENTS } from "./registry";
import { applyBakedGlobalLayout, applyGlobalLayoutJson } from "../layout/layoutSnapshot";
import { buildDefaultGlobalLayout } from "../layout/defaultLayouts";
import { deliverPendingGlobalSummon } from "../layout/globalSummon";
import { DockWatermark } from "./shared/DockWatermark";
import { useDockTheme } from "./shared/useDockTheme";

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
      wireMaximizeModeLayer(event.api, "global");
    },
    []
  );

  useEffect(
    () => () => {
      setGlobalApi(null);
    },
    [setGlobalApi]
  );

  const dockTheme = useDockTheme();
  return (
    <div className="legit-dock" style={{ height: "100%", position: "relative" }}>
      <DockviewReact
        components={GLOBAL_DOCKVIEW_COMPONENTS}
        tabComponents={GLOBAL_DOCKVIEW_TAB_COMPONENTS}
        watermarkComponent={DockWatermark}
        onReady={onReady}
        theme={dockTheme}
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
    // The docks no longer match a saved layout once they change.
    useLayoutsStore.getState().noteDockLayoutChanged();
  });

  deliverPendingGlobalSummon(api);

  // Last: the dock is fully initialized - only now publish the api.
  useDockviewStore.getState().setGlobalApi(api);
}

