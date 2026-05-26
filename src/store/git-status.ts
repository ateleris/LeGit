import { create } from "zustand";
import { gitStatusCheck, setGitPath } from "../lib/commands";
import type { GitStatus } from "../lib/types";

interface GitStatusStore {
  status: GitStatus | null;
  pending: boolean;
  refresh: () => Promise<void>;
  setPath: (path: string | null) => Promise<void>;
}

export const useGitStatusStore = create<GitStatusStore>((set) => ({
  status: null,
  pending: false,

  async refresh() {
    set({ pending: true });
    try {
      const status = await gitStatusCheck();
      set({ status });
    } finally {
      set({ pending: false });
    }
  },

  async setPath(path) {
    set({ pending: true });
    try {
      const status = await setGitPath(path);
      set({ status });
    } finally {
      set({ pending: false });
    }
  },
}));
