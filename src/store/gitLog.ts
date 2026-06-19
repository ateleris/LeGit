import { create } from "zustand";
import type { GitInvocation } from "../lib/types";

/** A logged git invocation with a client-assigned id + receipt time. */
export interface GitLogEntry extends GitInvocation {
  id: number;
  at: number;
}

const MAX_ENTRIES = 500; // ring buffer — git is chatty (status/log/diff per action)
let nextId = 1;

interface GitLogStore {
  entries: GitLogEntry[];
  add: (inv: GitInvocation) => void;
  clear: () => void;
}

/** Live log of every git command the app runs, fed by the `git_invocation`
 *  backend event. Powers the Git Log panel. */
export const useGitLogStore = create<GitLogStore>((set) => ({
  entries: [],
  add: (inv) =>
    set((s) => {
      const next = [...s.entries, { ...inv, id: nextId++, at: Date.now() }];
      if (next.length > MAX_ENTRIES) next.splice(0, next.length - MAX_ENTRIES);
      return { entries: next };
    }),
  clear: () => set({ entries: [] }),
}));
