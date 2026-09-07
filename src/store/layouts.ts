import { create } from "zustand";
import {
  deleteLayout as deleteLayoutCmd,
  listLayouts,
  loadLayout,
  renameLayout as renameLayoutCmd,
  saveLayout as saveLayoutCmd,
} from "../lib/commands";
import type { LayoutDocument, LayoutEntry } from "../lib/types";
import {
  applyLayoutDocument,
  asLayoutDocument,
  captureLayoutDocument,
  chooseUniqueName,
  migrateLegacyDefaultLayout,
  LAYOUTS_PANEL_ID,
} from "../panels/namedLayouts";
import {
  SAVED_GLOBAL_LAYOUT_KEY,
  SAVED_REPO_LAYOUT_KEY,
  applyBakedGlobalLayout,
  applyBakedRepoLayout,
} from "../panels/layoutSnapshot";
import { buildDefaultGlobalLayout, restoreGlobalPanelInactive } from "../panels/GlobalDock";
import { buildDefaultRepoLayout } from "../panels/RepoDock";
import { useDockviewStore } from "./dockview";

interface LayoutsStore {
  layouts: LayoutEntry[];
  /** Name of the saved layout the docks currently show (session-only marker
   *  for the View menu / Layouts panel). Cleared as soon as either dock
   *  changes (`noteDockLayoutChanged`) — a drifted arrangement no longer IS
   *  the saved layout. */
  lastApplied: string | null;

  init: () => Promise<void>;
  refreshList: () => Promise<void>;
  /** Snapshot the current docks under `name` (new layout or override). */
  saveCurrent: (name: string) => Promise<void>;
  apply: (name: string) => Promise<void>;
  rename: (oldName: string, newName: string) => Promise<void>;
  remove: (name: string) => Promise<void>;
  /** Store a validated imported document; returns the entry name used. */
  importDocument: (doc: LayoutDocument, suggestedName?: string) => Promise<string>;
  /** Rebuild both docks' built-in default layout. */
  resetToDefault: () => void;
  /** Called by the docks' onDidLayoutChange handlers: any layout change
   *  invalidates the `lastApplied` marker (unless the store itself is the
   *  one mutating the docks). */
  noteDockLayoutChanged: () => void;
}

/**
 * Suppresses `noteDockLayoutChanged` while `apply()` mutates the docks —
 * applying fires the exact same onDidLayoutChange events as a user drag,
 * which would clear the marker the apply is about to set. Released on a
 * timer, not synchronously: dockview may deliver some change events on a
 * later tick.
 */
let suppressDirty = false;
const SUPPRESS_DIRTY_MS = 100;

export const useLayoutsStore = create<LayoutsStore>((set, get) => ({
  layouts: [],
  lastApplied: null,

  async init() {
    await get().refreshList();
    await migrateLegacySavedDefault(get);
  },

  async refreshList() {
    const layouts = await listLayouts();
    set({ layouts });
  },

  async saveCurrent(name) {
    const { globalApi, repoApi } = useDockviewStore.getState();
    const doc = captureLayoutDocument(name, globalApi, repoApi);
    if (!doc) throw new Error("Nothing to capture - open a repository or a global panel first.");
    const entry = await saveLayoutCmd(name, doc);
    set({ lastApplied: entry.name });
    await get().refreshList();
  },

  async apply(name) {
    const raw = await loadLayout(name);
    const doc = asLayoutDocument(raw);
    if (!doc) throw new Error(`Layout file for "${name}" is not a valid layout.`);
    const { globalApi, repoApi } = useDockviewStore.getState();
    const layoutsPanelWasOpen = !!globalApi?.getPanel(LAYOUTS_PANEL_ID);
    suppressDirty = true;
    let ok: boolean;
    try {
      ok = applyLayoutDocument(doc, globalApi, repoApi);
      // If applying replaced the global dock (captures never contain the
      // Layouts panel), restore the panel the user is acting from — as an
      // INACTIVE background tab: applying a layout must never move focus to
      // the Layouts panel.
      if (layoutsPanelWasOpen && globalApi && !globalApi.getPanel(LAYOUTS_PANEL_ID)) {
        restoreGlobalPanelInactive(LAYOUTS_PANEL_ID);
      }
    } finally {
      setTimeout(() => {
        suppressDirty = false;
      }, SUPPRESS_DIRTY_MS);
    }
    if (!ok) throw new Error(`Layout "${name}" could not be fully applied.`);
    set({ lastApplied: name });
  },

  async rename(oldName, newName) {
    await renameLayoutCmd(oldName, newName);
    if (get().lastApplied === oldName) set({ lastApplied: newName.trim() });
    await get().refreshList();
  },

  async remove(name) {
    await deleteLayoutCmd(name);
    if (get().lastApplied === name) set({ lastApplied: null });
    await get().refreshList();
  },

  async importDocument(doc, suggestedName) {
    const taken = new Set(get().layouts.map((l) => l.name));
    const name = chooseUniqueName((suggestedName ?? doc.name).trim() || doc.name, taken);
    const entry = await saveLayoutCmd(name, doc);
    await get().refreshList();
    return entry.name;
  },

  resetToDefault() {
    const { globalApi, repoApi } = useDockviewStore.getState();
    if (globalApi) {
      globalApi.clear();
      if (!applyBakedGlobalLayout(globalApi)) {
        globalApi.clear();
        buildDefaultGlobalLayout(globalApi);
      }
    }
    if (repoApi) {
      repoApi.clear();
      if (!applyBakedRepoLayout(repoApi)) {
        repoApi.clear();
        buildDefaultRepoLayout(repoApi);
      }
    }
    set({ lastApplied: null });
  },

  noteDockLayoutChanged() {
    if (suppressDirty) return;
    if (get().lastApplied !== null) set({ lastApplied: null });
  },
}));

/**
 * One-time migration of the legacy "Save as default layout" snapshot into a
 * named layout ("My layout"). The keys are cleared only after a successful
 * save, so a failed backend write retries on the next startup.
 */
async function migrateLegacySavedDefault(get: () => LayoutsStore) {
  let rawRepo: string | null = null;
  let rawGlobal: string | null = null;
  try {
    rawRepo = localStorage.getItem(SAVED_REPO_LAYOUT_KEY);
    rawGlobal = localStorage.getItem(SAVED_GLOBAL_LAYOUT_KEY);
  } catch {
    return;
  }
  if (rawRepo === null && rawGlobal === null) return;
  const taken = new Set(get().layouts.map((l) => l.name));
  const doc = migrateLegacyDefaultLayout(rawRepo, rawGlobal, taken);
  try {
    if (doc) {
      await saveLayoutCmd(doc.name, doc);
      await get().refreshList();
    }
    localStorage.removeItem(SAVED_REPO_LAYOUT_KEY);
    localStorage.removeItem(SAVED_GLOBAL_LAYOUT_KEY);
  } catch (e) {
    console.warn("could not migrate the saved default layout", e);
  }
}
