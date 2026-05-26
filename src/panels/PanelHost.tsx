import { useCallback, useEffect, useRef } from "react";
import {
  DockviewReact,
  type DockviewApi,
  type DockviewReadyEvent,
} from "dockview-react";
import { useDockviewStore } from "../store/dockview";
import { useSettingsStore } from "../store/settings";
import { useThemeStore } from "../store/themes";
import { validateTheme } from "../theme/validate";
import { DOCKVIEW_COMPONENTS, PANELS } from "./registry";

/**
 * Dock-based panel shell. Restores the persisted layout on mount; persists
 * (debounced) on layout changes. Drag-and-drop import for
 * `.legit-theme.json` files is wired here too (DESIGN.md §6.4).
 */
export function PanelHost() {
  const apiRef = useRef<DockviewApi | null>(null);
  const saveLayoutDebounced = useSettingsStore((s) => s.saveLayoutDebounced);
  const setApi = useDockviewStore((s) => s.setApi);

  const onReady = useCallback(
    (event: DockviewReadyEvent) => {
      apiRef.current = event.api;
      setApi(event.api);

      const persisted = useSettingsStore.getState().settings?.dock_layout;
      let restored = false;
      if (persisted && typeof persisted === "object") {
        try {
          event.api.fromJSON(persisted as any);
          restored = true;
        } catch (e) {
          console.warn("could not restore dock layout, using default", e);
        }
      }
      if (!restored) {
        buildDefaultLayout(event.api);
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
    [saveLayoutDebounced, setApi]
  );

  useEffect(
    () => () => {
      setApi(null);
    },
    [setApi]
  );

  useEffect(() => {
    const handleDrop = async (e: DragEvent) => {
      if (!e.dataTransfer || e.dataTransfer.files.length === 0) return;
      const files = Array.from(e.dataTransfer.files).filter((f) =>
        f.name.toLowerCase().endsWith(".legit-theme.json")
      );
      if (files.length === 0) return;
      e.preventDefault();
      for (const file of files) {
        try {
          const text = await file.text();
          const json = JSON.parse(text);
          const result = validateTheme(json);
          if (!result.ok) {
            window.alert(
              `Cannot import ${file.name}:\n` +
                result.errors.map((er) => `  ${er.field}: ${er.message}`).join("\n")
            );
            continue;
          }
          await useThemeStore.getState().importThemeFromJson(json, file.name.replace(/\.legit-theme\.json$/i, ""));
        } catch (err) {
          window.alert(`Failed to import ${file.name}: ${(err as Error).message}`);
        }
      }
    };
    const handleDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes("Files")) {
        e.preventDefault();
      }
    };
    window.addEventListener("drop", handleDrop);
    window.addEventListener("dragover", handleDragOver);
    return () => {
      window.removeEventListener("drop", handleDrop);
      window.removeEventListener("dragover", handleDragOver);
    };
  }, []);

  return (
    <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
      <DockviewReact
        components={DOCKVIEW_COMPONENTS}
        onReady={onReady}
        className="dockview-theme-abyss"
      />
    </div>
  );
}

function buildDefaultLayout(api: DockviewApi) {
  api.addPanel({
    id: "repositories",
    component: "repositories",
    title: "Repositories",
  });
  api.addPanel({
    id: "console",
    component: "console",
    title: "Git Console",
    position: { referencePanel: "repositories", direction: "right" },
  });
  api.addPanel({
    id: "theme-editor",
    component: "theme-editor",
    title: "Theme Editor",
    position: { referencePanel: "console", direction: "below" },
  });
  api.addPanel({
    id: "settings",
    component: "settings",
    title: "Settings",
    position: { referencePanel: "theme-editor", direction: "within" },
  });
}

export function openPanel(api: DockviewApi | null, id: string) {
  if (!api) return;
  const desc = PANELS.find((p) => p.id === id);
  if (!desc) return;
  const existing = api.getPanel(id);
  if (existing) {
    existing.focus();
    return;
  }
  api.addPanel({ id: desc.id, component: desc.id, title: desc.title });
}
