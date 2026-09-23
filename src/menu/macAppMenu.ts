// Native macOS menu bar. macOS always shows a top menu bar; without an
// explicit menu the app gets tauri's generic default, and WebView text
// fields lack working Cmd+C/V (those route through the Edit menu's
// predefined items). Built from the frontend because every action (summon a
// panel, apply a layout) is frontend store logic. No-op on other platforms:
// Windows/Linux keep the in-app menus only.
//
// The menu is rebuilt (a fresh setAsAppMenu) when the saved-layouts list
// changes; panel entries are static per build and summon idempotently
// (focus when already open), so no open-state tracking is needed.

import { Menu, MenuItem, PredefinedMenuItem, Submenu } from "@tauri-apps/api/menu";
import { open as openFolderDialog } from "@tauri-apps/plugin-dialog";
import { formatAppError } from "../lib/errors";
import { summonGlobalPanel } from "../layout/globalSummon";
import { openRepoPanel } from "../panels/RepoDock";
import { toggleMaximizeActivePanel, useDockviewStore } from "../store/dockview";
import { useLayoutsStore } from "../store/layouts";
import { notify } from "../store/notifications";
import { useRepoStore } from "../store/repos";
import { parseMacMenuAction, viewMenuEntries, type MacMenuEntry } from "./macMenuModel";

export function isMacLike(): boolean {
  return typeof navigator !== "undefined" && /Mac/i.test(navigator.userAgent);
}

/** Route a menu item's action id to the same handlers the in-app menus use. */
export async function handleMacMenuAction(actionId: string): Promise<void> {
  const action = parseMacMenuAction(actionId);
  if (!action) return;
  switch (action.kind) {
    case "global-panel":
      summonGlobalPanel(action.id);
      return;
    case "repo-panel":
      // No repo open -> repoApi is null and this no-ops, matching the in-app
      // menu (whose entries do nothing without an active repo).
      openRepoPanel(useDockviewStore.getState().repoApi, action.id);
      return;
    case "layout":
      try {
        await useLayoutsStore.getState().apply(action.name);
      } catch (e) {
        notify.error(formatAppError(e));
      }
      return;
    case "maximize":
      toggleMaximizeActivePanel();
      return;
    case "settings":
      summonGlobalPanel("global-settings");
      return;
    case "open-repo": {
      const selected = await openFolderDialog({ directory: true, multiple: false });
      if (typeof selected !== "string") return;
      try {
        await useRepoStore.getState().openRepo(selected);
      } catch (e) {
        notify.error(formatAppError(e));
      }
      return;
    }
  }
}

const actionItem = (e: MacMenuEntry) =>
  MenuItem.new({ id: e.actionId, text: e.label, action: (id) => void handleMacMenuAction(id) });

const separator = () => PredefinedMenuItem.new({ item: "Separator" });

async function buildAndSetMenu(): Promise<void> {
  const layoutNames = useLayoutsStore.getState().layouts.map((l) => l.name);
  const entries = viewMenuEntries(layoutNames);

  // First submenu = the application menu on macOS (its title is always the
  // app name; the text here is ignored by the system).
  const appMenu = await Submenu.new({
    text: "LeGit",
    items: [
      await PredefinedMenuItem.new({ item: { About: null } }),
      await separator(),
      // Distinct id (not global:global-settings): the View menu lists the
      // same panel, and duplicate item ids in one menu are undefined ground.
      await actionItem({ actionId: "settings", label: "Settings…" }),
      await separator(),
      await PredefinedMenuItem.new({ item: "Services" }),
      await separator(),
      await PredefinedMenuItem.new({ item: "Hide" }),
      await PredefinedMenuItem.new({ item: "HideOthers" }),
      await PredefinedMenuItem.new({ item: "ShowAll" }),
      await separator(),
      await PredefinedMenuItem.new({ item: "Quit" }),
    ],
  });

  const fileMenu = await Submenu.new({
    text: "File",
    items: [
      await actionItem({ actionId: "open-repo", label: "Open Repository…" }),
      await separator(),
      // Clone/Init are forms inside the Repositories panel.
      await actionItem({ actionId: "global:repositories", label: "Repositories" }),
    ],
  });

  // Required for working clipboard/undo shortcuts in WebView text fields.
  const editMenu = await Submenu.new({
    text: "Edit",
    items: [
      await PredefinedMenuItem.new({ item: "Undo" }),
      await PredefinedMenuItem.new({ item: "Redo" }),
      await separator(),
      await PredefinedMenuItem.new({ item: "Cut" }),
      await PredefinedMenuItem.new({ item: "Copy" }),
      await PredefinedMenuItem.new({ item: "Paste" }),
      await PredefinedMenuItem.new({ item: "SelectAll" }),
    ],
  });

  const viewItems = [
    ...(await Promise.all(entries.globalPanels.map(actionItem))),
    await separator(),
    ...(await Promise.all(entries.repoPanels.map(actionItem))),
  ];
  if (entries.layouts.length > 0) {
    viewItems.push(await separator());
    viewItems.push(...(await Promise.all(entries.layouts.map(actionItem))));
  }
  viewItems.push(await separator());
  viewItems.push(await actionItem({ actionId: "maximize", label: "Toggle Maximized Panel" }));
  const viewMenu = await Submenu.new({ text: "View", items: viewItems });

  const windowMenu = await Submenu.new({
    text: "Window",
    items: [
      await PredefinedMenuItem.new({ item: "Minimize" }),
      await PredefinedMenuItem.new({ item: "Maximize" }),
      await PredefinedMenuItem.new({ item: "Fullscreen" }),
      await separator(),
      await PredefinedMenuItem.new({ item: "CloseWindow" }),
    ],
  });

  const menu = await Menu.new({ items: [appMenu, fileMenu, editMenu, viewMenu, windowMenu] });
  await menu.setAsAppMenu();
}

let installed = false;

/** Install the native menu bar (macOS only; call once at app start). */
export async function installMacAppMenu(): Promise<void> {
  if (!isMacLike() || installed) return;
  installed = true;
  try {
    await buildAndSetMenu();
  } catch (e) {
    console.warn("could not install the macOS app menu", e);
    return;
  }
  // Rebuild when the saved-layouts NAMES change (rename/add/remove) — other
  // layouts-store churn (lastApplied, dirty flags) doesn't affect the menu.
  let prevNames = JSON.stringify(useLayoutsStore.getState().layouts.map((l) => l.name));
  useLayoutsStore.subscribe((s) => {
    const names = JSON.stringify(s.layouts.map((l) => l.name));
    if (names === prevNames) return;
    prevNames = names;
    void buildAndSetMenu().catch((e) => console.warn("could not rebuild the macOS app menu", e));
  });
}
