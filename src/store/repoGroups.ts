import { create } from "zustand";
import { api } from "../lib/commands";
import { formatAppError } from "../lib/errors";
import type { RepoGroupsDoc, RepoGroupsOp } from "../lib/types";
import { notify } from "./notifications";

interface RepoGroupsStore {
  doc: RepoGroupsDoc;
  /** Fetch the persisted doc (startup, and on settings-changed broadcasts -
   * RepoTabBar owns the event subscription). */
  load: () => Promise<void>;
  /** Apply a structural op; the backend returns (and this caches and
   * resolves) the merged doc, or null on failure. Errors surface as a toast -
   * the strip itself never shows banners. */
  applyOp: (op: RepoGroupsOp) => Promise<RepoGroupsDoc | null>;
}

export const useRepoGroupsStore = create<RepoGroupsStore>((set) => ({
  doc: { items: [] },

  async load() {
    try {
      set({ doc: await api.getRepoGroups() });
    } catch (e) {
      console.warn("getRepoGroups failed", e);
    }
  },

  async applyOp(op) {
    try {
      const doc = await api.applyRepoGroupsOp(op);
      set({ doc });
      return doc;
    } catch (e) {
      notify.error(formatAppError(e));
      return null;
    }
  },
}));
