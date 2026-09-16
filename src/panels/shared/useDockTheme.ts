import { useMemo } from "react";
import type { DockviewTheme } from "dockview-react";
import { PANEL_GAP_MAX, useSettingsStore } from "../../store/settings";

/**
 * The dockview theme both docks share: the abyss class stays as the
 * structural base (global.css maps its `--dv-*` variables onto LeGit
 * tokens), and the user's panel-gap setting flows into dockview's own
 * `gap` (spacing between panel groups; dockview relayouts live on change).
 * The matching corner radius is CSS (`--legit-panel-radius`, applied by the
 * settings store).
 */
export function useDockTheme(): DockviewTheme {
  const gap = useSettingsStore((s) => s.settings?.panel_gap ?? 0);
  return useMemo(
    () => ({
      name: "legit",
      className: "dockview-theme-abyss",
      gap: Math.min(Math.max(gap, 0), PANEL_GAP_MAX),
    }),
    [gap],
  );
}
