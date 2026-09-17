import { create } from "zustand";
import {
  deleteLayout as deleteLayoutCmd,
  listLayouts,
  loadLayout,
  renameLayout as renameLayoutCmd,
  saveLayout as saveLayoutCmd,
  setLayoutsOrder,
} from "../lib/commands";
import type { LayoutDocument, LayoutEntry } from "../lib/types";
import {
  applyLayoutDocument,
  asLayoutDocument,
  captureLayoutDocument,
  chooseUniqueName,
  migrateLegacyDefaultLayout,
} from "../panels/namedLayouts";
import {
  SAVED_GLOBAL_LAYOUT_KEY,
  SAVED_REPO_LAYOUT_KEY,
  applyBakedGlobalLayout,
  applyBakedRepoLayout,
} from "../panels/layoutSnapshot";
import { buildDefaultGlobalLayout } from "../panels/GlobalDock";
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
  /** Persist the user's layout order (`app.applyLayoutN` addresses layouts
   *  by position, so the order is a decision, not a sort). */
  setOrder: (names: string[]) => Promise<void>;
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
    const { repoApi } = useDockviewStore.getState();
    const doc = captureLayoutDocument(name, repoApi);
    if (!doc) throw new Error("Nothing to capture - open a repository first.");
    const entry = await saveLayoutCmd(name, doc);
    set({ lastApplied: entry.name });
    await get().refreshList();
  },

  async apply(name) {
    const raw = await loadLayout(name);
    const doc = asLayoutDocument(raw);
    if (!doc) throw new Error(`Layout file for "${name}" is not a valid layout.`);
    const { repoApi } = useDockviewStore.getState();
    suppressDirty = true;
    let ok: boolean;
    try {
      ok = applyLayoutDocument(doc, repoApi);
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

  async setOrder(names) {
    // Optimistic: the dragged rows must not snap back to the old order while
    // the write is in flight.
    const byName = new Map(get().layouts.map((l) => [l.name, l]));
    const reordered = names
      .map((n) => byName.get(n))
      .filter((l): l is LayoutEntry => l !== undefined);
    set({ layouts: reordered });
    await setLayoutsOrder(names);
    await get().refreshList();
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
