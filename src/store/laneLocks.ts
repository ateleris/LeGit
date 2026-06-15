import { create } from "zustand";
import {
  listLaneLocks,
  setLaneLock as setLaneLockCmd,
  unsetLaneLock as unsetLaneLockCmd,
} from "../lib/commands";
import type { LaneLock, RepoId } from "../lib/types";

interface LaneLocksStore {
  /** Per-repo locks, keyed by RepoId. */
  locks: Record<RepoId, LaneLock[]>;

  /** Load locks for a repo (calls list_lane_locks). */
  loadLocks: (repoId: RepoId) => Promise<void>;

  /** Set a lock, then refresh `locks[repoId]` from the returned list. */
  setLock: (repoId: RepoId, refName: string, laneIndex: number) => Promise<void>;

  /** Remove a lock, then refresh `locks[repoId]` from the returned list. */
  unsetLock: (repoId: RepoId, refName: string) => Promise<void>;

  /** Pure selector: returns the cached locks for a repo (empty array if none). */
  getLocks: (repoId: RepoId) => LaneLock[];
}

export const useLaneLocksStore = create<LaneLocksStore>((set, get) => ({
  locks: {},

  async loadLocks(repoId: RepoId) {
    try {
      const list = await listLaneLocks(repoId);
      set((s) => ({ locks: { ...s.locks, [repoId]: list } }));
    } catch (e) {
      console.warn("loadLocks failed", e);
    }
  },

  async setLock(repoId: RepoId, refName: string, laneIndex: number) {
    const list = await setLaneLockCmd(repoId, refName, laneIndex);
    set((s) => ({ locks: { ...s.locks, [repoId]: list } }));
  },

  async unsetLock(repoId: RepoId, refName: string) {
    const list = await unsetLaneLockCmd(repoId, refName);
    set((s) => ({ locks: { ...s.locks, [repoId]: list } }));
  },

  getLocks(repoId: RepoId) {
    return get().locks[repoId] ?? [];
  },
}));

/** Convenience hook returning the current locks for a repo. */
export function useLaneLocks(repoId: RepoId): LaneLock[] {
  return useLaneLocksStore((s) => s.locks[repoId] ?? EMPTY);
}

// Module-level empty array so the hook returns a stable reference when a
// repo has no locks yet — avoids needless re-renders in `useMemo` consumers.
const EMPTY: LaneLock[] = [];
