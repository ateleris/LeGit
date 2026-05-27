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
import { REPO_DOCKVIEW_COMPONENTS, REPO_PANELS } from "./registry";

/**
 * Repo-scope dockview instance. Hosts the Git Console and Repo Settings.
 * See DESIGN-v0.2.md §C.2 and §F.1.
 *
 * Drop-target for `.legit-theme.json` files (same as v0.1 PanelHost).
 */
export function RepoDock() {
  const setRepoApi = useDockviewStore((s) => s.setRepoApi);
  const saveLayoutDebounced = useSettingsStore((s) => s.saveRepoLayoutDebounced);
  const apiRef = useRef<DockviewApi | null>(null);

  const onReady = useCallback(
    (event: DockviewReadyEvent) => {
      apiRef.current = event.api;
      setRepoApi(event.api);

      const persisted = useSettingsStore.getState().settings?.repo_dock_layout;
      let restored = false;
      if (persisted && typeof persisted === "object") {
        try {
          event.api.fromJSON(persisted as any);
          if (event.api.panels.length > 0) {
            restored = true;
          } else {
            console.warn("repo dock layout restored 0 panels, using default");
          }
        } catch (e) {
          console.warn("could not restore repo dock layout, using default", e);
        }
      }
      if (!restored) {
        buildDefaultRepoLayout(event.api);
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
    [saveLayoutDebounced, setRepoApi]
  );

  useEffect(
    () => () => {
      setRepoApi(null);
    },
    [setRepoApi]
  );

  // Theme drag-and-drop (same behaviour as v0.1).
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
          await useThemeStore
            .getState()
            .importThemeFromJson(json, file.name.replace(/\.legit-theme\.json$/i, ""));
        } catch (err) {
          window.alert(`Failed to import ${file.name}: ${(err as Error).message}`);
        }
      }
    };
    const handleDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
    };
    window.addEventListener("drop", handleDrop);
    window.addEventListener("dragover", handleDragOver);
    return () => {
      window.removeEventListener("drop", handleDrop);
      window.removeEventListener("dragover", handleDragOver);
    };
  }, []);

  return (
    <div style={{ height: "100%", position: "relative" }}>
      <DockviewReact
        components={REPO_DOCKVIEW_COMPONENTS}
        onReady={onReady}
        className="dockview-theme-abyss"
      />
    </div>
  );
}

function buildDefaultRepoLayout(api: DockviewApi) {
  api.addPanel({
    id: "console",
    component: "console",
    title: "Git Console",
  });
  api.addPanel({
    id: "repo-settings",
    component: "repo-settings",
    title: "Repo Settings",
    position: { referencePanel: "console", direction: "right" },
  });
}

/** Open or focus a repo panel by id. */
export function openRepoPanel(api: DockviewApi | null, id: string) {
  if (!api) return;
  const desc = REPO_PANELS.find((p) => p.id === id);
  if (!desc) return;
  const existing = api.getPanel(id);
  if (existing) {
    existing.focus();
    return;
  }
  api.addPanel({ id: desc.id, component: desc.id, title: desc.title });
}
