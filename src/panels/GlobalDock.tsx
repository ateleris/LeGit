import { useCallback, useEffect, useRef } from "react";
import {
  DockviewReact,
  type DockviewApi,
  type DockviewReadyEvent,
} from "dockview-react";
import { useDockviewStore } from "../store/dockview";
import { useSettingsStore } from "../store/settings";
import { GLOBAL_DOCKVIEW_COMPONENTS, GLOBAL_PANELS } from "./registry";

/**
 * Global-scope dockview instance. Hosts Repositories, Theme Editor, and
 * Global Settings. See DESIGN-v0.2.md §C.2 and §F.1.
 */
export function GlobalDock() {
  const setGlobalApi = useDockviewStore((s) => s.setGlobalApi);
  const saveLayoutDebounced = useSettingsStore((s) => s.saveGlobalLayoutDebounced);
  const apiRef = useRef<DockviewApi | null>(null);

  const onReady = useCallback(
    (event: DockviewReadyEvent) => {
      apiRef.current = event.api;
      setGlobalApi(event.api);

      const persisted = useSettingsStore.getState().settings?.global_dock_layout;
      let restored = false;
      if (persisted && typeof persisted === "object") {
        try {
          event.api.fromJSON(persisted as any);
          if (event.api.panels.length > 0) {
            restored = true;
          } else {
            console.warn("global dock layout restored 0 panels, using default");
          }
        } catch (e) {
          console.warn("could not restore global dock layout, using default", e);
        }
      }
      if (!restored) {
        buildDefaultGlobalLayout(event.api);
      }

      event.api.onDidLayoutChange(() => {
        try {
          const json = event.api.toJSON();
          saveLayoutDebounced(json);
        } catch (e) {
          console.warn("toJSON failed", e);
        }
      });
    },
    [saveLayoutDebounced, setGlobalApi]
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
        onReady={onReady}
        className="dockview-theme-abyss"
      />
    </div>
  );
}

function buildDefaultGlobalLayout(api: DockviewApi) {
  api.addPanel({
    id: "repositories",
    component: "repositories",
    title: "Repositories",
  });
  api.addPanel({
    id: "theme-editor",
    component: "theme-editor",
    title: "Theme Editor",
    position: { referencePanel: "repositories", direction: "right" },
  });
  api.addPanel({
    id: "global-settings",
    component: "global-settings",
    title: "Global Settings",
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
