// Pure model for the native macOS menu bar (see macAppMenu.ts for the
// tauri wiring). Entries derive from the same panel descriptors as the
// in-app View menu; a menu item carries only its string id across the IPC
// boundary, so actions round-trip through `parseMacMenuAction`.

import { GLOBAL_PANELS, REPO_PANELS } from "../panels/descriptors";

export interface MacMenuEntry {
  actionId: string;
  label: string;
}

/** The dynamic View-menu sections: panels from the registry, layouts by name. */
export function viewMenuEntries(layoutNames: readonly string[]): {
  globalPanels: MacMenuEntry[];
  repoPanels: MacMenuEntry[];
  layouts: MacMenuEntry[];
} {
  return {
    globalPanels: GLOBAL_PANELS.map((p) => ({ actionId: `global:${p.id}`, label: p.title })),
    // summonOnly panels (interactive-rebase) are transient: they exist only
    // while their operation does, so they get no re-open entry (same rule as
    // the in-app View menu).
    repoPanels: REPO_PANELS.filter((p) => !p.summonOnly).map((p) => ({
      actionId: `repo:${p.id}`,
      label: p.title,
    })),
    layouts: layoutNames.map((name) => ({ actionId: `layout:${name}`, label: name })),
  };
}

export type MacMenuAction =
  | { kind: "global-panel"; id: string }
  | { kind: "repo-panel"; id: string }
  | { kind: "layout"; name: string }
  | { kind: "maximize" }
  | { kind: "open-repo" }
  | { kind: "settings" };

/** Action id -> action; null for ids this build doesn't know (stale menu). */
export function parseMacMenuAction(actionId: string): MacMenuAction | null {
  if (actionId === "maximize") return { kind: "maximize" };
  if (actionId === "open-repo") return { kind: "open-repo" };
  if (actionId === "settings") return { kind: "settings" };
  const sep = actionId.indexOf(":");
  if (sep < 0) return null;
  const prefix = actionId.slice(0, sep);
  // Only the first colon separates — layout names may contain colons.
  const rest = actionId.slice(sep + 1);
  if (rest === "") return null;
  if (prefix === "global") return { kind: "global-panel", id: rest };
  if (prefix === "repo") return { kind: "repo-panel", id: rest };
  if (prefix === "layout") return { kind: "layout", name: rest };
  return null;
}
