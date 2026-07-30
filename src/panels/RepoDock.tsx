import { useCallback, useEffect, useRef } from "react";
import {
  DockviewReact,
  type DockviewApi,
  type DockviewReadyEvent,
} from "dockview-react";
import { applyPanelConstraints, useDockviewStore } from "../store/dockview";
import { useThemeStore } from "../store/themes";
import { useSummonStore } from "../store/summon";
import { validateTheme } from "../theme/validate";
import { REPO_DOCKVIEW_COMPONENTS, REPO_DOCKVIEW_TAB_COMPONENTS, REPO_PANELS } from "./registry";
import { applyBakedRepoLayout, applyRepoLayoutEnvelope, capturePlacements, parseRepoLayoutEnvelope } from "./layoutSnapshot";

const LAYOUT_KEY = "legit.repo-dock-layout";
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function persistLayout(data: unknown) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(data)); } catch { /* quota */ }
  }, 300);
}

/**
 * Repo-scope dockview instance. Hosts the Git Console and Repo Settings.
 * See DESIGN-v0.2.md §C.2 and §F.1.
 *
 * Drop-target for `.legit-theme.json` files (same as v0.1 PanelHost).
 */
export function RepoDock() {
  const setRepoApi = useDockviewStore((s) => s.setRepoApi);
  const apiRef = useRef<DockviewApi | null>(null);

  const onReady = useCallback(
    (event: DockviewReadyEvent) => {
      apiRef.current = event.api;
      setRepoApi(event.api);

      // Envelope format: { dockview: <layout>, placements: <map>, fallbacks: <map> }
      const envelope = parseRepoLayoutEnvelope(localStorage.getItem(LAYOUT_KEY));
      const restored = envelope !== null && applyRepoLayoutEnvelope(event.api, envelope);
      if (!restored) {
        if (envelope !== null) {
          console.warn("could not restore repo dock layout, using default");
        }
        // First launch (or broken persisted layout): the baked-in default,
        // with the programmatic builder as last resort.
        if (!applyBakedRepoLayout(event.api)) {
          buildDefaultRepoLayout(event.api);
          // Capture initial placements immediately so summon works before the
          // first layout-change event fires (the restore path does this itself).
          capturePlacements(event.api);
          // Enforce the panel minimum width on existing and future groups.
          applyPanelConstraints(event.api);
        }
      }

      event.api.onDidLayoutChange(() => {
        try {
          const dockview = event.api.toJSON();
          capturePlacements(event.api, dockview);
          persistLayout({
            dockview,
            placements: useSummonStore.getState().placements,
            fallbacks: useSummonStore.getState().fallbackPositions,
          });
        } catch { /* ignore */ }
      });
    },
    [setRepoApi]
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
        tabComponents={REPO_DOCKVIEW_TAB_COMPONENTS}
        onReady={onReady}
        className="dockview-theme-abyss"
      />
    </div>
  );
}

/** First-launch repo layout; also the fallback for "Reset to default layout"
 * when no saved snapshot exists (ViewMenu). */
export function buildDefaultRepoLayout(api: DockviewApi) {
  api.addPanel({ id: "log", component: "log", title: "Commits" });
  api.addPanel({
    id: "commit-details",
    component: "commit-details",
    title: "Commit Details",
    position: { referencePanel: "log", direction: "right" },
  });
  const consolePanel = api.addPanel({
    id: "console",
    component: "console",
    title: "Git Console",
    position: { referencePanel: "log", direction: "below" },
  });
  api.addPanel({
    id: "repo-settings",
    component: "repo-settings",
    tabComponent: "confirm-close",
    title: "Repo Settings",
    position: { referencePanel: "console", direction: "within" },
  });
  // Collapse the bottom group (console + repo-settings) on first launch.
  // Users can expand it by dragging the sash or opening a panel via the menu.
  // Existing saved layouts are NOT affected — they restore from localStorage.
  consolePanel.group.api.setVisible(false);
}

/** Open or focus a repo panel by id. */
export function openRepoPanel(api: DockviewApi | null, id: string) {
  if (!api) return;
  const desc = REPO_PANELS.find((p) => p.id === id);
  if (!desc) return;
  const existing = api.getPanel(id);
  if (existing) {
    // A panel can live in a hidden group (the console group starts collapsed
    // via setVisible(false)); focus alone would not reveal it.
    if (!existing.group.api.isVisible) existing.group.api.setVisible(true);
    existing.focus();
    return;
  }
  // Without an explicit position dockview adds to the ACTIVE group, which on
  // a fresh layout can be the hidden console group — the panel would open
  // invisibly. Use the descriptor's default placement (guarding against its
  // reference panel being closed), mirroring summon()'s fallback.
  const placement = desc.defaultPlacement;
  const refOpen = placement?.referencePanel ? !!api.getPanel(placement.referencePanel) : false;
  api.addPanel({
    id: desc.id,
    component: desc.id,
    title: desc.title,
    position: placement
      ? refOpen
        ? { referencePanel: placement.referencePanel!, direction: placement.direction }
        : { direction: placement.direction }
      : undefined,
  });
}
