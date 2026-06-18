import { create } from "zustand";
import {
  closeRepo as closeRepoCmd,
  listRepos,
  openRepo as openRepoCmd,
  restoreOpenRepos,
  setActiveRepo as setActiveRepoCmd,
  setOpenReposOrder as setOpenReposOrderCmd,
  getRepoSettings as getRepoSettingsCmd,
  updateRepoSettings as updateRepoSettingsCmd,
} from "../lib/commands";
import type { RepoId, RepoSettings, RepoSummary } from "../lib/types";

interface RepoStore {
  openRepos: RepoSummary[];
  activeRepoId: RepoId | null;
  initialized: boolean;

  /** Cached repo-scope settings, keyed by RepoId. */
  repoSettings: Record<RepoId, RepoSettings>;

  /** Called once at app startup. Restores persisted open repos + active. */
  init: () => Promise<void>;
  refresh: () => Promise<void>;
  openRepo: (path: string) => Promise<RepoSummary>;
  closeRepo: (id: RepoId) => Promise<void>;
  setActive: (id: RepoId | null) => void;
  /** Reorder the open-repo tabs to `orderedIds` and persist the order. */
  reorderRepos: (orderedIds: RepoId[]) => void;

  /** Fetch and cache repo settings for the given repo. */
  loadRepoSettings: (id: RepoId) => Promise<void>;
  /** Update a single field of repo settings, persist, and refresh cache. */
  updateRepoSetting: <K extends keyof RepoSettings>(
    id: RepoId,
    key: K,
    value: RepoSettings[K]
  ) => Promise<void>;
}

export const useRepoStore = create<RepoStore>((set, get) => ({
  openRepos: [],
  activeRepoId: null,
  initialized: false,
  repoSettings: {},

  async init() {
    if (get().initialized) return;
    try {
      const restored = await restoreOpenRepos();
      set({
        openRepos: restored.repos,
        activeRepoId: restored.active_id,
        initialized: true,
      });
      // Pre-load settings for the active repo.
      if (restored.active_id) {
        get().loadRepoSettings(restored.active_id);
      }
    } catch (e) {
      console.warn("restore_open_repos failed", e);
      set({ initialized: true });
    }
  },

  async refresh() {
    const open = await listRepos();
    set((s) => {
      // `listRepos` returns name-sorted; preserve the user's current tab order
      // for repos that remain and append any newly-opened ones at the end.
      const present = new Map(open.map((r) => [r.id, r] as const));
      const ordered: RepoSummary[] = [];
      for (const r of s.openRepos) {
        const cur = present.get(r.id);
        if (cur) {
          ordered.push(cur);
          present.delete(r.id);
        }
      }
      for (const r of open) if (present.has(r.id)) ordered.push(r);
      return {
        openRepos: ordered,
        // Keep active id if still present; otherwise pick the first repo.
        activeRepoId:
          s.activeRepoId && ordered.some((r) => r.id === s.activeRepoId)
            ? s.activeRepoId
            : ordered[0]?.id ?? null,
        initialized: true,
      };
    });
  },

  reorderRepos(orderedIds) {
    set((s) => {
      const byId = new Map(s.openRepos.map((r) => [r.id, r] as const));
      const next: RepoSummary[] = [];
      for (const id of orderedIds) {
        const r = byId.get(id);
        if (r) {
          next.push(r);
          byId.delete(id);
        }
      }
      // Safety: keep any repo not named in `orderedIds`.
      for (const r of s.openRepos) if (byId.has(r.id)) next.push(r);
      return { openRepos: next };
    });
    setOpenReposOrderCmd(orderedIds).catch((e) => console.warn("persist repo order failed", e));
  },

  async openRepo(path: string) {
    const summary = await openRepoCmd(path);
    await get().refresh();
    set({ activeRepoId: summary.id });
    setActiveRepoCmd(summary.id).catch((e) => console.warn("persist active failed", e));
    // Pre-load repo settings so the Repo Settings panel is ready.
    get().loadRepoSettings(summary.id);
    return summary;
  },

  async closeRepo(id: RepoId) {
    await closeRepoCmd(id);
    await get().refresh();
  },

  setActive(id: RepoId | null) {
    set({ activeRepoId: id });
    setActiveRepoCmd(id).catch((e) => console.warn("persist active failed", e));
    // Eagerly load settings for the newly-active repo if not cached.
    if (id && !get().repoSettings[id]) {
      get().loadRepoSettings(id);
    }
  },

  async loadRepoSettings(id: RepoId) {
    try {
      const settings = await getRepoSettingsCmd(id);
      set((s) => ({ repoSettings: { ...s.repoSettings, [id]: settings } }));
    } catch (e) {
      console.warn("loadRepoSettings failed", e);
    }
  },

  async updateRepoSetting(id, key, value) {
    const current = get().repoSettings[id] ?? {
      git_path_override: null,
      warn_on_mixed_endings: null,
    };
    const updated = { ...current, [key]: value };
    set((s) => ({ repoSettings: { ...s.repoSettings, [id]: updated } }));
    await updateRepoSettingsCmd(id, updated);
  },
}));

/** Convenience hook returning the active `RepoSummary` (or null). */
export function useActiveRepo(): RepoSummary | null {
  const id = useRepoStore((s) => s.activeRepoId);
  const repos = useRepoStore((s) => s.openRepos);
  return repos.find((r) => r.id === id) ?? null;
}
