import { create } from "zustand";
import {
  closeRepo as closeRepoCmd,
  listRepos,
  openRepo as openRepoCmd,
  restoreOpenRepos,
  setActiveRepo as setActiveRepoCmd,
} from "../lib/commands";
import type { RepoId, RepoSummary } from "../lib/types";

interface RepoStore {
  openRepos: RepoSummary[];
  activeRepoId: RepoId | null;
  initialized: boolean;

  /** Called once at app startup. Restores persisted open repos + active. */
  init: () => Promise<void>;
  refresh: () => Promise<void>;
  openRepo: (path: string) => Promise<RepoSummary>;
  closeRepo: (id: RepoId) => Promise<void>;
  setActive: (id: RepoId | null) => void;
}

export const useRepoStore = create<RepoStore>((set, get) => ({
  openRepos: [],
  activeRepoId: null,
  initialized: false,

  async init() {
    if (get().initialized) return;
    try {
      const restored = await restoreOpenRepos();
      set({
        openRepos: restored.repos,
        activeRepoId: restored.active_id,
        initialized: true,
      });
    } catch (e) {
      // Restore failure isn't fatal — still mark initialized so the UI proceeds.
      console.warn("restore_open_repos failed", e);
      set({ initialized: true });
    }
  },

  async refresh() {
    const open = await listRepos();
    set((s) => ({
      openRepos: open,
      // Keep active id if still present; otherwise pick the first repo.
      activeRepoId:
        s.activeRepoId && open.some((r) => r.id === s.activeRepoId)
          ? s.activeRepoId
          : open[0]?.id ?? null,
      initialized: true,
    }));
  },

  async openRepo(path: string) {
    const summary = await openRepoCmd(path);
    await get().refresh();
    set({ activeRepoId: summary.id });
    // The backend persisted active in open_repo already, but the active id
    // here may differ from what the backend just wrote (e.g., user clicked a
    // recents row that resolved to an already-open repo). Re-sync.
    setActiveRepoCmd(summary.id).catch((e) => console.warn("persist active failed", e));
    return summary;
  },

  async closeRepo(id: RepoId) {
    await closeRepoCmd(id);
    await get().refresh();
  },

  setActive(id: RepoId | null) {
    set({ activeRepoId: id });
    setActiveRepoCmd(id).catch((e) => console.warn("persist active failed", e));
  },
}));

/** Convenience hook returning the active `RepoSummary` (or null). */
export function useActiveRepo(): RepoSummary | null {
  const id = useRepoStore((s) => s.activeRepoId);
  const repos = useRepoStore((s) => s.openRepos);
  return repos.find((r) => r.id === id) ?? null;
}
