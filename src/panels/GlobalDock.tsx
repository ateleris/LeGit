import { useCallback, useEffect, useRef } from "react";
import {
  DockviewReact,
  type DockviewApi,
  type DockviewReadyEvent,
} from "dockview-react";
import { applyPanelConstraints, useDockviewStore } from "../store/dockview";
import { GLOBAL_DOCKVIEW_COMPONENTS, GLOBAL_DOCKVIEW_TAB_COMPONENTS, GLOBAL_PANELS, PANEL_TITLES } from "./registry";
import { applyBakedGlobalLayout, applyGlobalLayoutJson } from "./layoutSnapshot";

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
      setGlobalApi(event.api);

      let restored = false;
      const raw = localStorage.getItem(LAYOUT_KEY);
      if (raw) {
        try {
          // Sanitized apply: retired panels in a stale layout are pruned
          // instead of blowing up fromJSON.
          restored = applyGlobalLayoutJson(event.api, JSON.parse(raw));
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
        if (!applyBakedGlobalLayout(event.api)) {
          buildDefaultGlobalLayout(event.api);
        }
      }

      // Enforce the panel minimum width on existing and future groups.
      applyPanelConstraints(event.api);

      event.api.onDidLayoutChange(() => {
        try { persistLayout(event.api.toJSON()); } catch { /* ignore */ }
      });
    },
    [setGlobalApi]
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
        onReady={onReady}
        className="dockview-theme-abyss"
      />
    </div>
  );
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
