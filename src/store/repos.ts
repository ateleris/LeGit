import { create } from "zustand";
import { repoInit as repoInitCmd, repoClone as repoCloneCmd, api } from "../lib/commands";
import type { CloneOptions, InitOptions } from "../lib/commands";
import { notifyLfsStubs } from "../lib/lfsFeedback";
import type { RepoId, RepoSettings, RepoSettingsPatch, RepoSummary } from "../lib/types";
import { pickNextActive, pushActivation } from "./repoActivation";
import { useConsoleStore } from "./console";
import { useSettingsStore } from "./settings";

interface RepoStore {
  openRepos: RepoSummary[];
  activeRepoId: RepoId | null;
  /** Most-recent-first repo activation history (session-local). Closing the
   * active tab returns to the previously used repo, not the first tab. */
  activationHistory: RepoId[];
  initialized: boolean;

  /** Cached repo-scope settings, keyed by RepoId. */
  repoSettings: Record<RepoId, RepoSettings>;

  /** Called once at app startup. Restores persisted open repos + active. */
  init: () => Promise<void>;
  refresh: () => Promise<void>;
  openRepo: (path: string) => Promise<RepoSummary>;
  /**
   * Init a new repo at `path`, open it, optionally apply a profile.
   * A bare init returns null (created, but there is no worktree to open).
   */
  initRepo: (
    path: string,
    profileId: string | null,
    options?: InitOptions
  ) => Promise<RepoSummary | null>;
  /** Clone `url` into `parentDir/name`, open it, optionally apply a profile. */
  cloneRepo: (
    url: string,
    parentDir: string,
    name: string,
    profileId: string | null,
    opId: string,
    options?: CloneOptions
  ) => Promise<RepoSummary>;
  closeRepo: (id: RepoId) => Promise<void>;
  setActive: (id: RepoId | null) => void;
  /** Reorder the open-repo tabs to `orderedIds` and persist the order. */
  reorderRepos: (orderedIds: RepoId[]) => void;
  /** Patch a repo's watch state (from the `legit://watch-state` event):
   * error = watcher failed to start, null = watching again. */
  setWatchError: (id: RepoId, error: string | null) => void;

  /** Fetch and cache repo settings for the given repo. */
  loadRepoSettings: (id: RepoId) => Promise<void>;
  /** Change one repo setting (only that field is sent), persist, and cache
   *  the merged settings the backend returns. */
  updateRepoSetting: <K extends keyof RepoSettingsPatch>(
    id: RepoId,
    key: K,
    value: RepoSettingsPatch[K]
  ) => Promise<void>;
}

export const useRepoStore = create<RepoStore>((set, get) => ({
  openRepos: [],
  activeRepoId: null,
  activationHistory: [],
  initialized: false,
  repoSettings: {},

  async init() {
    if (get().initialized) return;
    try {
      const restored = await api.restoreOpenRepos();
      set({
        openRepos: restored.repos,
        activeRepoId: restored.active_id,
        activationHistory: restored.active_id ? [restored.active_id] : [],
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
    const open = await api.listRepos();
    set((s) => {
      // `api.listRepos` returns name-sorted; preserve the user's current tab order
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
      // Keep the active id if still present; otherwise return to the most
      // recently used open repo (MRU), not the first tab.
      const stillActive = s.activeRepoId && ordered.some((r) => r.id === s.activeRepoId);
      const nextActive = stillActive
        ? s.activeRepoId
        : pickNextActive(
            s.activationHistory,
            ordered.map((r) => r.id),
          );
      if (!stillActive) {
        // The switch came from a close, not a click: persist it so a restart
        // restores the same repo.
        api.setActiveRepo(nextActive).catch((e) => console.warn("persist active failed", e));
      }
      return {
        openRepos: ordered,
        activeRepoId: nextActive,
        // Drop closed repos so the history cannot resurrect stale ids.
        activationHistory: s.activationHistory.filter((id) =>
          ordered.some((r) => r.id === id),
        ),
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
    api.setOpenReposOrder(orderedIds).catch((e) => console.warn("persist repo order failed", e));
  },

  async openRepo(path: string) {
    const summary = await api.openRepo(path);
    await get().refresh();
    get().setActive(summary.id);
    return summary;
  },

  async initRepo(path, profileId, options) {
    const summary = await repoInitCmd(path, profileId, options);
    if (!summary) return null; // bare init: created, nothing to open
    await get().refresh();
    get().setActive(summary.id);
    return summary;
  },

  async cloneRepo(url, parentDir, name, profileId, opId, options) {
    const outcome = await repoCloneCmd(url, parentDir, name, profileId, opId, options);
    // git can exit 0 while LFS downloads failed, leaving pointer stubs in
    // the fresh clone - the user must learn the files hold no real content.
    notifyLfsStubs(outcome.lfs_stubs, "clone");
    // The backend persisted parentDir as `last_clone_parent_dir` (clone-form
    // prefill); patch the cached settings so a second clone this session
    // prefills the fresh value without a settings refetch.
    useSettingsStore.setState((s) =>
      s.settings ? { settings: { ...s.settings, last_clone_parent_dir: parentDir } } : s,
    );
    await get().refresh();
    get().setActive(outcome.summary.id);
    return outcome.summary;
  },

  async closeRepo(id: RepoId) {
    // A running (or pager-paused, i.e. pipe-blocked) console command must
    // die with its repo - and the cancel needs the repo session, so it goes
    // BEFORE the backend close.
    const opId = useConsoleStore.getState().sessions[id]?.opId;
    if (opId) {
      await api.consoleCancel(id, opId).catch(() => {
        /* already finished */
      });
    }
    await api.closeRepo(id);
    // The console session is repo-scoped state: a closed repo's scrollback
    // must not linger (or resurrect if the repo is reopened later).
    useConsoleStore.getState().dropRepo(id);
    await get().refresh();
  },

  setWatchError(id, error) {
    set((s) => ({
      openRepos: s.openRepos.map((r) =>
        r.id === id ? { ...r, watch_error: error } : r
      ),
    }));
  },

  setActive(id: RepoId | null) {
    set((s) => ({
      activeRepoId: id,
      activationHistory: id ? pushActivation(s.activationHistory, id) : s.activationHistory,
    }));
    api.setActiveRepo(id).catch((e) => console.warn("persist active failed", e));
    // Eagerly load settings for the newly-active repo if not cached.
    if (id && !get().repoSettings[id]) {
      get().loadRepoSettings(id);
    }
  },

  async loadRepoSettings(id: RepoId) {
    try {
      const settings = await api.getRepoSettings(id);
      set((s) => ({ repoSettings: { ...s.repoSettings, [id]: settings } }));
    } catch (e) {
      console.warn("loadRepoSettings failed", e);
    }
  },

  async updateRepoSetting(id, key, value) {
    const patch: RepoSettingsPatch = { [key]: value };
    const cached = get().repoSettings[id];
    if (cached) set((s) => ({ repoSettings: { ...s.repoSettings, [id]: { ...cached, ...patch } } }));
    const merged = await api.patchRepoSettings(id, patch);
    set((s) => ({ repoSettings: { ...s.repoSettings, [id]: merged } }));
  },
}));

/** Convenience hook returning the active `RepoSummary` (or null). */
export function useActiveRepo(): RepoSummary | null {
  const id = useRepoStore((s) => s.activeRepoId);
  const repos = useRepoStore((s) => s.openRepos);
  return repos.find((r) => r.id === id) ?? null;
}
