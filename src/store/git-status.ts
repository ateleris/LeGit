import { create } from "zustand";
import { gitStatusCheck, setGitPath, wslListDistros } from "../lib/commands";
import { localGitUsable } from "../panels/Setup/gateDecision";
import type { GitStatus } from "../lib/types";

interface GitStatusStore {
  status: GitStatus | null;
  /** Whether a remote host (a WSL distribution) could run git instead - only
   *  probed when the app machine's own git is unusable, so the common path
   *  costs nothing. */
  remoteHostsAvailable: boolean;
  pending: boolean;
  refresh: () => Promise<void>;
  setPath: (path: string | null) => Promise<void>;
}

/** `wsl.exe -l`: installed distros, without connecting to (or starting) any. */
async function probeRemoteHosts(status: GitStatus): Promise<boolean> {
  if (localGitUsable(status)) return false;
  try {
    return (await wslListDistros()).length > 0;
  } catch (e) {
    console.warn("failed to list WSL distributions", e);
    return false;
  }
}

export const useGitStatusStore = create<GitStatusStore>((set) => ({
  status: null,
  remoteHostsAvailable: false,
  pending: false,

  async refresh() {
    set({ pending: true });
    try {
      const status = await gitStatusCheck();
      set({ status, remoteHostsAvailable: await probeRemoteHosts(status) });
    } finally {
      set({ pending: false });
    }
  },

  async setPath(path) {
    set({ pending: true });
    try {
      const status = await setGitPath(path);
      set({ status, remoteHostsAvailable: await probeRemoteHosts(status) });
    } finally {
      set({ pending: false });
    }
  },
}));
